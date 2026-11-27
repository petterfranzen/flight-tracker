package com.flighttracker.service.confirmation;

import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.training.ConfirmedLanding;
import com.flighttracker.service.training.TrainingDataService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.Nullable;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Turns "probably landed" into "confirmed" by asking the arrival providers.
 *
 * <p>Each tick it picks the aircraft worth confirming and walks them
 * oldest-first for every enabled provider that covers their airport. The
 * gateway answers from its cache when it can, so a tick makes at most one
 * real call per provider and the cached answers cost nothing. A FOUND answer
 * with an actual touchdown or gate-in time goes into the {@link ConfirmationStore},
 * which {@code TrackStatus} prefers over any estimate.
 *
 * <p>Candidates, in priority order:
 * <ol>
 *   <li>LANDED_INFERRED gaps, at the gap's landing airport (else the callsign's destination);</li>
 *   <li>COVERAGE_LOST gaps whose predicted touchdown has passed and whose
 *       landing probability is at least {@code min-landing-probability};</li>
 *   <li>aircraft on the ground that landed within {@code on-ground-window-minutes}
 *       (for the gate), at the nearest runway's airport, else the callsign's destination.</li>
 * </ol>
 * An aircraft that already has a gate-in time is not asked again, and one
 * confirmed as landed but without a gate is asked only until
 * {@code gate-wait-minutes} (45) after its touchdown (a provider may set its own,
 * {@link ArrivalConfirmationProvider#gateWait()}; AeroDataBox's is zero), and after every
 * unconfirmed candidate.
 *
 * <p>An answer whose landing time is more than {@code skew-tolerance-seconds}
 * before the aircraft's last report (for a gap) or before it touched down (on
 * the ground) is about an earlier flight and is ignored.
 *
 * <p>Providers come in two shapes. A per-flight {@link ArrivalConfirmationProvider}
 * is asked about each candidate in turn. An {@link AirportArrivalsProvider}
 * serves a whole board per airport and UTC date: the candidate is looked up in
 * the cached board without a call (by normalised callsign, else by registration
 * from the aircraft table), and a board is fetched only when none is fresh. One
 * fetch serves every candidate at that airport in the same tick. The same
 * rules apply to both: at most one real call per provider per tick, the
 * skew-tolerance rejection and the candidate order.
 *
 * <p>When the answer is for a gap, the provider's touchdown time also goes to
 * {@link TrainingDataService#recordConfirmedLanding} under the gap's key (the
 * last report before the gap). An on-ground aircraft has no gap and so no
 * feature row to label; writing one would leave an orphan label. A provider whose
 * terms limit how long its data may be kept ({@link ArrivalConfirmationProvider#mayStoreLongTerm})
 * writes no label.
 *
 * <p>Precedence: a per-flight provider is not asked about a candidate whose airport an
 * enabled board provider covers, so a global fallback source (AeroDataBox) only sees
 * the airports no board serves.
 */
@Service
public class ArrivalConfirmationService {

    private static final Logger log = LoggerFactory.getLogger(ArrivalConfirmationService.class);

    /** An on-ground report this close to a runway threshold counts as being at its airport. */
    static final double RUNWAY_AIRPORT_RADIUS_M = 5_000;

    /** A candidate's recheck memo: one provider, aircraft, airport and board date. */
    private record RecheckKey(String providerId, String icao24, String airport, LocalDate date) { }

    /** One board provider's pass over the candidates; {@code called} once its one real fetch of the tick is spent. */
    private static final class BoardPass {
        final AirportArrivalsProvider provider;
        final Instant now;
        boolean called;

        BoardPass(AirportArrivalsProvider provider, Instant now) {
            this.provider = provider;
            this.now = now;
        }
    }

    private final List<ArrivalConfirmationProvider> providers;
    private final List<AirportArrivalsProvider> boardProviders;
    private final ConfirmationGateway gateway;
    private final ConfirmationStore store;
    private final LiveStateStore liveStateStore;
    private final TrainingDataService training;
    private final Clock clock;
    private final ArrivalCandidateRules candidateRules;
    private final BoardEntryMatcher boardMatcher;
    private final Duration skewTolerance;
    private final Duration gateWait;
    private final Duration boardRecheck;
    /** When each candidate last drew a blank from a board, as that board's fetch time. */
    private final Map<RecheckKey, Instant> blanks = new ConcurrentHashMap<>();

    public ArrivalConfirmationService(List<ArrivalConfirmationProvider> providers,
                                      @Nullable List<AirportArrivalsProvider> boardProviders,
                                      AircraftRepository aircraftRepository,
                                      ConfirmationGateway gateway,
                                      ConfirmationStore store,
                                      LiveStateStore liveStateStore,
                                      CallsignRouteService routeService,
                                      RunwayIndex runwayIndex,
                                      TrainingDataService training,
                                      Clock clock,
                                      @Value("${flighttracker.confirmation.min-landing-probability:0.5}") double minLandingProbability,
                                      @Value("${flighttracker.confirmation.on-ground-window-minutes:120}") long onGroundWindowMinutes,
                                      @Value("${flighttracker.confirmation.skew-tolerance-seconds:300}") long skewToleranceSeconds,
                                      @Value("${flighttracker.confirmation.gate-wait-minutes:45}") long gateWaitMinutes,
                                      @Value("${flighttracker.confirmation.board-recheck-minutes:15}") long boardRecheckMinutes) {
        this.providers = providers;
        this.boardProviders = boardProviders == null ? List.of() : boardProviders;
        this.gateway = gateway;
        this.store = store;
        this.liveStateStore = liveStateStore;
        this.training = training;
        this.clock = clock;
        this.candidateRules = new ArrivalCandidateRules(routeService, runwayIndex, minLandingProbability,
                Duration.ofMinutes(onGroundWindowMinutes));
        this.boardMatcher = new BoardEntryMatcher(aircraftRepository);
        this.skewTolerance = Duration.ofSeconds(skewToleranceSeconds);
        this.gateWait = Duration.ofMinutes(gateWaitMinutes);
        this.boardRecheck = Duration.ofMinutes(boardRecheckMinutes);
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.confirmation.interval-seconds:30} * 1000}")
    void tick() {
        try {
            store.prune(liveStateStore::get);
            List<ArrivalConfirmationProvider> active = providers.stream().filter(ArrivalConfirmationProvider::enabled).toList();
            List<AirportArrivalsProvider> activeBoards = boardProviders.stream().filter(AirportArrivalsProvider::enabled).toList();
            if (active.isEmpty() && activeBoards.isEmpty()) return;

            List<ArrivalCandidate> candidates = candidates(clock.instant());
            if (candidates.isEmpty()) return;

            for (ArrivalConfirmationProvider provider : active) {
                askSafely(provider.id(), () -> askProvider(provider, candidates, activeBoards));
            }
            for (AirportArrivalsProvider provider : activeBoards) {
                askSafely(provider.id(), () -> askBoardProvider(provider, candidates));
            }
        } catch (RuntimeException e) {
            log.warn("Arrival confirmation tick failed", e);
        }
    }

    /** One provider's failure does not keep the others from their turn this tick. */
    private static void askSafely(String providerId, Runnable ask) {
        try {
            ask.run();
        } catch (RuntimeException e) {
            log.warn("Arrival confirmation via {} failed this tick", providerId, e);
        }
    }

    /** Cached answers are applied as they come; the first real call (or a skipped one) ends this provider's tick. */
    private void askProvider(ArrivalConfirmationProvider provider, List<ArrivalCandidate> candidates,
                             List<AirportArrivalsProvider> activeBoards) {
        Instant now = clock.instant();
        for (ArrivalCandidate c : candidates) {
            if (!worthAsking(provider, c, activeBoards, now)) continue;
            ConfirmationGateway.Outcome outcome = gateway.lookup(provider, c.query());
            if (outcome.kind() == ConfirmationGateway.Kind.SKIPPED) return;
            applyIfFound(provider, c, outcome.result());
            if (outcome.kind() == ConfirmationGateway.Kind.CALLED) return;
        }
    }

    private boolean worthAsking(ArrivalConfirmationProvider provider, ArrivalCandidate c,
                                List<AirportArrivalsProvider> activeBoards, Instant now) {
        if (!provider.covers(c.airport())) return false;
        if (c.gateWaitOver(provider.gateWait() != null ? provider.gateWait() : gateWait, now)) return false;
        // An enabled airport board is the better source at its own airports (one call serves every flight).
        return c.airport() == null || activeBoards.stream().noneMatch(b -> b.covers(c.airport()));
    }

    private void applyIfFound(ArrivalConfirmationProvider provider, ArrivalCandidate c, LookupResult result) {
        if (result.status() == LookupResult.Status.FOUND && result.info() != null) {
            apply(provider.id(), c, result.info(), provider.mayStoreLongTerm());
        }
    }

    /**
     * Board providers: every candidate at a covered airport is looked up in that
     * airport's board for the date the provider files that touchdown under
     * ({@link AirportArrivalsProvider#boardDate}, the UTC date unless it overrides). A fresh cached board costs
     * nothing; a missing or stale one is fetched, at most once per tick, and
     * then serves all the candidates at that airport. A skipped fetch (paced,
     * over budget, cooling down) spends that one attempt: later candidates are
     * still matched against fresh cached boards, for free, but nothing more is asked.
     *
     * <p>A candidate that a board has no (new) answer for, whether a GA aircraft, a
     * callsign that is not on the board or an aircraft still waiting for its gate time,
     * may not trigger another fetch of that board until
     * {@code board-recheck-minutes} (15) have passed since that board was fetched.
     * Without this, every unmatched candidate would refetch the board every
     * {@code board-ttl-seconds} for as long as it stays a candidate, and the daily
     * budget would go on boards that cannot change the outcome. It can still be matched against a
     * fresher board that another candidate's fetch brings in.
     */
    private void askBoardProvider(AirportArrivalsProvider provider, List<ArrivalCandidate> candidates) {
        Instant now = clock.instant();
        blanks.values().removeIf(at -> !at.plus(boardRecheck).isAfter(now));
        BoardPass pass = new BoardPass(provider, now);
        for (ArrivalCandidate c : candidates) {
            if (provider.covers(c.airport()) && !c.gateWaitOver(gateWait, now)) askBoard(pass, c);
        }
    }

    private void askBoard(BoardPass pass, ArrivalCandidate c) {
        AirportArrivalsProvider provider = pass.provider;
        LocalDate date = provider.boardDate(c.expectedAt());
        RecheckKey key = new RecheckKey(provider.id(), c.aircraft().icao24(), c.airport(), date);
        BoardResult board = gateway.cachedBoard(provider, c.airport(), date).orElseGet(() -> fetchBoard(pass, key));
        if (board == null || !isAnswer(board)) return;
        if (!answeredFrom(board, provider.id(), c)) rememberBlank(pass, key);
    }

    /** Null when no board came: the tick's one real call is spent, the candidate drew a blank recently, or the fetch was skipped. */
    private BoardResult fetchBoard(BoardPass pass, RecheckKey key) {
        if (pass.called) return null; // the one real call of this tick is spent
        Instant blankAt = blanks.get(key);
        if (blankAt != null && blankAt.plus(boardRecheck).isAfter(pass.now)) return null; // checked recently, not on it
        ConfirmationGateway.BoardOutcome outcome = gateway.board(pass.provider, key.airport(), key.date());
        pass.called = outcome.kind() != ConfirmationGateway.Kind.CACHED; // a skipped fetch counts too: the gateway is not asked again this tick
        return outcome.kind() == ConfirmationGateway.Kind.SKIPPED ? null : outcome.board();
    }

    private static boolean isAnswer(BoardResult board) {
        return board.status() == LookupResult.Status.FOUND || board.status() == LookupResult.Status.NOT_FOUND;
    }

    private boolean answeredFrom(BoardResult board, String providerId, ArrivalCandidate c) {
        if (board.status() != LookupResult.Status.FOUND) return false;
        BoardEntry entry = boardMatcher.match(board, c);
        if (entry == null || entry.info() == null) return false;
        return apply(providerId, c, entry.info(), true);
    }

    private void rememberBlank(BoardPass pass, RecheckKey key) {
        Instant fetchedAt = gateway.boardFetchedAt(pass.provider, key.airport(), key.date()).orElse(pass.now);
        blanks.merge(key, fetchedAt, (old, fresh) -> fresh.isAfter(old) ? fresh : old);
    }

    /** True when the answer was stored: it confirmed the landing or added the gate time. */
    private boolean apply(String sourceId, ArrivalCandidate c, ArrivalInfo info, boolean mayStoreLongTerm) {
        LiveAircraft a = c.aircraft();
        if (isEarlierFlight(a, info.landedAt(), sourceId)) return false;
        Confirmation confirmation = new Confirmation(sourceId, info, clock.instant(), a.observedAt());
        if (!store.put(a.icao24(), confirmation)) return false;
        log.info("{} confirmed by {}: {}", a.icao24(), sourceId, info.actualIn() != null ? "at gate" : "landed");
        if (mayStoreLongTerm) recordTrainingLabel(sourceId, c, info);
        return true;
    }

    /**
     * A cached or stale answer can be about an earlier landing of the same callsign.
     * On the ground the reports keep coming, so the floor is the touchdown, not the last report.
     */
    private boolean isEarlierFlight(LiveAircraft a, Instant landedAt, String sourceId) {
        if (landedAt == null) return false;
        Instant floor = a.onGround() && a.landedSince() != null ? a.landedSince() : a.observedAt();
        if (!landedAt.isBefore(floor.minus(skewTolerance))) return false;
        log.debug("{} answer from {} landed at {}, before {}: an earlier flight, ignored",
                a.icao24(), sourceId, landedAt, floor);
        return true;
    }

    /** Only a gap has a feature row to label, and only with an actual touchdown time. */
    private void recordTrainingLabel(String sourceId, ArrivalCandidate c, ArrivalInfo info) {
        LiveAircraft a = c.aircraft();
        if (info.actualOn() == null || a.gap() == null) return;
        try {
            String airport = info.arrivalAirportIcao() != null ? info.arrivalAirportIcao() : c.airport();
            training.recordConfirmedLanding(new ConfirmedLanding(a.icao24(), a.observedAt(), sourceId, info.actualOn(), airport));
        } catch (RuntimeException e) {
            log.warn("Recording the confirmed landing of {} failed", a.icao24(), e);
        }
    }

    private List<ArrivalCandidate> candidates(Instant now) {
        List<LiveAircraft> live = liveStateStore.liveAircraft(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                now.minus(LiveVisibilityWindows.LANDED_VISIBILITY));
        List<ArrivalCandidate> out = new ArrayList<>();
        for (LiveAircraft a : live) {
            ArrivalCandidate c = candidateFor(a, now);
            if (c != null) out.add(c);
        }
        out.sort(Comparator.comparing(ArrivalCandidate::confirmed)
                .thenComparingInt(ArrivalCandidate::priority)
                .thenComparing(ArrivalCandidate::expectedAt)
                .thenComparing(c -> c.aircraft().icao24()));
        return out;
    }

    /**
     * Null without a callsign, or once the gate-in time is known. Landed but no gate
     * yet: each provider waits a while for it, see {@link ArrivalCandidate#gateWaitOver}.
     */
    private ArrivalCandidate candidateFor(LiveAircraft a, Instant now) {
        if (a.callsign() == null || a.callsign().isBlank()) return null;
        Confirmation known = store.forAircraft(a).orElse(null);
        if (known != null && known.gateAt() != null) return null;
        return candidateRules.candidate(a, now, known);
    }
}

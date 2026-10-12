package com.flighttracker.service.confirmation;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.Runway;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
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
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

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
 * {@code gate-wait-minutes} (45) after its touchdown, and after every
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
 * feature row to label; writing one would leave an orphan label.
 */
@Service
public class ArrivalConfirmationService {

    private static final Logger log = LoggerFactory.getLogger(ArrivalConfirmationService.class);

    /** An on-ground report this close to a runway threshold counts as being at its airport. */
    static final double RUNWAY_AIRPORT_RADIUS_M = 5_000;

    private record Candidate(LiveAircraft aircraft, int priority, String airport, Instant expectedAt, boolean confirmed) { }

    private final List<ArrivalConfirmationProvider> providers;
    private final List<AirportArrivalsProvider> boardProviders;
    private final AircraftRepository aircraftRepository;
    private final ConfirmationGateway gateway;
    private final ConfirmationStore store;
    private final LiveStateStore liveStateStore;
    private final CallsignRouteService routeService;
    private final RunwayIndex runwayIndex;
    private final TrainingDataService training;
    private final Clock clock;
    private final double minLandingProbability;
    private final Duration onGroundWindow;
    private final Duration skewTolerance;
    private final Duration gateWait;

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
                                      @Value("${flighttracker.confirmation.gate-wait-minutes:45}") long gateWaitMinutes) {
        this.providers = providers;
        this.boardProviders = boardProviders == null ? List.of() : boardProviders;
        this.aircraftRepository = aircraftRepository;
        this.gateway = gateway;
        this.store = store;
        this.liveStateStore = liveStateStore;
        this.routeService = routeService;
        this.runwayIndex = runwayIndex;
        this.training = training;
        this.clock = clock;
        this.minLandingProbability = minLandingProbability;
        this.onGroundWindow = Duration.ofMinutes(onGroundWindowMinutes);
        this.skewTolerance = Duration.ofSeconds(skewToleranceSeconds);
        this.gateWait = Duration.ofMinutes(gateWaitMinutes);
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.confirmation.interval-seconds:30} * 1000}")
    void tick() {
        try {
            store.prune(liveStateStore::get);
            List<ArrivalConfirmationProvider> active = providers.stream().filter(ArrivalConfirmationProvider::enabled).toList();
            List<AirportArrivalsProvider> activeBoards = boardProviders.stream().filter(AirportArrivalsProvider::enabled).toList();
            if (active.isEmpty() && activeBoards.isEmpty()) return;

            Instant now = clock.instant();
            List<Candidate> candidates = candidates(now);
            if (candidates.isEmpty()) return;

            for (ArrivalConfirmationProvider provider : active) {
                try {
                    askProvider(provider, candidates);
                } catch (RuntimeException e) {
                    log.warn("Arrival confirmation via {} failed this tick", provider.id(), e);
                }
            }
            for (AirportArrivalsProvider provider : activeBoards) {
                try {
                    askBoardProvider(provider, candidates);
                } catch (RuntimeException e) {
                    log.warn("Arrival confirmation via {} failed this tick", provider.id(), e);
                }
            }
        } catch (RuntimeException e) {
            log.warn("Arrival confirmation tick failed", e);
        }
    }

    /** Cached answers are applied as they come; the first real call (or a skipped one) ends this provider's tick. */
    private void askProvider(ArrivalConfirmationProvider provider, List<Candidate> candidates) {
        for (Candidate c : candidates) {
            if (!provider.covers(c.airport())) continue;
            LiveAircraft a = c.aircraft();
            ConfirmationGateway.Outcome outcome = gateway.lookup(provider,
                    new ArrivalQuery(a.icao24(), a.callsign(), c.airport(), c.expectedAt()));
            if (outcome.kind() == ConfirmationGateway.Kind.SKIPPED) return;
            LookupResult result = outcome.result();
            if (result.status() == LookupResult.Status.FOUND && result.info() != null) {
                apply(provider.id(), c, result.info());
            }
            if (outcome.kind() == ConfirmationGateway.Kind.CALLED) return;
        }
    }

    /**
     * Board providers: every candidate at a covered airport is looked up in that
     * airport's board for the date it touched down. A fresh cached board costs
     * nothing; a missing or stale one is fetched, at most once per tick, and
     * then serves all the candidates at that airport. A skipped fetch (paced,
     * over budget, cooling down) ends this provider's tick, as for per-flight.
     */
    private void askBoardProvider(AirportArrivalsProvider provider, List<Candidate> candidates) {
        boolean called = false;
        for (Candidate c : candidates) {
            if (!provider.covers(c.airport())) continue;
            LocalDate date = c.expectedAt().atZone(ZoneOffset.UTC).toLocalDate();
            BoardResult board = gateway.cachedBoard(provider, c.airport(), date).orElse(null);
            if (board == null) {
                if (called) continue; // the one real call of this tick is spent
                ConfirmationGateway.BoardOutcome outcome = gateway.board(provider, c.airport(), date);
                if (outcome.kind() == ConfirmationGateway.Kind.SKIPPED) return;
                called = outcome.kind() == ConfirmationGateway.Kind.CALLED;
                board = outcome.board();
            }
            if (board.status() != LookupResult.Status.FOUND) continue;
            BoardEntry entry = match(board, c);
            if (entry != null && entry.info() != null) {
                apply(provider.id(), c, entry.info());
            }
        }
    }

    /**
     * The board entry for the candidate: by normalised callsign, else by
     * registration when both sides have one (the aircraft table's, from adsbdb).
     * Several entries with the same callsign (a flight that runs twice a day)
     * resolve to the one whose landing is nearest the expected touchdown.
     */
    private BoardEntry match(BoardResult board, Candidate c) {
        String callsign = BoardEntry.normalizeCallsign(c.aircraft().callsign());
        BoardEntry best = nearest(board.entries().stream()
                .filter(e -> !callsign.isEmpty() && callsign.equals(BoardEntry.normalizeCallsign(e.callsign()))).toList(), c);
        if (best != null) return best;
        if (board.entries().stream().noneMatch(e -> !BoardEntry.normalizeRegistration(e.registration()).isEmpty())) return null;
        String registration = BoardEntry.normalizeRegistration(
                aircraftRepository.findById(c.aircraft().icao24()).map(Aircraft::registration).orElse(null));
        if (registration.isEmpty()) return null;
        return nearest(board.entries().stream()
                .filter(e -> registration.equals(BoardEntry.normalizeRegistration(e.registration()))).toList(), c);
    }

    private static BoardEntry nearest(List<BoardEntry> entries, Candidate c) {
        return entries.stream().min(Comparator.comparingLong((BoardEntry e) -> {
            Instant landed = e.info() == null ? null : e.info().landedAt();
            return landed == null ? Long.MAX_VALUE : Math.abs(Duration.between(landed, c.expectedAt()).toMillis());
        })).orElse(null);
    }

    private void apply(String sourceId, Candidate c, ArrivalInfo info) {
        LiveAircraft a = c.aircraft();
        Instant landedAt = info.landedAt();
        // A cached or stale answer can be about an earlier landing of the same callsign.
        // On the ground the reports keep coming, so the floor is the touchdown, not the last report.
        Instant floor = a.onGround() && a.landedSince() != null ? a.landedSince() : a.observedAt();
        if (landedAt != null && landedAt.isBefore(floor.minus(skewTolerance))) {
            log.debug("{} answer from {} landed at {}, before {}: an earlier flight, ignored",
                    a.icao24(), sourceId, landedAt, floor);
            return;
        }
        Confirmation confirmation = new Confirmation(sourceId, info, clock.instant(), a.observedAt());
        if (!store.put(a.icao24(), confirmation)) return;
        log.info("{} confirmed by {}: {}", a.icao24(), sourceId, info.actualIn() != null ? "at gate" : "landed");
        if (info.actualOn() != null && a.gap() != null) {
            try {
                String airport = info.arrivalAirportIcao() != null ? info.arrivalAirportIcao() : c.airport();
                training.recordConfirmedLanding(a.icao24(), a.observedAt(), sourceId, info.actualOn(), airport);
            } catch (RuntimeException e) {
                log.warn("Recording the confirmed landing of {} failed", a.icao24(), e);
            }
        }
    }

    private List<Candidate> candidates(Instant now) {
        List<LiveAircraft> live = liveStateStore.liveAircraft(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                now.minus(LiveVisibilityWindows.LANDED_VISIBILITY));
        List<Candidate> out = new ArrayList<>();
        for (LiveAircraft a : live) {
            if (a.callsign() == null || a.callsign().isBlank()) continue;
            Optional<Confirmation> existing = store.forAircraft(a);
            if (existing.isPresent()) {
                Confirmation known = existing.get();
                if (known.gateAt() != null) continue;
                // Landed but no gate yet: wait a while for it, then stop asking.
                if (!known.landedAt().plus(gateWait).isAfter(now)) continue;
            }
            Candidate c = candidate(a, now, existing.isPresent());
            if (c != null) out.add(c);
        }
        out.sort(Comparator.comparing(Candidate::confirmed)
                .thenComparingInt(Candidate::priority)
                .thenComparing(Candidate::expectedAt)
                .thenComparing(c -> c.aircraft().icao24()));
        return out;
    }

    private Candidate candidate(LiveAircraft a, Instant now, boolean confirmed) {
        if (a.onGround()) {
            Instant since = a.landedSince();
            if (since == null || since.isBefore(now.minus(onGroundWindow))) return null;
            // Where it is beats where it was going: a diversion lands elsewhere.
            String airport = runwayIndex.near(a.latitude(), a.longitude(), RUNWAY_AIRPORT_RADIUS_M).stream()
                    .findFirst().map(Runway::airportIcao).orElseGet(() -> destination(a));
            return new Candidate(a, 3, airport, since, confirmed);
        }
        GapEstimate gap = a.gap();
        if (gap == null || gap.touchdownAt() == null) return null;
        if (gap.state() == TrackState.LANDED_INFERRED) {
            return new Candidate(a, 1, airportOf(a, gap), gap.touchdownAt(), confirmed);
        }
        if (gap.state() == TrackState.COVERAGE_LOST && !gap.touchdownAt().isAfter(now)
                && gap.landingProbability() >= minLandingProbability) {
            return new Candidate(a, 2, airportOf(a, gap), gap.touchdownAt(), confirmed);
        }
        return null;
    }

    private String airportOf(LiveAircraft a, GapEstimate gap) {
        return gap.landingAirportIcao() != null ? gap.landingAirportIcao() : destination(a);
    }

    private String destination(LiveAircraft a) {
        return routeService.cached(a.callsign()).map(Route::destinationAirport).orElse(null);
    }
}

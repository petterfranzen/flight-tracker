package com.flighttracker.service.training;

import com.flighttracker.service.coverage.Runway;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.training.TrainingDataRepository.Label;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * Captures training data for a learned landing model: a features row for
 * every coverage gap that matters for landing inference (a "track end"), the
 * moment the gap first reaches LANDED_INFERRED, and a label once we learn
 * what really happened.
 *
 * <p>A gap is captured only once it has lasted {@code capture-delay-seconds}
 * (default 600): on the first tick where {@code now - lastObservedAt} reaches
 * it, whether the gap qualifies is decided once, and the row holds the
 * physics output of that tick. Gaps shorter than a global sweep are the bulk
 * of all gaps and are noise for a landing model, so one that ends before the
 * delay leaves no feature row and no label. If the gap already is
 * LANDED_INFERRED at the capture tick, the inferred columns are set in the
 * same write, so inferred_at is then the capture time.
 *
 * <p>EstimatorAgent drives it from its tick: {@link #onGapEstimate} for each
 * aircraft in a gap, {@link #reconcile} for the rest, then {@link #flush}.
 * Nothing is written while the tick runs. The writes are queued and flushed
 * in one transaction at the end, so the estimator never waits on SQLite per
 * aircraft, and a failure here is logged and never reaches the estimate.
 *
 * <p>The labels. A gap is resolved when the aircraft gets a newer real
 * report: on the ground means LANDED (source adsb_ground, with the airport
 * of the nearest runway threshold within 5 km), otherwise AIRBORNE (source
 * adsb_airborne). An airborne resume after more than
 * {@code max-airborne-label-gap-minutes} (default 30) is ambiguous, because
 * the aircraft may have landed and departed again inside the gap, so it gets
 * no label (absence means unknown). An aircraft that is evicted from the live set first gets
 * no label, because absence means unknown. A confirmation provider reports
 * through {@link #recordConfirmedLanding}.
 *
 * <p>A failed flush keeps its writes: they are put back in front of the next
 * tick's batch, so the in-memory state (which already assumes they happened)
 * stays true. The queue is bounded, see {@link #MAX_PENDING}.
 *
 * <p>Only the gaps still open in memory can be labelled by ADS-B. After a
 * restart the open set is empty, so a gap that ends during downtime stays
 * unlabelled, which is the same as unknown.
 */
@Service
public class TrainingDataService {

    private static final Logger log = LoggerFactory.getLogger(TrainingDataService.class);

    /** A report on the ground this close to a runway threshold counts as landing at its airport. */
    static final double LANDING_AIRPORT_RADIUS_M = 5_000;

    /** Most writes kept for retry. Past it the oldest are dropped. */
    static final int MAX_PENDING = 5_000;
    /** A write that itself throws is dropped after this many attempts (it is not a transient failure). */
    static final int MAX_ATTEMPTS = 5;

    /** One queued write. Every write is idempotent, so a retry after a rolled-back batch is safe. */
    private static final class Write {
        final Runnable op;
        int attempts;

        Write(Runnable op) {
            this.op = op;
        }
    }

    /** A captured gap that has no label yet. */
    private static final class OpenGap {
        final Instant lastObservedAt;
        boolean inferredDone;

        OpenGap(Instant lastObservedAt) {
            this.lastObservedAt = lastObservedAt;
        }
    }

    private final TrainingDataRepository repository;
    private final RunwayIndex runwayIndex;
    private final TransactionTemplate transactionTemplate;
    private final Clock clock;
    private final boolean enabled;
    private final double maxAltitudeM;
    private final Duration captureDelay;
    private final Duration maxAirborneLabelGap;

    private final Map<String, OpenGap> open = new ConcurrentHashMap<>();
    // Gaps that reached the capture delay and did not qualify: icao24 -> last report. Decided once.
    private final Map<String, Instant> rejected = new ConcurrentHashMap<>();
    // Only the estimator thread queues and flushes.
    private List<Write> pending = new ArrayList<>();

    public TrainingDataService(TrainingDataRepository repository,
                               RunwayIndex runwayIndex,
                               TransactionTemplate transactionTemplate,
                               Clock clock,
                               @Value("${flighttracker.training.enabled:true}") boolean enabled,
                               @Value("${flighttracker.training.max-altitude-m:4000}") double maxAltitudeM,
                               @Value("${flighttracker.training.capture-delay-seconds:600}") long captureDelaySeconds,
                               @Value("${flighttracker.training.max-airborne-label-gap-minutes:30}") long maxAirborneLabelGapMinutes) {
        this.repository = repository;
        this.runwayIndex = runwayIndex;
        this.transactionTemplate = transactionTemplate;
        this.clock = clock;
        this.enabled = enabled;
        this.maxAltitudeM = maxAltitudeM;
        this.captureDelay = Duration.ofSeconds(Math.max(0, captureDelaySeconds));
        this.maxAirborneLabelGap = Duration.ofMinutes(Math.max(0, maxAirborneLabelGapMinutes));
    }

    public boolean enabled() {
        return enabled;
    }

    /**
     * One aircraft in a coverage gap was just estimated.
     *
     * @param a           the live aircraft, whose latest report is the last one before the gap
     * @param f           its features, with the physics output
     * @param newSnapshot true when this tick loaded the snapshot (a new track end), false when it was cached
     */
    public void onGapEstimate(LiveAircraft a, TrackEndFeatures f, boolean newSnapshot) {
        if (!enabled) return;
        String icao24 = f.icao24();
        OpenGap cur = open.get(icao24);
        if (cur != null && !cur.lastObservedAt.equals(f.lastObservedAt())) {
            // A different last report means the aircraft reported again after the earlier gap.
            resolve(cur, icao24, a);
            open.remove(icao24);
            cur = null;
        }
        Instant now = clock.instant();
        if (cur == null && !f.lastObservedAt().equals(rejected.get(icao24))
                && !Duration.between(f.lastObservedAt(), now).minus(captureDelay).isNegative()) {
            // The first tick on which the gap has lasted long enough: decide once.
            if (qualifies(f)) {
                rejected.remove(icao24);
                pending.add(new Write(() -> repository.insertFeatures(f, now)));
                cur = new OpenGap(f.lastObservedAt());
                open.put(icao24, cur);
            } else {
                rejected.put(icao24, f.lastObservedAt());
            }
        }
        if (cur != null && !cur.inferredDone && f.state() == TrackState.LANDED_INFERRED) {
            cur.inferredDone = true;
            pending.add(new Write(() -> repository.markInferred(icao24, f.lastObservedAt(),
                    f.state().name(), f.landingProbability(), now)));
        }
    }

    /**
     * Labels the open gaps of aircraft that are no longer in a gap. An
     * aircraft with a newer report resolves its gap, an aircraft that has left
     * the live store (evicted) is forgotten without a label.
     *
     * @param inGap  icao24s that are in a gap this tick (handled by {@link #onGapEstimate})
     * @param lookup the current live aircraft by icao24
     */
    public void reconcile(Set<String> inGap, Function<String, Optional<LiveAircraft>> lookup) {
        if (!enabled) return;
        rejected.keySet().retainAll(inGap);
        if (open.isEmpty()) return;
        for (Map.Entry<String, OpenGap> e : open.entrySet()) {
            if (inGap.contains(e.getKey())) continue;
            Optional<LiveAircraft> now = lookup.apply(e.getKey());
            if (now.isEmpty()) {
                open.remove(e.getKey());
            } else if (now.get().observedAt().isAfter(e.getValue().lastObservedAt)) {
                resolve(e.getValue(), e.getKey(), now.get());
                open.remove(e.getKey());
            }
        }
    }

    /**
     * Writes everything queued in one transaction. Never throws. If the
     * transaction fails (for example SQLITE_BUSY while another writer holds
     * the database) it rolls back as a whole and the writes are queued again
     * in front of the next batch, in their original order. Re-queueing was
     * chosen over rolling back the in-memory state because that state spans
     * several maps and the estimator has already moved on, while every write
     * is idempotent. At most {@link #MAX_PENDING} writes are kept, the oldest
     * are dropped with one warning. A write that itself throws
     * {@link #MAX_ATTEMPTS} times is dropped as unwritable.
     */
    public void flush() {
        if (pending.isEmpty()) return;
        List<Write> batch = pending;
        pending = new ArrayList<>();
        Write[] current = new Write[1];
        try {
            transactionTemplate.executeWithoutResult(status -> {
                for (Write w : batch) {
                    current[0] = w;
                    w.op.run();
                }
                current[0] = null;
            });
        } catch (RuntimeException e) {
            if (current[0] != null) current[0].attempts++;
            log.warn("training data flush of {} writes failed, will retry", batch.size(), e);
            requeue(batch);
        }
    }

    private void requeue(List<Write> failed) {
        List<Write> next = new ArrayList<>(failed.size());
        int unwritable = 0;
        for (Write w : failed) {
            if (w.attempts >= MAX_ATTEMPTS) unwritable++;
            else next.add(w);
        }
        if (unwritable > 0) log.warn("Dropped {} training writes that failed {} times", unwritable, MAX_ATTEMPTS);
        if (next.size() > MAX_PENDING) {
            int drop = next.size() - MAX_PENDING;
            log.warn("Training data write queue over {}, dropped the {} oldest writes", MAX_PENDING, drop);
            next = new ArrayList<>(next.subList(drop, next.size()));
        }
        pending = next;
    }

    /**
     * A confirmation provider says the aircraft landed at {@code onTime}
     * during the gap that began with the report at {@code lastObservedAt}.
     * Writes a LANDED label with the provider as its source. An existing
     * label wins, except that an adsb_airborne one is replaced when the
     * landing is not later than the report that ended the gap: then the
     * aircraft landed inside the gap and took off again before ADS-B
     * returned. A landing after that moment is a later flight and changes
     * nothing. Safe to call from any thread.
     */
    public void recordConfirmedLanding(String icao24, Instant lastObservedAt, String providerId,
                                       Instant onTime, String airportIcao) {
        if (!enabled) return;
        repository.confirmLanded(new Label(icao24, lastObservedAt, Label.LANDED, providerId,
                onTime, null, null, airportIcao), clock.instant());
    }

    private boolean qualifies(TrackEndFeatures f) {
        boolean low = f.altitudeM() != null && f.altitudeM() < maxAltitudeM;
        boolean candidate = f.landingAirportIcao() != null
                || (f.geometry() != null && f.geometry().airportIcao() != null);
        return low || candidate;
    }

    private void resolve(OpenGap gap, String icao24, LiveAircraft resumed) {
        Label label;
        if (resumed.onGround()) {
            String airport = runwayIndex.near(resumed.latitude(), resumed.longitude(), LANDING_AIRPORT_RADIUS_M)
                    .stream().findFirst().map(Runway::airportIcao).orElse(null);
            label = new Label(icao24, gap.lastObservedAt, Label.LANDED, "adsb_ground",
                    resumed.observedAt(), resumed.latitude(), resumed.longitude(), airport);
        } else {
            if (Duration.between(gap.lastObservedAt, resumed.observedAt()).compareTo(maxAirborneLabelGap) > 0) {
                return; // may hide a landing and a new departure: unknown, not AIRBORNE
            }
            label = new Label(icao24, gap.lastObservedAt, Label.AIRBORNE, "adsb_airborne",
                    resumed.observedAt(), resumed.latitude(), resumed.longitude(), null);
        }
        Instant now = clock.instant();
        pending.add(new Write(() -> repository.insertLabel(label, now)));
    }
}

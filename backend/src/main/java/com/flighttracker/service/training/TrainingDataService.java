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
 * <p>EstimatorAgent drives it from its tick: {@link #onGapEstimate} for each
 * aircraft in a gap, {@link #reconcile} for the rest, then {@link #flush}.
 * Nothing is written while the tick runs. The writes are queued and flushed
 * in one transaction at the end, so the estimator never waits on SQLite per
 * aircraft, and a failure here is logged and never reaches the estimate.
 *
 * <p>The labels. A gap is resolved when the aircraft gets a newer real
 * report: on the ground means LANDED (source adsb_ground, with the airport
 * of the nearest runway threshold within 5 km), otherwise AIRBORNE (source
 * adsb_airborne). An aircraft that is evicted from the live set first gets
 * no label, because absence means unknown. A confirmation provider reports
 * through {@link #recordConfirmedLanding}.
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

    private final Map<String, OpenGap> open = new ConcurrentHashMap<>();
    // Only the estimator thread queues and flushes.
    private List<Runnable> pending = new ArrayList<>();

    public TrainingDataService(TrainingDataRepository repository,
                               RunwayIndex runwayIndex,
                               TransactionTemplate transactionTemplate,
                               Clock clock,
                               @Value("${flighttracker.training.enabled:true}") boolean enabled,
                               @Value("${flighttracker.training.max-altitude-m:4000}") double maxAltitudeM) {
        this.repository = repository;
        this.runwayIndex = runwayIndex;
        this.transactionTemplate = transactionTemplate;
        this.clock = clock;
        this.enabled = enabled;
        this.maxAltitudeM = maxAltitudeM;
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
        OpenGap cur = open.get(f.icao24());
        if (newSnapshot && (cur == null || !cur.lastObservedAt.equals(f.lastObservedAt()))) {
            // A different last report means the aircraft reported again after the earlier gap.
            if (cur != null) resolve(cur, f.icao24(), a);
            open.remove(f.icao24());
            if (qualifies(f)) {
                Instant now = clock.instant();
                pending.add(() -> repository.insertFeatures(f, now));
                cur = new OpenGap(f.lastObservedAt());
                open.put(f.icao24(), cur);
            }
        }
        if (cur != null && !cur.inferredDone && cur.lastObservedAt.equals(f.lastObservedAt())
                && f.state() == TrackState.LANDED_INFERRED) {
            cur.inferredDone = true;
            Instant now = clock.instant();
            pending.add(() -> repository.markInferred(f.icao24(), f.lastObservedAt(),
                    f.state().name(), f.landingProbability(), now));
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
        if (!enabled || open.isEmpty()) return;
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

    /** Writes everything queued this tick in one transaction. Never throws. */
    public void flush() {
        if (pending.isEmpty()) return;
        List<Runnable> batch = pending;
        pending = new ArrayList<>();
        try {
            transactionTemplate.executeWithoutResult(status -> {
                for (Runnable op : batch) {
                    try {
                        op.run();
                    } catch (RuntimeException e) {
                        log.warn("training data write failed", e);
                    }
                }
            });
        } catch (RuntimeException e) {
            log.warn("training data flush of {} writes failed", batch.size(), e);
        }
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
            label = new Label(icao24, gap.lastObservedAt, Label.AIRBORNE, "adsb_airborne",
                    resumed.observedAt(), resumed.latitude(), resumed.longitude(), null);
        }
        Instant now = clock.instant();
        pending.add(() -> repository.insertLabel(label, now));
    }
}

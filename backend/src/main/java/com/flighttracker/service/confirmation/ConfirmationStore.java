package com.flighttracker.service.confirmation;

import com.flighttracker.service.live.LiveAircraft;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Comparator;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * Provider confirmations by icao24, in memory like the live state. The rules:
 *
 * <ul>
 *   <li><b>Never downgraded.</b> A confirmation with a gate-in time is not
 *       replaced by one without (unless the new one is a later landing, a
 *       flight ADS-B never showed airborne), and a later estimate cannot touch it: the
 *       status mapping prefers it over whatever the live aircraft says.</li>
 *   <li><b>Survives the ground.</b> Taxiing and parked reports (on ground) leave it alone.</li>
 *   <li><b>Cleared by a new flight.</b> An airborne report later than the
 *       confirmed touchdown (plus a short grace for clock differences between
 *       the provider and ADS-B) means the aircraft took off again.</li>
 *   <li><b>Bounded.</b> Evicted with the aircraft, and at {@code max-entries}
 *       the oldest confirmation goes.</li>
 * </ul>
 */
@Component
public class ConfirmationStore {

    private final Map<String, Confirmation> byIcao24 = new ConcurrentHashMap<>();
    private final Duration newFlightGrace;
    private final int maxEntries;

    public ConfirmationStore(
            @Value("${flighttracker.confirmation.new-flight-grace-seconds:120}") long newFlightGraceSeconds,
            @Value("${flighttracker.confirmation.store-max-entries:5000}") int maxEntries) {
        this.newFlightGrace = Duration.ofSeconds(newFlightGraceSeconds);
        this.maxEntries = maxEntries;
    }

    /**
     * Records a confirmation unless it would downgrade the current one.
     *
     * @return true if the store changed (a new confirmation, or one that adds the gate-in time)
     */
    public boolean put(String icao24, Confirmation candidate) {
        if (candidate.info().rank() == 0) return false;
        boolean[] changed = {false};
        byIcao24.compute(icao24, (k, existing) -> {
            boolean laterLanding = existing != null
                    && candidate.landedAt().isAfter(existing.landedAt().plus(newFlightGrace));
            if (existing != null && !laterLanding && existing.info().rank() >= candidate.info().rank()) {
                return existing; // same or better already known
            }
            changed[0] = true;
            return candidate;
        });
        if (changed[0] && byIcao24.size() > maxEntries) evictOldest();
        return changed[0];
    }

    /** The confirmation that applies to the aircraft as it is now, or empty (none, or a new flight). */
    public Optional<Confirmation> forAircraft(LiveAircraft a) {
        Confirmation c = byIcao24.get(a.icao24());
        if (c == null || isNewFlight(c, a)) return Optional.empty();
        return Optional.of(c);
    }

    /** Drops confirmations of aircraft that are gone from the live set or have started a new flight. */
    public void prune(Function<String, Optional<LiveAircraft>> lookup) {
        byIcao24.entrySet().removeIf(e -> {
            Optional<LiveAircraft> a = lookup.apply(e.getKey());
            return a.isEmpty() || isNewFlight(e.getValue(), a.get());
        });
    }

    public int size() {
        return byIcao24.size();
    }

    private boolean isNewFlight(Confirmation c, LiveAircraft a) {
        return !a.onGround() && a.observedAt().isAfter(c.landedAt().plus(newFlightGrace));
    }

    private void evictOldest() {
        while (byIcao24.size() > maxEntries) {
            byIcao24.entrySet().stream()
                    .min(Comparator.comparing(e -> e.getValue().confirmedAt()))
                    .ifPresent(e -> byIcao24.remove(e.getKey()));
        }
    }
}

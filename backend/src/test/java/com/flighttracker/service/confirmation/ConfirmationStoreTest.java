package com.flighttracker.service.confirmation;

import com.flighttracker.service.live.LiveAircraft;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/** The monotonic rule: never downgraded, survives the ground, cleared by a new flight. */
class ConfirmationStoreTest {

    private static final Instant ON = Instant.parse("2026-10-12T11:00:00Z");
    private static final Instant IN = ON.plusSeconds(480);

    private final ConfirmationStore store = new ConfirmationStore(120, 3);

    private static Confirmation confirmation(Instant on, Instant in) {
        return new Confirmation("mock", new ArrivalInfo(null, null, on, in, in == null ? null : "B14", "2", "ESSA"),
                ON.plusSeconds(60), ON.minusSeconds(300));
    }

    private static LiveAircraft aircraft(String icao24, boolean onGround, Instant observedAt) {
        return new LiveAircraft(1L, icao24, "SAS123", observedAt, 59.6, 17.9, null, null, null, null,
                onGround, "opensky", onGround ? observedAt : null, null, null, null, null);
    }

    @Test
    void aConfirmationIsNeverReplacedByAWeakerOne() {
        assertThat(store.put("abc123", confirmation(ON, IN))).isTrue();

        assertThat(store.put("abc123", confirmation(ON, null))).isFalse();

        assertThat(store.forAircraft(aircraft("abc123", true, IN)).orElseThrow().gateAt()).isEqualTo(IN);
    }

    @Test
    void landedIsUpgradedToAtGate() {
        assertThat(store.put("abc123", confirmation(ON, null))).isTrue();
        assertThat(store.put("abc123", confirmation(ON, null))).isFalse();

        assertThat(store.put("abc123", confirmation(ON, IN))).isTrue();
        assertThat(store.forAircraft(aircraft("abc123", true, IN)).orElseThrow().gateAt()).isEqualTo(IN);
    }

    @Test
    void aReportWithNothingToConfirm_isIgnored() {
        assertThat(store.put("abc123", confirmation(null, null))).isFalse();
        assertThat(store.size()).isZero();
    }

    @Test
    void survivesLaterOnGroundReports_whileTaxiing() {
        store.put("abc123", confirmation(ON, null));

        assertThat(store.forAircraft(aircraft("abc123", true, ON.plusSeconds(30)))).isPresent();
        assertThat(store.forAircraft(aircraft("abc123", true, ON.plusSeconds(3600)))).isPresent();
    }

    @Test
    void survivesTheLastAirborneReportBeforeTouchdown_andClockSkewWithinTheGrace() {
        store.put("abc123", confirmation(ON, null));

        assertThat(store.forAircraft(aircraft("abc123", false, ON.minusSeconds(40)))).isPresent();
        assertThat(store.forAircraft(aircraft("abc123", false, ON.plusSeconds(100)))).isPresent();
    }

    @Test
    void isClearedByAnAirborneReportAfterTheLanding_aNewFlight() {
        store.put("abc123", confirmation(ON, IN));

        assertThat(store.forAircraft(aircraft("abc123", false, IN.plusSeconds(1800)))).isEmpty();
    }

    @Test
    void pruneDropsNewFlights_andAircraftThatAreGone() {
        store.put("gone", confirmation(ON, null));
        store.put("flying", confirmation(ON, null));
        store.put("parked", confirmation(ON, null));
        Map<String, LiveAircraft> live = Map.of(
                "flying", aircraft("flying", false, ON.plusSeconds(3600)),
                "parked", aircraft("parked", true, ON.plusSeconds(3600)));

        store.prune(icao24 -> Optional.ofNullable(live.get(icao24)));

        assertThat(store.size()).isEqualTo(1);
        assertThat(store.forAircraft(aircraft("parked", true, ON))).isPresent();
    }

    @Test
    void aLaterLandingReplacesAStaleConfirmation_ofAFlightAdsbNeverShowed() {
        store.put("abc123", confirmation(ON, IN));
        Instant later = ON.plusSeconds(4 * 3600);

        assertThat(store.put("abc123", confirmation(later, null))).isTrue();
        assertThat(store.forAircraft(aircraft("abc123", true, later)).orElseThrow().landedAt()).isEqualTo(later);
    }

    @Test
    void isBounded_theOldestConfirmationGoesFirst() {
        for (int i = 0; i < 5; i++) {
            Confirmation c = new Confirmation("mock", confirmation(ON, null).info(), ON.plusSeconds(i), ON);
            store.put("a" + i, c);
        }

        assertThat(store.size()).isEqualTo(3);
        assertThat(store.forAircraft(aircraft("a0", true, ON))).isEmpty();
        assertThat(store.forAircraft(aircraft("a4", true, ON))).isPresent();
    }
}

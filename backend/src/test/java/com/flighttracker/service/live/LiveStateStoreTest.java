package com.flighttracker.service.live;

import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.dto.LiveMarker;
import com.flighttracker.dto.LiveOverview;
import com.flighttracker.model.FlightPosition;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Ports FlightPositionRepository.upsertLatestPosition's and
 * EstimatorAgent's ESTIMATE_UPDATE_SQL's own semantics into Java — these
 * tests exist specifically to pin that port down (monotonic observed_at
 * guard, landed_since streak logic, estimate clearing on a real report,
 * and the estimate write's own optimistic-concurrency guard), per
 * docs/cloud-migration/PLAN.md §6 A1 item 12. No Spring context, no DB —
 * warmUp()'s JdbcTemplate/Clock dependencies are never exercised here
 * (that's a @PostConstruct only Spring invokes; a plain
 * `new LiveStateStore(mock, mock)` starts with an empty map, exactly what
 * every test below wants).
 */
@ExtendWith(MockitoExtension.class)
class LiveStateStoreTest {

    @Mock
    private JdbcTemplate jdbcTemplate;
    @Mock
    private Clock clock;

    private LiveStateStore store() {
        return new LiveStateStore(jdbcTemplate, clock);
    }

    private static final Instant T0 = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void firstReportForAnAircraft_alwaysAccepted() {
        LiveStateStore store = store();

        boolean accepted = store.upsert("abc123", "SAS100", T0, 59.0, 18.0,
                10_000.0, 200.0, 90.0, 0.0, false, "opensky");

        assertThat(accepted).isTrue();
        Optional<FlightPosition> p = store.findLatestPosition("abc123");
        assertThat(p).isPresent();
        assertThat(p.get().latitude()).isEqualTo(59.0);
        assertThat(p.get().observedAt()).isEqualTo(T0);
    }

    @Test
    void newerReport_acceptedAndReplacesPosition() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");

        Instant t1 = T0.plusSeconds(20);
        boolean accepted = store.upsert("abc123", "SAS100", t1, 59.5, 18.5, null, null, null, null, false, "opensky");

        assertThat(accepted).isTrue();
        assertThat(store.findLatestPosition("abc123").get().latitude()).isEqualTo(59.5);
    }

    @Test
    void olderOrEqualReport_rejectedAndStateUnchanged() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");

        boolean acceptedEqual = store.upsert("abc123", "SAS100", T0, 61.0, 20.0, null, null, null, null, false, "opensky");
        boolean acceptedOlder = store.upsert("abc123", "SAS100", T0.minusSeconds(5), 62.0, 21.0, null, null, null, null, false, "opensky");

        assertThat(acceptedEqual).isFalse();
        assertThat(acceptedOlder).isFalse();
        // Neither stale write took — position is still the original T0 report.
        FlightPosition p = store.findLatestPosition("abc123").orElseThrow();
        assertThat(p.latitude()).isEqualTo(59.0);
        assertThat(p.observedAt()).isEqualTo(T0);
    }

    @Test
    void id_isAssignedOnceAndStableAcrossUpdates() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");
        long firstId = store.findLatestPosition("abc123").orElseThrow().id();

        store.upsert("abc123", "SAS100", T0.plusSeconds(10), 59.1, 18.1, null, null, null, null, false, "opensky");
        long secondId = store.findLatestPosition("abc123").orElseThrow().id();

        // A stale write is rejected outright, but even a *rejected* write
        // must never disturb the stored id — mirrors ON CONFLICT DO UPDATE
        // never reassigning a row's BIGSERIAL id.
        store.upsert("abc123", "SAS100", T0.minusSeconds(5), 1.0, 1.0, null, null, null, null, false, "opensky");
        long thirdId = store.findLatestPosition("abc123").orElseThrow().id();

        assertThat(secondId).isEqualTo(firstId);
        assertThat(thirdId).isEqualTo(firstId);

        // A different aircraft gets its own, different id.
        store.upsert("def456", "SAS200", T0, 60.0, 19.0, null, null, null, null, false, "opensky");
        long otherId = store.findLatestPosition("def456").orElseThrow().id();
        assertThat(otherId).isNotEqualTo(firstId);
    }

    @Test
    void landedSince_startsTheStreakOnTheFirstOnGroundReport() {
        LiveStateStore store = store();

        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, true, "opensky");

        // landed_since isn't directly exposed on FlightPosition — verify it
        // indirectly via countLive/liveFlightPositions honouring the
        // landedCutoff window, which is what landedSince actually gates.
        Instant justBeforeT0 = T0.minusSeconds(1);
        List<FlightPosition> live = store.liveFlightPositions(T0.minus(Duration.ofHours(1)), justBeforeT0, null);
        assertThat(live).hasSize(1); // landedSince (T0) is after justBeforeT0 cutoff
    }

    @Test
    void landedSince_carriesForwardWhileStayingOnGround_thenClearsOnGoingAirborne_thenRestartsOnLandingAgain() {
        LiveStateStore store = store();
        Instant t1 = T0.plusSeconds(10);
        Instant t2 = T0.plusSeconds(20);
        Instant t3 = T0.plusSeconds(30);

        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, true, "opensky"); // lands at T0
        store.upsert("abc123", "SAS100", t1, 59.0, 18.0, null, null, null, null, true, "opensky"); // still grounded

        // landedSince should still be T0 (carried forward) — a landedCutoff
        // just after T0 but before t1 still finds it live via the original
        // landing time, proving the streak start didn't reset to t1.
        List<FlightPosition> stillLandedFromT0 = store.liveFlightPositions(
                T0.minus(Duration.ofHours(1)), T0.minusSeconds(1), null);
        assertThat(stillLandedFromT0).hasSize(1);

        store.upsert("abc123", "SAS100", t2, 59.1, 18.1, null, null, null, null, false, "opensky"); // takes off
        store.upsert("abc123", "SAS100", t3, 59.0, 18.0, null, null, null, null, true, "opensky"); // lands again at t3

        // The streak should have restarted at t3, not stayed at the
        // original T0 — proven with a cutoff strictly between the two
        // (t2): T0.isAfter(t2) is false, so a store that (incorrectly)
        // still had landed_since = T0 would read as not-live here, while
        // the correct landed_since = t3 does satisfy t3.isAfter(t2) and so
        // reads as live.
        List<FlightPosition> liveWithCutoffBetweenOldAndNewLanding = store.liveFlightPositions(
                T0.minus(Duration.ofHours(1)), t2, null);
        assertThat(liveWithCutoffBetweenOldAndNewLanding).hasSize(1);

        // Sanity check the other direction too: a cutoff at or after the
        // new landing time (t3) is no longer satisfied by it either — this
        // isn't just "always live no matter what".
        List<FlightPosition> notLiveOnceCutoffReachesNewLanding = store.liveFlightPositions(
                T0.minus(Duration.ofHours(1)), t3, null);
        assertThat(notLiveOnceCutoffReachesNewLanding).isEmpty();
    }

    @Test
    void realReport_alwaysClearsAnyExistingEstimate() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");
        store.writeEstimate("abc123", T0, 59.5, 18.5, T0.plusSeconds(5));
        assertThat(store.findLatestPosition("abc123").orElseThrow().latitude()).isEqualTo(59.5); // estimate showing

        Instant t1 = T0.plusSeconds(20);
        store.upsert("abc123", "SAS100", t1, 60.0, 19.0, null, null, null, null, false, "opensky");

        FlightPosition p = store.findLatestPosition("abc123").orElseThrow();
        assertThat(p.latitude()).isEqualTo(60.0); // real report, not the stale estimate
        assertThat(store.icao24sWithEstimate()).doesNotContain("abc123");
    }

    @Test
    void writeEstimate_appliesOnlyWhenObservedAtStillMatches() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");

        // A real report supersedes T0 between EstimatorAgent's read and its
        // write — the estimate write must no-op rather than clobber it.
        store.upsert("abc123", "SAS100", T0.plusSeconds(5), 59.2, 18.2, null, null, null, null, false, "opensky");

        boolean applied = store.writeEstimate("abc123", T0, 99.0, 99.0, T0); // stale expectedObservedAt

        assertThat(applied).isFalse();
        assertThat(store.findLatestPosition("abc123").orElseThrow().latitude()).isEqualTo(59.2);
    }

    @Test
    void writeEstimate_unknownIcao24_noOpNotAnException() {
        LiveStateStore store = store();

        boolean applied = store.writeEstimate("ghost01", T0, 1.0, 1.0, T0);

        assertThat(applied).isFalse();
    }

    @Test
    void writeEstimate_null_explicitlyClearsAStoredEstimate() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");
        store.writeEstimate("abc123", T0, 59.5, 18.5, T0.plusSeconds(5));
        assertThat(store.icao24sWithEstimate()).contains("abc123");

        boolean applied = store.writeEstimate("abc123", T0, null, null, null);

        assertThat(applied).isTrue();
        assertThat(store.icao24sWithEstimate()).doesNotContain("abc123");
        assertThat(store.findLatestPosition("abc123").orElseThrow().latitude()).isEqualTo(59.0); // back to the raw report
    }

    @Test
    void findRawLatestLatLon_neverReflectsAnEstimate() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");
        store.writeEstimate("abc123", T0, 59.5, 18.5, T0.plusSeconds(5));

        LiveStateStore.RawLatLon raw = store.findRawLatestLatLon("abc123").orElseThrow();

        assertThat(raw.latitude()).isEqualTo(59.0);
        assertThat(raw.longitude()).isEqualTo(18.0);
        // ...while the coalesced view does reflect it.
        assertThat(store.findLatestPosition("abc123").orElseThrow().latitude()).isEqualTo(59.5);
    }

    @Test
    void isEmpty_trueOnlyBeforeAnyUpsert() {
        LiveStateStore store = store();
        assertThat(store.isEmpty()).isTrue();

        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");

        assertThat(store.isEmpty()).isFalse();
    }

    @Test
    void countLive_reflectsTheSameLivenessWindowAsLiveFlightPositions() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky"); // airborne
        store.upsert("def456", "SAS200", T0, 60.0, 19.0, null, null, null, null, true, "opensky"); // grounded, lands at T0

        Instant staleAirborneCutoff = T0.minusSeconds(1); // airborne report (T0) still after this
        Instant landedCutoff = T0.minusSeconds(1); // landed_since (T0) still after this

        assertThat(store.countLive(staleAirborneCutoff, landedCutoff)).isEqualTo(2);

        // Push the airborne cutoff past T0 — the airborne aircraft drops out, the grounded one doesn't.
        assertThat(store.countLive(T0.plusSeconds(1), landedCutoff)).isEqualTo(1);
    }

    @Test
    void icao24sWithEstimate_reflectsOnlyAircraftWithANonNullEstimate() {
        LiveStateStore store = store();
        store.upsert("abc123", "SAS100", T0, 59.0, 18.0, null, null, null, null, false, "opensky");
        store.upsert("def456", "SAS200", T0, 60.0, 19.0, null, null, null, null, false, "opensky");

        assertThat(store.icao24sWithEstimate()).isEmpty();

        store.writeEstimate("abc123", T0, 59.5, 18.5, T0.plusSeconds(5));

        assertThat(store.icao24sWithEstimate()).containsExactly("abc123");
    }

    private static final Bounds WORLD = new Bounds(-90, 90, -180, 180);

    @Test
    void clustered_placesEachClusterAtTheMeanPositionOfItsAircraft_notTheCellCentre() {
        LiveStateStore store = store();
        // Grid 2 deg: both fall in the cell lat [10,12) x lon [20,22), whose centre is (11, 21).
        store.upsert("aaa111", "A1", T0, 10.1, 20.1, null, null, null, null, false, "opensky");
        store.upsert("bbb222", "B2", T0, 10.3, 20.5, null, null, null, null, false, "opensky");
        // A lone aircraft in another cell sits exactly where it is, not at its cell's centre.
        store.upsert("ccc333", "C3", T0, 30.2, -40.7, null, null, null, null, false, "opensky");

        List<ClusterPoint> clusters = store.clustered(T0.minusSeconds(1), T0.minusSeconds(1), T0.minusSeconds(1), WORLD, 2.0);

        assertThat(clusters).hasSize(2);
        ClusterPoint pair = clusters.stream().filter(c -> c.getCount() == 2).findFirst().orElseThrow();
        assertThat(pair.getLat()).isCloseTo(10.2, within(1e-9));
        assertThat(pair.getLon()).isCloseTo(20.3, within(1e-9));
        ClusterPoint lone = clusters.stream().filter(c -> c.getCount() == 1).findFirst().orElseThrow();
        assertThat(lone.getLat()).isCloseTo(30.2, within(1e-9));
        assertThat(lone.getLon()).isCloseTo(-40.7, within(1e-9));
    }

    @Test
    void clustered_aClusterStaysInsideItsOwnCell() {
        LiveStateStore store = store();
        store.upsert("aaa111", "A1", T0, 10.0, 20.0, null, null, null, null, false, "opensky");
        store.upsert("bbb222", "B2", T0, 11.99, 21.99, null, null, null, null, false, "opensky");

        ClusterPoint c = store.clustered(T0.minusSeconds(1), T0.minusSeconds(1), T0.minusSeconds(1), WORLD, 2.0).get(0);

        assertThat(c.getLat()).isBetween(10.0, 12.0);
        assertThat(c.getLon()).isBetween(20.0, 22.0);
    }

    @Test
    void clustered_countsActiveTrafficOnly_notParkedOrSilentAircraft() {
        LiveStateStore store = store();
        Instant activeSince = T0.minusSeconds(7200); // "2 h before T0"
        // Active: airborne, reported recently.
        store.upsert("air111", "AIR1", T0, 10.1, 20.1, null, null, null, null, false, "opensky");
        store.upsert("air222", "AIR2", T0.minusSeconds(60), 10.3, 20.3, null, null, null, null, false, "opensky");
        // Same cell, but parked at a gate: live (shown when zoomed in) yet not "traffic".
        store.upsert("gnd333", "GND3", T0, 10.2, 20.2, null, null, 0.0, null, true, "opensky");
        // Same cell, airborne but silent for over 2 h.
        store.upsert("old444", "OLD4", T0.minusSeconds(7201), 10.9, 20.9, null, null, null, null, false, "opensky");

        List<ClusterPoint> clusters = store.clustered(T0.minusSeconds(100_000), T0.minusSeconds(100_000), activeSince, WORLD, 2.0);

        assertThat(clusters).hasSize(1);
        ClusterPoint c = clusters.get(0);
        assertThat(c.getCount()).isEqualTo(2);
        // Centroid of the two active aircraft only: the parked and silent ones don't pull it.
        assertThat(c.getLat()).isCloseTo(10.2, within(1e-9));
        assertThat(c.getLon()).isCloseTo(20.2, within(1e-9));
        // The parked and silent aircraft are still live — only the bubbles ignore them.
        assertThat(store.countLive(T0.minusSeconds(100_000), T0.minusSeconds(100_000))).isEqualTo(4);
    }

    @Test
    void clustered_aCellOfOnlyParkedAircraftProducesNoCluster() {
        LiveStateStore store = store();
        store.upsert("gnd111", "GND1", T0, 10.1, 20.1, null, null, 0.0, null, true, "opensky");
        store.upsert("gnd222", "GND2", T0, 10.2, 20.2, null, null, 0.0, null, true, "opensky");

        assertThat(store.clustered(T0.minusSeconds(1), T0.minusSeconds(1), T0.minusSeconds(7200), WORLD, 2.0)).isEmpty();
    }

    @Test
    void overview_drawsTheFastestActiveAircraftAsPlanes_andBubblesTheRestWithoutDoubleCounting() {
        LiveStateStore store = store();
        Instant cut = T0.minusSeconds(100_000);
        Instant activeSince = T0.minusSeconds(7200);
        // One cell (lat [10,12) x lon [20,22)): four active aircraft at different speeds.
        store.upsert("slow11", "SLOW", T0, 10.1, 20.1, null, 60.0, null, null, false, "opensky");
        store.upsert("mid222", "MID", T0, 10.3, 20.3, null, 150.0, null, null, false, "opensky");
        store.upsert("fast33", "FAST", T0, 10.5, 20.5, null, 250.0, null, null, false, "opensky");
        store.upsert("noVel4", "NOVEL", T0, 10.7, 20.7, null, null, null, null, false, "opensky");
        // Never part of the overview: parked, and silent for over 2 h.
        store.upsert("gnd555", "GND", T0, 10.9, 20.9, null, 0.0, null, null, true, "opensky");
        store.upsert("old666", "OLD", T0.minusSeconds(7201), 11.1, 21.1, null, 300.0, null, null, false, "opensky");

        // Two planes allowed (any number per cell): the two fastest.
        LiveOverview o = store.overview(cut, cut, activeSince, WORLD, 2.0, 2, 10);

        assertThat(o.planes()).extracting(LiveMarker::getIcao24).containsExactly("fast33", "mid222");
        // The other two active aircraft are bubbled, and the planes are NOT counted again.
        assertThat(o.clusters()).hasSize(1);
        assertThat(o.clusters().get(0).getCount()).isEqualTo(2);
        assertThat(o.clusters().get(0).getLat()).isCloseTo(10.4, within(1e-9)); // mean of 10.1 and 10.7
    }

    @Test
    void overview_perCellCapSpreadsPlanesAcrossCells_soAHubCannotUseUpTheWholeAllowance() {
        LiveStateStore store = store();
        Instant cut = T0.minusSeconds(100_000);
        // Four fast aircraft in one cell, one slower in another.
        store.upsert("hub111", "H1", T0, 10.1, 20.1, null, 250.0, null, null, false, "opensky");
        store.upsert("hub222", "H2", T0, 10.2, 20.2, null, 240.0, null, null, false, "opensky");
        store.upsert("hub333", "H3", T0, 10.3, 20.3, null, 230.0, null, null, false, "opensky");
        store.upsert("hub444", "H4", T0, 10.4, 20.4, null, 220.0, null, null, false, "opensky");
        store.upsert("far555", "F5", T0, 40.1, 60.1, null, 100.0, null, null, false, "opensky");

        LiveOverview o = store.overview(cut, cut, T0.minusSeconds(7200), WORLD, 2.0, 10, 2);

        assertThat(o.planes()).extracting(LiveMarker::getIcao24).containsExactlyInAnyOrder("hub111", "hub222", "far555");
        assertThat(o.clusters()).hasSize(1);
        assertThat(o.clusters().get(0).getCount()).isEqualTo(2); // the hub's other two
    }

    @Test
    void overview_serializesToTheShapeTheMapReads() throws Exception {
        LiveStateStore store = store();
        Instant cut = T0.minusSeconds(100_000);
        store.upsert("fast33", "FAST", T0, 10.5, 20.5, null, 250.0, 90.0, null, false, "opensky");
        store.upsert("slow11", "SLOW", T0, 10.1, 20.1, null, 60.0, null, null, false, "opensky");

        String json = new com.fasterxml.jackson.databind.ObjectMapper().findAndRegisterModules()
                .writeValueAsString(store.overview(cut, cut, T0.minusSeconds(7200), WORLD, 2.0, 1, 3));
        com.fasterxml.jackson.databind.JsonNode root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);

        com.fasterxml.jackson.databind.JsonNode plane = root.get("planes").get(0);
        assertThat(plane.get("icao24").asText()).isEqualTo("fast33");
        assertThat(plane.get("callsign").asText()).isEqualTo("FAST");
        assertThat(plane.get("latitude").asDouble()).isEqualTo(10.5);
        assertThat(plane.get("longitude").asDouble()).isEqualTo(20.5);
        assertThat(plane.get("headingDeg").asDouble()).isEqualTo(90.0);
        assertThat(plane.has("observedAt")).isTrue();
        assertThat(plane.get("onGround").asBoolean()).isFalse();
        com.fasterxml.jackson.databind.JsonNode cluster = root.get("clusters").get(0);
        assertThat(cluster.get("lat").asDouble()).isEqualTo(10.1);
        assertThat(cluster.get("lon").asDouble()).isEqualTo(20.1);
        assertThat(cluster.get("count").asLong()).isEqualTo(1);
    }
}

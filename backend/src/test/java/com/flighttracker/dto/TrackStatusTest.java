package com.flighttracker.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.flighttracker.service.confirmation.ArrivalInfo;
import com.flighttracker.service.confirmation.Confirmation;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.live.LiveAircraft;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.stream.StreamSupport;

import static org.assertj.core.api.Assertions.assertThat;

/** The mapping from LiveAircraft to the /status contract, and the JSON it serialises to. */
class TrackStatusTest {

    private static final Instant SEEN = Instant.parse("2026-10-12T11:00:00Z");
    private static final Instant AT = Instant.parse("2026-10-12T11:02:00Z");
    private static final Instant TOUCHDOWN = Instant.parse("2026-10-12T11:03:10Z");
    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules()
            .configure(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);

    private static LiveAircraft aircraft(boolean onGround, GapEstimate gap) {
        return new LiveAircraft(1L, "4ca123", "SAS123", SEEN, 59.60, 17.90,
                900.0, 70.0, 193.0, -3.0, onGround, "opensky", onGround ? SEEN : null,
                gap == null ? null : gap.estLat(), gap == null ? null : gap.estLon(), gap == null ? null : gap.at(), gap);
    }

    private static GapEstimate gap(TrackState state, String airport, String runway) {
        return new GapEstimate(state, 0.4, 0.85, 59.65, 17.93, 1800, AT,
                airport, runway, airport == null ? null : TOUCHDOWN, null, "physics-v1");
    }

    private static List<String> fieldNames(JsonNode node) {
        Iterator<String> it = node.fieldNames();
        return StreamSupport.stream(((Iterable<String>) () -> it).spliterator(), false).toList();
    }

    @Test
    void liveAircraft_isLive_observed_withNoConfidenceEstimateOrLanding() throws Exception {
        TrackStatus s = TrackStatus.from(aircraft(false, null));

        JsonNode json = MAPPER.readTree(MAPPER.writeValueAsString(s));
        assertThat(json.get("state").asText()).isEqualTo("LIVE");
        assertThat(json.get("confidence").isNull()).isTrue();
        assertThat(json.get("source").asText()).isEqualTo("adsb");
        assertThat(json.get("sourceKind").asText()).isEqualTo("observed");
        assertThat(json.get("estimate").isNull()).isTrue();
        assertThat(json.get("landing").isNull()).isTrue();
    }

    @Test
    void onGround_isOnGround_withFullConfidence() {
        TrackStatus s = TrackStatus.from(aircraft(true, null));

        assertThat(s.state()).isEqualTo(TrackState.ON_GROUND);
        assertThat(s.confidence()).isEqualTo(1.0);
        assertThat(s.source()).isEqualTo("adsb");
        assertThat(s.sourceKind()).isEqualTo("observed");
        assertThat(s.estimate()).isNull();
        assertThat(s.landing()).isNull();
    }

    @Test
    void coverageLost_carriesTheGapEstimate_andTheLastRealReportNotTheDisplayPosition() throws Exception {
        TrackStatus s = TrackStatus.from(aircraft(false, gap(TrackState.COVERAGE_LOST, "ESSA", "19R")));

        JsonNode json = MAPPER.readTree(MAPPER.writeValueAsString(s));
        assertThat(fieldNames(json)).containsExactly("icao24", "state", "confidence", "source", "sourceKind",
                "lastSeenAt", "lastSeenLat", "lastSeenLon", "estimate", "landing", "gate", "terminal", "confirmedAt");
        assertThat(json.get("icao24").asText()).isEqualTo("4ca123");
        assertThat(json.get("state").asText()).isEqualTo("COVERAGE_LOST");
        assertThat(json.get("confidence").asDouble()).isEqualTo(0.85);
        assertThat(json.get("source").asText()).isEqualTo("physics");
        assertThat(json.get("sourceKind").asText()).isEqualTo("inferred");
        assertThat(json.get("lastSeenAt").asText()).isEqualTo("2026-10-12T11:00:00Z");
        assertThat(json.get("lastSeenLat").asDouble()).isEqualTo(59.60);
        assertThat(json.get("lastSeenLon").asDouble()).isEqualTo(17.90);

        JsonNode est = json.get("estimate");
        assertThat(fieldNames(est)).containsExactly("lat", "lon", "radiusM", "at", "landingProbability");
        assertThat(est.get("lat").asDouble()).isEqualTo(59.65);
        assertThat(est.get("lon").asDouble()).isEqualTo(17.93);
        assertThat(est.get("radiusM").asDouble()).isEqualTo(1800);
        assertThat(est.get("at").asText()).isEqualTo("2026-10-12T11:02:00Z");
        assertThat(est.get("landingProbability").asDouble()).isEqualTo(0.4);

        JsonNode landing = json.get("landing");
        assertThat(fieldNames(landing)).containsExactly("airportIcao", "runway", "touchdownAt");
        assertThat(landing.get("airportIcao").asText()).isEqualTo("ESSA");
        assertThat(landing.get("runway").asText()).isEqualTo("19R");
        assertThat(landing.get("touchdownAt").asText()).isEqualTo("2026-10-12T11:03:10Z");

        // present, and null, until a confirmation provider fills them
        assertThat(json.has("gate")).isTrue();
        assertThat(json.get("gate").isNull()).isTrue();
        assertThat(json.get("terminal").isNull()).isTrue();
        assertThat(json.get("confirmedAt").isNull()).isTrue();
    }

    @Test
    void landedInferred_keepsTheGapState() {
        TrackStatus s = TrackStatus.from(aircraft(false, gap(TrackState.LANDED_INFERRED, "ESSA", "19R")));

        assertThat(s.state()).isEqualTo(TrackState.LANDED_INFERRED);
        assertThat(s.sourceKind()).isEqualTo("inferred");
        assertThat(s.landing().touchdownAt()).isEqualTo(TOUCHDOWN);
    }

    @Test
    void noLandingCandidate_meansNoLanding_andARunwayMayBeNull() {
        assertThat(TrackStatus.from(aircraft(false, gap(TrackState.COVERAGE_LOST, null, null))).landing()).isNull();

        TrackStatus noRunway = TrackStatus.from(aircraft(false, gap(TrackState.COVERAGE_LOST, "ESSA", null)));
        assertThat(noRunway.landing().airportIcao()).isEqualTo("ESSA");
        assertThat(noRunway.landing().runway()).isNull();
    }

    private static final Instant ON = Instant.parse("2026-10-12T11:03:30Z");
    private static final Instant IN = Instant.parse("2026-10-12T11:11:30Z");

    private static Optional<Confirmation> confirmation(Instant on, Instant in, String gate) {
        return Optional.of(new Confirmation("mock", new ArrivalInfo(null, null, on, in, gate, gate == null ? null : "2", "ESSA"),
                Instant.parse("2026-10-12T11:12:00Z"), SEEN));
    }

    @Test
    void confirmedLanding_withoutGateIn_isLandedConfirmed_andReplacesTheEstimate() throws Exception {
        TrackStatus s = TrackStatus.from(aircraft(false, gap(TrackState.LANDED_INFERRED, "ESSA", "19R")), confirmation(ON, null, null));

        assertThat(s.state()).isEqualTo(TrackState.LANDED_CONFIRMED);
        assertThat(s.confidence()).isEqualTo(1.0);
        assertThat(s.source()).isEqualTo("mock");
        assertThat(s.sourceKind()).isEqualTo("confirmed");
        assertThat(s.estimate()).isNull();
        assertThat(s.landing().airportIcao()).isEqualTo("ESSA");
        assertThat(s.landing().runway()).isEqualTo("19R");
        assertThat(s.landing().touchdownAt()).isEqualTo(ON);
        assertThat(s.confirmedAt()).isEqualTo(ON);
        assertThat(s.gate()).isNull();
        assertThat(s.lastSeenAt()).isEqualTo(SEEN);
    }

    @Test
    void confirmedGateIn_isAtGate_withGateTerminalAndConfirmedAtTheGateTime() throws Exception {
        TrackStatus s = TrackStatus.from(aircraft(true, null), confirmation(ON, IN, "B14"));

        assertThat(s.state()).isEqualTo(TrackState.AT_GATE);
        assertThat(s.gate()).isEqualTo("B14");
        assertThat(s.terminal()).isEqualTo("2");
        assertThat(s.confirmedAt()).isEqualTo(IN);
        assertThat(s.landing().airportIcao()).isEqualTo("ESSA");
        assertThat(s.landing().runway()).isNull();

        JsonNode json = MAPPER.readTree(MAPPER.writeValueAsString(s));
        assertThat(fieldNames(json)).containsExactly("icao24", "state", "confidence", "source", "sourceKind",
                "lastSeenAt", "lastSeenLat", "lastSeenLon", "estimate", "landing", "gate", "terminal", "confirmedAt");
        assertThat(json.get("state").asText()).isEqualTo("AT_GATE");
        assertThat(json.get("sourceKind").asText()).isEqualTo("confirmed");
        assertThat(json.get("estimate").isNull()).isTrue();
        assertThat(json.get("confirmedAt").asText()).isEqualTo("2026-10-12T11:11:30Z");
    }

    @Test
    void gateInWithoutTouchdownTime_stillConfirms_andAGatelessGateInHasNullGate() {
        TrackStatus s = TrackStatus.from(aircraft(true, null), confirmation(null, IN, null));

        assertThat(s.state()).isEqualTo(TrackState.AT_GATE);
        assertThat(s.gate()).isNull();
        assertThat(s.confirmedAt()).isEqualTo(IN);
    }

    @Test
    void noConfirmation_isTheUnconfirmedStatus() {
        LiveAircraft a = aircraft(false, gap(TrackState.COVERAGE_LOST, "ESSA", "19R"));

        assertThat(TrackStatus.from(a, Optional.empty())).isEqualTo(TrackStatus.from(a));
    }
}

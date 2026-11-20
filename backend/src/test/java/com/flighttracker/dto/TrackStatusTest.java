package com.flighttracker.dto;

import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.cfg.DateTimeFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.flighttracker.service.confirmation.ArrivalInfo;
import com.flighttracker.service.confirmation.Confirmation;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.live.LiveAircraft;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/** The mapping from LiveAircraft to the /status contract, and the JSON it serialises to. */
class TrackStatusTest {

    private static final Instant SEEN = Instant.parse("2026-10-12T11:00:00Z");
    private static final Instant AT = Instant.parse("2026-10-12T11:02:00Z");
    private static final Instant TOUCHDOWN = Instant.parse("2026-10-12T11:03:10Z");
    private static final ObjectMapper MAPPER = JsonMapper.builder().disable(DateTimeFeature.WRITE_DATES_AS_TIMESTAMPS).build();

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
        return List.copyOf(node.propertyNames());
    }

    /** The named fields of {@code node}, each read with {@code read}, in order. */
    private static <T> List<T> values(JsonNode node, Function<JsonNode, T> read, String... fields) {
        return Arrays.stream(fields).map(node::get).map(read).toList();
    }

    private static JsonNode json(TrackStatus s) {
        return MAPPER.readTree(MAPPER.writeValueAsString(s));
    }

    private static final List<String> STATUS_FIELDS = List.of("icao24", "state", "confidence", "source", "sourceKind",
            "lastSeenAt", "lastSeenLat", "lastSeenLon", "estimate", "landing", "gate", "terminal", "confirmedAt");

    @Test
    void liveAircraft_isLive_observed_withNoConfidenceEstimateOrLanding() throws Exception {
        TrackStatus s = TrackStatus.from(aircraft(false, null));

        JsonNode json = json(s);
        assertThat(values(json, JsonNode::asText, "state", "source", "sourceKind"))
                .containsExactly("LIVE", "adsb", "observed");
        assertThat(values(json, JsonNode::isNull, "confidence", "estimate", "landing"))
                .containsExactly(true, true, true);
    }

    @Test
    void onGround_isOnGround_withFullConfidence() {
        TrackStatus s = TrackStatus.from(aircraft(true, null));

        assertThat(s)
                .extracting(TrackStatus::state, TrackStatus::confidence, TrackStatus::source, TrackStatus::sourceKind,
                        TrackStatus::estimate, TrackStatus::landing)
                .containsExactly(TrackState.ON_GROUND, 1.0, "adsb", "observed", null, null);
    }

    @Test
    void coverageLost_carriesTheGapEstimate_andTheLastRealReportNotTheDisplayPosition() throws Exception {
        TrackStatus s = TrackStatus.from(aircraft(false, gap(TrackState.COVERAGE_LOST, "ESSA", "19R")));

        JsonNode json = json(s);
        assertThat(fieldNames(json)).containsExactlyElementsOf(STATUS_FIELDS);
        assertThat(values(json, JsonNode::asText, "icao24", "state", "source", "sourceKind", "lastSeenAt"))
                .containsExactly("4ca123", "COVERAGE_LOST", "physics", "inferred", "2026-10-12T11:00:00Z");
        assertThat(values(json, JsonNode::asDouble, "confidence", "lastSeenLat", "lastSeenLon"))
                .containsExactly(0.85, 59.60, 17.90);

        JsonNode est = json.get("estimate");
        assertThat(fieldNames(est)).containsExactly("lat", "lon", "radiusM", "at", "landingProbability");
        assertThat(values(est, JsonNode::asDouble, "lat", "lon", "radiusM", "landingProbability"))
                .containsExactly(59.65, 17.93, 1800.0, 0.4);
        assertThat(est.get("at").asText()).isEqualTo("2026-10-12T11:02:00Z");

        JsonNode landing = json.get("landing");
        assertThat(fieldNames(landing)).containsExactly("airportIcao", "runway", "touchdownAt");
        assertThat(values(landing, JsonNode::asText, "airportIcao", "runway", "touchdownAt"))
                .containsExactly("ESSA", "19R", "2026-10-12T11:03:10Z");

        // present, and null, until a confirmation provider fills them
        assertThat(json.has("gate")).isTrue();
        assertThat(values(json, JsonNode::isNull, "gate", "terminal", "confirmedAt"))
                .containsExactly(true, true, true);
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

        assertThat(s)
                .extracting(TrackStatus::state, TrackStatus::confidence, TrackStatus::source, TrackStatus::sourceKind,
                        TrackStatus::estimate, TrackStatus::confirmedAt, TrackStatus::gate, TrackStatus::lastSeenAt)
                .containsExactly(TrackState.LANDED_CONFIRMED, 1.0, "mock", "confirmed", null, ON, null, SEEN);
        assertThat(s.landing())
                .extracting(TrackStatus.Landing::airportIcao, TrackStatus.Landing::runway, TrackStatus.Landing::touchdownAt)
                .containsExactly("ESSA", "19R", ON);
    }

    @Test
    void confirmedGateIn_isAtGate_withGateTerminalAndConfirmedAtTheGateTime() throws Exception {
        TrackStatus s = TrackStatus.from(aircraft(true, null), confirmation(ON, IN, "B14"));

        assertThat(s)
                .extracting(TrackStatus::state, TrackStatus::gate, TrackStatus::terminal, TrackStatus::confirmedAt)
                .containsExactly(TrackState.AT_GATE, "B14", "2", IN);
        assertThat(s.landing())
                .extracting(TrackStatus.Landing::airportIcao, TrackStatus.Landing::runway)
                .containsExactly("ESSA", null);

        JsonNode json = json(s);
        assertThat(fieldNames(json)).containsExactlyElementsOf(STATUS_FIELDS);
        assertThat(values(json, JsonNode::asText, "state", "sourceKind", "confirmedAt"))
                .containsExactly("AT_GATE", "confirmed", "2026-10-12T11:11:30Z");
        assertThat(json.get("estimate").isNull()).isTrue();
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

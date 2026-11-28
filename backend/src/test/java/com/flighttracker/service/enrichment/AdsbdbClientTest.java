package com.flighttracker.service.enrichment;

import com.flighttracker.service.enrichment.AdsbdbClient.LookupStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pins AdsbdbClient against a loopback adsbdb: how each JSON shape maps to a
 * Route / AircraftInfo, and how each HTTP outcome maps to a LookupStatus.
 * THROTTLED vs NOT_FOUND vs FAILED is what CallsignRouteService's backoff
 * and miss cache key on (see CallsignRouteServiceTest), so it is pinned here.
 */
class AdsbdbClientTest {

    private static final String ARLANDA =
            "{\"icao_code\":\"ESSA\",\"iata_code\":\"ARN\",\"name\":\"Stockholm-Arlanda Airport\","
                    + "\"latitude\":59.651901,\"longitude\":17.918600}";
    private static final String SCHIPHOL =
            "{\"icao_code\":\"EHAM\",\"iata_code\":\"AMS\",\"name\":\"Amsterdam Airport Schiphol\","
                    + "\"latitude\":52.308601,\"longitude\":4.763890}";
    private static final String NOT_FOUND_BODY = "{\"response\":\"unknown callsign\"}";

    private StubHttpServer adsbdb;
    private AdsbdbClient client;

    @BeforeEach
    void startStub() throws IOException {
        adsbdb = new StubHttpServer();
        client = new AdsbdbClient(adsbdb.baseUrl());
    }

    @AfterEach
    void stopStub() {
        adsbdb.close();
    }

    /** An adsbdb /callsign answer; each airport is a JSON object or {@code null}. */
    private record RouteJson(String origin, String destination) {
        String body() {
            return "{\"response\":{\"flightroute\":{\"callsign\":\"SAS1234\",\"origin\":" + origin
                    + ",\"destination\":" + destination + "}}}";
        }
    }

    /** An adsbdb /aircraft answer; each field is a JSON literal (quoted string or {@code null}). */
    private record AircraftJson(String type, String manufacturer, String registration, String owner) {
        String body() {
            return "{\"response\":{\"aircraft\":{\"type\":" + type + ",\"icao_type\":\"A20N\",\"manufacturer\":"
                    + manufacturer + ",\"mode_s\":\"4AC9E5\",\"registration\":" + registration
                    + ",\"registered_owner\":" + owner + "}}}";
        }
    }

    @Test
    void foundRoute_mapsEveryAirportField() {
        adsbdb.reply(200, new RouteJson(ARLANDA, SCHIPHOL).body());

        AdsbdbClient.RouteLookup lookup = client.lookupRoute("SAS1234");

        assertThat(lookup.status()).isEqualTo(LookupStatus.FOUND);
        assertThat(lookup.route()).contains(new Route(
                "ESSA", "Stockholm-Arlanda Airport", 59.651901, 17.918600,
                "EHAM", "Amsterdam Airport Schiphol", 52.308601, 4.763890));
    }

    @Test
    void lookup_requestsTheCallsignPathAsGiven() {
        adsbdb.reply(200, new RouteJson(ARLANDA, SCHIPHOL).body());

        client.lookupRoute("SAS1234");

        assertThat(adsbdb.requests()).singleElement()
                .satisfies(r -> assertThat(r.method() + " " + r.path()).isEqualTo("GET /callsign/SAS1234"));
    }

    @Test
    void fetchRoute_returnsTheSameRouteAsLookupRoute() {
        adsbdb.reply(200, new RouteJson(ARLANDA, SCHIPHOL).body());

        assertThat(client.fetchRoute("SAS1234")).isEqualTo(client.lookupRoute("SAS1234").route());
    }

    @Test
    void routeWithOnlyAnOrigin_isFoundWithNullDestinationFields() {
        adsbdb.reply(200, new RouteJson(ARLANDA, "null").body());

        AdsbdbClient.RouteLookup lookup = client.lookupRoute("SAS1234");

        assertThat(lookup.status()).isEqualTo(LookupStatus.FOUND);
        assertThat(lookup.route()).contains(new Route(
                "ESSA", "Stockholm-Arlanda Airport", 59.651901, 17.918600, null, null, null, null));
    }

    @Test
    void airportWithNullAndBlankFields_passesThemThroughUnchanged() {
        adsbdb.reply(200, new RouteJson("{\"icao_code\":\"\",\"name\":null}", SCHIPHOL).body());

        Route route = client.lookupRoute("SAS1234").route().orElseThrow();

        assertThat(route.originAirport()).isEmpty();
        assertThat(route.originAirportName()).isNull();
        assertThat(route.originAirportLat()).isNull();
        assertThat(route.originAirportLon()).isNull();
        assertThat(route.destinationAirport()).isEqualTo("EHAM");
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {
            "{\"response\":{\"flightroute\":{\"callsign\":\"SAS1234\",\"origin\":null,\"destination\":null}}}",
            "{\"response\":{\"flightroute\":null}}",
            "{\"response\":null}",
            "{}"
    })
    void answerWithoutARoute_isNotFound(String json) {
        adsbdb.reply(200, json);

        assertThat(client.lookupRoute("SAS1234")).isEqualTo(AdsbdbClient.RouteLookup.of(LookupStatus.NOT_FOUND));
    }

    @ParameterizedTest(name = "HTTP {0} -> {1}")
    @CsvSource({
            "404, NOT_FOUND",
            "400, NOT_FOUND",
            "429, THROTTLED",
            "500, FAILED",
            "503, FAILED"
    })
    void httpErrorStatus_mapsToLookupStatus(int status, LookupStatus expected) {
        adsbdb.reply(status, NOT_FOUND_BODY);

        AdsbdbClient.RouteLookup lookup = client.lookupRoute("SAS1234");

        assertThat(lookup.status()).isEqualTo(expected);
        assertThat(lookup.route()).isEmpty();
    }

    @Test
    void malformedJson_isFailedNotNotFound() {
        adsbdb.reply(200, "{\"response\":");

        assertThat(client.lookupRoute("SAS1234").status()).isEqualTo(LookupStatus.FAILED);
    }

    @Test
    void connectionFailure_isFailedAndFetchRouteIsEmpty() throws IOException {
        AdsbdbClient unreachable = new AdsbdbClient(StubHttpServer.unusedBaseUrl());

        assertThat(unreachable.lookupRoute("SAS1234").status()).isEqualTo(LookupStatus.FAILED);
        assertThat(unreachable.fetchRoute("SAS1234")).isEmpty();
    }

    @Test
    void foundAircraft_joinsManufacturerAndTypeIntoTheModel() {
        adsbdb.reply(200, new AircraftJson("\"A320 251N\"", "\"Airbus\"", "\"SE-ROA\"", "\"Scandinavian Airlines\"").body());

        assertThat(client.fetchAircraftInfo("4ac9e5"))
                .contains(new AircraftInfo("Airbus A320 251N", "SE-ROA", "Scandinavian Airlines"));
        assertThat(adsbdb.requests()).singleElement()
                .satisfies(r -> assertThat(r.path()).isEqualTo("/aircraft/4ac9e5"));
    }

    @Test
    void aircraftWithoutManufacturer_usesTheTypeAlone() {
        adsbdb.reply(200, new AircraftJson("\"A320 251N\"", "null", "\"SE-ROA\"", "null").body());

        assertThat(client.fetchAircraftInfo("4ac9e5")).contains(new AircraftInfo("A320 251N", "SE-ROA", null));
    }

    @Test
    void aircraftWithoutType_hasNoModelEvenWithAManufacturer() {
        adsbdb.reply(200, new AircraftJson("null", "\"Airbus\"", "\"SE-ROA\"", "null").body());

        assertThat(client.fetchAircraftInfo("4ac9e5")).contains(new AircraftInfo(null, "SE-ROA", null));
    }

    @Test
    void aircraftWithBlankRegistration_keepsItAsGiven() {
        adsbdb.reply(200, new AircraftJson("null", "null", "\"\"", "\"Private\"").body());

        assertThat(client.fetchAircraftInfo("4ac9e5")).contains(new AircraftInfo(null, "", "Private"));
    }

    @Test
    void aircraftWithNoUsableField_isEmpty() {
        adsbdb.reply(200, new AircraftJson("null", "\"Airbus\"", "null", "null").body());

        assertThat(client.fetchAircraftInfo("4ac9e5")).isEmpty();
    }

    @ParameterizedTest(name = "HTTP {0}: {1}")
    @CsvSource(delimiter = '|', value = {
            "200 | {\"response\":{\"aircraft\":null}}",
            "200 | {}",
            "404 | {\"response\":\"unknown aircraft\"}",
            "429 | {}",
            "500 | {}",
            "200 | {\"response\":"
    })
    void aircraftLookupThatYieldsNothing_isEmpty(int status, String json) {
        adsbdb.reply(status, json);

        assertThat(client.fetchAircraftInfo("4ac9e5")).isEqualTo(Optional.empty());
    }

    @Test
    void aircraftConnectionFailure_isEmpty() throws IOException {
        AdsbdbClient unreachable = new AdsbdbClient(StubHttpServer.unusedBaseUrl());

        assertThat(unreachable.fetchAircraftInfo("4ac9e5")).isEmpty();
    }
}

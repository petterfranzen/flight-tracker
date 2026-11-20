package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.config.YamlPropertiesFactoryBean;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.http.client.MockClientHttpResponse;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Properties;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.client.ExpectedCount.once;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** AeroDataBoxArrivalProvider against reconstructed fixtures and a mock HTTP server; nothing leaves the JVM. */
class AeroDataBoxArrivalProviderTest {

    static final String BASE = "https://aerodatabox.p.rapidapi.com";
    static final String CPA271 = BASE + "/flights/Number/CPA271?withAircraftImage=false&withLocation=false";
    static final Instant LANDED = Instant.parse("2026-10-12T06:02:00Z");

    private final TestClock clock = new TestClock();
    private final PhaseLogger phases = mock(PhaseLogger.class);
    private MockRestServiceServer server;
    private RestClient.Builder builder;

    @BeforeEach
    void setUp() {
        clock.set(Instant.parse("2026-10-12T12:00:00Z"));
        builder = RestClient.builder();
        resetServer();
    }

    /** The provider's constructor settings; {@link #DEFAULTS} is what most tests run with. */
    record Setup(boolean enabled, String key, String searchBy, boolean labels) {
        Setup withKey(String newKey) {
            return new Setup(enabled, newKey, searchBy, labels);
        }

        Setup searchingBy(String newSearchBy) {
            return new Setup(enabled, key, newSearchBy, labels);
        }

        Setup disabled() {
            return new Setup(false, key, searchBy, labels);
        }

        Setup recordingLabels() {
            return new Setup(enabled, key, searchBy, true);
        }
    }

    static final Setup DEFAULTS = new Setup(true, "test-key", "Number", false);

    private AeroDataBoxArrivalProvider provider(Setup s) {
        return new AeroDataBoxArrivalProvider(clock, phases, s.enabled(), s.key(), BASE, "aerodatabox.p.rapidapi.com",
                s.searchBy(), s.labels(), builder);
    }

    private AeroDataBoxArrivalProvider provider() {
        return provider(DEFAULTS);
    }

    /** A fresh mock server for the next request of a test that makes several. */
    private void resetServer() {
        server = MockRestServiceServer.bindTo(builder).build();
    }

    static ArrivalQuery queryFor(String callsign) {
        return new ArrivalQuery("780a8c", callsign, "EHAM", LANDED);
    }

    static Properties applicationYml() {
        YamlPropertiesFactoryBean yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        return yaml.getObject();
    }

    static String fixture(String name) throws IOException {
        return new String(new ClassPathResource("aerodatabox/" + name).getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    static ArrivalQuery query(Instant expected) {
        return new ArrivalQuery("780a8c", "CPA271", "EHAM", expected);
    }

    private LookupResult lookupFixture(String name, ArrivalQuery query) throws IOException {
        server.expect(once(), requestTo(CPA271)).andRespond(withSuccess(fixture(name), MediaType.APPLICATION_JSON));
        return provider().lookup(query);
    }

    private LookupResult lookupBody(String body, ArrivalQuery query) {
        server.expect(once(), requestTo(CPA271)).andRespond(withSuccess(body, MediaType.APPLICATION_JSON));
        return provider().lookup(query);
    }

    /** One AeroDataBox arrival entry at EHAM; a null time is left out of the JSON. */
    record Arrival(String status, String scheduled, String revised, String runway) {
        String json() {
            StringBuilder sb = new StringBuilder("[{\"status\":\"" + status + "\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"}");
            appendTime(sb, "scheduledTime", scheduled);
            appendTime(sb, "revisedTime", revised);
            appendTime(sb, "runwayTime", runway);
            return sb.append("}}]").toString();
        }

        private static void appendTime(StringBuilder sb, String field, String utc) {
            if (utc != null) sb.append(",\"").append(field).append("\":{\"utc\":\"").append(utc).append("\"}");
        }
    }

    // ---- the time parser

    @Test
    void parsesUtcWithZ() {
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12 05:09Z")).isEqualTo(Instant.parse("2025-01-12T05:09:00Z"));
    }

    @Test
    void parsesALocalTimeWithAnOffset() {
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12 06:09+01:00")).isEqualTo(Instant.parse("2025-01-12T05:09:00Z"));
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-07-12 10:30-05:00")).isEqualTo(Instant.parse("2025-07-12T15:30:00Z"));
    }

    @ParameterizedTest
    @CsvSource(delimiter = '|', ignoreLeadingAndTrailingWhitespace = false, value = {
            "2025-01-12T05:09:30Z|2025-01-12T05:09:30Z",
            "2025-01-12T06:09+01:00|2025-01-12T05:09:00Z",
            "2025-01-12 06:09+0100|2025-01-12T05:09:00Z",
            "2025-01-12 06:09:15.250+01|2025-01-12T05:09:15.250Z",
            "  2025-01-12 05:09z |2025-01-12T05:09:00Z"})
    void parsesIsoWithTSecondsAndOffsetsWithoutAColon(String text, Instant utc) {
        assertThat(AeroDataBoxArrivalProvider.parseTime(text)).isEqualTo(utc);
    }

    @Test
    void aTimeWithoutAnOffsetIsUtc() {
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12 05:09")).isEqualTo(Instant.parse("2025-01-12T05:09:00Z"));
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"soon", "2025-13-45 05:09Z", "2025-01-12"})
    void garbageNullAndImpossibleTimesParseToNull(String text) {
        assertThat(AeroDataBoxArrivalProvider.parseTime(text)).isNull();
    }

    // ---- request

    @Test
    void sendsTheRapidApiHeadersToTheNearestFlightUrl() throws IOException {
        server.expect(once(), requestTo(CPA271))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header("X-RapidAPI-Key", "test-key"))
                .andExpect(header("X-RapidAPI-Host", "aerodatabox.p.rapidapi.com"))
                .andExpect(header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE))
                .andRespond(withSuccess(fixture("cx271-two-days.json"), MediaType.APPLICATION_JSON));

        LookupResult result = provider().lookup(query(LANDED));

        server.verify();
        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
    }

    @Test
    void searchByCallSignChangesThePath() {
        server.expect(once(), requestTo(BASE + "/flights/CallSign/CPA271?withAircraftImage=false&withLocation=false"))
                .andRespond(withStatus(HttpStatus.NO_CONTENT));

        provider(DEFAULTS.withKey("k").searchingBy("callsign")).lookup(query(LANDED));

        server.verify();
    }

    @Test
    void anUnknownSearchByFallsBackToNumber() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.NO_CONTENT));

        provider(DEFAULTS.withKey("k").searchingBy("Reg")).lookup(query(LANDED));

        server.verify();
    }

    @Test
    void theCallsignIsTrimmedAndSpacesAreRemoved() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.NO_CONTENT));

        provider().lookup(new ArrivalQuery("780a8c", "  cpa 271 ", "EHAM", LANDED));

        server.verify();
    }

    @Test
    void aCallsignLongerThanTenCharactersOrWithOddCharactersMakesNoCall() {
        AeroDataBoxArrivalProvider p = provider();

        assertThat(Stream.of("ABCDEFGHIJK", "CPA/271", " ", null).map(callsign -> p.lookup(queryFor(callsign)).status()))
                .containsExactly(LookupResult.Status.NOT_FOUND, LookupResult.Status.NOT_FOUND,
                        LookupResult.Status.NOT_FOUND, LookupResult.Status.NOT_FOUND);
        server.verify(); // an unexpected request would have failed above
    }

    // ---- mapping and choosing the entry

    @Test
    void picksTheEntryNearestTheExpectedArrivalOfTwoAdjacentDays() throws IOException {
        LookupResult result = lookupFixture("cx271-two-days.json", query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(result.info())
                .extracting(ArrivalInfo::actualOn, ArrivalInfo::actualIn, ArrivalInfo::terminal, ArrivalInfo::gate,
                        ArrivalInfo::arrivalAirportIcao, ArrivalInfo::rank)
                // actualIn is null: revised == runway, so no gate time
                .containsExactly(Instant.parse("2026-10-12T06:02:00Z"), null, "2", null, "EHAM", 1);
    }

    @Test
    void theEarlierDayIsPickedWhenThatIsWhenItLanded() throws IOException {
        LookupResult result = lookupFixture("cx271-two-days.json", query(Instant.parse("2026-10-11T05:59:00Z")));

        assertThat(result.info().actualOn()).isEqualTo(Instant.parse("2026-10-11T05:58:00Z"));
        assertThat(result.info().gate()).isEqualTo("D87");
    }

    @Test
    void aRevisedTimeLaterThanTheRunwayTimeIsTheGateTime() throws IOException {
        LookupResult result = lookupFixture("arrived-at-gate.json", query(LANDED));

        assertThat(result.info())
                .extracting(ArrivalInfo::actualOn, ArrivalInfo::actualIn, ArrivalInfo::gate, ArrivalInfo::rank)
                .containsExactly(Instant.parse("2026-10-12T06:02:00Z"), Instant.parse("2026-10-12T06:14:00Z"), "D87", 2);
    }

    @Test
    void approachingWithOnlyEstimatedTimesHasNoActualTimes() throws IOException {
        LookupResult result = lookupFixture("approaching.json", query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(result.info())
                .extracting(ArrivalInfo::actualOn, ArrivalInfo::actualIn, ArrivalInfo::rank)
                .containsExactly(null, null, 0);
    }

    @Test
    void aCanceledFlightDoesNotConfirmALanding() throws IOException {
        LookupResult result = lookupFixture("canceled.json", query(LANDED));

        assertThat(result.info().actualOn()).isNull();
        assertThat(result.info().rank()).isZero();
    }

    @Test
    void divertedAndCanceledUncertainDoNotConfirmALandingEvenWithARunwayTime() {
        for (String status : new String[] {"Diverted", "CanceledUncertain", "Canceled", "Expected"}) {
            server.reset();
            resetServer();
            LookupResult result = lookupBody(new Arrival(status, "2026-10-12 06:05Z", "2026-10-12 06:03Z", "2026-10-12 06:02Z").json(), query(LANDED));
            assertThat(result.info().rank()).as(status).isZero();
        }
    }

    @Test
    void theOperatorBeatsAnEntryThatIsNearerButACodeshare() throws IOException {
        LookupResult result = lookupFixture("operator-and-codeshare.json", query(Instant.parse("2026-10-12T06:03:00Z")));

        assertThat(result.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T06:02:00Z"));
        assertThat(result.info().gate()).isNull(); // not the codeshare's X9
    }

    @Test
    void aCodeshareIsUsedWhenItIsAllThereIs() {
        LookupResult result = lookupBody("[{\"status\":\"Arrived\",\"codeshareStatus\":\"IsCodeshared\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},"
                + "\"runwayTime\":{\"utc\":\"2026-10-12 06:02Z\"}}}]", query(LANDED));

        assertThat(result.info().actualOn()).isEqualTo(LANDED);
    }

    @Test
    void unknownBeatsCodeshareAndTheComparisonIgnoresCase() {
        LookupResult result = lookupBody("[{\"status\":\"Arrived\",\"codeshareStatus\":\"IsCodeshared\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:02Z\"}}},"
                + "{\"status\":\"Arrived\",\"codeshareStatus\":\"Unknown\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:09Z\"}}}]", query(LANDED));
        assertThat(result.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T06:09:00Z"));

        resetServer();
        result = lookupBody("[{\"status\":\"Arrived\",\"codeshareStatus\":\"IsCodeshared\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:02Z\"}}},"
                + "{\"status\":\"arrived\",\"codeshareStatus\":\"isoperator\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:09Z\"}}}]", query(LANDED));
        assertThat(result.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T06:09:00Z"));
    }

    @Test
    void anEntryForAnotherAirframeIsSkipped() throws IOException {
        LookupResult result = lookupFixture("modes-mismatch.json", query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.NOT_FOUND);
    }

    @Test
    void theModeSComparisonIgnoresCase() throws IOException {
        LookupResult result = lookupFixture("cx271-two-days.json", new ArrivalQuery("780A8C", "CPA271", "EHAM", LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
    }

    @Test
    void anEntryWithoutModeSIsKept() {
        LookupResult result = lookupBody(new Arrival("Arrived", null, "2026-10-12 06:02Z", "2026-10-12 06:02Z").json(), query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
    }

    @Test
    void onlyEntriesArrivingAtTheQueriedAirportCount() throws IOException {
        LookupResult result = lookupFixture("cx271-two-days.json", new ArrivalQuery("780a8c", "CPA271", "EGLL", LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.NOT_FOUND);
    }

    @Test
    void aNullQueryAirportAcceptsAnyAndReportsTheEntrysAirport() throws IOException {
        LookupResult result = lookupFixture("cx271-two-days.json", new ArrivalQuery("780a8c", "CPA271", null, LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(result.info().arrivalAirportIcao()).isEqualTo("EHAM");
    }

    @Test
    void anEntryMoreThanTwelveHoursFromTheExpectedArrivalIsAnotherFlight() throws IOException {
        LookupResult result = lookupFixture("cx271-two-days.json", query(Instant.parse("2026-10-15T06:02:00Z")));

        assertThat(result.status()).isEqualTo(LookupResult.Status.NOT_FOUND);
    }

    @Test
    void arrivedWithoutARunwayTimeUsesTheRevisedTimeAndNoGateTime() {
        LookupResult result = lookupBody(new Arrival("Arrived", "2026-10-12 06:05Z", "2026-10-12 06:02Z", null).json(), query(LANDED));

        assertThat(result.info().actualOn()).isEqualTo(LANDED);
        assertThat(result.info().actualIn()).isNull();
    }

    @Test
    void aRevisedTimeEarlierThanOrEqualToTheRunwayTimeIsNotAGateTime() {
        LookupResult earlier = lookupBody(new Arrival("Arrived", null, "2026-10-12 06:00Z", "2026-10-12 06:02Z").json(), query(LANDED));
        assertThat(earlier.info().actualOn()).isEqualTo(LANDED);
        assertThat(earlier.info().actualIn()).isNull();
    }

    @Test
    void anEmptyArrayAndAnEmptyBodyAreNotFound() {
        assertThat(lookupBody("[]", query(LANDED)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        resetServer();
        assertThat(lookupBody("", query(LANDED)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
    }

    @Test
    void aMalformedBodyFailsAndDegrades() {
        LookupResult result = lookupBody("{not json", query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FAILED);
        verify(phases).degraded(contains("unreadable"));
    }

    // ---- status codes

    @Test
    void noContentIsNotFound() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.NO_CONTENT));

        LookupResult result = provider().lookup(query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        verify(phases, never()).degraded(contains(""));
    }

    @Test
    void tooManyRequestsHonoursRetryAfterSeconds() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "120"));

        LookupResult result = provider().lookup(query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.THROTTLED);
        assertThat(result.retryAfter()).isEqualTo(Duration.ofSeconds(120));
        verify(phases).degraded(contains("429"));
    }

    @Test
    void tooManyRequestsHonoursAnHttpDateRetryAfter() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS)
                .header(HttpHeaders.RETRY_AFTER, "Mon, 12 Oct 2026 12:05:00 GMT"));

        LookupResult result = provider().lookup(query(LANDED));

        assertThat(result.retryAfter()).isEqualTo(Duration.ofMinutes(5));
    }

    @Test
    void tooManyRequestsWithoutAUsableRetryAfterWaitsSixtySeconds() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));
        assertThat(provider().lookup(query(LANDED)).retryAfter()).isEqualTo(Duration.ofSeconds(60));

        resetServer();
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "soon"));
        assertThat(provider().lookup(query(LANDED)).retryAfter()).isEqualTo(Duration.ofSeconds(60));

        resetServer();
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "Mon, 12 Oct 2026 11:00:00 GMT"));
        assertThat(provider().lookup(query(LANDED)).retryAfter()).isEqualTo(Duration.ofSeconds(60));
    }

    @Test
    void aRejectedKeyFailsOnceAndLocksTheProviderUntilTheNextUtcMidnight() {
        for (HttpStatus status : new HttpStatus[] {HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN}) {
            clock.set(Instant.parse("2026-10-12T12:00:00Z"));
            resetServer();
            server.expect(once(), requestTo(CPA271)).andRespond(withStatus(status));
            AeroDataBoxArrivalProvider p = provider();
            assertThat(p.enabled()).isTrue();

            LookupResult result = p.lookup(query(LANDED));

            assertThat(result.status()).as(status.toString()).isEqualTo(LookupResult.Status.FAILED);
            assertThat(p.enabled()).isFalse();
            clock.set(Instant.parse("2026-10-12T23:59:59Z"));
            assertThat(p.enabled()).isFalse();
            clock.set(Instant.parse("2026-10-13T00:00:00Z"));
            assertThat(p.enabled()).isTrue();
        }
        verify(phases, org.mockito.Mockito.times(2)).degraded(contains("rejected the API key"));
    }

    @Test
    void aLockedProviderMakesNoCall() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.FORBIDDEN));
        AeroDataBoxArrivalProvider p = provider();
        p.lookup(query(LANDED));

        assertThat(p.lookup(query(LANDED)).status()).isEqualTo(LookupResult.Status.FAILED);
        server.verify();
    }

    @Test
    void aServerErrorFailsAndDegradesWithoutLockingTheProvider() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR));
        AeroDataBoxArrivalProvider p = provider();

        LookupResult result = p.lookup(query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(p.enabled()).isTrue();
        verify(phases).degraded(contains("500"));
    }

    // ---- enabled, cost, coverage, config

    @Test
    void badRequestNotFoundAndUnprocessableAreNoSuchFlight_notAFailure() {
        for (HttpStatus status : new HttpStatus[] {HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND, HttpStatus.UNPROCESSABLE_ENTITY}) {
            resetServer();
            server.expect(once(), requestTo(CPA271)).andRespond(withStatus(status));

            LookupResult result = provider().lookup(query(LANDED));

            assertThat(result.status()).as(status.toString()).isEqualTo(LookupResult.Status.NOT_FOUND);
            assertThat(result.costUnits()).as("a real answer: the charge stands").isNull();
        }
    }

    @Test
    void otherClientErrorsAndServerErrorsStayFailures_and429StaysThrottled() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.BAD_GATEWAY));
        assertThat(provider().lookup(query(LANDED)).status()).isEqualTo(LookupResult.Status.FAILED);

        resetServer();
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));
        assertThat(provider().lookup(query(LANDED)).status()).isEqualTo(LookupResult.Status.THROTTLED);

        resetServer();
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.METHOD_NOT_ALLOWED));
        assertThat(provider().lookup(query(LANDED)).status()).isEqualTo(LookupResult.Status.FAILED);
    }

    @Test
    void aBodyThatCannotBeReadFailsInsteadOfReadingAsNoFlight() {
        server.expect(once(), requestTo(CPA271)).andRespond(request -> {
            MockClientHttpResponse response = new MockClientHttpResponse(new InputStream() {
                @Override public int read() throws IOException {
                    throw new IOException("connection reset");
                }
            }, HttpStatus.OK);
            response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
            return response;
        });

        LookupResult result = provider().lookup(query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(result.costUnits()).as("the request reached the API").isNull();
        verify(phases).degraded(contains("unreadable"));
    }

    @Test
    void aConnectionThatNeverReachedTheApiReportsNoCost_butATimeoutWhileReadingKeepsIt() {
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new ConnectException("Connection refused")));
        LookupResult refused = provider().lookup(query(LANDED));
        assertThat(refused.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(refused.costUnits()).isZero();

        resetServer();
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new UnknownHostException("aerodatabox.p.rapidapi.com")));
        assertThat(provider().lookup(query(LANDED)).costUnits()).isZero();

        resetServer();
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new SocketTimeoutException("connect timed out")));
        assertThat(provider().lookup(query(LANDED)).costUnits()).isZero();

        resetServer();
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new SocketTimeoutException("Read timed out")));
        LookupResult slow = provider().lookup(query(LANDED));
        assertThat(slow.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(slow.costUnits()).as("the API may have billed it").isNull();
    }

    @Test
    void acceptsOnlyAUsableCallsignWhileEnabled() {
        AeroDataBoxArrivalProvider p = provider();

        assertThat(Stream.of(query(LANDED), queryFor("cpa 271")).map(p::accepts)).containsExactly(true, true);
        assertThat(Stream.of("ABCDEFGHIJK", "CPA/271", " ", null).map(callsign -> p.accepts(queryFor(callsign))))
                .containsExactly(false, false, false, false);
        assertThat(Stream.of(DEFAULTS.withKey(""), DEFAULTS.withKey("key").disabled())
                .map(setup -> provider(setup).accepts(query(LANDED))))
                .as("no key, flag off").containsExactly(false, false);
    }

    @Test
    void aLockedOutProviderDoesNotAccept() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.FORBIDDEN));
        AeroDataBoxArrivalProvider p = provider();
        p.lookup(query(LANDED));

        assertThat(p.accepts(query(LANDED))).isFalse();
    }

    @Test
    void recheckIntervalsAndGateWaitDefaultToThirtyMinutesThreeHoursAndNone() {
        AeroDataBoxArrivalProvider p = provider();

        assertThat(p.foundRecheck()).isEqualTo(Duration.ofMinutes(30));
        assertThat(p.notFoundRecheck()).isEqualTo(Duration.ofHours(3));
        assertThat(p.gateWait()).isEqualTo(Duration.ZERO);
    }

    @Test
    void applicationYmlSetsTheRecheckIntervalsAndNoGateWait() {
        Properties props = applicationYml();

        assertThat(props.getProperty("flighttracker.confirmation.aerodatabox.found-recheck-minutes")).isEqualTo("30");
        assertThat(props.getProperty("flighttracker.confirmation.aerodatabox.not-found-recheck-minutes")).isEqualTo("180");
        assertThat(props.getProperty("flighttracker.confirmation.aerodatabox.gate-wait-minutes")).isEqualTo("0");
    }

    @Test
    void theNearestEntryInTimeBeatsAnOperatorLegHoursAway_theRankOnlyBreaksCloseTies() {
        LookupResult result = lookupBody("["
                + "{\"status\":\"Arrived\",\"codeshareStatus\":\"IsOperator\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 17:00Z\"}}},"
                + "{\"status\":\"Arrived\",\"codeshareStatus\":\"Unknown\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:09Z\"}}}]",
                query(LANDED));

        assertThat(result.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T06:09:00Z"));

        // 50 minutes apart: close enough for the operator to win.
        resetServer();
        result = lookupBody("["
                + "{\"status\":\"Arrived\",\"codeshareStatus\":\"IsOperator\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:55Z\"}}},"
                + "{\"status\":\"Arrived\",\"codeshareStatus\":\"Unknown\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:05Z\"}}}]",
                query(LANDED));
        assertThat(result.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T06:55:00Z"));
    }

    @Test
    void isDisabledWithoutAKeyOrWithTheFlagOffAndMakesNoCall() {
        assertThat(Stream.of(DEFAULTS.withKey(""), DEFAULTS.withKey("  "), DEFAULTS.withKey(null),
                        DEFAULTS.withKey("key").disabled())
                .map(setup -> provider(setup).enabled()))
                .containsExactly(false, false, false, false);
        assertThat(provider(DEFAULTS.withKey("key")).enabled()).isTrue();

        assertThat(provider(DEFAULTS.withKey("")).lookup(query(LANDED)).status()).isEqualTo(LookupResult.Status.FAILED);
        server.verify();
    }

    @Test
    void aLookupCostsTwoUnits() {
        assertThat(provider().callCost()).isEqualTo(2);
        assertThat(provider().id()).isEqualTo("aerodatabox");
    }

    @Test
    void coversAnyKnownAirportButNotAnUnknownOne() {
        AeroDataBoxArrivalProvider p = provider();

        assertThat(Stream.of("EHAM", "KJFK", null, " ").map(p::covers)).containsExactly(true, true, false, false);
    }

    @Test
    void longTermStorageIsOffUnlessConfigured() {
        assertThat(provider(DEFAULTS.withKey("k")).mayStoreLongTerm()).isFalse();
        assertThat(provider(DEFAULTS.withKey("k").recordingLabels()).mayStoreLongTerm()).isTrue();
    }

    @Test
    void applicationYmlSetsTheCostBudgetsAndDefaults() {
        Properties p = applicationYml();
        Map<String, String> expected = Map.of(
                "flighttracker.confirmation.providers.aerodatabox.monthly-budget", "380",
                "flighttracker.confirmation.providers.aerodatabox.daily-budget", "14",
                "flighttracker.confirmation.aerodatabox.api-key", "${AERODATABOX_API_KEY:}",
                "flighttracker.confirmation.aerodatabox.base-url", BASE,
                "flighttracker.confirmation.aerodatabox.host", "aerodatabox.p.rapidapi.com",
                "flighttracker.confirmation.aerodatabox.search-by", "Number",
                "flighttracker.confirmation.aerodatabox.enabled", "true",
                "flighttracker.confirmation.aerodatabox.record-training-labels", "false");

        assertThat(expected).allSatisfy((key, value) -> assertThat(p.getProperty(key)).as(key).isEqualTo(value));
    }
}

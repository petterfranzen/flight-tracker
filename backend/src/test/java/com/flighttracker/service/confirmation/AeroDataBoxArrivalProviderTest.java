package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
import java.util.Properties;

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
        server = MockRestServiceServer.bindTo(builder).build();
    }

    private AeroDataBoxArrivalProvider provider(boolean enabled, String key, String searchBy, boolean labels) {
        return new AeroDataBoxArrivalProvider(clock, phases, enabled, key, BASE, "aerodatabox.p.rapidapi.com", searchBy, labels, builder);
    }

    private AeroDataBoxArrivalProvider provider() {
        return provider(true, "test-key", "Number", false);
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

    private static String arrival(String status, String scheduled, String revised, String runway) {
        StringBuilder sb = new StringBuilder("[{\"status\":\"" + status + "\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"}");
        if (scheduled != null) sb.append(",\"scheduledTime\":{\"utc\":\"").append(scheduled).append("\"}");
        if (revised != null) sb.append(",\"revisedTime\":{\"utc\":\"").append(revised).append("\"}");
        if (runway != null) sb.append(",\"runwayTime\":{\"utc\":\"").append(runway).append("\"}");
        return sb.append("}}]").toString();
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

    @Test
    void parsesIsoWithTSecondsAndOffsetsWithoutAColon() {
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12T05:09:30Z")).isEqualTo(Instant.parse("2025-01-12T05:09:30Z"));
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12T06:09+01:00")).isEqualTo(Instant.parse("2025-01-12T05:09:00Z"));
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12 06:09+0100")).isEqualTo(Instant.parse("2025-01-12T05:09:00Z"));
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12 06:09:15.250+01")).isEqualTo(Instant.parse("2025-01-12T05:09:15.250Z"));
        assertThat(AeroDataBoxArrivalProvider.parseTime("  2025-01-12 05:09z ")).isEqualTo(Instant.parse("2025-01-12T05:09:00Z"));
    }

    @Test
    void aTimeWithoutAnOffsetIsUtc() {
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12 05:09")).isEqualTo(Instant.parse("2025-01-12T05:09:00Z"));
    }

    @Test
    void garbageNullAndImpossibleTimesParseToNull() {
        assertThat(AeroDataBoxArrivalProvider.parseTime(null)).isNull();
        assertThat(AeroDataBoxArrivalProvider.parseTime("")).isNull();
        assertThat(AeroDataBoxArrivalProvider.parseTime("soon")).isNull();
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-13-45 05:09Z")).isNull();
        assertThat(AeroDataBoxArrivalProvider.parseTime("2025-01-12")).isNull();
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

        provider(true, "k", "callsign", false).lookup(query(LANDED));

        server.verify();
    }

    @Test
    void anUnknownSearchByFallsBackToNumber() {
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.NO_CONTENT));

        provider(true, "k", "Reg", false).lookup(query(LANDED));

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

        assertThat(p.lookup(new ArrivalQuery("780a8c", "ABCDEFGHIJK", "EHAM", LANDED)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(p.lookup(new ArrivalQuery("780a8c", "CPA/271", "EHAM", LANDED)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(p.lookup(new ArrivalQuery("780a8c", " ", "EHAM", LANDED)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(p.lookup(new ArrivalQuery("780a8c", null, "EHAM", LANDED)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        server.verify(); // an unexpected request would have failed above
    }

    // ---- mapping and choosing the entry

    @Test
    void picksTheEntryNearestTheExpectedArrivalOfTwoAdjacentDays() throws IOException {
        LookupResult result = lookupFixture("cx271-two-days.json", query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
        ArrivalInfo info = result.info();
        assertThat(info.actualOn()).isEqualTo(Instant.parse("2026-10-12T06:02:00Z"));
        assertThat(info.actualIn()).isNull(); // revised == runway: no gate time
        assertThat(info.terminal()).isEqualTo("2");
        assertThat(info.gate()).isNull();
        assertThat(info.arrivalAirportIcao()).isEqualTo("EHAM");
        assertThat(info.rank()).isEqualTo(1);
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

        ArrivalInfo info = result.info();
        assertThat(info.actualOn()).isEqualTo(Instant.parse("2026-10-12T06:02:00Z"));
        assertThat(info.actualIn()).isEqualTo(Instant.parse("2026-10-12T06:14:00Z"));
        assertThat(info.gate()).isEqualTo("D87");
        assertThat(info.rank()).isEqualTo(2);
    }

    @Test
    void approachingWithOnlyEstimatedTimesHasNoActualTimes() throws IOException {
        LookupResult result = lookupFixture("approaching.json", query(LANDED));

        assertThat(result.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(result.info().actualOn()).isNull();
        assertThat(result.info().actualIn()).isNull();
        assertThat(result.info().rank()).isZero();
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
            server = MockRestServiceServer.bindTo(builder).build();
            LookupResult result = lookupBody(arrival(status, "2026-10-12 06:05Z", "2026-10-12 06:03Z", "2026-10-12 06:02Z"), query(LANDED));
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

        server = MockRestServiceServer.bindTo(builder).build();
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
        LookupResult result = lookupBody(arrival("Arrived", null, "2026-10-12 06:02Z", "2026-10-12 06:02Z"), query(LANDED));

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
        LookupResult result = lookupBody(arrival("Arrived", "2026-10-12 06:05Z", "2026-10-12 06:02Z", null), query(LANDED));

        assertThat(result.info().actualOn()).isEqualTo(LANDED);
        assertThat(result.info().actualIn()).isNull();
    }

    @Test
    void aRevisedTimeEarlierThanOrEqualToTheRunwayTimeIsNotAGateTime() {
        LookupResult earlier = lookupBody(arrival("Arrived", null, "2026-10-12 06:00Z", "2026-10-12 06:02Z"), query(LANDED));
        assertThat(earlier.info().actualOn()).isEqualTo(LANDED);
        assertThat(earlier.info().actualIn()).isNull();
    }

    @Test
    void anEmptyArrayAndAnEmptyBodyAreNotFound() {
        assertThat(lookupBody("[]", query(LANDED)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        server = MockRestServiceServer.bindTo(builder).build();
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

        server = MockRestServiceServer.bindTo(builder).build();
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "soon"));
        assertThat(provider().lookup(query(LANDED)).retryAfter()).isEqualTo(Duration.ofSeconds(60));

        server = MockRestServiceServer.bindTo(builder).build();
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "Mon, 12 Oct 2026 11:00:00 GMT"));
        assertThat(provider().lookup(query(LANDED)).retryAfter()).isEqualTo(Duration.ofSeconds(60));
    }

    @Test
    void aRejectedKeyFailsOnceAndLocksTheProviderUntilTheNextUtcMidnight() {
        for (HttpStatus status : new HttpStatus[] {HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN}) {
            clock.set(Instant.parse("2026-10-12T12:00:00Z"));
            server = MockRestServiceServer.bindTo(builder).build();
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
            server = MockRestServiceServer.bindTo(builder).build();
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

        server = MockRestServiceServer.bindTo(builder).build();
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));
        assertThat(provider().lookup(query(LANDED)).status()).isEqualTo(LookupResult.Status.THROTTLED);

        server = MockRestServiceServer.bindTo(builder).build();
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

        server = MockRestServiceServer.bindTo(builder).build();
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new UnknownHostException("aerodatabox.p.rapidapi.com")));
        assertThat(provider().lookup(query(LANDED)).costUnits()).isZero();

        server = MockRestServiceServer.bindTo(builder).build();
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new SocketTimeoutException("connect timed out")));
        assertThat(provider().lookup(query(LANDED)).costUnits()).isZero();

        server = MockRestServiceServer.bindTo(builder).build();
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new SocketTimeoutException("Read timed out")));
        LookupResult slow = provider().lookup(query(LANDED));
        assertThat(slow.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(slow.costUnits()).as("the API may have billed it").isNull();
    }

    @Test
    void acceptsOnlyAUsableCallsignWhileEnabled() {
        AeroDataBoxArrivalProvider p = provider();

        assertThat(p.accepts(query(LANDED))).isTrue();
        assertThat(p.accepts(new ArrivalQuery("780a8c", "cpa 271", "EHAM", LANDED))).isTrue();
        assertThat(p.accepts(new ArrivalQuery("780a8c", "ABCDEFGHIJK", "EHAM", LANDED))).isFalse();
        assertThat(p.accepts(new ArrivalQuery("780a8c", "CPA/271", "EHAM", LANDED))).isFalse();
        assertThat(p.accepts(new ArrivalQuery("780a8c", " ", "EHAM", LANDED))).isFalse();
        assertThat(p.accepts(new ArrivalQuery("780a8c", null, "EHAM", LANDED))).isFalse();
        assertThat(provider(true, "", "Number", false).accepts(query(LANDED))).as("no key").isFalse();
        assertThat(provider(false, "key", "Number", false).accepts(query(LANDED))).as("flag off").isFalse();
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
        YamlPropertiesFactoryBean yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        Properties props = yaml.getObject();

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
        server = MockRestServiceServer.bindTo(builder).build();
        result = lookupBody("["
                + "{\"status\":\"Arrived\",\"codeshareStatus\":\"IsOperator\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:55Z\"}}},"
                + "{\"status\":\"Arrived\",\"codeshareStatus\":\"Unknown\",\"arrival\":{\"airport\":{\"icao\":\"EHAM\"},\"runwayTime\":{\"utc\":\"2026-10-12 06:05Z\"}}}]",
                query(LANDED));
        assertThat(result.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T06:55:00Z"));
    }

    @Test
    void isDisabledWithoutAKeyOrWithTheFlagOffAndMakesNoCall() {
        assertThat(provider(true, "", "Number", false).enabled()).isFalse();
        assertThat(provider(true, "  ", "Number", false).enabled()).isFalse();
        assertThat(provider(true, null, "Number", false).enabled()).isFalse();
        assertThat(provider(false, "key", "Number", false).enabled()).isFalse();
        assertThat(provider(true, "key", "Number", false).enabled()).isTrue();

        assertThat(provider(true, "", "Number", false).lookup(query(LANDED)).status()).isEqualTo(LookupResult.Status.FAILED);
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

        assertThat(p.covers("EHAM")).isTrue();
        assertThat(p.covers("KJFK")).isTrue();
        assertThat(p.covers(null)).isFalse();
        assertThat(p.covers(" ")).isFalse();
    }

    @Test
    void longTermStorageIsOffUnlessConfigured() {
        assertThat(provider(true, "k", "Number", false).mayStoreLongTerm()).isFalse();
        assertThat(provider(true, "k", "Number", true).mayStoreLongTerm()).isTrue();
    }

    @Test
    void applicationYmlSetsTheCostBudgetsAndDefaults() {
        YamlPropertiesFactoryBean yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        Properties p = yaml.getObject();

        assertThat(p.getProperty("flighttracker.confirmation.providers.aerodatabox.monthly-budget")).isEqualTo("380");
        assertThat(p.getProperty("flighttracker.confirmation.providers.aerodatabox.daily-budget")).isEqualTo("14");
        assertThat(p.getProperty("flighttracker.confirmation.aerodatabox.api-key")).isEqualTo("${AERODATABOX_API_KEY:}");
        assertThat(p.getProperty("flighttracker.confirmation.aerodatabox.base-url")).isEqualTo(BASE);
        assertThat(p.getProperty("flighttracker.confirmation.aerodatabox.host")).isEqualTo("aerodatabox.p.rapidapi.com");
        assertThat(p.getProperty("flighttracker.confirmation.aerodatabox.search-by")).isEqualTo("Number");
        assertThat(p.getProperty("flighttracker.confirmation.aerodatabox.enabled")).isEqualTo("true");
        assertThat(p.getProperty("flighttracker.confirmation.aerodatabox.record-training-labels")).isEqualTo("false");
    }
}

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
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.client.ExpectedCount.once;
import static org.springframework.test.web.client.ExpectedCount.times;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** SwedaviaArrivalsProvider against reconstructed fixtures and a mock HTTP server; nothing leaves the JVM. */
class SwedaviaArrivalsProviderTest {

    static final String BASE = "https://api.swedavia.se/flightinfo/v2";
    static final String ARN_TODAY = BASE + "/ARN/arrivals/2026-10-12";
    static final LocalDate TODAY = LocalDate.parse("2026-10-12");

    private final TestClock clock = new TestClock();
    private MockRestServiceServer server;
    private RestClient.Builder builder;

    @BeforeEach
    void setUp() {
        clock.set(Instant.parse("2026-10-12T12:00:00Z"));
        builder = RestClient.builder();
        server = MockRestServiceServer.bindTo(builder).build();
    }

    private SwedaviaArrivalsProvider provider(boolean enabled, String key, String secondary) {
        return new SwedaviaArrivalsProvider(clock, new PhaseLogger(), new SwedaviaSettings(enabled, key, secondary, BASE), builder);
    }

    private SwedaviaArrivalsProvider provider() {
        return provider(true, "primary", "");
    }

    static String fixture(String name) throws IOException {
        return new String(new ClassPathResource("swedavia/" + name).getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    private BoardEntry byCallsign(BoardResult board, String callsign) {
        return board.entries().stream().filter(e -> callsign.equals(e.callsign())).findFirst().orElseThrow();
    }

    // ---- request

    @Test
    void sendsTheKeyAndTheHeadersToTheIataAndLocalDateUrl() throws IOException {
        server.expect(once(), requestTo(ARN_TODAY))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header("Ocp-Apim-Subscription-Key", "primary"))
                .andExpect(header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE))
                .andExpect(header(HttpHeaders.CACHE_CONTROL, "no-cache"))
                .andRespond(withSuccess(fixture("empty-arrivals.json"), MediaType.APPLICATION_JSON));

        BoardResult board = provider().fetchArrivals("ESSA", TODAY);

        server.verify();
        assertThat(board.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(board.entries()).isEmpty();
        assertThat(board.costUnits()).isEqualTo(1);
    }

    @Test
    void usesTheIataCodeOfTheAirport() {
        server.expect(once(), requestTo(BASE + "/GOT/arrivals/2026-10-13"))
                .andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));

        assertThat(provider().fetchArrivals("ESGG", LocalDate.parse("2026-10-13")).status()).isEqualTo(LookupResult.Status.FOUND);

        server.verify();
    }

    // ---- schedule boards (fetchBoardBody)

    @Test
    void aBoardBodyFetchReportsABodyANothingAskedOrAFailure() {
        server.expect(once(), requestTo(BASE + "/ARN/departures/2026-10-12")).andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));
        server.expect(once(), requestTo(BASE + "/BMA/arrivals/2026-10-12")).andRespond(withStatus(HttpStatus.BAD_REQUEST));
        server.expect(once(), requestTo(BASE + "/GOT/arrivals/2026-10-12")).andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR));
        SwedaviaArrivalsProvider p = provider();

        assertThat(p.fetchBoardBody("ARN", "departures", TODAY).hasBody()).isTrue();
        SwedaviaArrivalsProvider.BoardFetch noBoard = p.fetchBoardBody("BMA", "arrivals", TODAY);
        assertThat(noBoard.hasBody()).isFalse();
        assertThat(noBoard.failed()).isFalse();
        SwedaviaArrivalsProvider.BoardFetch down = p.fetchBoardBody("GOT", "arrivals", TODAY);
        assertThat(down.failed()).isTrue();
        assertThat(down.retryAfter()).isNull();
    }

    @Test
    void aBoardBodyFetchOn429CarriesTheRetryAfter() {
        server.expect(once(), requestTo(BASE + "/ARN/arrivals/2026-10-12"))
                .andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "120"));

        SwedaviaArrivalsProvider.BoardFetch r = provider().fetchBoardBody("ARN", "arrivals", TODAY);

        assertThat(r.failed()).isTrue();
        assertThat(r.retryAfter()).isEqualTo(java.time.Duration.ofSeconds(120));
    }

    // ---- mapping

    @Test
    void mapsEveryCaseOfTheArnFixture() throws IOException {
        server.expect(once(), requestTo(ARN_TODAY))
                .andRespond(withSuccess(fixture("arn-arrivals-2026-10-12.json"), MediaType.APPLICATION_JSON));

        BoardResult board = provider().fetchArrivals("ESSA", TODAY);

        assertThat(board.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(board.entries()).hasSize(7);

        // LAN with gate and bags: landed, and at the gate from the first bag.
        BoardEntry sas1402 = byCallsign(board, "SAS1402");
        assertThat(sas1402)
                .returns("SK1402", BoardEntry::flightNumber)
                .returns("SE-ROA", BoardEntry::registration);
        assertThat(sas1402.info())
                .returns(Instant.parse("2026-10-12T10:04:12Z"), ArrivalInfo::actualOn)
                .returns(Instant.parse("2026-10-12T10:14:00Z"), ArrivalInfo::actualIn)
                .returns("E5", ArrivalInfo::gate)
                .returns("5", ArrivalInfo::terminal)
                .returns("ESSA", ArrivalInfo::arrivalAirportIcao)
                .returns(2, ArrivalInfo::rank);

        // LAN without a first bag (only an estimate): landed, not at the gate.
        BoardEntry sas1404 = byCallsign(board, "SAS1404");
        assertThat(sas1404.info())
                .returns(Instant.parse("2026-10-12T10:20:00Z"), ArrivalInfo::actualOn)
                .returns(null, ArrivalInfo::actualIn)
                .returns("F3", ArrivalInfo::gate)
                .returns(1, ArrivalInfo::rank);

        // SCH: on the board, nothing to confirm.
        BoardEntry noz4001 = byCallsign(board, "NOZ4001");
        assertNothingToConfirm(noz4001, "NOZ4001");

        // DEL (deleted) and DIV (diverted) never confirm a landing, even with times and bags.
        for (String callsign : List.of("SAS2012", "SAS1500")) {
            assertNothingToConfirm(byCallsign(board, callsign), callsign);
        }

        // No locationAndStatus, a timestamp without Z, diIndicator inside flightLegIdentifier.
        BoardEntry fin861 = byCallsign(board, "FIN861");
        assertThat(fin861.info())
                .returns(Instant.parse("2026-10-12T11:30:00Z"), ArrivalInfo::actualOn)
                .returns(null, ArrivalInfo::gate)
                .returns(null, ArrivalInfo::terminal);

        // Nulls everywhere, an unknown field, an offset timestamp: matched by registration only.
        BoardEntry byReg = board.entries().stream().filter(e -> "SE-RUB".equals(e.registration())).findFirst().orElseThrow();
        assertThat(byReg)
                .returns(null, BoardEntry::callsign)
                .returns(null, BoardEntry::flightNumber);
        assertThat(byReg.info())
                .returns(Instant.parse("2026-10-12T12:10:00.250Z"), ArrivalInfo::actualOn)
                .returns(null, ArrivalInfo::gate);
    }

    /** On the board, but no landing and no gate to confirm, and ranked lowest. */
    private static void assertNothingToConfirm(BoardEntry entry, String callsign) {
        assertThat(entry.info()).as(callsign)
                .returns(null, ArrivalInfo::actualOn)
                .returns(null, ArrivalInfo::actualIn)
                .returns(0, ArrivalInfo::rank);
    }

    @Test
    void anEmptyBoardIsFoundAndEmpty() throws IOException {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(withSuccess(fixture("empty-arrivals.json"), MediaType.APPLICATION_JSON));

        BoardResult board = provider().fetchArrivals("ESSA", TODAY);

        assertThat(board.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(board.entries()).isEmpty();
    }

    @Test
    void aBodyWithoutFlightsOrWithNoBodyIsAnEmptyBoard() {
        server.expect(times(2), requestTo(ARN_TODAY))
                .andRespond(withSuccess("{\"numberOfFlights\":0}", MediaType.APPLICATION_JSON));

        assertThat(provider().fetchArrivals("ESSA", TODAY).entries()).isEmpty();
        assertThat(provider().fetchArrivals("ESSA", TODAY).status()).isEqualTo(LookupResult.Status.FOUND);
    }

    @Test
    void anUnreadableBodyFails() {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(withSuccess("<html>not json", MediaType.TEXT_HTML));

        assertThat(provider().fetchArrivals("ESSA", TODAY).status()).isEqualTo(LookupResult.Status.FAILED);
    }

    // ---- keys

    @Test
    void aRejectedKeyFailsTheFetchAtCostOne_andTheNextAttemptUsesTheOtherKey() throws IOException {
        SwedaviaArrivalsProvider provider = provider(true, "primary", "secondary");
        server.expect(once(), requestTo(ARN_TODAY))
                .andExpect(header("Ocp-Apim-Subscription-Key", "primary"))
                .andRespond(withStatus(HttpStatus.UNAUTHORIZED));
        server.expect(times(2), requestTo(ARN_TODAY))
                .andExpect(header("Ocp-Apim-Subscription-Key", "secondary"))
                .andRespond(withSuccess(fixture("empty-arrivals.json"), MediaType.APPLICATION_JSON));

        BoardResult first = provider.fetchArrivals("ESSA", TODAY); // no back-to-back retry
        assertThat(first.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(first.costUnits()).isEqualTo(1);
        assertThat(provider.enabled()).isTrue();

        BoardResult next = provider.fetchArrivals("ESSA", TODAY);
        BoardResult after = provider.fetchArrivals("ESSA", TODAY); // the key that worked stays preferred

        server.verify();
        assertThat(next.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(next.costUnits()).isEqualTo(1);
        assertThat(after.costUnits()).isEqualTo(1);
    }

    @Test
    void aForbiddenKeyIsTreatedLikeAnUnauthorisedOne() {
        SwedaviaArrivalsProvider provider = provider(true, "primary", "secondary");
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "primary"))
                .andRespond(withStatus(HttpStatus.FORBIDDEN));
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "secondary"))
                .andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));

        assertThat(provider.fetchArrivals("ESSA", TODAY).costUnits()).isEqualTo(1);
        assertThat(provider.fetchArrivals("ESSA", TODAY).status()).isEqualTo(LookupResult.Status.FOUND);
        server.verify();
    }

    @Test
    void bothKeysRejectedInARow_lockTheProviderOutUntilUtcMidnight() {
        PhaseLogger logger = mock(PhaseLogger.class);
        SwedaviaArrivalsProvider provider = new SwedaviaArrivalsProvider(clock, logger,
                new SwedaviaSettings(true, "primary", "secondary", BASE), builder);
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "primary"))
                .andRespond(withStatus(HttpStatus.UNAUTHORIZED));
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "secondary"))
                .andRespond(withStatus(HttpStatus.FORBIDDEN));

        BoardResult first = provider.fetchArrivals("ESSA", TODAY);
        assertThat(provider.enabled()).isTrue(); // one key left to try
        BoardResult second = provider.fetchArrivals("ESSA", TODAY);

        server.verify();
        assertThat(first.costUnits()).isEqualTo(1);
        assertThat(second)
                .returns(LookupResult.Status.FAILED, BoardResult::status)
                .returns(1, BoardResult::costUnits);
        assertThat(provider.enabled()).isFalse();
        verify(logger).degraded(contains("rejected every API key"));
        assertThat(provider.fetchArrivals("ESSA", TODAY).costUnits()).isZero(); // and no call is made while locked

        clock.set(Instant.parse("2026-10-12T23:59:59Z"));
        assertThat(provider.enabled()).isFalse();
        clock.set(Instant.parse("2026-10-13T00:00:00Z"));
        assertThat(provider.enabled()).isTrue();
    }

    @Test
    void aKeyThatWorksBetweenTwoRejections_resetsTheCount() throws IOException {
        SwedaviaArrivalsProvider provider = provider(true, "primary", "secondary");
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "primary"))
                .andRespond(withStatus(HttpStatus.UNAUTHORIZED));
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "secondary"))
                .andRespond(withSuccess(fixture("empty-arrivals.json"), MediaType.APPLICATION_JSON));
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "secondary"))
                .andRespond(withStatus(HttpStatus.UNAUTHORIZED));

        provider.fetchArrivals("ESSA", TODAY);
        provider.fetchArrivals("ESSA", TODAY);
        provider.fetchArrivals("ESSA", TODAY);

        server.verify();
        assertThat(provider.enabled()).isTrue(); // two rejections, but not in a row
    }

    @Test
    void aRejectedOnlyKeyFailsAtCostOne_andLocksTheProvider() {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(withStatus(HttpStatus.UNAUTHORIZED));
        SwedaviaArrivalsProvider provider = provider();

        BoardResult board = provider.fetchArrivals("ESSA", TODAY);

        assertThat(board.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(board.costUnits()).isEqualTo(1);
        assertThat(provider.enabled()).isFalse();
    }

    @Test
    void aSecondaryOnlyConfigurationUsesTheSecondary() {
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "secondary"))
                .andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));

        SwedaviaArrivalsProvider provider = provider(true, "", "secondary");

        assertThat(provider.enabled()).isTrue();
        assertThat(provider.fetchArrivals("ESSA", TODAY).costUnits()).isEqualTo(1);
        server.verify();
    }

    // ---- errors

    @Test
    void a429WithRetryAfterIsThrottledForThatLong() {
        server.expect(once(), requestTo(ARN_TODAY))
                .andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "120"));

        BoardResult board = provider().fetchArrivals("ESSA", TODAY);

        assertThat(board.status()).isEqualTo(LookupResult.Status.THROTTLED);
        assertThat(board.retryAfter()).isEqualTo(Duration.ofSeconds(120));
    }

    @Test
    void a429WithoutRetryAfterIsThrottledForSixtySeconds() {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));

        BoardResult board = provider().fetchArrivals("ESSA", TODAY);

        assertThat(board.status()).isEqualTo(LookupResult.Status.THROTTLED);
        assertThat(board.retryAfter()).isEqualTo(Duration.ofSeconds(60));
    }

    @Test
    void aRetryAfterThatIsAnHttpDateIsHonoured() {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS)
                .header(HttpHeaders.RETRY_AFTER, "Mon, 12 Oct 2026 12:05:00 GMT"));

        assertThat(provider().fetchArrivals("ESSA", TODAY).retryAfter()).isEqualTo(Duration.ofMinutes(5));
    }

    @Test
    void a400IsNotFoundNotFailed() throws IOException {
        server.expect(once(), requestTo(ARN_TODAY))
                .andRespond(withStatus(HttpStatus.BAD_REQUEST).contentType(MediaType.APPLICATION_JSON).body(fixture("error-400-date.json")));

        BoardResult board = provider().fetchArrivals("ESSA", TODAY);

        assertThat(board.status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(board.retryAfter()).isNull();
    }

    @Test
    void a500IsFailed() {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR));

        BoardResult board = provider().fetchArrivals("ESSA", TODAY);

        assertThat(board.status()).isEqualTo(LookupResult.Status.FAILED);
    }

    @Test
    void anotherClientErrorIsFailed() {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(withStatus(HttpStatus.NOT_FOUND));

        assertThat(provider().fetchArrivals("ESSA", TODAY).status()).isEqualTo(LookupResult.Status.FAILED);
    }

    @Test
    void anIoErrorIsFailed() {
        server.expect(once(), requestTo(ARN_TODAY)).andRespond(request -> {
            throw new IOException("connection reset");
        });

        assertThat(provider().fetchArrivals("ESSA", TODAY).status()).isEqualTo(LookupResult.Status.FAILED);
    }

    // ---- the date window

    @Test
    void aDateMoreThanSixDaysBackIsNotFoundWithoutACall() {
        BoardResult board = provider().fetchArrivals("ESSA", TODAY.minusDays(7));

        assertThat(board.status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(board.costUnits()).isZero();
        server.verify(); // no request was expected, none was made
    }

    @Test
    void sixDaysBackIsStillFetched() {
        server.expect(once(), requestTo(BASE + "/ARN/arrivals/2026-10-06"))
                .andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));

        assertThat(provider().fetchArrivals("ESSA", TODAY.minusDays(6)).status()).isEqualTo(LookupResult.Status.FOUND);
        server.verify();
    }

    @Test
    void aDateBeyondNinetyDaysAheadIsNotFoundWithoutACall() {
        BoardResult board = provider().fetchArrivals("ESSA", TODAY.plusDays(91));

        assertThat(board.status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(board.costUnits()).isZero();
    }

    @Test
    void theWindowFollowsTheLocalDateNotTheUtcOne() {
        // 23:30 UTC on 12 Oct is 01:30 local on 13 Oct, so 6 days back is the 7th.
        clock.set(Instant.parse("2026-10-12T23:30:00Z"));
        server.expect(once(), requestTo(BASE + "/ARN/arrivals/2026-10-07"))
                .andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));

        assertThat(provider().fetchArrivals("ESSA", LocalDate.parse("2026-10-06")).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(provider().fetchArrivals("ESSA", LocalDate.parse("2026-10-07")).status()).isEqualTo(LookupResult.Status.FOUND);
    }

    // ---- board date

    @Test
    void aSummerTouchdownAt2230UtcIsOnTheNextLocalDate() {
        SwedaviaArrivalsProvider provider = provider();

        assertBoardDates(provider, List.of(
                // CEST is UTC+2: 22:30Z on 12 Jul is 00:30 on 13 Jul.
                List.of("2026-07-12T22:30:00Z", "2026-07-13"),
                List.of("2026-07-12T21:59:00Z", "2026-07-12"),
                // CET is UTC+1: 22:30Z in January is still the same local day, 23:30 local.
                List.of("2026-01-12T22:30:00Z", "2026-01-12"),
                List.of("2026-01-12T23:00:00Z", "2026-01-13")));
    }

    @Test
    void theBoardDateFollowsTheDstSwitchesOfTheLastSundaysOfMarchAndOctober() {
        SwedaviaArrivalsProvider provider = provider();

        assertBoardDates(provider, List.of(
                // Sunday 29 March 2026: CET becomes CEST at 01:00Z. 00:30Z is 01:30 CET, still the 29th.
                List.of("2026-03-29T00:30:00Z", "2026-03-29"),
                // After the switch it is UTC+2: 21:59Z is 23:59 local, 22:30Z is 00:30 on the 30th.
                List.of("2026-03-29T21:59:00Z", "2026-03-29"),
                List.of("2026-03-29T22:30:00Z", "2026-03-30"),
                // The evening before is still UTC+1: 22:30Z on the 28th is 23:30 local.
                List.of("2026-03-28T22:30:00Z", "2026-03-28"),

                // Sunday 25 October 2026: CEST becomes CET at 01:00Z. 00:30Z is 02:30 CEST, the 25th.
                List.of("2026-10-25T00:30:00Z", "2026-10-25"),
                // After the switch it is UTC+1: 22:30Z is 23:30 local, still the 25th; 23:00Z is the 26th.
                List.of("2026-10-25T22:30:00Z", "2026-10-25"),
                List.of("2026-10-25T23:00:00Z", "2026-10-26"),
                // The evening before is still UTC+2: 22:30Z on the 24th is 00:30 on the 25th.
                List.of("2026-10-24T22:30:00Z", "2026-10-25")));
    }

    /** Each case is an instant and the board date it falls on. */
    private static void assertBoardDates(SwedaviaArrivalsProvider provider, List<List<String>> cases) {
        for (List<String> c : cases) {
            assertThat(provider.boardDate(Instant.parse(c.get(0)))).as(c.get(0)).isEqualTo(LocalDate.parse(c.get(1)));
        }
    }

    @Test
    void otherBoardProvidersKeepTheUtcDate() {
        AirportArrivalsProvider utc = new AirportArrivalsProvider() {
            @Override public String id() { return "x"; }
            @Override public boolean covers(String icao) { return true; }
            @Override public BoardResult fetchArrivals(String icao, LocalDate date) { return BoardResult.notFound(); }
        };

        assertThat(utc.boardDate(Instant.parse("2026-07-12T22:30:00Z"))).isEqualTo(LocalDate.parse("2026-07-12"));
    }

    // ---- enabled, covers, config

    @Test
    void disabledWithoutAKeyOrWithTheFlagOff() {
        assertThat(provider(true, "primary", "").enabled()).isTrue();
        assertThat(List.of(provider(true, "", ""), provider(true, "  ", null), provider(false, "primary", "")))
                .noneMatch(SwedaviaArrivalsProvider::enabled);
    }

    @Test
    void coversTheTenSwedaviaAirportsOnly() {
        SwedaviaArrivalsProvider provider = provider();

        for (String icao : List.of("ESSA", "ESSB", "ESGG", "ESMS", "ESPA", "ESNU", "ESNZ", "ESSV", "ESDF", "ESNQ", "essa")) {
            assertThat(provider.covers(icao)).as(icao).isTrue();
        }
        assertThat(provider.covers("ESKN")).as("Skavsta is not Swedavia").isFalse();
        assertThat(Arrays.asList("EKCH", null)).noneMatch(provider::covers);
        assertThat(provider.id()).isEqualTo("swedavia");
    }

    @Test
    void anUncoveredAirportIsNeverFetched() {
        assertThat(provider().fetchArrivals("EKCH", TODAY).status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(provider().fetchArrivals("EKCH", TODAY).costUnits()).isZero();
        server.verify();
    }

    @Test
    void applicationYmlSetsTheBudgetsAndKeepsThePacingAtLeastTwoSeconds() {
        YamlPropertiesFactoryBean yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        Properties p = yaml.getObject();

        assertThat(Integer.parseInt(p.getProperty("flighttracker.confirmation.min-interval-seconds"))).isGreaterThanOrEqualTo(2);
        assertThat(Stream.of(
                        "flighttracker.confirmation.providers.swedavia.monthly-budget",
                        "flighttracker.confirmation.providers.swedavia.daily-budget",
                        "flighttracker.confirmation.swedavia.base-url",
                        "flighttracker.confirmation.swedavia.api-key",
                        "flighttracker.confirmation.swedavia.api-key-secondary").map(p::getProperty))
                .containsExactly("9000", "300", BASE, "${SWEDAVIA_API_KEY:}", "${SWEDAVIA_API_KEY_SECONDARY:}");
    }
}

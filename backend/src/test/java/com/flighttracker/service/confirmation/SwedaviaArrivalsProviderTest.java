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
import java.util.List;
import java.util.Properties;

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
        return new SwedaviaArrivalsProvider(clock, new PhaseLogger(), enabled, key, secondary, BASE, builder);
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
        assertThat(sas1402.flightNumber()).isEqualTo("SK1402");
        assertThat(sas1402.registration()).isEqualTo("SE-ROA");
        assertThat(sas1402.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T10:04:12Z"));
        assertThat(sas1402.info().actualIn()).isEqualTo(Instant.parse("2026-10-12T10:14:00Z"));
        assertThat(sas1402.info().gate()).isEqualTo("E5");
        assertThat(sas1402.info().terminal()).isEqualTo("5");
        assertThat(sas1402.info().arrivalAirportIcao()).isEqualTo("ESSA");
        assertThat(sas1402.info().rank()).isEqualTo(2);

        // LAN without a first bag (only an estimate): landed, not at the gate.
        BoardEntry sas1404 = byCallsign(board, "SAS1404");
        assertThat(sas1404.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T10:20:00Z"));
        assertThat(sas1404.info().actualIn()).isNull();
        assertThat(sas1404.info().gate()).isEqualTo("F3");
        assertThat(sas1404.info().rank()).isEqualTo(1);

        // SCH: on the board, nothing to confirm.
        BoardEntry noz4001 = byCallsign(board, "NOZ4001");
        assertThat(noz4001.info().actualOn()).isNull();
        assertThat(noz4001.info().actualIn()).isNull();
        assertThat(noz4001.info().rank()).isZero();

        // DEL (deleted) and DIV (diverted) never confirm a landing, even with times and bags.
        for (String callsign : List.of("SAS2012", "SAS1500")) {
            BoardEntry e = byCallsign(board, callsign);
            assertThat(e.info().actualOn()).as(callsign).isNull();
            assertThat(e.info().actualIn()).as(callsign).isNull();
            assertThat(e.info().rank()).as(callsign).isZero();
        }

        // No locationAndStatus, a timestamp without Z, diIndicator inside flightLegIdentifier.
        BoardEntry fin861 = byCallsign(board, "FIN861");
        assertThat(fin861.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T11:30:00Z"));
        assertThat(fin861.info().gate()).isNull();
        assertThat(fin861.info().terminal()).isNull();

        // Nulls everywhere, an unknown field, an offset timestamp: matched by registration only.
        BoardEntry byReg = board.entries().stream().filter(e -> "SE-RUB".equals(e.registration())).findFirst().orElseThrow();
        assertThat(byReg.callsign()).isNull();
        assertThat(byReg.flightNumber()).isNull();
        assertThat(byReg.info().actualOn()).isEqualTo(Instant.parse("2026-10-12T12:10:00.250Z"));
        assertThat(byReg.info().gate()).isNull();
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
        SwedaviaArrivalsProvider provider = new SwedaviaArrivalsProvider(clock, logger, true, "primary", "secondary", BASE, builder);
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "primary"))
                .andRespond(withStatus(HttpStatus.UNAUTHORIZED));
        server.expect(once(), requestTo(ARN_TODAY)).andExpect(header("Ocp-Apim-Subscription-Key", "secondary"))
                .andRespond(withStatus(HttpStatus.FORBIDDEN));

        BoardResult first = provider.fetchArrivals("ESSA", TODAY);
        assertThat(provider.enabled()).isTrue(); // one key left to try
        BoardResult second = provider.fetchArrivals("ESSA", TODAY);

        server.verify();
        assertThat(first.costUnits()).isEqualTo(1);
        assertThat(second.status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(second.costUnits()).isEqualTo(1);
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

        // CEST is UTC+2: 22:30Z on 12 Jul is 00:30 on 13 Jul.
        assertThat(provider.boardDate(Instant.parse("2026-07-12T22:30:00Z"))).isEqualTo(LocalDate.parse("2026-07-13"));
        assertThat(provider.boardDate(Instant.parse("2026-07-12T21:59:00Z"))).isEqualTo(LocalDate.parse("2026-07-12"));
        // CET is UTC+1: 22:30Z in January is still the same local day, 23:30 local.
        assertThat(provider.boardDate(Instant.parse("2026-01-12T22:30:00Z"))).isEqualTo(LocalDate.parse("2026-01-12"));
        assertThat(provider.boardDate(Instant.parse("2026-01-12T23:00:00Z"))).isEqualTo(LocalDate.parse("2026-01-13"));
    }

    @Test
    void theBoardDateFollowsTheDstSwitchesOfTheLastSundaysOfMarchAndOctober() {
        SwedaviaArrivalsProvider provider = provider();

        // Sunday 29 March 2026: CET becomes CEST at 01:00Z. 00:30Z is 01:30 CET, still the 29th.
        assertThat(provider.boardDate(Instant.parse("2026-03-29T00:30:00Z"))).isEqualTo(LocalDate.parse("2026-03-29"));
        // After the switch it is UTC+2: 21:59Z is 23:59 local, 22:30Z is 00:30 on the 30th.
        assertThat(provider.boardDate(Instant.parse("2026-03-29T21:59:00Z"))).isEqualTo(LocalDate.parse("2026-03-29"));
        assertThat(provider.boardDate(Instant.parse("2026-03-29T22:30:00Z"))).isEqualTo(LocalDate.parse("2026-03-30"));
        // The evening before is still UTC+1: 22:30Z on the 28th is 23:30 local.
        assertThat(provider.boardDate(Instant.parse("2026-03-28T22:30:00Z"))).isEqualTo(LocalDate.parse("2026-03-28"));

        // Sunday 25 October 2026: CEST becomes CET at 01:00Z. 00:30Z is 02:30 CEST, the 25th.
        assertThat(provider.boardDate(Instant.parse("2026-10-25T00:30:00Z"))).isEqualTo(LocalDate.parse("2026-10-25"));
        // After the switch it is UTC+1: 22:30Z is 23:30 local, still the 25th; 23:00Z is the 26th.
        assertThat(provider.boardDate(Instant.parse("2026-10-25T22:30:00Z"))).isEqualTo(LocalDate.parse("2026-10-25"));
        assertThat(provider.boardDate(Instant.parse("2026-10-25T23:00:00Z"))).isEqualTo(LocalDate.parse("2026-10-26"));
        // The evening before is still UTC+2: 22:30Z on the 24th is 00:30 on the 25th.
        assertThat(provider.boardDate(Instant.parse("2026-10-24T22:30:00Z"))).isEqualTo(LocalDate.parse("2026-10-25"));
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
        assertThat(provider(true, "", "").enabled()).isFalse();
        assertThat(provider(true, "  ", null).enabled()).isFalse();
        assertThat(provider(false, "primary", "").enabled()).isFalse();
    }

    @Test
    void coversTheTenSwedaviaAirportsOnly() {
        SwedaviaArrivalsProvider provider = provider();

        for (String icao : List.of("ESSA", "ESSB", "ESGG", "ESMS", "ESPA", "ESNU", "ESNZ", "ESSV", "ESDF", "ESNQ")) {
            assertThat(provider.covers(icao)).as(icao).isTrue();
        }
        assertThat(provider.covers("essa")).isTrue();
        assertThat(provider.covers("ESKN")).as("Skavsta is not Swedavia").isFalse();
        assertThat(provider.covers("EKCH")).isFalse();
        assertThat(provider.covers(null)).isFalse();
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

        assertThat(p.getProperty("flighttracker.confirmation.providers.swedavia.monthly-budget")).isEqualTo("9000");
        assertThat(p.getProperty("flighttracker.confirmation.providers.swedavia.daily-budget")).isEqualTo("300");
        assertThat(Integer.parseInt(p.getProperty("flighttracker.confirmation.min-interval-seconds"))).isGreaterThanOrEqualTo(2);
        assertThat(p.getProperty("flighttracker.confirmation.swedavia.base-url")).isEqualTo(BASE);
        assertThat(p.getProperty("flighttracker.confirmation.swedavia.api-key")).isEqualTo("${SWEDAVIA_API_KEY:}");
        assertThat(p.getProperty("flighttracker.confirmation.swedavia.api-key-secondary")).isEqualTo("${SWEDAVIA_API_KEY_SECONDARY:}");
    }
}

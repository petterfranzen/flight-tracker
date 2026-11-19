package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.io.InputStream;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Locale;
import java.util.Map;

/**
 * Swedavia FlightInfo v2 arrivals boards (the ten Swedavia airports), the
 * first {@link AirportArrivalsProvider}. The contract, its open questions and
 * the sources are in {@code docs/agents/swedavia-api.md}; nothing here has been
 * run against the live API yet.
 *
 * <p>One call is {@code GET {base}/{IATA}/arrivals/{yyyy-MM-dd}} and returns the
 * whole day's board (no pagination). The date is the <b>local Swedish date</b>
 * (a third-party measurement; the PDF says UTC), so {@link #boardDate} files a
 * touchdown under its Europe/Stockholm date and the gateway caches by it.
 *
 * <p>Auth is a subscription key in {@code Ocp-Apim-Subscription-Key}. Keys
 * rotate every six months between a primary and a secondary. A fetch makes one
 * call with the preferred key. A 401/403 fails that fetch (cost 1) and switches
 * the preferred key, so the next attempt, after the gateway's pacing, uses the
 * other one: there is no back-to-back retry. Once every configured key has been
 * rejected in a row (expired keys, or possibly a 403 for an exhausted quota, as
 * Azure API Management does) the provider is {@link #enabled locked out} until
 * the next UTC midnight rather than burning a unit on every attempt.
 *
 * <p>What an entry says:
 * <ul>
 *   <li>{@code actualOn} is {@code arrivalTime.actualUtc}. The docs only say
 *       "actual time of arrival", so it may be touchdown or in-block: treat it
 *       as an upper bound on the touchdown.</li>
 *   <li>{@code actualIn} is {@code baggage.firstBagUtc}. Bags on the belt mean
 *       the aircraft is parked, so it is an upper bound on in-block and turns
 *       the state to AT_GATE. The API has no at-gate status code.</li>
 *   <li>CAN, DEL (deleted, not delayed) and DIV never confirm a landing here, so
 *       their actual times are dropped.</li>
 *   <li>An entry without {@code actualUtc} stays on the board with no times; the
 *       service ignores it.</li>
 * </ul>
 */
@Component
public class SwedaviaArrivalsProvider implements AirportArrivalsProvider {

    private static final Logger log = LoggerFactory.getLogger(SwedaviaArrivalsProvider.class);

    static final String ID = "swedavia";
    static final ZoneId LOCAL_ZONE = ZoneId.of("Europe/Stockholm");
    static final String KEY_HEADER = "Ocp-Apim-Subscription-Key";
    static final Duration DEFAULT_RETRY_AFTER = Duration.ofSeconds(60);

    /** The API answers 400 from 7 days back; 6 is the safe limit. */
    static final int MAX_DAYS_BACK = 6;
    /** Documented as 90 days ahead. */
    static final int MAX_DAYS_AHEAD = 90;

    /** ICAO to IATA for the ten Swedavia airports. */
    static final Map<String, String> IATA_BY_ICAO = Map.of(
            "ESSA", "ARN", "ESSB", "BMA", "ESGG", "GOT", "ESMS", "MMX", "ESPA", "LLA",
            "ESNU", "UME", "ESNZ", "OSD", "ESSV", "VBY", "ESDF", "RNB", "ESNQ", "KRN");

    /** One HTTP exchange, read out before the connection closes. */
    private record Http(int status, String retryAfter, String body) { }

    /** One day board to ask for: {@code GET /{iata}/{direction}/{date}}. */
    private record BoardRequest(String iata, String direction, LocalDate date) { }

    private final RestClient client;
    private final SwedaviaBoardParser parser = new SwedaviaBoardParser();
    private final Clock clock;
    private final PhaseLogger phases;
    private final SwedaviaKeys keys;
    private final boolean flag;

    @Autowired
    public SwedaviaArrivalsProvider(Clock clock, PhaseLogger phases, SwedaviaSettings settings) {
        this(clock, phases, settings, defaultBuilder());
    }

    /** For tests: a builder that may already be bound to a mock server. */
    SwedaviaArrivalsProvider(Clock clock, PhaseLogger phases, SwedaviaSettings settings, RestClient.Builder builder) {
        this.clock = clock;
        this.phases = phases;
        this.flag = settings.enabled();
        this.keys = new SwedaviaKeys(settings, clock);
        this.client = builder.baseUrl(settings.baseUrl()).build();
        if (flag && !keys.any()) {
            log.info("Swedavia arrival confirmation is disabled: no SWEDAVIA_API_KEY configured");
        }
    }

    private static RestClient.Builder defaultBuilder() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5_000);
        requestFactory.setReadTimeout(10_000);
        return RestClient.builder().requestFactory(requestFactory);
    }

    @Override
    public String id() {
        return ID;
    }

    /** The flag is on, at least one key is configured and the keys have not all just been rejected. */
    @Override
    public boolean enabled() {
        return flag && keys.any() && !keys.lockedOut();
    }

    @Override
    public boolean covers(String arrivalAirportIcao) {
        return arrivalAirportIcao != null && IATA_BY_ICAO.containsKey(arrivalAirportIcao.trim().toUpperCase(Locale.ROOT));
    }

    /** Swedavia boards are local Swedish dates. */
    @Override
    public LocalDate boardDate(Instant expectedArrival) {
        return expectedArrival.atZone(LOCAL_ZONE).toLocalDate();
    }

    @Override
    public BoardResult fetchArrivals(String arrivalAirportIcao, LocalDate boardDate) {
        String icao = normalised(arrivalAirportIcao);
        String iata = IATA_BY_ICAO.get(icao);
        if (iata == null || !canAsk(boardDate)) return BoardResult.failed().withCost(0);
        // Outside the window Swedavia answers 400: there is no board, and asking costs quota.
        if (outsideWindow(boardDate)) return BoardResult.notFound().withCost(0);

        BoardRequest request = new BoardRequest(iata, "arrivals", boardDate);
        Http http = call(request);
        if (http == null) return BoardResult.failed().withCost(1);
        return interpret(http, request, icao).withCost(1);
    }

    private static String normalised(String code) {
        return code == null ? "" : code.trim().toUpperCase(Locale.ROOT);
    }

    /** A date is given and the provider is on. */
    private boolean canAsk(LocalDate date) {
        return date != null && enabled();
    }

    /** Outside the API's window it answers 400: there is no board, and asking costs quota. */
    private boolean outsideWindow(LocalDate date) {
        LocalDate today = boardDate(clock.instant());
        return date.isBefore(today.minusDays(MAX_DAYS_BACK)) || date.isAfter(today.plusDays(MAX_DAYS_AHEAD));
    }

    /**
     * One request with the preferred key, tracking key rejections. Null when the connection never
     * produced an answer (timeouts, DNS, resets).
     */
    private Http call(BoardRequest request) {
        Http http;
        try {
            http = get(request);
        } catch (RuntimeException e) {
            log.debug("Swedavia {} {} failed: {}", request.iata(), request.date(), e.toString());
            phases.degraded("Swedavia FlightInfo unreachable: " + e.getClass().getSimpleName());
            return null;
        }
        if (isKeyRejection(http.status())) keyRejected();
        else keys.accepted();
        return http;
    }

    private static boolean isKeyRejection(int status) {
        return status == 401 || status == 403;
    }

    private static boolean isSuccess(int status) {
        return status >= 200 && status < 300;
    }

    /** True for the IATA code of one of the ten Swedavia airports. */
    public boolean servesIata(String iata) {
        return iata != null && IATA_BY_ICAO.containsValue(iata.trim().toUpperCase(Locale.ROOT));
    }

    /** What one board request came to: a body, nothing asked (off, outside the window, 400), a failure, or a 429. */
    public record BoardFetch(String body, boolean failed, Duration retryAfter) {
        static BoardFetch ok(String body) { return new BoardFetch(body, false, null); }
        static BoardFetch none() { return new BoardFetch(null, false, null); }
        static BoardFetch failure() { return new BoardFetch(null, true, null); }
        static BoardFetch throttled(Duration wait) { return new BoardFetch(null, true, wait); }
        public boolean hasBody() { return body != null; }
    }

    /**
     * The raw day board ({@code arrivals} or {@code departures}) for the flight search, using the same
     * keys, rotation and lock-out as {@link #fetchArrivals}. {@link BoardFetch#none()} when the provider is
     * off or the date is outside the API's window; a failure or 429 is reported so the caller can back off.
     * Callers cache, budget and pace; this does not.
     */
    public BoardFetch fetchBoardBody(String iata, String direction, LocalDate date) {
        if (!boardAskable(iata, date)) return BoardFetch.none();
        Http http = call(new BoardRequest(normalised(iata), direction, date));
        if (http == null) return BoardFetch.failure();
        if (isSuccess(http.status()) && http.body() != null) return BoardFetch.ok(http.body());
        log.warn("Swedavia {} {} {} answered {}", iata, direction, date, http.status());
        return failedBoardFetch(http);
    }

    /** One of the ten airports, a date inside the API's window, and the provider on. */
    private boolean boardAskable(String iata, LocalDate date) {
        if (!servesIata(iata) || !canAsk(date)) return false;
        return !outsideWindow(date);
    }

    private BoardFetch failedBoardFetch(Http http) {
        if (http.status() == 429) return BoardFetch.throttled(retryAfter(http));
        return http.status() == 400 ? BoardFetch.none() : BoardFetch.failure();
    }

    /** Next attempt uses the other key; when all of them have failed in a row, the provider locks until UTC midnight. */
    private void keyRejected() {
        Instant lockedUntil = keys.rejected();
        if (lockedUntil == null) return;
        String detail = "Swedavia FlightInfo rejected every API key; off until " + lockedUntil
                + " (expired keys, or the quota may be exhausted)";
        log.warn(detail);
        phases.degraded(detail);
    }

    private Http get(BoardRequest request) {
        return client.get()
                .uri("/{iata}/{direction}/{date}", request.iata(), request.direction(), request.date().toString())
                .header(KEY_HEADER, keys.preferred())
                .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .header(HttpHeaders.CACHE_CONTROL, "no-cache")
                .exchange((req, res) -> {
                    String body;
                    try (InputStream in = res.getBody()) {
                        body = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                    } catch (IOException e) {
                        body = null;
                    }
                    HttpStatusCode status = res.getStatusCode();
                    return new Http(status.value(), res.getHeaders().getFirst(HttpHeaders.RETRY_AFTER), body);
                });
    }

    private BoardResult interpret(Http http, BoardRequest request, String icao) {
        String iata = request.iata();
        LocalDate date = request.date();
        int status = http.status();
        if (isSuccess(status)) {
            try {
                return BoardResult.found(parser.parseBoard(http.body(), icao));
            } catch (RuntimeException e) {
                log.warn("Swedavia {} {} answered with a body that could not be read: {}", iata, date, e.toString());
                phases.degraded("Swedavia FlightInfo answered with an unreadable body");
                return BoardResult.failed();
            }
        }
        if (status == 400) {
            // "Date does not contain a valid date.": no board for that date.
            return BoardResult.notFound();
        }
        if (status == 429) {
            Duration wait = retryAfter(http);
            phases.degraded("Swedavia FlightInfo rate-limited us (429), backing off " + wait.toSeconds() + "s");
            return BoardResult.throttled(wait);
        }
        if (isKeyRejection(status)) {
            log.warn("Swedavia rejected the API key(s) ({}). Check SWEDAVIA_API_KEY and SWEDAVIA_API_KEY_SECONDARY", status);
            phases.degraded("Swedavia FlightInfo rejected the API key (" + status + ")");
            return BoardResult.failed();
        }
        log.warn("Swedavia {} {} answered {}", iata, date, status);
        phases.degraded("Swedavia FlightInfo answered " + status);
        return BoardResult.failed();
    }

    /** Retry-After as seconds or an HTTP date; anything else (or absent, or not positive) is 60 s. */
    private Duration retryAfter(Http http) {
        String header = http.retryAfter();
        if (header == null || header.isBlank()) return DEFAULT_RETRY_AFTER;
        String value = header.trim();
        try {
            long seconds = Long.parseLong(value);
            return seconds > 0 ? Duration.ofSeconds(seconds) : DEFAULT_RETRY_AFTER;
        } catch (NumberFormatException ignored) {
            // fall through to the date form
        }
        try {
            Duration d = Duration.between(clock.instant(), ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant());
            return d.isNegative() || d.isZero() ? DEFAULT_RETRY_AFTER : d;
        } catch (DateTimeParseException e) {
            return DEFAULT_RETRY_AFTER;
        }
    }
}

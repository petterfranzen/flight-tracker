package com.flighttracker.service.confirmation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.flighttracker.observability.PhaseLogger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
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
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
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
 * rotate every six months between a primary and a secondary, so a 401/403 with
 * the key in use is retried once with the other one (the call then costs 2
 * units), and the key that worked is tried first from then on.
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

    private static final List<String> NO_LANDING_STATUSES = List.of("CAN", "DEL", "DIV");

    /** One HTTP exchange, read out before the connection closes. */
    private record Http(int status, String retryAfter, String body) { }

    private final RestClient client;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Clock clock;
    private final PhaseLogger phases;
    private final String primaryKey;
    private final String secondaryKey;
    private final boolean flag;

    /** The key that answered last, so a rotated-out primary is not retried on every fetch. */
    private volatile boolean secondaryPreferred;

    @Autowired
    public SwedaviaArrivalsProvider(Clock clock,
                                    PhaseLogger phases,
                                    @Value("${flighttracker.confirmation.swedavia.enabled:true}") boolean enabled,
                                    @Value("${flighttracker.confirmation.swedavia.api-key:}") String apiKey,
                                    @Value("${flighttracker.confirmation.swedavia.api-key-secondary:}") String apiKeySecondary,
                                    @Value("${flighttracker.confirmation.swedavia.base-url:https://api.swedavia.se/flightinfo/v2}") String baseUrl) {
        this(clock, phases, enabled, apiKey, apiKeySecondary, baseUrl, defaultBuilder());
    }

    /** For tests: a builder that may already be bound to a mock server. */
    SwedaviaArrivalsProvider(Clock clock, PhaseLogger phases, boolean enabled, String apiKey, String apiKeySecondary,
                             String baseUrl, RestClient.Builder builder) {
        this.clock = clock;
        this.phases = phases;
        this.flag = enabled;
        this.primaryKey = apiKey == null ? "" : apiKey.trim();
        this.secondaryKey = apiKeySecondary == null ? "" : apiKeySecondary.trim();
        this.client = builder.baseUrl(baseUrl).build();
        if (flag && !hasKey()) {
            log.info("Swedavia arrival confirmation is disabled: no SWEDAVIA_API_KEY configured");
        }
    }

    private static RestClient.Builder defaultBuilder() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5_000);
        requestFactory.setReadTimeout(10_000);
        return RestClient.builder().requestFactory(requestFactory);
    }

    private boolean hasKey() {
        return !primaryKey.isEmpty() || !secondaryKey.isEmpty();
    }

    @Override
    public String id() {
        return ID;
    }

    /** The flag is on and at least one key is configured. */
    @Override
    public boolean enabled() {
        return flag && hasKey();
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
        String icao = arrivalAirportIcao == null ? "" : arrivalAirportIcao.trim().toUpperCase(Locale.ROOT);
        String iata = IATA_BY_ICAO.get(icao);
        if (iata == null || boardDate == null || !hasKey()) return BoardResult.failed().withCost(0);

        // Outside the window Swedavia answers 400: there is no board, and asking costs quota.
        LocalDate today = boardDate(clock.instant());
        if (boardDate.isBefore(today.minusDays(MAX_DAYS_BACK)) || boardDate.isAfter(today.plusDays(MAX_DAYS_AHEAD))) {
            return BoardResult.notFound().withCost(0);
        }

        List<String> keys = keysInOrder();
        int calls = 0;
        Http http = null;
        for (int i = 0; i < keys.size(); i++) {
            try {
                http = get(iata, boardDate, keys.get(i));
            } catch (RuntimeException e) {
                // Timeouts, DNS, resets: a connection that never produced an answer.
                log.debug("Swedavia {} {} failed: {}", iata, boardDate, e.toString());
                phases.degraded("Swedavia FlightInfo unreachable: " + e.getClass().getSimpleName());
                return BoardResult.failed().withCost(calls + 1);
            }
            calls++;
            if (http.status() != 401 && http.status() != 403) {
                if (i > 0 && http.status() < 400) secondaryPreferred = !secondaryPreferred;
                break;
            }
        }
        return interpret(http, iata, boardDate, icao).withCost(calls);
    }

    /** The primary first, then the secondary; reversed once the secondary has taken over. Blank keys are left out. */
    private List<String> keysInOrder() {
        List<String> keys = new ArrayList<>(2);
        String first = secondaryPreferred ? secondaryKey : primaryKey;
        String second = secondaryPreferred ? primaryKey : secondaryKey;
        if (!first.isEmpty()) keys.add(first);
        if (!second.isEmpty() && !second.equals(first)) keys.add(second);
        return keys;
    }

    private Http get(String iata, LocalDate date, String key) {
        return client.get()
                .uri("/{iata}/arrivals/{date}", iata, date.toString())
                .header(KEY_HEADER, key)
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

    private BoardResult interpret(Http http, String iata, LocalDate date, String icao) {
        int status = http.status();
        if (status >= 200 && status < 300) {
            try {
                return BoardResult.found(parseBoard(http.body(), icao));
            } catch (IOException | RuntimeException e) {
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
            Duration wait = retryAfter(http.retryAfter());
            phases.degraded("Swedavia FlightInfo rate-limited us (429), backing off " + wait.toSeconds() + "s");
            return BoardResult.throttled(wait);
        }
        if (status == 401 || status == 403) {
            log.warn("Swedavia rejected the API key(s) ({}). Check SWEDAVIA_API_KEY and SWEDAVIA_API_KEY_SECONDARY", status);
            phases.degraded("Swedavia FlightInfo rejected the API key (" + status + ")");
            return BoardResult.failed();
        }
        log.warn("Swedavia {} {} answered {}", iata, date, status);
        phases.degraded("Swedavia FlightInfo answered " + status);
        return BoardResult.failed();
    }

    /** Retry-After as seconds or an HTTP date; anything else (or absent, or not positive) is 60 s. */
    private Duration retryAfter(String header) {
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

    // ---- parsing

    /** Tolerant: unknown fields are ignored, every field may be absent or null. */
    List<BoardEntry> parseBoard(String body, String icao) throws IOException {
        if (body == null || body.isBlank()) return List.of();
        JsonNode flights = mapper.readTree(body).path("flights");
        if (!flights.isArray()) return List.of();
        List<BoardEntry> out = new ArrayList<>();
        for (JsonNode flight : flights) {
            BoardEntry entry = entry(flight, icao);
            if (entry != null) out.add(entry);
        }
        return out;
    }

    private BoardEntry entry(JsonNode flight, String icao) {
        JsonNode leg = flight.path("flightLegIdentifier");
        String callsign = text(leg.path("callsign"));
        String registration = text(leg.path("aircraftRegistration"));
        String flightNumber = text(flight.path("flightId"));
        if (callsign == null && registration == null) return null; // nothing to match it on

        JsonNode where = flight.path("locationAndStatus");
        String status = text(where.path("flightLegStatus"));
        Instant on = instant(flight.path("arrivalTime").path("actualUtc"));
        Instant in = instant(flight.path("baggage").path("firstBagUtc"));
        if (status != null && NO_LANDING_STATUSES.contains(status.toUpperCase(Locale.ROOT))) {
            on = null;
            in = null;
        }
        ArrivalInfo info = new ArrivalInfo(null, null, on, in, text(where.path("gate")), text(where.path("terminal")), icao);
        return new BoardEntry(callsign, flightNumber, registration, info);
    }

    private static String text(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) return null;
        String s = node.asText().trim();
        return s.isEmpty() ? null : s;
    }

    /** ISO timestamp with {@code Z}, with an offset, or with neither (then UTC: the fields are named Utc). */
    static Instant instant(JsonNode node) {
        String s = text(node);
        if (s == null) return null;
        try {
            return Instant.parse(s);
        } catch (DateTimeParseException ignored) {
            // next form
        }
        try {
            return OffsetDateTime.parse(s).toInstant();
        } catch (DateTimeParseException ignored) {
            // next form
        }
        try {
            return LocalDateTime.parse(s).toInstant(ZoneOffset.UTC);
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}

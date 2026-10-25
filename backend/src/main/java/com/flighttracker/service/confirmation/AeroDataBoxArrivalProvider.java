package com.flighttracker.service.confirmation;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
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
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AeroDataBox (via RapidAPI) as a global, per-flight {@link ArrivalConfirmationProvider}: the
 * fallback for every airport that no enabled board provider (Swedavia) covers. The contract,
 * its sources and its open questions are in {@code docs/agents/aerodatabox-api.md}; nothing
 * here has been run against the live API yet.
 *
 * <p>One lookup is {@code GET {base}/flights/{searchBy}/{callsign}?withAircraftImage=false&withLocation=false},
 * the "nearest flight" variant without a date (Tier 2, so {@link #callCost()} is 2 units). It
 * answers with an array (adjacent days, multi-leg flights, codeshares), 204 for no flight.
 * The free plan allows 400 units a month, so the budgets in {@code application.yml} leave
 * headroom; once the quota is spent the upstream rejects calls until it renews.
 *
 * <p>Choosing the entry: it must arrive at the query's airport (any, if the query has none), within
 * {@value #MAX_TIME_OFFSET_HOURS} h of the expected touchdown, and must not name another airframe
 * (a differing {@code aircraft.modeS}). The entry nearest the expected arrival wins; among entries
 * within {@value #TIE_BREAK_HOURS} h of that nearest one the operator beats the codeshares
 * ({@code IsOperator}, then {@code Unknown}, then the rest).
 *
 * <p>What an entry says:
 * <ul>
 *   <li>Only {@code status == Arrived} yields times. {@code actualOn} is
 *       {@code arrival.runwayTime.utc}, else {@code revisedTime.utc}.</li>
 *   <li>{@code actualIn} is {@code revisedTime.utc} only when a runway time exists and the revised
 *       time differs from it and is later (then the revised time is the gate time and the state is
 *       AT_GATE). Otherwise in-block is unknown.</li>
 *   <li>Canceled, Diverted, CanceledUncertain and every other status give no times, only the
 *       gate and terminal, which the service ignores without a time.</li>
 * </ul>
 *
 * <p>Quota: a lookup costs two of the free plan's 400 monthly units, so the budgets leave 7 lookups a
 * day. Because the answer rarely gets a distinct in-block time, the provider asks the gateway to keep a
 * FOUND without a gate time for {@code found-recheck-minutes} (30) and a NOT_FOUND for
 * {@code not-found-recheck-minutes} (180), and to stop asking once the landing is confirmed
 * ({@link #gateWait()} is zero). A callsign the API cannot take is {@link #accepts refused} locally,
 * before any charge; 400, 404 and 422 answers are NOT_FOUND; a request that got no HTTP response
 * is reported as costing nothing, so the gateway refunds it.
 *
 * <p>A 401/403 fails the lookup, logs one degraded line and switches the provider off until the next
 * UTC midnight (a bad key, or possibly an exhausted quota).
 *
 * <p>Terms (aerodatabox.com/terms, 5.5): the Basic plan may cache data for 7 days at most. The
 * in-memory caches are bounded and short, but a training label is long-lived, so
 * {@link #mayStoreLongTerm()} is false unless
 * {@code flighttracker.confirmation.aerodatabox.record-training-labels} is true.
 */
@Component
public class AeroDataBoxArrivalProvider implements ArrivalConfirmationProvider {

    private static final Logger log = LoggerFactory.getLogger(AeroDataBoxArrivalProvider.class);

    static final String ID = "aerodatabox";
    static final String KEY_HEADER = "X-RapidAPI-Key";
    static final String HOST_HEADER = "X-RapidAPI-Host";
    static final Duration DEFAULT_RETRY_AFTER = Duration.ofSeconds(60);
    /** The longest search parameter we send; a longer callsign is not a flight number the API knows. */
    static final int MAX_PARAM_LENGTH = 10;
    /** An entry whose time is further than this from the expected touchdown is another day's flight. */
    static final int MAX_TIME_OFFSET_HOURS = 12;
    /** Entries this close in time to the nearest one are told apart by the operator rank. */
    static final int TIE_BREAK_HOURS = 1;
    static final Duration DEFAULT_FOUND_RECHECK = Duration.ofMinutes(30);
    static final Duration DEFAULT_NOT_FOUND_RECHECK = Duration.ofHours(3);

    private static final Pattern SAFE_PARAM = Pattern.compile("[A-Za-z0-9]+");
    private static final Pattern TIME = Pattern.compile(
            "(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)\\s*(Z|z|[+-]\\d{2}(?::?\\d{2})?)?");

    /** One HTTP exchange, read out before the connection closes. */
    private record Http(int status, String retryAfter, String body) { }

    private final RestClient client;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Clock clock;
    private final PhaseLogger phases;
    private final boolean flag;
    private final String apiKey;
    private final String host;
    private final String searchBy;
    private final boolean recordTrainingLabels;
    private final Duration foundRecheck;
    private final Duration notFoundRecheck;
    private final Duration gateWait;

    /** While the clock is before this, the key was rejected and the provider is off. */
    private volatile Instant lockedUntil = Instant.EPOCH;

    @Autowired
    public AeroDataBoxArrivalProvider(Clock clock,
                                      PhaseLogger phases,
                                      @Value("${flighttracker.confirmation.aerodatabox.enabled:true}") boolean enabled,
                                      @Value("${flighttracker.confirmation.aerodatabox.api-key:}") String apiKey,
                                      @Value("${flighttracker.confirmation.aerodatabox.base-url:https://aerodatabox.p.rapidapi.com}") String baseUrl,
                                      @Value("${flighttracker.confirmation.aerodatabox.host:aerodatabox.p.rapidapi.com}") String host,
                                      @Value("${flighttracker.confirmation.aerodatabox.search-by:Number}") String searchBy,
                                      @Value("${flighttracker.confirmation.aerodatabox.record-training-labels:false}") boolean recordTrainingLabels,
                                      @Value("${flighttracker.confirmation.aerodatabox.found-recheck-minutes:30}") long foundRecheckMinutes,
                                      @Value("${flighttracker.confirmation.aerodatabox.not-found-recheck-minutes:180}") long notFoundRecheckMinutes,
                                      @Value("${flighttracker.confirmation.aerodatabox.gate-wait-minutes:0}") long gateWaitMinutes) {
        this(clock, phases, enabled, apiKey, baseUrl, host, searchBy, recordTrainingLabels,
                Duration.ofMinutes(foundRecheckMinutes), Duration.ofMinutes(notFoundRecheckMinutes),
                Duration.ofMinutes(gateWaitMinutes), defaultBuilder());
    }

    /** For tests: a builder that may already be bound to a mock server, and the default recheck intervals. */
    AeroDataBoxArrivalProvider(Clock clock, PhaseLogger phases, boolean enabled, String apiKey, String baseUrl,
                               String host, String searchBy, boolean recordTrainingLabels, RestClient.Builder builder) {
        this(clock, phases, enabled, apiKey, baseUrl, host, searchBy, recordTrainingLabels,
                DEFAULT_FOUND_RECHECK, DEFAULT_NOT_FOUND_RECHECK, Duration.ZERO, builder);
    }

    AeroDataBoxArrivalProvider(Clock clock, PhaseLogger phases, boolean enabled, String apiKey, String baseUrl,
                               String host, String searchBy, boolean recordTrainingLabels,
                               Duration foundRecheck, Duration notFoundRecheck, Duration gateWait,
                               RestClient.Builder builder) {
        this.clock = clock;
        this.phases = phases;
        this.flag = enabled;
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.host = host;
        this.searchBy = normalizeSearchBy(searchBy);
        this.recordTrainingLabels = recordTrainingLabels;
        this.foundRecheck = foundRecheck;
        this.notFoundRecheck = notFoundRecheck;
        this.gateWait = gateWait;
        this.client = builder.baseUrl(baseUrl).build();
        if (flag && this.apiKey.isEmpty()) {
            log.info("AeroDataBox arrival confirmation is disabled: no AERODATABOX_API_KEY configured");
        }
    }

    private static RestClient.Builder defaultBuilder() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5_000);
        requestFactory.setReadTimeout(10_000);
        return RestClient.builder().requestFactory(requestFactory);
    }

    /** {@code Number} or {@code CallSign}; anything else (a typo) falls back to {@code Number}. */
    private static String normalizeSearchBy(String value) {
        if (value != null && value.trim().equalsIgnoreCase("CallSign")) return "CallSign";
        return "Number";
    }

    @Override
    public String id() {
        return ID;
    }

    /** The flag is on, a key is configured and the key has not just been rejected. */
    @Override
    public boolean enabled() {
        return flag && !apiKey.isEmpty() && !clock.instant().isBefore(lockedUntil);
    }

    /** Global: any airport (the service skips it where an enabled board provider covers the airport), but not an unknown one. */
    @Override
    public boolean covers(String arrivalAirportIcao) {
        return arrivalAirportIcao != null && !arrivalAirportIcao.isBlank();
    }

    /** The key is present and accepted, and the callsign can be sent as a search parameter. */
    @Override
    public boolean accepts(ArrivalQuery query) {
        return enabled() && searchParam(query.callsign()) != null;
    }

    /** The gate time rarely moves quickly and a lookup costs two units of a small quota. */
    @Override
    public Duration foundRecheck() {
        return foundRecheck;
    }

    /** The flight may appear on the API later, but not worth two units every 15 minutes. */
    @Override
    public Duration notFoundRecheck() {
        return notFoundRecheck;
    }

    /** Zero by default: it rarely has a distinct in-block time, so stop asking once the landing is confirmed. */
    @Override
    public Duration gateWait() {
        return gateWait;
    }

    /** A Tier 2 lookup costs two units. */
    @Override
    public int callCost() {
        return 2;
    }

    /** False by default: the terms allow caching for 7 days at most, and a training label is kept for a year. */
    @Override
    public boolean mayStoreLongTerm() {
        return recordTrainingLabels;
    }

    @Override
    public LookupResult lookup(ArrivalQuery query) {
        if (!enabled()) return LookupResult.failed();
        String param = searchParam(query.callsign());
        if (param == null) return LookupResult.notFound();

        Http http;
        try {
            http = get(param);
        } catch (RuntimeException e) {
            // Timeouts, DNS, resets: a connection that never produced an answer.
            log.debug("AeroDataBox {} failed: {}", param, e.toString());
            phases.degraded("AeroDataBox unreachable: " + e.getClass().getSimpleName());
            // A refused or unresolvable connection never reached the API, so it used no quota.
            return neverSent(e) ? LookupResult.failed().withCost(0) : LookupResult.failed();
        }
        return interpret(http, query, param);
    }

    /** True when the cause chain says the request was never sent: no route, refused, unresolvable or a connect timeout. */
    static boolean neverSent(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause() == t ? null : t.getCause()) {
            if (t instanceof ConnectException || t instanceof UnknownHostException || t instanceof NoRouteToHostException) return true;
            if (t instanceof SocketTimeoutException && t.getMessage() != null
                    && t.getMessage().toLowerCase(Locale.ROOT).startsWith("connect")) return true;
        }
        return false;
    }

    /** The callsign trimmed, spaces removed, upper case; null when it is empty, has odd characters or is too long. */
    static String searchParam(String callsign) {
        if (callsign == null) return null;
        String s = callsign.replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
        if (s.isEmpty() || s.length() > MAX_PARAM_LENGTH || !SAFE_PARAM.matcher(s).matches()) return null;
        return s;
    }

    private Http get(String param) {
        return client.get()
                .uri("/flights/{searchBy}/{param}?withAircraftImage=false&withLocation=false", searchBy, param)
                .header(KEY_HEADER, apiKey)
                .header(HOST_HEADER, host)
                .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .exchange((req, res) -> {
                    String body;
                    try (InputStream in = res.getBody()) {
                        body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                    } catch (IOException e) {
                        body = null;
                    }
                    HttpStatusCode status = res.getStatusCode();
                    return new Http(status.value(), res.getHeaders().getFirst(HttpHeaders.RETRY_AFTER), body);
                });
    }

    private LookupResult interpret(Http http, ArrivalQuery query, String param) {
        int status = http.status();
        if (status == 204) return LookupResult.notFound();
        if (status >= 200 && status < 300) {
            if (http.body() == null) {
                // The answer arrived but its body could not be read: unknown, not "no flight".
                log.warn("AeroDataBox {} answered {} but the body could not be read", param, status);
                phases.degraded("AeroDataBox answered with an unreadable body");
                return LookupResult.failed();
            }
            try {
                return select(parse(http.body()), query);
            } catch (RuntimeException e) {
                log.warn("AeroDataBox {} answered with a body that could not be read: {}", param, e.toString());
                phases.degraded("AeroDataBox answered with an unreadable body");
                return LookupResult.failed();
            }
        }
        if (status == 429) {
            Duration wait = retryAfter(http.retryAfter());
            phases.degraded("AeroDataBox rate-limited us (429), backing off " + wait.toSeconds() + "s");
            return LookupResult.throttled(wait);
        }
        if (status == 401 || status == 403) {
            lockedUntil = clock.instant().atZone(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
            String detail = "AeroDataBox rejected the API key (" + status + "); off until " + lockedUntil
                    + " (check AERODATABOX_API_KEY, or the monthly quota may be spent)";
            log.warn(detail);
            phases.degraded(detail);
            return LookupResult.failed();
        }
        if (status == 400 || status == 404 || status == 422) {
            // The API does not know this flight number (or cannot take it): a stable answer, so cacheable.
            log.warn("AeroDataBox {} answered {}, treated as no such flight", param, status);
            return LookupResult.notFound();
        }
        log.warn("AeroDataBox {} answered {}", param, status);
        phases.degraded("AeroDataBox answered " + status);
        return LookupResult.failed();
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

    // ---- parsing and choosing

    /** One element of the response array, reduced to what the mapping needs. */
    record Leg(String status, String codeshareStatus, String modeS, String arrivalIcao,
               Instant scheduled, Instant revised, Instant runway, String gate, String terminal) {

        /** The best time the entry has, for matching it to the expected arrival. */
        Instant bestTime() {
            return runway != null ? runway : revised != null ? revised : scheduled;
        }
    }

    /** Tolerant: unknown fields are ignored, every field may be absent or null; an object is read as a one-element array. */
    List<Leg> parse(String body) {
        if (body == null || body.isBlank()) return List.of();
        JsonNode root = mapper.readTree(body);
        List<JsonNode> nodes = new ArrayList<>();
        if (root.isArray()) root.forEach(nodes::add);
        else if (root.isObject()) nodes.add(root);
        List<Leg> out = new ArrayList<>();
        for (JsonNode n : nodes) {
            JsonNode arrival = n.path("arrival");
            out.add(new Leg(
                    text(n.path("status")),
                    text(n.path("codeshareStatus")),
                    text(n.path("aircraft").path("modeS")),
                    text(arrival.path("airport").path("icao")),
                    time(arrival.path("scheduledTime")),
                    time(arrival.path("revisedTime")),
                    time(arrival.path("runwayTime")),
                    text(arrival.path("gate")),
                    text(arrival.path("terminal"))));
        }
        return out;
    }

    LookupResult select(List<Leg> legs, ArrivalQuery query) {
        String airport = query.arrivalAirportIcao() == null ? null : query.arrivalAirportIcao().trim().toUpperCase(Locale.ROOT);
        Instant expected = query.expectedArrivalAt();
        Duration window = Duration.ofHours(MAX_TIME_OFFSET_HOURS);

        List<Leg> fit = legs.stream()
                .filter(l -> airport == null || airport.equalsIgnoreCase(l.arrivalIcao()))
                .filter(l -> l.modeS() == null || query.icao24() == null || l.modeS().equalsIgnoreCase(query.icao24().trim()))
                .filter(l -> expected == null || l.bestTime() == null || distance(l, expected).compareTo(window) <= 0)
                .toList();
        if (fit.isEmpty()) return LookupResult.notFound();
        // The nearest in time wins; the operator rank only separates entries close to it.
        Duration nearest = fit.stream().map(l -> distance(l, expected)).min(Comparator.naturalOrder()).orElseThrow();
        Duration tie = nearest.plusHours(TIE_BREAK_HOURS);
        Leg best = fit.stream()
                .filter(l -> distance(l, expected).compareTo(tie) <= 0)
                .min(Comparator.comparingInt((Leg l) -> codeshareRank(l.codeshareStatus()))
                        .thenComparing(l -> distance(l, expected)))
                .orElseThrow();
        return LookupResult.found(info(best, airport));
    }

    private static Duration distance(Leg leg, Instant expected) {
        if (expected == null || leg.bestTime() == null) return expected == null ? Duration.ZERO : Duration.ofDays(3650);
        return Duration.between(leg.bestTime(), expected).abs();
    }

    /** IsOperator first, then Unknown (or absent), then the codeshares. */
    private static int codeshareRank(String status) {
        if (status == null) return 1;
        String s = status.toLowerCase(Locale.ROOT);
        if (s.equals("isoperator")) return 0;
        if (s.equals("unknown")) return 1;
        return 2;
    }

    private static ArrivalInfo info(Leg leg, String queryAirport) {
        Instant on = null;
        Instant in = null;
        if ("arrived".equalsIgnoreCase(leg.status())) {
            on = leg.runway() != null ? leg.runway() : leg.revised();
            if (leg.runway() != null && leg.revised() != null && leg.revised().isAfter(leg.runway())) {
                in = leg.revised();
            }
        }
        String airport = leg.arrivalIcao() != null ? leg.arrivalIcao().toUpperCase(Locale.ROOT) : queryAirport;
        return new ArrivalInfo(null, null, on, in, leg.gate(), leg.terminal(), airport);
    }

    private static String text(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) return null;
        String s = node.asText().trim();
        return s.isEmpty() ? null : s;
    }

    /** The {@code utc} member of a time object such as {@code {"utc": "2025-01-12 05:09Z", "local": "..."}}. */
    private static Instant time(JsonNode node) {
        return parseTime(text(node.path("utc")));
    }

    /**
     * AeroDataBox times are {@code yyyy-MM-dd HH:mm} followed by {@code Z} or {@code +HH:mm}. Also accepts
     * ISO with a {@code T}, optional seconds, an offset without a colon and no offset at all (then UTC:
     * the fields are named utc). Null for anything else.
     */
    static Instant parseTime(String value) {
        if (value == null) return null;
        Matcher m = TIME.matcher(value.trim());
        if (!m.matches()) return null;
        String time = m.group(2).length() == 5 ? m.group(2) + ":00" : m.group(2);
        String zone = m.group(3);
        if (zone == null || zone.equalsIgnoreCase("Z")) {
            zone = "Z";
        } else {
            String digits = zone.substring(1).replace(":", "");
            zone = zone.charAt(0) + digits.substring(0, 2) + ":" + (digits.length() > 2 ? digits.substring(2) : "00");
        }
        try {
            return OffsetDateTime.parse(m.group(1) + "T" + time + zone).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}

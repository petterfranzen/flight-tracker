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
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Locale;
import java.util.Set;
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
    private static final List<Class<? extends Throwable>> NEVER_SENT =
            List.of(ConnectException.class, UnknownHostException.class, NoRouteToHostException.class);
    private static final Set<Integer> NO_SUCH_FLIGHT = Set.of(400, 404, 422);

    /** One HTTP exchange, read out before the connection closes. */
    private record Http(int status, String retryAfter, String body) { }

    /** One lookup: the query and the search parameter its callsign became. */
    private record Request(ArrivalQuery query, String param) { }

    private final RestClient client;
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
    public AeroDataBoxArrivalProvider(Clock clock, PhaseLogger phases, AeroDataBoxSettings settings) {
        this(clock, phases, settings, defaultBuilder());
    }

    /** For tests: a builder that may already be bound to a mock server, and the default recheck intervals. */
    AeroDataBoxArrivalProvider(Clock clock, PhaseLogger phases, boolean enabled, String apiKey, String baseUrl,
                               String host, String searchBy, boolean recordTrainingLabels, RestClient.Builder builder) {
        this(clock, phases, new AeroDataBoxSettings(enabled, apiKey, baseUrl, host, searchBy, recordTrainingLabels,
                DEFAULT_FOUND_RECHECK.toMinutes(), DEFAULT_NOT_FOUND_RECHECK.toMinutes(), 0), builder);
    }

    AeroDataBoxArrivalProvider(Clock clock, PhaseLogger phases, AeroDataBoxSettings settings, RestClient.Builder builder) {
        this.clock = clock;
        this.phases = phases;
        this.flag = settings.enabled();
        this.apiKey = settings.apiKey() == null ? "" : settings.apiKey().trim();
        this.host = settings.host();
        this.searchBy = settings.searchByOrDefault();
        this.recordTrainingLabels = settings.recordTrainingLabels();
        this.foundRecheck = settings.foundRecheck();
        this.notFoundRecheck = settings.notFoundRecheck();
        this.gateWait = settings.gateWait();
        this.client = builder.baseUrl(settings.baseUrl()).build();
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
        return enabled() && searchParam(query) != null;
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
        String param = searchParam(query);
        if (param == null) return LookupResult.notFound();
        Request request = new Request(query, param);

        Http http;
        try {
            http = get(request);
        } catch (RuntimeException e) {
            // Timeouts, DNS, resets: a connection that never produced an answer.
            log.debug("AeroDataBox {} failed: {}", param, e.toString());
            phases.degraded("AeroDataBox unreachable: " + e.getClass().getSimpleName());
            // A refused or unresolvable connection never reached the API, so it used no quota.
            return neverSent(e) ? LookupResult.failed().withCost(0) : LookupResult.failed();
        }
        return interpret(http, request);
    }

    /** True when the cause chain says the request was never sent: no route, refused, unresolvable or a connect timeout. */
    static boolean neverSent(Throwable e) {
        for (Throwable t = e; t != null; t = nextCause(t)) {
            if (isConnectFailure(t)) return true;
        }
        return false;
    }

    /** The cause, or null at the end of the chain (including a throwable that is its own cause). */
    private static Throwable nextCause(Throwable t) {
        return t.getCause() == t ? null : t.getCause();
    }

    private static boolean isConnectFailure(Throwable t) {
        if (NEVER_SENT.stream().anyMatch(type -> type.isInstance(t))) return true;
        return t instanceof SocketTimeoutException && isConnectPhase(t);
    }

    private static boolean isConnectPhase(Throwable t) {
        return t.getMessage() != null && t.getMessage().toLowerCase(Locale.ROOT).startsWith("connect");
    }

    /** The query's callsign trimmed, spaces removed, upper case; null when it is empty, has odd characters or is too long. */
    static String searchParam(ArrivalQuery query) {
        String callsign = query.callsign();
        if (callsign == null) return null;
        String s = callsign.replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
        return s.length() <= MAX_PARAM_LENGTH && SAFE_PARAM.matcher(s).matches() ? s : null;
    }

    private Http get(Request request) {
        return client.get()
                .uri("/flights/{searchBy}/{param}?withAircraftImage=false&withLocation=false", searchBy, request.param())
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

    private LookupResult interpret(Http http, Request request) {
        String param = request.param();
        int status = http.status();
        if (status == 204) return LookupResult.notFound();
        if (status >= 200 && status < 300) return interpretBody(http, request);
        if (status == 429) return throttled(http);
        if (status == 401 || status == 403) return keyRejected(http);
        if (NO_SUCH_FLIGHT.contains(status)) {
            // The API does not know this flight number (or cannot take it): a stable answer, so cacheable.
            log.warn("AeroDataBox {} answered {}, treated as no such flight", param, status);
            return LookupResult.notFound();
        }
        log.warn("AeroDataBox {} answered {}", param, status);
        phases.degraded("AeroDataBox answered " + status);
        return LookupResult.failed();
    }

    private LookupResult interpretBody(Http http, Request request) {
        String param = request.param();
        if (http.body() == null) {
            // The answer arrived but its body could not be read: unknown, not "no flight".
            log.warn("AeroDataBox {} answered {} but the body could not be read", param, http.status());
            phases.degraded("AeroDataBox answered with an unreadable body");
            return LookupResult.failed();
        }
        try {
            return AeroDataBoxResponse.select(AeroDataBoxResponse.parse(http.body()), request.query());
        } catch (RuntimeException e) {
            log.warn("AeroDataBox {} answered with a body that could not be read: {}", param, e.toString());
            phases.degraded("AeroDataBox answered with an unreadable body");
            return LookupResult.failed();
        }
    }

    private LookupResult throttled(Http http) {
        Duration wait = retryAfter(http);
        phases.degraded("AeroDataBox rate-limited us (429), backing off " + wait.toSeconds() + "s");
        return LookupResult.throttled(wait);
    }

    /** A rejected key switches the provider off until the next UTC midnight. */
    private LookupResult keyRejected(Http http) {
        lockedUntil = clock.instant().atZone(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        String detail = "AeroDataBox rejected the API key (" + http.status() + "); off until " + lockedUntil
                + " (check AERODATABOX_API_KEY, or the monthly quota may be spent)";
        log.warn(detail);
        phases.degraded(detail);
        return LookupResult.failed();
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

    /** See {@link AeroDataBoxResponse#parseTime}. */
    static Instant parseTime(String value) {
        return AeroDataBoxResponse.parseTime(value);
    }
}

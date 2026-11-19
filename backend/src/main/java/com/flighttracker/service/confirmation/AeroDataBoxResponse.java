package com.flighttracker.service.confirmation;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reading an AeroDataBox flights answer and choosing the entry that is the queried arrival; the rules
 * are in {@link AeroDataBoxArrivalProvider}'s class comment.
 */
final class AeroDataBoxResponse {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern TIME = Pattern.compile(
            "(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)\\s*(Z|z|[+-]\\d{2}(?::?\\d{2})?)?");
    /** The distance of an entry without any time from a known expected arrival: after every timed entry. */
    private static final Duration NO_TIME_DISTANCE = Duration.ofDays(3650);

    private AeroDataBoxResponse() {
    }

    /** One element of the response array, reduced to what the mapping needs. */
    record Leg(String status, String codeshareStatus, String modeS, String arrivalIcao,
               Instant scheduled, Instant revised, Instant runway, String gate, String terminal) {

        /** The best time the entry has, for matching it to the expected arrival. */
        Instant bestTime() {
            if (runway != null) return runway;
            return revised != null ? revised : scheduled;
        }

        /** In-block is the revised time only when it is later than a known runway time. */
        Instant gateTime() {
            if (runway == null || revised == null) return null;
            return revised.isAfter(runway) ? revised : null;
        }
    }

    /** Tolerant: unknown fields are ignored, every field may be absent or null; an object is read as a one-element array. */
    static List<Leg> parse(String body) {
        if (body == null || body.isBlank()) return List.of();
        List<Leg> out = new ArrayList<>();
        for (JsonNode n : entries(MAPPER.readTree(body))) out.add(leg(n));
        return out;
    }

    private static List<JsonNode> entries(JsonNode root) {
        List<JsonNode> nodes = new ArrayList<>();
        if (root.isArray()) root.forEach(nodes::add);
        else if (root.isObject()) nodes.add(root);
        return nodes;
    }

    private static Leg leg(JsonNode n) {
        JsonNode arrival = n.path("arrival");
        return new Leg(
                text(n.path("status")),
                text(n.path("codeshareStatus")),
                text(n.path("aircraft").path("modeS")),
                text(arrival.path("airport").path("icao")),
                time(arrival.path("scheduledTime")),
                time(arrival.path("revisedTime")),
                time(arrival.path("runwayTime")),
                text(arrival.path("gate")),
                text(arrival.path("terminal")));
    }

    static LookupResult select(List<Leg> legs, ArrivalQuery query) {
        String airport = query.arrivalAirportIcao() == null ? null : query.arrivalAirportIcao().trim().toUpperCase(Locale.ROOT);
        Instant expected = query.expectedArrivalAt();
        Duration window = Duration.ofHours(AeroDataBoxArrivalProvider.MAX_TIME_OFFSET_HOURS);

        List<Leg> fit = legs.stream()
                .filter(l -> arrivesAt(l, airport))
                .filter(l -> sameAirframe(l, query.icao24()))
                .filter(l -> withinWindow(l, expected, window))
                .toList();
        if (fit.isEmpty()) return LookupResult.notFound();
        // The nearest in time wins; the operator rank only separates entries close to it.
        Duration nearest = fit.stream().map(l -> distance(l, expected)).min(Comparator.naturalOrder()).orElseThrow();
        Duration tie = nearest.plusHours(AeroDataBoxArrivalProvider.TIE_BREAK_HOURS);
        Leg best = fit.stream()
                .filter(l -> distance(l, expected).compareTo(tie) <= 0)
                .min(Comparator.comparingInt((Leg l) -> codeshareRank(l.codeshareStatus()))
                        .thenComparing(l -> distance(l, expected)))
                .orElseThrow();
        return LookupResult.found(info(best, airport));
    }

    /** Any airport when the query has none. */
    private static boolean arrivesAt(Leg leg, String airport) {
        return airport == null || airport.equalsIgnoreCase(leg.arrivalIcao());
    }

    /** Not another airframe: an entry or a query without a Mode S code never disagrees. */
    private static boolean sameAirframe(Leg leg, String icao24) {
        if (leg.modeS() == null || icao24 == null) return true;
        return leg.modeS().equalsIgnoreCase(icao24.trim());
    }

    /** Without an expected arrival or an entry time there is nothing to rule the entry out by. */
    private static boolean withinWindow(Leg leg, Instant expected, Duration window) {
        if (expected == null || leg.bestTime() == null) return true;
        return distance(leg, expected).compareTo(window) <= 0;
    }

    /** Zero without an expected arrival; an entry without a time sorts after every timed one. */
    private static Duration distance(Leg leg, Instant expected) {
        if (expected == null) return Duration.ZERO;
        if (leg.bestTime() == null) return NO_TIME_DISTANCE;
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
        boolean arrived = "arrived".equalsIgnoreCase(leg.status());
        Instant on = arrived ? onBlockTime(leg) : null;
        Instant in = arrived ? leg.gateTime() : null;
        String airport = leg.arrivalIcao() != null ? leg.arrivalIcao().toUpperCase(Locale.ROOT) : queryAirport;
        return new ArrivalInfo(null, null, on, in, leg.gate(), leg.terminal(), airport);
    }

    private static Instant onBlockTime(Leg leg) {
        return leg.runway() != null ? leg.runway() : leg.revised();
    }

    private static String text(JsonNode node) {
        if (isAbsent(node)) return null;
        String s = node.asText().trim();
        return s.isEmpty() ? null : s;
    }

    private static boolean isAbsent(JsonNode node) {
        return node == null || node.isMissingNode() || node.isNull();
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
        try {
            return OffsetDateTime.parse(m.group(1) + "T" + time + isoZone(m.group(3))).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** {@code Z} for none or Z, else the offset as {@code ±HH:mm}. */
    private static String isoZone(String zone) {
        if (zone == null || zone.equalsIgnoreCase("Z")) return "Z";
        String digits = zone.substring(1).replace(":", "");
        String minutes = digits.length() > 2 ? digits.substring(2) : "00";
        return zone.charAt(0) + digits.substring(0, 2) + ":" + minutes;
    }
}

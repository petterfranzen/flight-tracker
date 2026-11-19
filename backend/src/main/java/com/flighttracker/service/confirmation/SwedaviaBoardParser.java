package com.flighttracker.service.confirmation;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reads a Swedavia FlightInfo v2 arrivals board into {@link BoardEntry}s. What
 * each field means is in {@link SwedaviaArrivalsProvider}'s class comment.
 */
final class SwedaviaBoardParser {

    private static final List<String> NO_LANDING_STATUSES = List.of("CAN", "DEL", "DIV");

    private final ObjectMapper mapper = new ObjectMapper();

    /** Tolerant: unknown fields are ignored, every field may be absent or null. */
    List<BoardEntry> parseBoard(String body, String icao) {
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

    private static BoardEntry entry(JsonNode flight, String icao) {
        JsonNode leg = flight.path("flightLegIdentifier");
        String callsign = text(leg.path("callsign"));
        String registration = text(leg.path("aircraftRegistration"));
        String flightNumber = text(flight.path("flightId"));
        if (callsign == null && registration == null) return null; // nothing to match it on

        JsonNode where = flight.path("locationAndStatus");
        Instant on = null;
        Instant in = null;
        if (mayHaveLanded(text(where.path("flightLegStatus")))) {
            on = instant(flight.path("arrivalTime").path("actualUtc"));
            in = instant(flight.path("baggage").path("firstBagUtc"));
        }
        ArrivalInfo info = new ArrivalInfo(null, null, on, in, text(where.path("gate")), text(where.path("terminal")), icao);
        return new BoardEntry(callsign, flightNumber, registration, info);
    }

    /** CAN, DEL (deleted, not delayed) and DIV never confirm a landing here. */
    private static boolean mayHaveLanded(String status) {
        return status == null || !NO_LANDING_STATUSES.contains(status.toUpperCase(Locale.ROOT));
    }

    private static String text(JsonNode node) {
        if (isAbsent(node)) return null;
        String s = node.asText().trim();
        return s.isEmpty() ? null : s;
    }

    private static boolean isAbsent(JsonNode node) {
        return node == null || node.isMissingNode() || node.isNull();
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

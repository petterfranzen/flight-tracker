package com.flighttracker.profile;

import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Set;

import static com.flighttracker.profile.ProfileLimitException.Reason.INVALID;
import static com.flighttracker.profile.ProfileLimitException.Reason.TOO_LONG;

/**
 * Server-side bounds on what a profile may store, checked by the repositories
 * before anything is written (nothing is truncated).
 *
 * Values come from what frontend/src/favorites.ts and watchlist.ts store: a
 * FavoriteRoute is two ICAO codes, two optional names and two optional IATA
 * codes (about 200 bytes of JSON), a FavoriteAircraft three short strings
 * (about 100 bytes), so 2 KB leaves 10x headroom for a new field. Keys are
 * routeKey (ICAO-ICAO) or an icao24 (6 hex), a flight number is at most about
 * 8 chars, an airport an ICAO code (4). The row caps are far above what a
 * person favourites by hand.
 */
public final class ProfileLimits {

    public static final int MAX_FAVORITE_DATA_BYTES = 2048;
    public static final int MAX_ITEM_KEY_LENGTH = 32;
    public static final int MAX_FLIGHT_NUMBER_LENGTH = 16;
    public static final int MAX_AIRPORT_LENGTH = 8;
    public static final int MAX_LABEL_LENGTH = 80;
    public static final int MAX_FAVORITES_PER_PROFILE = 200;
    public static final int MAX_WATCHED_FLIGHTS_PER_PROFILE = 50;

    public static final Set<String> FAVORITE_KINDS = Set.of("route", "aircraft");

    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    private ProfileLimits() {
    }

    public static void checkFavorite(String kind, String itemKey, String data) {
        if (kind == null || !FAVORITE_KINDS.contains(kind)) {
            throw new ProfileLimitException(INVALID, "kind", "kind must be one of " + FAVORITE_KINDS);
        }
        requireText("itemKey", itemKey, MAX_ITEM_KEY_LENGTH);
        if (data == null) {
            throw new ProfileLimitException(INVALID, "data", "data is required");
        }
        if (data.getBytes(StandardCharsets.UTF_8).length > MAX_FAVORITE_DATA_BYTES) {
            throw new ProfileLimitException(TOO_LONG, "data",
                    "data exceeds " + MAX_FAVORITE_DATA_BYTES + " bytes");
        }
        try {
            JsonNode node = JSON.readTree(data);
            if (node == null || node.isMissingNode()) {
                throw new IllegalArgumentException("empty");
            }
        } catch (Exception e) {
            throw new ProfileLimitException(INVALID, "data", "data is not valid JSON");
        }
    }

    public static void checkWatchedFlight(String flightNumber, String flightDate, String airport, String label) {
        requireText("flightNumber", flightNumber, MAX_FLIGHT_NUMBER_LENGTH);
        requireText("airport", airport, MAX_AIRPORT_LENGTH);
        checkFlightDate(flightDate);
        if (label != null && label.length() > MAX_LABEL_LENGTH) {
            throw new ProfileLimitException(TOO_LONG, "label", "label exceeds " + MAX_LABEL_LENGTH + " chars");
        }
    }

    /** flight_date must be a real calendar date written yyyy-MM-dd (the prune compares it as text). */
    public static void checkFlightDate(String flightDate) {
        if (flightDate == null || flightDate.length() != 10) {
            throw new ProfileLimitException(INVALID, "flightDate", "flightDate must be yyyy-MM-dd");
        }
        try {
            LocalDate.parse(flightDate);
        } catch (DateTimeParseException e) {
            throw new ProfileLimitException(INVALID, "flightDate", "flightDate must be a valid yyyy-MM-dd date");
        }
    }

    private static void requireText(String field, String value, int max) {
        if (value == null || value.isBlank()) {
            throw new ProfileLimitException(INVALID, field, field + " is required");
        }
        if (value.length() > max) {
            throw new ProfileLimitException(TOO_LONG, field, field + " exceeds " + max + " chars");
        }
    }
}

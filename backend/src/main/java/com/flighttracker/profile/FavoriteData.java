package com.flighttracker.profile;

import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;

import static com.flighttracker.profile.ProfileLimitException.Reason.INVALID;
import static com.flighttracker.profile.ProfileLimitException.Reason.TOO_LONG;
import static com.flighttracker.profile.ProfileLimits.MAX_FAVORITE_DATA_BYTES;

/** The {@code data} check behind {@link ProfileLimits#checkFavorite}. */
final class FavoriteData {

    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    private FavoriteData() {
    }

    static void check(String data) {
        if (data == null) {
            throw new ProfileLimitException(INVALID, "data", "data is required");
        }
        if (data.getBytes(StandardCharsets.UTF_8).length > MAX_FAVORITE_DATA_BYTES) {
            throw new ProfileLimitException(TOO_LONG, "data",
                    "data exceeds " + MAX_FAVORITE_DATA_BYTES + " bytes");
        }
        if (!isJsonObject(data)) {
            throw new ProfileLimitException(INVALID, "data", "data must be a JSON object");
        }
    }

    /**
     * The frontend only stores a FavoriteRoute/FavoriteAircraft object, so a
     * bare scalar, an array, JSON null or unparseable text does not count as
     * valid data.
     */
    private static boolean isJsonObject(String data) {
        try {
            JsonNode node = JSON.readTree(data);
            return node != null && node.isObject();
        } catch (Exception e) {
            return false;
        }
    }
}

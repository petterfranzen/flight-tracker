package com.flighttracker.model;

import java.time.Instant;

/**
 * One row of the favorite table (schema.sql), keyed the way the frontend
 * already keys a favourite: (profile_id, kind, item_key). `data` is the
 * FavoriteRoute / FavoriteAircraft JSON the frontend speaks (favorites.ts),
 * stored verbatim so the server never has to know what a favourite *is*.
 */
public record Favorite(
        String profileId,
        String kind,
        String itemKey,
        String data,
        Instant updatedAt
) {
}

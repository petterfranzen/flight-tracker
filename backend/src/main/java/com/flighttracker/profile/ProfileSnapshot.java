package com.flighttracker.profile;

import tools.jackson.databind.JsonNode;

import java.util.List;

/**
 * The body of {@code GET /api/profile} (design section9-hq #84, step 5a-2, D4):
 * who is signed in and the two lists the app keeps for them.
 *
 * <p>The field names and order are the contract the SPA reads — {@code provider},
 * {@code favorites}, {@code watched} (D4) — so they are pinned by the tests. No
 * profile id, subject or hash is ever part of this body (design §3): the client
 * is identified by its session, not by an id it could enumerate.
 *
 * <p>Each list holds the profile's own rows with the server-side fields dropped.
 * A favourite is its stored {@code kind} and {@code itemKey} plus the frontend's
 * own {@code data} object (parsed, so the client reads back the shape it wrote);
 * a watched flight is its key and its label. An empty list means an empty
 * list — a brand-new profile has no rows.
 */
public record ProfileSnapshot(String provider, List<FavoriteItem> favorites, List<WatchedItem> watched) {

    /** One favourite row minus the profile id: the client's own kind, key and data. */
    public record FavoriteItem(String kind, String itemKey, JsonNode data) {
    }

    /** One watched-flight row minus the profile id and its timestamp. */
    public record WatchedItem(String flightNumber, String flightDate, String airport, String label) {
    }
}

package com.flighttracker.profile;

import com.flighttracker.model.Favorite;
import com.flighttracker.model.Profile;
import com.flighttracker.model.WatchedFlight;
import com.flighttracker.repository.FavoriteRepository;
import com.flighttracker.repository.WatchedFlightRepository;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;

/**
 * The read half of the profile API (design section9-hq #84, step 5a-2): turns a
 * signed-in {@code (provider, subject)} into the body {@code GET /api/profile}
 * answers with.
 *
 * <p>The profile row is resolved through {@link ProfileResolver} — the same
 * first-sight insert the login path uses — so a read of a profile the server has
 * never seen creates it and answers with two empty lists rather than a 404.
 *
 * <p>The profile id, the subject and its hash are server-side only and never
 * appear in what this returns (design §3). A favourite keeps its stored
 * {@code kind} and {@code itemKey} and its {@code data}, parsed back to a JSON
 * object so the client gets the shape it wrote; the server still never inspects
 * what a favourite *is*. A watched flight keeps its key and label.
 *
 * <p>Flag-conditional, like {@link ProfileResolver} and {@code AuthController}:
 * with {@code flighttracker.profile.enabled=false} (the default) the bean does
 * not exist at all, so the flag-off app is unchanged.
 */
@Service
@ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
public class ProfileReader {

    private final ProfileResolver resolver;
    private final FavoriteRepository favorites;
    private final WatchedFlightRepository watchedFlights;
    private final ObjectMapper json;

    public ProfileReader(ProfileResolver resolver,
                         FavoriteRepository favorites,
                         WatchedFlightRepository watchedFlights,
                         ObjectMapper json) {
        this.resolver = resolver;
        this.favorites = favorites;
        this.watchedFlights = watchedFlights;
        this.json = json;
    }

    /** The signed-in user's profile: who they are and the rows it holds. */
    public ProfileSnapshot read(String provider, String subject) {
        Profile profile = resolver.resolve(provider, subject);
        return new ProfileSnapshot(provider, favoriteItems(profile.id()), watchedItems(profile.id()));
    }

    private List<ProfileSnapshot.FavoriteItem> favoriteItems(String profileId) {
        return favorites.findByProfileId(profileId).stream().map(this::toFavoriteItem).toList();
    }

    private ProfileSnapshot.FavoriteItem toFavoriteItem(Favorite row) {
        return new ProfileSnapshot.FavoriteItem(row.kind(), row.itemKey(), dataObject(row.data()));
    }

    /** The stored data verbatim, as a JSON object: the client wrote one, it reads one back. */
    private JsonNode dataObject(String data) {
        return json.readTree(data);
    }

    private List<ProfileSnapshot.WatchedItem> watchedItems(String profileId) {
        return watchedFlights.findByProfileId(profileId).stream()
                .map(ProfileReader::toWatchedItem).toList();
    }

    private static ProfileSnapshot.WatchedItem toWatchedItem(WatchedFlight row) {
        return new ProfileSnapshot.WatchedItem(
                row.flightNumber(), row.flightDate(), row.airport(), row.label());
    }
}

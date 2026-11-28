package com.flighttracker.controller;

import com.flighttracker.profile.ProfileLimitException;
import com.flighttracker.profile.ProfileLimits;
import com.flighttracker.profile.ProfileResolver;
import com.flighttracker.repository.FavoriteRepository;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;

/**
 * The favourite half of the profile write API (design section9-hq #84, step
 * 5b-1, D4): {@code PUT /api/profile/favorite} upserts one favourite and
 * {@code DELETE /api/profile/favorite} removes one.
 *
 * <p>The profile is resolved through {@link ProfileResolver} — the same
 * first-sight insert the read uses ({@code ProfileReader}) — so a write to a
 * profile the server has never seen creates it and then applies the write; a
 * request is validated in full before that, so a rejected write creates nothing. The
 * profile id, the subject and its hash are server-side only (design §3) and
 * never appear in a request or a response.
 *
 * <p>Mapped only with {@code flighttracker.profile.enabled=true}, exactly like
 * {@code AuthController} and {@code ProfileResolver}. With the flag off there is
 * no bean at all, so the paths do not exist: the flag-off chain is permitAll
 * with CSRF off, and an always-mapped write would be reachable anonymously in
 * production.
 *
 * <p>Errors are <b>controller-local</b>, not a global handler. A write that
 * breaks a cap in {@code ProfileLimits} throws {@link ProfileLimitException},
 * which the handler below maps to {@code 409} for a full profile
 * ({@link ProfileLimitException.Reason#TOO_MANY_ROWS}, 200 favourites) and
 * {@code 400} for everything else — a missing or blank {@code kind}/{@code
 * itemKey}, an unknown kind, {@code data} that is not a JSON object, or
 * {@code data} over 2048 bytes. CSRF and the signed-out case are the flag-on
 * chain's job, not this controller's: a write with no token is a {@code 403},
 * an anonymous one a {@code 401}.
 */
@RestController
@RequestMapping("/api/profile")
@ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
public class ProfileDataController {

    private final ProfileResolver resolver;
    private final FavoriteRepository favorites;
    private final ObjectMapper json;

    public ProfileDataController(ProfileResolver resolver, FavoriteRepository favorites, ObjectMapper json) {
        this.resolver = resolver;
        this.favorites = favorites;
        this.json = json;
    }

    /**
     * Upserts one favourite: {@code {kind, itemKey, data}} (D4). The repository
     * enforces the caps ({@code ProfileLimits.checkFavorite}), so a full profile
     * is a {@code 409} and a bad row — the kind, the key or the data — a
     * {@code 400}, both through the handler below.
     */
    @PutMapping("/favorite")
    public ResponseEntity<Void> putFavorite(@RequestBody FavoriteWriteRequest body, Authentication authentication) {
        requireKey(body.kind(), body.itemKey());
        String data = data(body.data());
        // Validate the whole row before resolving: resolving creates a first-sight
        // profile, and a rejected write must not leave one behind.
        ProfileLimits.checkFavorite(body.kind(), body.itemKey(), data);
        favorites.upsert(new FavoriteRepository.Key(profileId(authentication), body.kind(), body.itemKey()), data);
        return ResponseEntity.ok().build();
    }

    /**
     * Removes one favourite: {@code kind} and {@code itemKey} as query
     * parameters. Answers {@code 204} whether the row existed or not, so a
     * caller cannot probe another profile; a missing or blank key is a
     * {@code 400} (the same input rule as the write).
     */
    @DeleteMapping("/favorite")
    public ResponseEntity<Void> deleteFavorite(@RequestParam(required = false) String kind,
                                               @RequestParam(required = false) String itemKey,
                                               Authentication authentication) {
        requireKey(kind, itemKey);
        favorites.delete(new FavoriteRepository.Key(profileId(authentication), kind, itemKey));
        return ResponseEntity.noContent().build();
    }

    /** The signed-in user's profile id, resolved on first sight and never exposed. */
    private String profileId(Authentication authentication) {
        return resolver.resolve(provider(authentication), authentication.getName()).id();
    }

    /** The registration id for an OAuth2 login (google or github); the name otherwise, as the read does. */
    private static String provider(Authentication authentication) {
        return authentication instanceof OAuth2AuthenticationToken token
                ? token.getAuthorizedClientRegistrationId()
                : authentication.getName();
    }

    /** The request's data as the JSON text a row stores; {@code null} stays null for the limits check. */
    private String data(JsonNode data) {
        return data == null || data.isNull() ? null : json.writeValueAsString(data);
    }

    private static void requireKey(String kind, String itemKey) {
        if (kind == null || kind.isBlank()) {
            throw new ProfileLimitException(ProfileLimitException.Reason.INVALID, "kind", "kind is required");
        }
        if (itemKey == null || itemKey.isBlank()) {
            throw new ProfileLimitException(ProfileLimitException.Reason.INVALID, "itemKey", "itemKey is required");
        }
    }

    /**
     * The one error mapping this API owns: a full profile is a {@code 409}, every
     * other {@link ProfileLimitException} a {@code 400}. The body names the field
     * and the reason — input field names only, never a profile id or subject.
     */
    @ExceptionHandler(ProfileLimitException.class)
    public ResponseEntity<Map<String, String>> onProfileLimit(ProfileLimitException e) {
        HttpStatus status = e.reason() == ProfileLimitException.Reason.TOO_MANY_ROWS
                ? HttpStatus.CONFLICT
                : HttpStatus.BAD_REQUEST;
        return ResponseEntity.status(status).body(Map.of("field", e.field(), "error", e.getMessage()));
    }

    /** The body of a favourite write (D4): {@code {kind, itemKey, data}}. */
    public record FavoriteWriteRequest(String kind, String itemKey, JsonNode data) {
    }
}

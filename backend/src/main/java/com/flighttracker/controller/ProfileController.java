package com.flighttracker.controller;

import com.flighttracker.profile.ProfileProperties;
import com.flighttracker.profile.ProfileReader;
import com.flighttracker.profile.ProfileSnapshot;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The profile read (design §84, step 5a-2): who is signed in, and the
 * favourites and watched flights their profile holds.
 *
 * <p>The endpoint is always mapped, so the flag's off state is observable to
 * the SPA exactly as designed (§7): with
 * {@code flighttracker.profile.enabled=false} it answers {@code 503} and the
 * frontend shows no sign-in control, never a broken one. With the flag on, the
 * security chain has already rejected an anonymous caller with {@code 401}, so
 * reaching the body means there is a session.
 *
 * <p>The rows are read by {@link ProfileReader}, which only exists with the flag
 * on — hence the {@link ObjectProvider}: with the flag off there is no reader
 * bean and this answers the 503 above, without ever asking for one.
 *
 * <p>Only the provider id and the profile's own lists are returned: no email,
 * no name, no avatar (§1.3), and no profile id or subject (§3).
 */
@RestController
@RequestMapping("/api/profile")
public class ProfileController {

    private final ProfileProperties properties;
    private final ObjectProvider<ProfileReader> readers;

    public ProfileController(ProfileProperties properties, ObjectProvider<ProfileReader> readers) {
        this.properties = properties;
        this.readers = readers;
    }

    @GetMapping
    public ResponseEntity<ProfileSnapshot> profile(Authentication authentication) {
        if (!properties.enabled()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        if (authentication == null || !authentication.isAuthenticated()) {
            // Belt and braces: the chain already answers 401 for this path.
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(readers.getObject().read(provider(authentication), authentication.getName()));
    }

    /** The registration id for an OAuth2 login ("google"/"github"); the name otherwise, as before. */
    private static String provider(Authentication authentication) {
        return authentication instanceof OAuth2AuthenticationToken token
                ? token.getAuthorizedClientRegistrationId()
                : authentication.getName();
    }
}

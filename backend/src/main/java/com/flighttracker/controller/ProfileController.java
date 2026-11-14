package com.flighttracker.controller;

import com.flighttracker.profile.ProfileProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The smallest profile read that proves the login round-trip (design §84,
 * step 2 spike): who is signed in, if anyone. The full profile body — the
 * favourites/watched lists, merge, export and delete — is a later step.
 *
 * <p>The endpoint itself is always mapped, so the flag's off state is
 * observable to the SPA exactly as designed (§7): with
 * {@code flighttracker.profile.enabled=false} it answers {@code 503} and the
 * frontend shows no sign-in control, never a broken one. With the flag on, the
 * security chain has already rejected an anonymous caller with {@code 401}, so
 * reaching the body means there is a session.
 *
 * <p>Only the provider id is returned: no email, no name, no avatar — with
 * {@code scope=openid} the provider never sends them (§1.3).
 */
@RestController
@RequestMapping("/api/profile")
public class ProfileController {

    private final ProfileProperties properties;

    public ProfileController(ProfileProperties properties) {
        this.properties = properties;
    }

    @GetMapping
    public ResponseEntity<Map<String, String>> profile(Authentication authentication) {
        if (!properties.enabled()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        if (authentication == null || !authentication.isAuthenticated()) {
            // Belt and braces: the chain already answers 401 for this path.
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String provider = authentication instanceof OAuth2AuthenticationToken token
                ? token.getAuthorizedClientRegistrationId()
                : authentication.getName();
        return ResponseEntity.ok(Map.of("provider", provider));
    }
}

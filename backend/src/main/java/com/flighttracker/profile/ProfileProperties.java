package com.flighttracker.profile;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * The feature flag for optional social login (design §7):
 * {@code flighttracker.profile.enabled}, default <b>false</b>. Off, none of the
 * profile endpoints are wired and the app is byte-identical to today, which is
 * how the flag should read to an anonymous visitor.
 *
 * The HTTP layer reads this flag: {@code ProfileController} answers {@code 503}
 * for {@code GET /api/profile} while it is off (the SPA hides the sign-in
 * control rather than show a broken one), and each security chain in
 * {@code ProfileSecurityConfig} is gated on it.
 */
@ConfigurationProperties(prefix = "flighttracker.profile")
public record ProfileProperties(@DefaultValue("false") boolean enabled) {
}

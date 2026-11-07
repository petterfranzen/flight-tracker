package com.flighttracker.profile;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * The feature flag for optional social login (design §7):
 * {@code flighttracker.profile.enabled}, default <b>false</b>. Off, none of the
 * profile endpoints are wired and the app is byte-identical to today, which is
 * how the flag should read to an anonymous visitor.
 *
 * This slice (design step 1) ships only the schema, repositories and helpers
 * behind the flag; nothing is user-visible yet. The SPI/HTTP layer that reads
 * this flag is step 3.
 */
@ConfigurationProperties(prefix = "flighttracker.profile")
public record ProfileProperties(@DefaultValue("false") boolean enabled) {
}

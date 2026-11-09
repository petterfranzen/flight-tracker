package com.flighttracker;

import com.flighttracker.profile.ProfileProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

// UserDetailsServiceAutoConfiguration is excluded outright: it is what logs
// "Using generated security password: <uuid>" at startup when no
// UserDetailsService exists. Boot already backs it off while
// spring-security-oauth2-client is on the classpath (its
// @ConditionalOnMissingClass on ClientRegistrationRepository), but the flag
// must not depend on that classpath accident: this is a public-facing service
// and that secret-shaped log line must never appear in journald. There is no
// form login here, so nothing loses a user account by its absence.
@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
@EnableScheduling // the agents are scheduled pollers, see service/agent
@EnableAsync // AircraftEnrichmentService's third-party lookups run off the poll thread
@EnableConfigurationProperties(ProfileProperties.class) // the optional-social-login flag, flighttracker.profile.enabled
public class FlightTrackerApplication {
    public static void main(String[] args) {
        SpringApplication.run(FlightTrackerApplication.class, args);
    }
}

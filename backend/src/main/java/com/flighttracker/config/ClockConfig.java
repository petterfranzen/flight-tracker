package com.flighttracker.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Clock;

/**
 * Cloud migration A2 (PLAN.md §6 item 4): "Inject a Clock bean everywhere
 * Instant.now() is used in persistence code (tests become deterministic)."
 * One system UTC clock bean for the whole app — persistence code takes
 * this as a constructor dependency instead of calling Instant.now()
 * directly, so a test can substitute Clock.fixed(...) and get a repeatable
 * "now" for retention cutoffs, timestamp columns, etc.
 */
@Configuration
public class ClockConfig {

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }
}

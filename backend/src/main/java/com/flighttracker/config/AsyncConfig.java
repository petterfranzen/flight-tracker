package com.flighttracker.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * A small, dedicated pool for AircraftEnrichmentService's @Async lookups.
 * Spring Boot's default @Async executor has a core pool size of 8, which
 * sounds modest until a cold start (empty aircraft table) sees a few
 * hundred "new" aircraft in the very first poll cycle — 8-way-concurrent
 * bursts of that size are enough to blow through OpenSky's rate limit
 * before OpenSkyFlightsClient's own backoff even has a first failure to
 * react to. Two concurrent lookups keeps a large backlog from front-loading
 * a burst, at the cost of taking longer to drain.
 */
@Configuration
@Profile("agent")
public class AsyncConfig {

    @Bean(name = "enrichmentExecutor")
    public Executor enrichmentExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(2);
        executor.setThreadNamePrefix("aircraft-enrich-");
        executor.initialize();
        return executor;
    }
}

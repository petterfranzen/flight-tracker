package com.flighttracker.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * A small, dedicated pool for ViewportService.report()'s @Async write —
 * see that method's own comment for why it's async at all. The row it
 * writes is a single shared one (id=1, "one viewer at a time"), so
 * concurrent report() calls already serialize on that row regardless of
 * pool size; this only needs enough threads that one slow commit (the
 * whole reason this is async - see report()'s comment) doesn't stall
 * every other viewport report queued behind it in the same pool.
 */
@Configuration
@Profile("api")
public class ApiAsyncConfig {

    @Bean(name = "viewportReportExecutor")
    public Executor viewportReportExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(4);
        executor.setThreadNamePrefix("viewport-report-");
        executor.initialize();
        return executor;
    }
}

package com.flighttracker.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
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
 *
 * Deliberately NOT @Profile("api") even though report() is only ever
 * *called* from the api profile: ViewportService itself is a plain,
 * profile-unscoped @Service (the agent profile loads it too, to call its
 * current() method), so Spring's @Async proxy needs this named executor
 * resolvable in every profile's context that loads ViewportService, not
 * just the one that happens to invoke the annotated method - confirmed
 * the hard way: scoping this to "api" alone crashed backend-agent on
 * startup (its context couldn't resolve "viewportReportExecutor" while
 * building ViewportService's proxy, even though agent never calls
 * report()). A few idle threads in a profile that never uses them costs
 * nothing worth scoping around.
 */
@Configuration
public class ViewportAsyncConfig {

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

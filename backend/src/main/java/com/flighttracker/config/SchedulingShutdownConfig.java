package com.flighttracker.config;

import org.springframework.boot.task.ThreadPoolTaskSchedulerCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * How the shared @Scheduled pool behaves on shutdown (every deploy restarts
 * the systemd unit). Spring 6.1's default is already most of what we want,
 * and spring.task.scheduling.shutdown.await-termination would undo it:
 *
 * <ol>
 *   <li>Context close shuts the executor down: periodic tasks are dropped, so
 *       nothing starts a new run, and nothing running is interrupted.</li>
 *   <li>The scheduler's lifecycle stop then waits for the runs in flight to
 *       return, up to spring.lifecycle.timeout-per-shutdown-phase. This is
 *       before any bean is destroyed, so the DataSource is still open.</li>
 *   <li>Only a run still going after that is interrupted, when the scheduler
 *       bean itself is destroyed.</li>
 * </ol>
 *
 * Setting await-termination switches the scheduler to a "late" shutdown
 * instead: no early stop, periodic tasks keep firing through the web
 * server's drain, and the wait moves into bean destruction, where the
 * DataSource may already be closed.
 *
 * The one gap is cron tasks: Spring reschedules @Scheduled(cron) as one-shot
 * delayed tasks, which a shut-down ScheduledThreadPoolExecutor still runs by
 * default. Turning that off means a nightly job due mid-shutdown is skipped
 * rather than started.
 */
@Configuration
public class SchedulingShutdownConfig {

    @Bean
    ThreadPoolTaskSchedulerCustomizer noDelayedTasksAfterShutdown() {
        return scheduler -> scheduler.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }
}

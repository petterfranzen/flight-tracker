package com.flighttracker.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.context.LifecycleAutoConfiguration;
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * With the real application.yml scheduling/lifecycle settings, closing the
 * context lets a @Scheduled run in progress finish uninterrupted and starts
 * no new one — what a deploy's restart relies on for an in-flight poll,
 * retention batch or route lookup.
 */
class SchedulingShutdownTest {

    static final long RUN_MS = 1_500;

    @Test
    void inFlightRunFinishesAndNoNewRunStarts() throws Exception {
        ConfigurableApplicationContext ctx = new SpringApplicationBuilder(TestApp.class)
                .web(WebApplicationType.NONE)
                .run();
        SlowJob job = ctx.getBean(SlowJob.class);
        assertThat(job.started.await(5, TimeUnit.SECONDS)).isTrue();

        long start = System.nanoTime();
        ctx.close();
        long closeMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        assertThat(job.interrupted).as("run was interrupted").isFalse();
        assertThat(job.completed).as("run finished before close returned").isTrue();
        assertThat(closeMs).as("close waited for the run").isGreaterThan(RUN_MS / 2);
        Thread.sleep(300); // several fixedDelay periods
        assertThat(job.runs).as("no run started after close").hasValue(1);
    }

    @Configuration
    @EnableScheduling
    @ImportAutoConfiguration({TaskSchedulingAutoConfiguration.class, LifecycleAutoConfiguration.class})
    @Import(SchedulingShutdownConfig.class)
    static class TestApp {
        @Bean
        SlowJob slowJob() {
            return new SlowJob();
        }
    }

    static class SlowJob {
        final CountDownLatch started = new CountDownLatch(1);
        final AtomicInteger runs = new AtomicInteger();
        volatile boolean interrupted;
        volatile boolean completed;

        @Scheduled(fixedDelay = 50)
        void run() {
            if (runs.incrementAndGet() > 1) return;
            started.countDown();
            try {
                Thread.sleep(RUN_MS);
                completed = true;
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
    }
}

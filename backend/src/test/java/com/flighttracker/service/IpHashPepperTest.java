package com.flighttracker.service;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@link IpHashPepper} has no fallback key (finding M3 follow-up, section9-hq
 * #405): a fixed, repo-visible key would leave the persisted budget tokens
 * brute-forceable. So a prod-profile run refuses to start without
 * {@code FLIGHTTRACKER_RATE_LIMIT_PEPPER}, any other run still starts on a
 * random per-run key, and a configured pepper below the 32-byte floor is refused
 * under any profile.
 */
class IpHashPepperTest {

    private static final String PEPPER = "unit-test-pepper-0123456789abcdef";

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(Enable.class);

    @Configuration
    @Import(IpHashPepper.class)
    static class Enable {
    }

    @Test
    void aConfiguredPepper_isUsedAsIs() {
        runner.withPropertyValues("flighttracker.rate-limit.ip-hash-pepper=" + PEPPER)
                .run(ctx -> {
                    assertThat(ctx).hasNotFailed();
                    assertThat(ctx.getBean(IpHashPepper.class).value()).isEqualTo(PEPPER);
                });
    }

    @Test
    void noPepper_andNoProdProfile_stillStarts_onARandomKey() {
        runner.run(ctx -> {
            assertThat(ctx).hasNotFailed();
            String value = ctx.getBean(IpHashPepper.class).value();
            // 32 random bytes, in hex — never the old fixed, repo-visible key.
            assertThat(value).matches("[0-9a-f]{64}");
        });
    }

    @Test
    void noPepper_underTheProdProfile_refusesToStart() {
        runner.withInitializer(ctx -> ctx.getEnvironment().setActiveProfiles("prod"))
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @Test
    void aPepperBelowTheMinimum_refusesToStart_underAnyProfile() {
        runner.withPropertyValues("flighttracker.rate-limit.ip-hash-pepper=too-short")
                .run(ctx -> assertThat(ctx).hasFailed());
        runner.withPropertyValues("flighttracker.rate-limit.ip-hash-pepper=too-short")
                .withInitializer(ctx -> ctx.getEnvironment().setActiveProfiles("prod"))
                .run(ctx -> assertThat(ctx).hasFailed());
    }
}

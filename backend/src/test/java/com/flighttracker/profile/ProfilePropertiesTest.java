package com.flighttracker.profile;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

import static org.assertj.core.api.Assertions.assertThat;

/** The flag is off unless something turns it on (design §7). */
class ProfilePropertiesTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(Enable.class);

    @Configuration
    @EnableConfigurationProperties(ProfileProperties.class)
    static class Enable {
    }

    @Test
    void defaultIsDisabled() {
        runner.run(ctx -> assertThat(ctx.getBean(ProfileProperties.class).enabled()).isFalse());
    }

    @Test
    void canBeTurnedOn() {
        runner.withPropertyValues("flighttracker.profile.enabled=true")
                .run(ctx -> assertThat(ctx.getBean(ProfileProperties.class).enabled()).isTrue());
    }
}

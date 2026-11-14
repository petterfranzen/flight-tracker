package com.flighttracker;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration;
import org.springframework.core.annotation.AnnotatedElementUtils;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The generated-password log line (section9-hq #234, must-fix 2): Boot's
 * {@code UserDetailsServiceAutoConfiguration} is what prints
 * {@code Using generated security password: <uuid>} at startup when no
 * {@code UserDetailsService} bean exists. This app has no form login, so the
 * credential is unusable — but it is a secret-shaped line written into
 * journald on a public-facing service, and it must not depend on a classpath
 * accident.
 *
 * <p>Measured on the built jar (flag off, Boot 4.1.2): the line does
 * <b>not</b> currently appear, because the same auto-configuration is
 * {@code @ConditionalOnMissingClass ClientRegistrationRepository} and
 * {@code spring-security-oauth2-client} is on the classpath — the
 * condition-evaluation report lists it as "found unwanted class". The explicit
 * exclusion this test pins makes that guarantee independent of the oauth2
 * starter: never removed silently.
 */
class GeneratedPasswordGuardTest {

    @Test
    void theApplicationExcludesTheGeneratedPasswordAutoConfiguration() {
        SpringBootApplication annotation = AnnotatedElementUtils
                .findMergedAnnotation(FlightTrackerApplication.class, SpringBootApplication.class);

        assertThat(annotation).as("FlightTrackerApplication must be a @SpringBootApplication").isNotNull();
        assertThat(annotation.exclude())
                .as("without this, Boot can log 'Using generated security password: <uuid>' into journald")
                .contains(UserDetailsServiceAutoConfiguration.class);
    }
}

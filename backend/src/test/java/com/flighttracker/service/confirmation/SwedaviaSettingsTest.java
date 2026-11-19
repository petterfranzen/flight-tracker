package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;

import java.time.Clock;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Spring builds the provider's settings from flighttracker.confirmation.swedavia.*, with the same defaults. */
class SwedaviaSettingsTest {

    private static SwedaviaSettings settings(Map<String, Object> properties) {
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", properties));
            ctx.registerBean(Clock.class, Clock::systemUTC);
            ctx.registerBean(PhaseLogger.class, PhaseLogger::new);
            ctx.register(SwedaviaSettings.class, SwedaviaArrivalsProvider.class);
            ctx.refresh();
            assertThat(ctx.getBean(SwedaviaArrivalsProvider.class)).isNotNull();
            return ctx.getBean(SwedaviaSettings.class);
        }
    }

    @Test
    void defaults_whenNothingIsConfigured() {
        SwedaviaSettings s = settings(Map.of());

        assertThat(s.enabled()).isTrue();
        assertThat(s.primaryKey()).isEmpty();
        assertThat(s.secondaryKey()).isEmpty();
        assertThat(s.baseUrl()).isEqualTo("https://api.swedavia.se/flightinfo/v2");
    }

    @Test
    void configuredValues_areUsed_andTheKeysTrimmed() {
        String prefix = "flighttracker.confirmation.swedavia.";
        SwedaviaSettings s = settings(Map.of(
                prefix + "enabled", "false",
                prefix + "api-key", " k1 ",
                prefix + "api-key-secondary", "k2",
                prefix + "base-url", "http://localhost:1"));

        assertThat(s.enabled()).isFalse();
        assertThat(s.primaryKey()).isEqualTo("k1");
        assertThat(s.secondaryKey()).isEqualTo("k2");
        assertThat(s.baseUrl()).isEqualTo("http://localhost:1");
    }

    @Test
    void toString_neverPrintsTheKeys() {
        assertThat(new SwedaviaSettings(true, "secret-1", "secret-2", "b").toString())
                .doesNotContain("secret-1").doesNotContain("secret-2").contains("<redacted>");
        assertThat(new SwedaviaSettings(true, null, " ", "b").toString()).contains("apiKey=<unset>");
    }
}

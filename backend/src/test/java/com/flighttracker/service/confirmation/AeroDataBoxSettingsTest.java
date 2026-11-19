package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;

import java.time.Clock;
import java.time.Duration;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Spring builds the provider's settings from flighttracker.confirmation.aerodatabox.*, with the same defaults. */
class AeroDataBoxSettingsTest {

    private static AeroDataBoxSettings settings(Map<String, Object> properties) {
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", properties));
            ctx.registerBean(Clock.class, Clock::systemUTC);
            ctx.registerBean(PhaseLogger.class, PhaseLogger::new);
            ctx.register(AeroDataBoxSettings.class, AeroDataBoxArrivalProvider.class);
            ctx.refresh();
            assertThat(ctx.getBean(AeroDataBoxArrivalProvider.class)).isNotNull();
            return ctx.getBean(AeroDataBoxSettings.class);
        }
    }

    @Test
    void defaults_whenNothingIsConfigured() {
        AeroDataBoxSettings s = settings(Map.of());

        assertThat(s.enabled()).isTrue();
        assertThat(s.apiKey()).isEmpty();
        assertThat(s.baseUrl()).isEqualTo("https://aerodatabox.p.rapidapi.com");
        assertThat(s.host()).isEqualTo("aerodatabox.p.rapidapi.com");
        assertThat(s.searchByOrDefault()).isEqualTo("Number");
        assertThat(s.recordTrainingLabels()).isFalse();
        assertThat(s.foundRecheck()).isEqualTo(Duration.ofMinutes(30));
        assertThat(s.notFoundRecheck()).isEqualTo(Duration.ofHours(3));
        assertThat(s.gateWait()).isEqualTo(Duration.ZERO);
    }

    @Test
    void configuredValues_areUsed() {
        String prefix = "flighttracker.confirmation.aerodatabox.";
        AeroDataBoxSettings s = settings(Map.of(
                prefix + "enabled", "false",
                prefix + "api-key", "k",
                prefix + "search-by", " callsign ",
                prefix + "record-training-labels", "true",
                prefix + "found-recheck-minutes", "5",
                prefix + "not-found-recheck-minutes", "6",
                prefix + "gate-wait-minutes", "7"));

        assertThat(s.enabled()).isFalse();
        assertThat(s.apiKey()).isEqualTo("k");
        assertThat(s.searchByOrDefault()).isEqualTo("CallSign");
        assertThat(s.recordTrainingLabels()).isTrue();
        assertThat(s.foundRecheck()).isEqualTo(Duration.ofMinutes(5));
        assertThat(s.notFoundRecheck()).isEqualTo(Duration.ofMinutes(6));
        assertThat(s.gateWait()).isEqualTo(Duration.ofMinutes(7));
    }

    @Test
    void unknownSearchBy_fallsBackToNumber() {
        assertThat(new AeroDataBoxSettings(true, "k", "b", "h", "Typo", false, 1, 1, 0).searchByOrDefault())
                .isEqualTo("Number");
        assertThat(new AeroDataBoxSettings(true, "k", "b", "h", null, false, 1, 1, 0).searchByOrDefault())
                .isEqualTo("Number");
    }
}

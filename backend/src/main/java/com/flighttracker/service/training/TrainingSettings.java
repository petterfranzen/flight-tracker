package com.flighttracker.service.training;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * The {@code flighttracker.training.*} settings {@link TrainingDataService}
 * runs with. Negative durations are clamped to zero.
 */
@Component
public class TrainingSettings {

    private final boolean enabled;
    private final double maxAltitudeM;
    private final Duration captureDelay;
    private final Duration maxAirborneLabelGap;

    public TrainingSettings(@Value("${flighttracker.training.enabled:true}") boolean enabled,
                            @Value("${flighttracker.training.max-altitude-m:4000}") double maxAltitudeM,
                            @Value("${flighttracker.training.capture-delay-seconds:600}") long captureDelaySeconds,
                            @Value("${flighttracker.training.max-airborne-label-gap-minutes:30}") long maxAirborneLabelGapMinutes) {
        this.enabled = enabled;
        this.maxAltitudeM = maxAltitudeM;
        this.captureDelay = Duration.ofSeconds(Math.max(0, captureDelaySeconds));
        this.maxAirborneLabelGap = Duration.ofMinutes(Math.max(0, maxAirborneLabelGapMinutes));
    }

    public boolean enabled() {
        return enabled;
    }

    public double maxAltitudeM() {
        return maxAltitudeM;
    }

    public Duration captureDelay() {
        return captureDelay;
    }

    public Duration maxAirborneLabelGap() {
        return maxAirborneLabelGap;
    }
}

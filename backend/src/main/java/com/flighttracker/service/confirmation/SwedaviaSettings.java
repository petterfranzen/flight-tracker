package com.flighttracker.service.confirmation;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** {@link SwedaviaArrivalsProvider}'s configuration, as {@code flighttracker.confirmation.swedavia.*} gives it. */
@Component
record SwedaviaSettings(
        @Value("${flighttracker.confirmation.swedavia.enabled:true}") boolean enabled,
        @Value("${flighttracker.confirmation.swedavia.api-key:}") String apiKey,
        @Value("${flighttracker.confirmation.swedavia.api-key-secondary:}") String apiKeySecondary,
        @Value("${flighttracker.confirmation.swedavia.base-url:https://api.swedavia.se/flightinfo/v2}") String baseUrl) {

    /** The primary key, trimmed; empty when unset. */
    String primaryKey() {
        return trimmed(apiKey);
    }

    /** The secondary key, trimmed; empty when unset. */
    String secondaryKey() {
        return trimmed(apiKeySecondary);
    }

    private static String trimmed(String key) {
        return key == null ? "" : key.trim();
    }

    /** Never print the API keys: a record's default toString would. */
    @Override
    public String toString() {
        return "SwedaviaSettings[enabled=" + enabled + ", apiKey=" + redacted(apiKey)
                + ", apiKeySecondary=" + redacted(apiKeySecondary) + ", baseUrl=" + baseUrl + "]";
    }

    private static String redacted(String key) {
        return key == null || key.isBlank() ? "<unset>" : "<redacted>";
    }
}

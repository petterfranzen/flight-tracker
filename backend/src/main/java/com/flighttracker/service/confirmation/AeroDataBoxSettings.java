package com.flighttracker.service.confirmation;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;

/** {@link AeroDataBoxArrivalProvider}'s configuration, as {@code flighttracker.confirmation.aerodatabox.*} gives it. */
@Component
record AeroDataBoxSettings(
        @Value("${flighttracker.confirmation.aerodatabox.enabled:true}") boolean enabled,
        @Value("${flighttracker.confirmation.aerodatabox.api-key:}") String apiKey,
        @Value("${flighttracker.confirmation.aerodatabox.base-url:https://aerodatabox.p.rapidapi.com}") String baseUrl,
        @Value("${flighttracker.confirmation.aerodatabox.host:aerodatabox.p.rapidapi.com}") String host,
        @Value("${flighttracker.confirmation.aerodatabox.search-by:Number}") String searchBy,
        @Value("${flighttracker.confirmation.aerodatabox.record-training-labels:false}") boolean recordTrainingLabels,
        @Value("${flighttracker.confirmation.aerodatabox.found-recheck-minutes:30}") long foundRecheckMinutes,
        @Value("${flighttracker.confirmation.aerodatabox.not-found-recheck-minutes:180}") long notFoundRecheckMinutes,
        @Value("${flighttracker.confirmation.aerodatabox.gate-wait-minutes:0}") long gateWaitMinutes) {

    /** {@code Number} or {@code CallSign}; anything else (a typo) falls back to {@code Number}. */
    String searchByOrDefault() {
        if (searchBy != null && searchBy.trim().equalsIgnoreCase("CallSign")) return "CallSign";
        return "Number";
    }

    Duration foundRecheck() {
        return Duration.ofMinutes(foundRecheckMinutes);
    }

    Duration notFoundRecheck() {
        return Duration.ofMinutes(notFoundRecheckMinutes);
    }

    /** Never print the API key: a record's default toString would. */
    @Override
    public String toString() {
        return "AeroDataBoxSettings[enabled=" + enabled + ", apiKey=" + (apiKey == null || apiKey.isBlank() ? "<unset>" : "<redacted>")
                + ", baseUrl=" + baseUrl + ", host=" + host + ", searchBy=" + searchBy + "]";
    }

    Duration gateWait() {
        return Duration.ofMinutes(gateWaitMinutes);
    }
}

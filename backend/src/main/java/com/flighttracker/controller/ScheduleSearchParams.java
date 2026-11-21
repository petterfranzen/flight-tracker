package com.flighttracker.controller;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.List;
import java.util.function.Supplier;

/**
 * The /api/schedule/search query parameters, all optional: a flight number, or a route
 * ({@code from} and {@code to}, comma-separated codes), an {@code airport} filter for the flight
 * number search, and a {@code date} (yyyy-MM-dd).
 */
public record ScheduleSearchParams(String flight, String from, String to, String airport, String date) {

    boolean byFlightNumber() {
        return present(flight);
    }

    boolean byRoute() {
        return present(from) && present(to);
    }

    /** The requested day; without one, the day {@code today} gives. */
    LocalDate day(Supplier<LocalDate> today) {
        if (!present(date)) return today.get();
        try {
            return LocalDate.parse(date.trim());
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "date must be yyyy-MM-dd");
        }
    }

    List<String> airportCodes() {
        return codes(airport);
    }

    List<String> fromCodes() {
        return codes(from);
    }

    List<String> toCodes() {
        return codes(to);
    }

    private static boolean present(String value) {
        return value != null && !value.isBlank();
    }

    private static List<String> codes(String csv) {
        return csv == null ? List.of() : Arrays.stream(csv.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }
}

package com.flighttracker.controller;

import com.flighttracker.dto.AircraftUsage;
import com.flighttracker.service.UsageService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api/usage")
public class UsageController {

    /** The widest window one request may ask for. */
    static final Duration MAX_WINDOW = Duration.ofHours(24);

    private final UsageService usageService;

    public UsageController(UsageService usageService) {
        this.usageService = usageService;
    }

    /**
     * Fleet-wide usage for a window of up to {@link #MAX_WINDOW}, derived from
     * historic positions. {@code to} must be after {@code from}.
     */
    @GetMapping
    public List<AircraftUsage> usage(@RequestParam Instant from, @RequestParam Instant to) {
        if (!to.isAfter(from) || Duration.between(from, to).compareTo(MAX_WINDOW) > 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "to must be after from, at most 24 h later");
        }
        return usageService.usageForWindow(from, to);
    }
}

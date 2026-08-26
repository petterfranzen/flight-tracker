package com.flighttracker.controller;

import com.flighttracker.dto.AircraftUsage;
import com.flighttracker.service.UsageService;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api/usage")
@Profile("api")
public class UsageController {

    private final UsageService usageService;

    public UsageController(UsageService usageService) {
        this.usageService = usageService;
    }

    /** Fleet-wide usage for an arbitrary window, derived from historic positions. */
    @GetMapping
    public List<AircraftUsage> usage(@RequestParam Instant from, @RequestParam Instant to) {
        return usageService.usageForWindow(from, to);
    }
}

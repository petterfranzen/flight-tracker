package com.flighttracker.controller;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.FlightPositionRepository;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

@RestController
@RequestMapping("/api/flights")
@Profile("api")
public class FlightController {

    private final FlightPositionRepository positionRepository;

    public FlightController(FlightPositionRepository positionRepository) {
        this.positionRepository = positionRepository;
    }

    /** Latest known position per aircraft, for the initial map paint (WebSocket carries updates after that). */
    @GetMapping("/live")
    public List<FlightPosition> live(@RequestParam(defaultValue = "10") int withinMinutes) {
        return positionRepository.findLatestPerAircraftSince(Instant.now().minus(withinMinutes, ChronoUnit.MINUTES));
    }

    /** Full historic track for one aircraft, for the "trace the route across the map" view. */
    @GetMapping("/{icao24}/history")
    public List<FlightPosition> history(@PathVariable String icao24,
                                         @RequestParam Instant from,
                                         @RequestParam Instant to) {
        return positionRepository.findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(icao24, from, to);
    }
}

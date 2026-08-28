package com.flighttracker.controller;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.FlightPositionRepository;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api/flights")
@Profile("api")
public class FlightController {

    // Outer bound for an airborne aircraft that's gone silent (feed gap or
    // truly lost) — past this, presume it's no longer worth showing rather
    // than keep it on the map indefinitely. Not user-specified; a few hours
    // comfortably covers real ADS-B gaps without letting a dead icao24
    // linger forever.
    private static final Duration STALE_AIRBORNE_BOUND = Duration.ofHours(4);

    // How long a landed aircraft stays visible after touching down.
    private static final Duration LANDED_VISIBILITY = Duration.ofMinutes(20);

    private final FlightPositionRepository positionRepository;

    public FlightController(FlightPositionRepository positionRepository) {
        this.positionRepository = positionRepository;
    }

    /** Latest known position per aircraft, for the initial map paint (WebSocket carries updates after that). */
    @GetMapping("/live")
    public List<FlightPosition> live() {
        Instant now = Instant.now();
        return positionRepository.findLive(now.minus(STALE_AIRBORNE_BOUND), now.minus(LANDED_VISIBILITY));
    }

    /** Full historic track for one aircraft, for the "trace the route across the map" view. */
    @GetMapping("/{icao24}/history")
    public List<FlightPosition> history(@PathVariable String icao24,
                                         @RequestParam Instant from,
                                         @RequestParam Instant to) {
        return positionRepository.findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(icao24, from, to);
    }
}

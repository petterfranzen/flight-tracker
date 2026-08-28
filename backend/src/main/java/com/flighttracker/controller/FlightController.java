package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.ViewportService;
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
    private final ViewportService viewportService;

    public FlightController(FlightPositionRepository positionRepository, ViewportService viewportService) {
        this.positionRepository = positionRepository;
        this.viewportService = viewportService;
    }

    /**
     * Latest known position per aircraft, for the initial map paint
     * (WebSocket carries updates after that). Tracking is global, but a
     * client normally passes its current map viewport (all four bbox
     * params) to get back only what's visible — otherwise every aircraft
     * being tracked anywhere is returned, which is what the bbox-less form
     * is for (e.g. a fleet-wide check), not what the map UI calls with.
     *
     * Passing a bbox also reports it as the current viewport (see
     * ViewportService) — this is what tells the "agent" container's hot
     * poll, and this container's WebSocket broadcast filtering, what's
     * actually on someone's screen right now.
     */
    @GetMapping("/live")
    public List<FlightPosition> live(@RequestParam(required = false) Double latMin,
                                      @RequestParam(required = false) Double latMax,
                                      @RequestParam(required = false) Double lonMin,
                                      @RequestParam(required = false) Double lonMax) {
        Instant now = Instant.now();
        Instant staleAirborneCutoff = now.minus(STALE_AIRBORNE_BOUND);
        Instant landedCutoff = now.minus(LANDED_VISIBILITY);

        if (latMin == null || latMax == null || lonMin == null || lonMax == null) {
            return positionRepository.findLive(staleAirborneCutoff, landedCutoff);
        }
        Bounds bounds = new Bounds(latMin, latMax, lonMin, lonMax);
        viewportService.report(bounds);
        return positionRepository.findLiveInBounds(staleAirborneCutoff, landedCutoff,
                bounds.latMin(), bounds.latMax(), bounds.lonMin(), bounds.lonMax());
    }

    /** Full historic track for one aircraft, for the "trace the route across the map" view. */
    @GetMapping("/{icao24}/history")
    public List<FlightPosition> history(@PathVariable String icao24,
                                         @RequestParam Instant from,
                                         @RequestParam Instant to) {
        return positionRepository.findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(icao24, from, to);
    }
}

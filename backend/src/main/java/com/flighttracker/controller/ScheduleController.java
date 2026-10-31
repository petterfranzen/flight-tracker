package com.flighttracker.controller;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.schedule.FlightScheduleService;
import com.flighttracker.service.schedule.ScheduledFlight;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.List;

/**
 * Find a flight before it is airborne: by flight number ({@code ?flight=BA778}) or by route
 * ({@code ?from=LHR,LGW,LCY&to=ARN}), on a date (default today, Swedish time). Each row carries the
 * live aircraft's icao24 once one with the flight's callsign is flying near its time, so a watched
 * flight polls this one endpoint and links to the plane when it appears.
 */
@RestController
@RequestMapping("/api/schedule")
public class ScheduleController {

    /** A callsign repeats every day; only a flight within this window of now can be the one in the air. */
    static final Duration MATCH_WINDOW = Duration.ofHours(12);

    private final FlightScheduleService schedule;
    private final LiveStateStore liveStateStore;

    public ScheduleController(FlightScheduleService schedule, LiveStateStore liveStateStore) {
        this.schedule = schedule;
        this.liveStateStore = liveStateStore;
    }

    @GetMapping("/search")
    public List<ScheduledFlight> search(@RequestParam(required = false) String flight,
                                        @RequestParam(required = false) String from,
                                        @RequestParam(required = false) String to,
                                        @RequestParam(required = false) String airport,
                                        @RequestParam(required = false) String date) {
        if (!schedule.available()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Flight schedules need a Swedavia API key");
        }
        LocalDate day;
        try {
            day = date == null || date.isBlank() ? schedule.today() : LocalDate.parse(date.trim());
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "date must be yyyy-MM-dd");
        }
        List<ScheduledFlight> found;
        if (flight != null && !flight.isBlank()) {
            found = schedule.byFlightNumber(flight, day, codes(airport));
        } else if (from != null && !from.isBlank() && to != null && !to.isBlank()) {
            found = schedule.byRoute(codes(from), codes(to), day);
        } else {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "give flight, or from and to");
        }
        return found.stream().map(this::withLive).toList();
    }

    private static List<String> codes(String csv) {
        return csv == null ? List.of() : Arrays.stream(csv.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    private ScheduledFlight withLive(ScheduledFlight f) {
        Instant when = f.bestTime();
        if (f.callsign() == null || when == null || Duration.between(when, Instant.now()).abs().compareTo(MATCH_WINDOW) > 0) return f;
        Instant now = Instant.now();
        return liveStateStore.searchByCallsign(f.callsign(), now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                        now.minus(LiveVisibilityWindows.LANDED_VISIBILITY), 10).stream()
                .filter(p -> f.callsign().equalsIgnoreCase(p.callsign()) && !p.onGround())
                .findFirst().map(FlightPosition::icao24).map(f::withLive).orElse(f);
    }
}

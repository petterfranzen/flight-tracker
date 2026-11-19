package com.flighttracker.controller;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.schedule.FlightScheduleService;
import com.flighttracker.service.schedule.ScheduledFlight;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
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

    /** "ok", "stale" (an older board stood in for one that failed) or "incomplete" (a board is missing). */
    public static final String STATUS_HEADER = "X-Schedule-Status";

    private final FlightScheduleService schedule;
    private final LiveStateStore liveStateStore;

    public ScheduleController(FlightScheduleService schedule, LiveStateStore liveStateStore) {
        this.schedule = schedule;
        this.liveStateStore = liveStateStore;
    }

    @GetMapping("/search")
    public ResponseEntity<List<ScheduledFlight>> search(@RequestParam(required = false) String flight,
                                        @RequestParam(required = false) String from,
                                        @RequestParam(required = false) String to,
                                        @RequestParam(required = false) String airport,
                                        @RequestParam(required = false) String date) {
        return search(new ScheduleSearchParams(flight, from, to, airport, date));
    }

    /** The search itself, on parameters already bound by {@link #search(String, String, String, String, String)}. */
    public ResponseEntity<List<ScheduledFlight>> search(ScheduleSearchParams params) {
        if (!schedule.available()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Flight schedules need a Swedavia API key");
        }
        LocalDate day = params.day(schedule::today);
        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();
        List<ScheduledFlight> found = find(params, day, outcome);
        return ResponseEntity.ok().header(STATUS_HEADER, outcome.status())
                .body(found.stream().map(this::withLive).toList());
    }

    private List<ScheduledFlight> find(ScheduleSearchParams q, LocalDate day, FlightScheduleService.Outcome outcome) {
        if (q.byFlightNumber()) return schedule.byFlightNumber(q.flight(), day, q.airportCodes(), outcome);
        if (q.byRoute()) return schedule.byRoute(q.fromCodes(), q.toCodes(), day, outcome);
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "give flight, or from and to");
    }

    private ScheduledFlight withLive(ScheduledFlight f) {
        if (f.callsign() == null || !withinMatchWindow(f.bestTime())) return f;
        Instant now = Instant.now();
        return liveStateStore.searchByCallsign(f.callsign(), now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                        now.minus(LiveVisibilityWindows.LANDED_VISIBILITY), 10).stream()
                .filter(p -> f.callsign().equalsIgnoreCase(p.callsign()) && !p.onGround())
                .findFirst().map(FlightPosition::icao24).map(f::withLive).orElse(f);
    }

    private static boolean withinMatchWindow(Instant when) {
        return when != null && Duration.between(when, Instant.now()).abs().compareTo(MATCH_WINDOW) <= 0;
    }
}

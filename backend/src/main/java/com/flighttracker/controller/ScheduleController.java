package com.flighttracker.controller;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.schedule.FlightScheduleService;
import com.flighttracker.service.schedule.ScheduledFlight;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
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

    /** "ok", "stale" (an older board stood in for one that failed) or "incomplete" (a board is missing). */
    public static final String STATUS_HEADER = "X-Schedule-Status";

    private final FlightScheduleService schedule;
    private final LiveStateStore liveStateStore;

    public ScheduleController(FlightScheduleService schedule, LiveStateStore liveStateStore) {
        this.schedule = schedule;
        this.liveStateStore = liveStateStore;
    }

    @GetMapping("/search")
    public ResponseEntity<List<ScheduledFlight>> search(@ModelAttribute SearchParams params) {
        if (!schedule.available()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Flight schedules need a Swedavia API key");
        }
        LocalDate day = parseDay(params.date());
        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();
        List<ScheduledFlight> found = find(params, day, outcome);
        return ResponseEntity.ok().header(STATUS_HEADER, outcome.status())
                .body(found.stream().map(this::withLive).toList());
    }

    /**
     * The search's query parameters, all optional: {@code flight}, {@code from}, {@code to},
     * {@code airport} and {@code date}, bound by name from the request.
     */
    public record SearchParams(String flight, String from, String to, String airport, String date) {
        boolean byFlightNumber() {
            return present(flight);
        }

        boolean byRoute() {
            return present(from) && present(to);
        }
    }

    private static boolean present(String value) {
        return value != null && !value.isBlank();
    }

    /** The requested day, default today (Swedish time). */
    private LocalDate parseDay(String date) {
        if (!present(date)) return schedule.today();
        try {
            return LocalDate.parse(date.trim());
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "date must be yyyy-MM-dd");
        }
    }

    private List<ScheduledFlight> find(SearchParams q, LocalDate day, FlightScheduleService.Outcome outcome) {
        if (q.byFlightNumber()) return schedule.byFlightNumber(q.flight(), day, codes(q.airport()), outcome);
        if (q.byRoute()) return schedule.byRoute(codes(q.from()), codes(q.to()), day, outcome);
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "give flight, or from and to");
    }

    private static List<String> codes(String csv) {
        return csv == null ? List.of() : Arrays.stream(csv.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
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

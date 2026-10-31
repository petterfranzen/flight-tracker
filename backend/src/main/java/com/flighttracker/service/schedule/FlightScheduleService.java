package com.flighttracker.service.schedule;

import com.flighttracker.service.confirmation.SwedaviaArrivalsProvider;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Looks flights up on Swedavia's FlightInfo boards (the key and rotation are the arrivals provider's).
 * Only flights touching one of the ten Swedavia airports can be found: no other free source gives
 * scheduled times. Boards are cached for {@link #TTL} so a watch list refreshing every minute costs
 * one call per airport, direction and day, not one per flight.
 */
@Service
public class FlightScheduleService {

    static final Duration TTL = Duration.ofMinutes(5);
    static final ZoneId LOCAL = ZoneId.of("Europe/Stockholm");
    /** Where a bare flight number is looked for when the caller names no airport. */
    static final List<String> DEFAULT_AIRPORTS = List.of("ARN", "BMA", "GOT");

    /** IATA airline code to the ICAO telephony prefix used in callsigns. */
    static final Map<String, String> ICAO_PREFIX = Map.ofEntries(
            Map.entry("BA", "BAW"), Map.entry("SK", "SAS"), Map.entry("DY", "NOZ"), Map.entry("D8", "NSZ"),
            Map.entry("AY", "FIN"), Map.entry("LH", "DLH"), Map.entry("KL", "KLM"), Map.entry("AF", "AFR"),
            Map.entry("FR", "RYR"), Map.entry("U2", "EZY"), Map.entry("W6", "WZZ"), Map.entry("LX", "SWR"),
            Map.entry("OS", "AUA"), Map.entry("LO", "LOT"), Map.entry("TP", "TAP"), Map.entry("IB", "IBE"),
            Map.entry("SN", "BEL"), Map.entry("EI", "EIN"), Map.entry("VY", "VLG"), Map.entry("TK", "THY"),
            Map.entry("EK", "UAE"), Map.entry("QR", "QTR"), Map.entry("FI", "ICE"), Map.entry("EW", "EWG"),
            Map.entry("WF", "WIF"), Map.entry("DL", "DAL"), Map.entry("UA", "UAL"), Map.entry("AA", "AAL"));

    private static final Map<String, String> STATUS = Map.of(
            "SCH", "Scheduled", "FPL", "Flight plan filed", "FLS", "Suspended", "SEQ", "Sequenced",
            "ACT", "Active", "CAN", "Cancelled", "LAN", "Landed", "RER", "Rerouted",
            "DIV", "Diverted", "DEL", "Deleted");

    private record Cached(Instant at, List<ScheduledFlight> flights) { }

    private final SwedaviaArrivalsProvider swedavia;
    private final Clock clock;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Map<String, Cached> cache = new ConcurrentHashMap<>();

    public FlightScheduleService(SwedaviaArrivalsProvider swedavia, Clock clock) {
        this.swedavia = swedavia;
        this.clock = clock;
    }

    public boolean available() {
        return swedavia.enabled();
    }

    /** "ba 778" and "BA778" are the same flight. */
    public static String normalizeFlight(String s) {
        return s == null ? "" : s.replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }

    /** One flight number on the given day, on the arrivals and departures of {@code airports} (default ARN, BMA, GOT). */
    public List<ScheduledFlight> byFlightNumber(String flight, LocalDate date, List<String> airports) {
        String wanted = normalizeFlight(flight);
        List<String> where = airports == null || airports.isEmpty() ? DEFAULT_AIRPORTS : airports;
        List<ScheduledFlight> out = new ArrayList<>();
        for (String airport : where) {
            for (String direction : List.of("arrivals", "departures")) {
                board(airport, direction, date).stream()
                        .filter(f -> wanted.equals(normalizeFlight(f.flightNumber())))
                        .forEach(out::add);
            }
        }
        return sorted(out);
    }

    /** Flights from any of {@code from} to any of {@code to} on the given day; at least one side must be a Swedavia airport. */
    public List<ScheduledFlight> byRoute(List<String> from, List<String> to, LocalDate date) {
        List<ScheduledFlight> out = new ArrayList<>();
        Set<String> fromSet = Set.copyOf(upper(from));
        Set<String> toSet = Set.copyOf(upper(to));
        for (String dest : toSet) {
            if (!swedavia.servesIata(dest)) continue;
            board(dest, "arrivals", date).stream().filter(f -> fromSet.contains(f.departureIata())).forEach(out::add);
        }
        for (String origin : fromSet) {
            if (!swedavia.servesIata(origin)) continue;
            board(origin, "departures", date).stream().filter(f -> toSet.contains(f.arrivalIata())).forEach(out::add);
        }
        return sorted(out);
    }

    private static List<String> upper(List<String> codes) {
        return codes.stream().map(c -> c.trim().toUpperCase(Locale.ROOT)).filter(c -> !c.isEmpty()).toList();
    }

    private static List<ScheduledFlight> sorted(List<ScheduledFlight> flights) {
        List<ScheduledFlight> copy = new ArrayList<>(flights);
        copy.sort((a, b) -> {
            Instant x = a.bestTime(), y = b.bestTime();
            if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
            return x.compareTo(y);
        });
        return copy;
    }

    private List<ScheduledFlight> board(String airport, String direction, LocalDate date) {
        String iata = airport.trim().toUpperCase(Locale.ROOT);
        String key = iata + "/" + direction + "/" + date;
        Cached hit = cache.get(key);
        if (hit != null && clock.instant().isBefore(hit.at().plus(TTL))) return hit.flights();
        Optional<String> body = swedavia.fetchBoardBody(iata, direction, date);
        // A failed call is not cached as an empty board: the next search tries again (a stale board is served meanwhile).
        if (body.isEmpty()) return hit == null ? List.of() : hit.flights();
        List<ScheduledFlight> flights = parse(body.get(), iata, direction);
        cache.put(key, new Cached(clock.instant(), flights));
        return flights;
    }

    /** Tolerant: every field may be missing. The departures shape is by analogy with arrivals (unverified, see docs/agents/swedavia-api.md). */
    List<ScheduledFlight> parse(String body, String airport, String direction) {
        List<ScheduledFlight> out = new ArrayList<>();
        JsonNode flights = mapper.readTree(body).path("flights");
        if (!flights.isArray()) return out;
        boolean arrivals = direction.equals("arrivals");
        for (JsonNode f : flights) {
            String number = text(f.path("flightId"));
            if (number == null) continue;
            JsonNode leg = f.path("flightLegIdentifier");
            JsonNode times = f.path(arrivals ? "arrivalTime" : "departureTime");
            JsonNode where = f.path("locationAndStatus");
            String code = text(where.path("flightLegStatus"));
            String status = text(where.path("flightLegStatusEnglish"));
            if (status == null && code != null) status = STATUS.getOrDefault(code.toUpperCase(Locale.ROOT), code);
            String departure = text(leg.path("departureAirportIata"));
            String arrival = text(leg.path("arrivalAirportIata"));
            out.add(new ScheduledFlight(normalizeFlight(number), callsign(f, number), direction, airport,
                    arrivals ? departure : airport, arrivals ? airport : arrival,
                    instant(times.path("scheduledUtc")), instant(times.path("estimatedUtc")), instant(times.path("actualUtc")),
                    text(where.path("gate")), text(where.path("terminal")), code, status, null, false));
        }
        return out;
    }

    /** Swedavia's own callsign if it gives one, else the airline's ICAO code (or our prefix table) plus the number. */
    static String callsign(JsonNode flight, String flightNumber) {
        String given = text(flight.path("flightLegIdentifier").path("callsign"));
        if (given != null) return given.toUpperCase(Locale.ROOT);
        String n = normalizeFlight(flightNumber);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^([A-Z0-9]{2})(\\d+[A-Z]?)$").matcher(n);
        if (!m.matches()) return null;
        String prefix = text(flight.path("airlineOperator").path("icao"));
        if (prefix == null) prefix = ICAO_PREFIX.get(m.group(1));
        return prefix == null ? null : prefix.toUpperCase(Locale.ROOT) + m.group(2);
    }

    private static String text(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) return null;
        String s = node.asText().trim();
        return s.isEmpty() ? null : s;
    }

    private static Instant instant(JsonNode node) {
        String s = text(node);
        if (s == null) return null;
        try {
            return s.endsWith("Z") || s.matches(".*[+-]\\d\\d:\\d\\d$") ? java.time.OffsetDateTime.parse(s).toInstant()
                    : java.time.LocalDateTime.parse(s).toInstant(java.time.ZoneOffset.UTC);
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }

    public LocalDate today() {
        return clock.instant().atZone(LOCAL).toLocalDate();
    }
}

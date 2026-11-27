package com.flighttracker.service.live;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AirportRepository;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import com.flighttracker.service.enrichment.Route;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The search box's two modes over the in-memory live set: by callsign
 * (autocomplete) or by airport (the "advanced search" panel). Backs
 * FlightController's /api/flights/search; see that endpoint's javadoc for
 * how the two modes are chosen.
 */
@Service
public class LiveFlightSearch {

    /** At most this many results per search, in either mode. */
    public static final int RESULT_LIMIT = 8;

    private static final Comparator<LiveAircraft> BY_CALLSIGN_NULLS_LAST =
            Comparator.comparing(LiveAircraft::callsign, Comparator.nullsLast(Comparator.naturalOrder()));

    private final LiveStateStore liveStateStore;
    private final AircraftEnrichmentService enrichmentService;
    private final AirportRepository airportRepository;

    public LiveFlightSearch(LiveStateStore liveStateStore,
                            AircraftEnrichmentService enrichmentService,
                            AirportRepository airportRepository) {
        this.liveStateStore = liveStateStore;
        this.enrichmentService = enrichmentService;
        this.airportRepository = airportRepository;
    }

    /**
     * Live aircraft whose callsign matches {@code callsign} (already trimmed,
     * non-empty), ranked by LiveStateStore.searchByCallsign. Positions are
     * EstimatorAgent's current estimate, like every other LiveStateStore read.
     */
    public List<FlightPosition> byCallsign(String callsign, Instant staleAirborneCutoff, Instant landedCutoff) {
        return liveStateStore.searchByCallsign(callsign, staleAirborneCutoff, landedCutoff, RESULT_LIMIT);
    }

    /**
     * Matches a live aircraft whose origin OR destination airport matches the
     * given pattern (name, IATA code, ICAO code, or city), case-insensitively.
     * The text is resolved to airport codes once (one query over the airport
     * reference table: ICAO/IATA code, name, municipality — so "Kalmar" finds
     * ESMQ), then every live aircraft is matched in memory against its
     * *current* flight's route (AircraftEnrichmentService.knownRoute: by
     * callsign, from CallsignRouteService's cache, which a background job
     * keeps filled for every live callsign). Ordered by callsign ascending,
     * nulls last (no prefix-match ranking here, unlike byCallsign).
     */
    public List<FlightPosition> byAirport(String pattern, Instant staleAirborneCutoff, Instant landedCutoff) {
        String needle = pattern.toLowerCase(Locale.ROOT);
        Set<String> matchingCodes = airportRepository.findIcaoCodesMatching(needle);
        List<LiveAircraft> candidates = liveStateStore.liveAircraft(staleAirborneCutoff, landedCutoff);
        if (candidates.isEmpty()) return List.of();

        return candidates.stream()
                .filter(live -> flies(live, needle, matchingCodes))
                .sorted(BY_CALLSIGN_NULLS_LAST)
                .limit(RESULT_LIMIT)
                .map(LiveFlightSearch::toFlightPosition)
                .toList();
    }

    private boolean flies(LiveAircraft live, String needle, Set<String> matchingCodes) {
        return enrichmentService.knownRoute(live.icao24(), live.callsign())
                .filter(route -> matchesAirport(route, needle, matchingCodes))
                .isPresent();
    }

    private static boolean matchesAirport(Route route, String needle, Set<String> matchingCodes) {
        return matchesCode(route.originAirport(), matchingCodes)
                || matchesCode(route.destinationAirport(), matchingCodes)
                || containsIgnoreCase(route.originAirportName(), needle)
                || containsIgnoreCase(route.destinationAirportName(), needle);
    }

    private static boolean matchesCode(String code, Set<String> matchingCodes) {
        return code != null && matchingCodes.contains(code);
    }

    private static boolean containsIgnoreCase(String value, String needle) {
        return value != null && value.toLowerCase(Locale.ROOT).contains(needle);
    }

    private static FlightPosition toFlightPosition(LiveAircraft a) {
        return new FlightPosition(a.id(), a.icao24(), a.callsign(), a.observedAt(),
                a.displayLatitude(), a.displayLongitude(), a.altitudeM(), a.velocityMs(),
                a.headingDeg(), a.verticalRateMs(), a.onGround(), a.agentSource());
    }
}

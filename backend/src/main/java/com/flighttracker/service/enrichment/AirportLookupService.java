package com.flighttracker.service.enrichment;

import com.flighttracker.model.Airport;
import com.flighttracker.repository.AirportRepository;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Looks up an airport's name/coordinates by ICAO code from the local
 * `airport` reference table (seeded once by AirportSeedService). Exists to
 * backfill the gap left by adsbdb, which only ever returns a name as part
 * of a resolved flight-route — a route resolved via OpenSkyFlightsClient's
 * fallback (bare codes only) previously had no way to get a name at all.
 * Not a live external call: this is a local, static reference table, so
 * there's no failure mode here worth an Optional-swallowing try/catch the
 * way the real HTTP clients in this package need.
 */
@Service
public class AirportLookupService {

    private final AirportRepository airportRepository;

    public AirportLookupService(AirportRepository airportRepository) {
        this.airportRepository = airportRepository;
    }

    public Optional<Airport> lookup(String icaoCode) {
        if (icaoCode == null || icaoCode.isBlank()) return Optional.empty();
        return airportRepository.findById(icaoCode);
    }
}

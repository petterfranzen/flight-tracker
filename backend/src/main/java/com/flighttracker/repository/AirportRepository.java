package com.flighttracker.repository;

import com.flighttracker.model.Airport;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface AirportRepository extends JpaRepository<Airport, String> {

    // The map's own airport data (VectorBasemap's WORLD_AIRPORTS, from
    // Natural Earth) keys everything by IATA code, not the icao_code this
    // repository's id normally looks up by — this is what lets the airport
    // dossier resolve a click straight from that code.
    Optional<Airport> findByIataCode(String iataCode);
}

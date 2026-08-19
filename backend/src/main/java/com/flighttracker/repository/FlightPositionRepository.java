package com.flighttracker.repository;

import com.flighttracker.model.FlightPosition;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;

public interface FlightPositionRepository extends JpaRepository<FlightPosition, Long> {

    // Live map: most recent report per aircraft seen in the last N minutes.
    @Query(value = """
        SELECT DISTINCT ON (icao24) *
        FROM flight_position
        WHERE observed_at > :since
        ORDER BY icao24, observed_at DESC
        """, nativeQuery = true)
    List<FlightPosition> findLatestPerAircraftSince(@Param("since") Instant since);

    // Usage calc: full ordered history for one aircraft in a window.
    List<FlightPosition> findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(
            String icao24, Instant from, Instant to);

    // Usage calc: history for every aircraft in a window, for the fleet report.
    List<FlightPosition> findByObservedAtBetweenOrderByIcao24AscObservedAtAsc(
            Instant from, Instant to);
}

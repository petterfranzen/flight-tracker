package com.flighttracker.dto;

/** Aircraft type/registration/operator and origin/destination, for the map's Field Log panel. Any field may be null. */
public record AircraftDossier(
        String icao24,
        String registration,
        String model,
        String operator,
        String originAirport,
        String destinationAirport
) { }

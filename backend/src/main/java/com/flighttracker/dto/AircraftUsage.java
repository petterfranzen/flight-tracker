package com.flighttracker.dto;

public record AircraftUsage(
        String icao24,
        String registration,
        long positionReports,
        double distanceFlownKm,
        double airborneHours,
        double averageGroundSpeedKmh
) { }

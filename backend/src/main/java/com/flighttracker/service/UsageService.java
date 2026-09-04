package com.flighttracker.service;

import com.flighttracker.dto.AircraftUsage;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Turns flight_position history into usage figures.
 *
 * This used to be the stated reason for keeping every historic row
 * forever. It no longer is: PositionRetentionService prunes that table to
 * a rolling 24h window, so these figures now cover the retention window
 * rather than all time. That was a deliberate trade — /api/usage has no
 * caller anywhere in the frontend, while unbounded history cost ~0.8 GB a
 * day. If deep usage history is ever genuinely wanted, the right shape is
 * a small rolled-up aggregate table written as the data ages out, not
 * retaining raw position rows to derive it from.
 */
@Service
public class UsageService {

    private static final double EARTH_RADIUS_KM = 6371.0;

    private final FlightPositionRepository positionRepository;
    private final AircraftRepository aircraftRepository;

    public UsageService(FlightPositionRepository positionRepository,
                         AircraftRepository aircraftRepository) {
        this.positionRepository = positionRepository;
        this.aircraftRepository = aircraftRepository;
    }

    public List<AircraftUsage> usageForWindow(Instant from, Instant to) {
        List<FlightPosition> all = positionRepository.findByObservedAtBetweenOrderByIcao24AscObservedAtAsc(from, to);

        Map<String, List<FlightPosition>> byAircraft = all.stream()
                .collect(Collectors.groupingBy(FlightPosition::getIcao24, LinkedHashMap::new, Collectors.toList()));

        List<AircraftUsage> results = new ArrayList<>();
        for (var entry : byAircraft.entrySet()) {
            results.add(summarise(entry.getKey(), entry.getValue()));
        }
        return results;
    }

    private AircraftUsage summarise(String icao24, List<FlightPosition> track) {
        double distanceKm = 0.0;
        double airborneSeconds = 0.0;

        for (int i = 1; i < track.size(); i++) {
            FlightPosition prev = track.get(i - 1);
            FlightPosition curr = track.get(i);

            double legKm = haversineKm(prev.getLatitude(), prev.getLongitude(),
                                        curr.getLatitude(), curr.getLongitude());
            distanceKm += legKm;

            if (!prev.isOnGround() && !curr.isOnGround()) {
                airborneSeconds += Duration.between(prev.getObservedAt(), curr.getObservedAt()).getSeconds();
            }
        }

        double airborneHours = airborneSeconds / 3600.0;
        double avgSpeedKmh = airborneHours > 0 ? distanceKm / airborneHours : 0.0;

        String registration = aircraftRepository.findById(icao24)
                .map(a -> a.getRegistration())
                .orElse(null);

        return new AircraftUsage(icao24, registration, track.size(), round2(distanceKm), round2(airborneHours), round2(avgSpeedKmh));
    }

    private static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        double c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return EARTH_RADIUS_KM * c;
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}

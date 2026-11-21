package com.flighttracker.service;

import com.flighttracker.dto.AircraftUsage;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Turns flight_position history into usage figures.
 *
 * This used to be the stated reason for keeping every historic row
 * forever. It no longer is: PositionRetentionService prunes that table to
 * a rolling 72h window, so these figures now cover the retention window
 * rather than all time. That was a deliberate trade — /api/usage has no
 * caller anywhere in the frontend, while unbounded history cost ~0.8 GB a
 * day. If deep usage history is ever genuinely wanted, the right shape is
 * a small rolled-up aggregate table written as the data ages out, not
 * retaining raw position rows to derive it from.
 *
 * UsageController caps one request at 24h, and the rows are streamed
 * rather than loaded, so a request holds one running total per aircraft,
 * not the window's rows.
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
        // Rows arrive in (icao24, observed_at) order, so each aircraft's
        // track is one contiguous run: only the current aircraft's running
        // totals and its previous row are held, never the window's rows.
        List<Track> tracks = new ArrayList<>();
        positionRepository.forEachInWindowByAircraft(from, to, position -> {
            Track current = tracks.isEmpty() ? null : tracks.get(tracks.size() - 1);
            if (current == null || !current.icao24.equals(position.icao24())) {
                current = new Track(position.icao24());
                tracks.add(current);
            }
            current.add(position);
        });
        // Registrations are looked up after the read has finished, so the
        // streaming query never waits on a second connection.
        return tracks.stream().map(this::summarise).toList();
    }

    /** One aircraft's running totals, built row by row in observed_at order. */
    private static final class Track {
        private final String icao24;
        private long reports;
        private double distanceKm;
        private double airborneSeconds;
        private FlightPosition previous;

        Track(String icao24) {
            this.icao24 = icao24;
        }

        void add(FlightPosition curr) {
            if (previous != null) {
                distanceKm += haversineKm(previous.latitude(), previous.longitude(),
                                          curr.latitude(), curr.longitude());
                if (!previous.onGround() && !curr.onGround()) {
                    airborneSeconds += Duration.between(previous.observedAt(), curr.observedAt()).getSeconds();
                }
            }
            previous = curr;
            reports++;
        }
    }

    private AircraftUsage summarise(Track track) {
        double airborneHours = track.airborneSeconds / 3600.0;
        double avgSpeedKmh = airborneHours > 0 ? track.distanceKm / airborneHours : 0.0;

        String registration = aircraftRepository.findById(track.icao24)
                .map(a -> a.registration())
                .orElse(null);

        return new AircraftUsage(track.icao24, registration, track.reports,
                round2(track.distanceKm), round2(airborneHours), round2(avgSpeedKmh));
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

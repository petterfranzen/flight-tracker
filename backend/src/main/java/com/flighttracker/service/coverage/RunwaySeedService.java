package com.flighttracker.service.coverage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Keeps the `runway` table in sync with the bundled runways.tsv (OurAirports,
 * public domain, trimmed by scripts/build-runways-tsv.py to open runways at
 * the airports in airports.tsv, one row per landing direction) and then
 * rebuilds the in-memory {@link RunwayIndex} from the same parsed rows.
 *
 * Mirrors AirportSeedService: re-applied every 24 h with ON CONFLICT DO
 * UPDATE, so a refreshed bundled file in a later release is picked up
 * without clearing anything, and an unchanged row is a cheap no-op.
 * The index is built from the file, not read back from the table, so it is
 * populated even if the database write fails.
 */
@Component
public class RunwaySeedService {

    private static final Logger log = LoggerFactory.getLogger(RunwaySeedService.class);
    private static final String TSV_RESOURCE = "runways.tsv";

    // A literal for the same reason as in AirportSeedService (@Scheduled
    // needs a compile-time constant).
    private static final long RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000L;

    private final JdbcTemplate jdbcTemplate;
    private final RunwayIndex runwayIndex;

    public RunwaySeedService(JdbcTemplate jdbcTemplate, RunwayIndex runwayIndex) {
        this.jdbcTemplate = jdbcTemplate;
        this.runwayIndex = runwayIndex;
    }

    @Scheduled(initialDelay = 0, fixedRate = RESYNC_INTERVAL_MS)
    void sync() {
        List<Runway> runways = readBundled();
        if (runways.isEmpty()) {
            log.warn("Runway reference file had no usable rows — skipping this sync");
            return;
        }

        runwayIndex.replace(runways);
        try {
            upsert(runways);
            log.info("Synced runway reference table: {} rows", runways.size());
        } catch (RuntimeException e) {
            log.warn("Runway table sync failed (the in-memory index is still loaded): {}", e.toString());
        }
    }

    void upsert(List<Runway> runways) {
        List<Object[]> rows = new ArrayList<>(runways.size());
        for (Runway r : runways) {
            rows.add(new Object[]{r.airportIcao(), r.ident(), r.thresholdLat(), r.thresholdLon(),
                    r.headingDeg(), r.elevationM(), r.lengthM()});
        }
        jdbcTemplate.batchUpdate(
                """
                INSERT INTO runway (airport_icao, ident, threshold_lat, threshold_lon, heading_deg, elevation_m, length_m)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (airport_icao, ident) DO UPDATE SET
                    threshold_lat = EXCLUDED.threshold_lat,
                    threshold_lon = EXCLUDED.threshold_lon,
                    heading_deg = EXCLUDED.heading_deg,
                    elevation_m = EXCLUDED.elevation_m,
                    length_m = EXCLUDED.length_m
                """,
                rows);
    }

    static List<Runway> readBundled() {
        try (InputStream in = new ClassPathResource(TSV_RESOURCE).getInputStream()) {
            return parse(in);
        } catch (IOException e) {
            log.warn("Failed to read bundled runway reference file: {}", e.toString());
            return List.of();
        }
    }

    // Tab-delimited with a header line, like airports.tsv. Malformed lines
    // are skipped rather than failing the whole sync.
    static List<Runway> parse(InputStream in) throws IOException {
        List<Runway> runways = new ArrayList<>();
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        String line = reader.readLine(); // header
        while ((line = reader.readLine()) != null) {
            if (line.isBlank()) continue;
            String[] f = line.split("\t", -1);
            if (f.length != 7 || f[0].isBlank() || f[1].isBlank()) continue;
            try {
                runways.add(new Runway(f[0], f[1],
                        Double.parseDouble(f[2]), Double.parseDouble(f[3]),
                        Double.parseDouble(f[4]),
                        f[5].isBlank() ? null : Double.valueOf(f[5]),
                        Double.parseDouble(f[6])));
            } catch (NumberFormatException e) {
                // skip the malformed line
            }
        }
        return runways;
    }
}

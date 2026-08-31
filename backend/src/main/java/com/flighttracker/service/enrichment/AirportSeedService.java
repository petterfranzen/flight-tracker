package com.flighttracker.service.enrichment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Keeps the `airport` table in sync with a bundled OurAirports (public
 * domain, ourairports.com via its davidmegginson/ourairports-data GitHub
 * mirror) CSV extract — every real large/medium/small airport with a
 * 4-letter ICAO code, trimmed to just the columns this app uses (~10k
 * rows, ~680KB). Static reference data, not a live per-request API call:
 * adsbdb has no standalone "look up this code" endpoint (only ever
 * returns a name as part of a resolved route), so this exists purely to
 * backfill the gap — see AirportLookupService.
 *
 * Re-applied on a schedule (RESYNC_INTERVAL_MS), not just once at
 * startup: an ICAO/IATA designation or airport name essentially never
 * changes day to day, but "never" isn't "literally can't" — reassignments
 * and new/closed airports do happen occasionally in the real OurAirports
 * data, and a future app update could ship a refreshed bundled file. The
 * old one-time "skip if the table already has any rows" guard meant an
 * existing deployment would never pick that up, ever, short of manually
 * clearing the table. ON CONFLICT DO UPDATE (not DO NOTHING) is what
 * makes re-running this safe and actually useful: unchanged rows are a
 * cheap no-op UPDATE, changed ones actually update, and it's still a
 * single local batched Postgres operation either way — no external call,
 * so there's no cost to doing this daily instead of once.
 *
 * No @Profile restriction, same as the rest of the enrichment package —
 * both the "api" and "agent" containers call AircraftEnrichmentService, so
 * both need this table populated, and both independently running this
 * sync on their own schedule is harmless: icao_code is the primary key,
 * so two concurrent upserts of the same row just serialize at the DB
 * level, not a conflict.
 */
@Component
public class AirportSeedService {

    private static final Logger log = LoggerFactory.getLogger(AirportSeedService.class);
    private static final String CSV_RESOURCE = "airports.tsv";

    // 24h, as a literal (not Duration.ofHours(24).toMillis()) — @Scheduled's
    // fixedRate needs a compile-time constant expression, which a method
    // call, even assigned to a static final field, doesn't qualify as.
    private static final long RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000L;

    private final JdbcTemplate jdbcTemplate;

    public AirportSeedService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Scheduled(initialDelay = 0, fixedRate = RESYNC_INTERVAL_MS)
    void sync() {
        List<Object[]> rows = readTsv();
        if (rows.isEmpty()) {
            log.warn("Airport reference file had no usable rows — skipping this sync");
            return;
        }

        jdbcTemplate.batchUpdate(
                """
                INSERT INTO airport (icao_code, iata_code, name, municipality, country, latitude, longitude)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (icao_code) DO UPDATE SET
                    iata_code = EXCLUDED.iata_code,
                    name = EXCLUDED.name,
                    municipality = EXCLUDED.municipality,
                    country = EXCLUDED.country,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude
                """,
                rows);
        log.info("Synced airport reference table: {} rows", rows.size());
    }

    private List<Object[]> readTsv() {
        List<Object[]> rows = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new ClassPathResource(CSV_RESOURCE).getInputStream(), StandardCharsets.UTF_8))) {
            String line = reader.readLine(); // header
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                String[] f = parseTsvLine(line);
                if (f.length != 7 || f[0].isBlank() || f[2].isBlank()) continue;
                rows.add(new Object[]{
                        f[0],                       // icao_code
                        nullIfBlank(f[1]),           // iata_code
                        f[2],                        // name
                        nullIfBlank(f[3]),           // municipality
                        nullIfBlank(f[4]),           // country
                        parseDoubleOrNull(f[5]),     // latitude
                        parseDoubleOrNull(f[6]),     // longitude
                });
            }
        } catch (IOException e) {
            log.warn("Failed to read bundled airport reference file: {}", e.toString());
        }
        return rows;
    }

    // Tab-delimited, not comma: the free-text fields (name, municipality)
    // do legitimately contain commas in real OurAirports data (verified
    // while bundling this file — a naive comma-split silently misparsed
    // ~250 rows), and tab is guaranteed absent from every field (checked at
    // bundling time), so this needs no quoting/escaping logic at all.
    private static String[] parseTsvLine(String line) {
        return line.split("\t", -1);
    }

    private static String nullIfBlank(String s) {
        return s.isBlank() ? null : s;
    }

    private static Double parseDoubleOrNull(String s) {
        if (s.isBlank()) return null;
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

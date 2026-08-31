package com.flighttracker.service.enrichment;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Seeds the `airport` table once from a bundled OurAirports (public domain,
 * ourairports.com via its davidmegginson/ourairports-data GitHub mirror)
 * CSV extract — every real large/medium/small airport with a 4-letter ICAO
 * code, trimmed to just the columns this app uses (~10k rows, ~680KB).
 * Static reference data, not a live per-request API call: adsbdb has no
 * standalone "look up this code" endpoint (only ever returns a name as
 * part of a resolved route), so this exists purely to backfill the gap —
 * see AirportLookupService.
 *
 * Guarded the same way AgentOrchestrator.seedOnStartup() guards its own
 * one-time seed: check first, skip entirely if the table already has rows.
 * No @Profile restriction, same as the rest of the enrichment package — both
 * the "api" and "agent" containers call AircraftEnrichmentService, so both
 * need this table populated. Harmless if both race to seed on a fresh
 * deployment: icao_code is the primary key, and the batch insert uses
 * "ON CONFLICT DO NOTHING", so a double-seed is a no-op, not a failure.
 */
@Component
public class AirportSeedService {

    private static final Logger log = LoggerFactory.getLogger(AirportSeedService.class);
    private static final String CSV_RESOURCE = "airports.tsv";

    private final JdbcTemplate jdbcTemplate;

    public AirportSeedService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostConstruct
    void seedIfEmpty() {
        Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM airport", Integer.class);
        if (count != null && count > 0) {
            log.debug("Airport reference table already seeded ({} rows) — skipping", count);
            return;
        }

        List<Object[]> rows = readTsv();
        if (rows.isEmpty()) {
            log.warn("Airport reference file had no usable rows — airport-name backfill will be a no-op");
            return;
        }

        jdbcTemplate.batchUpdate(
                "INSERT INTO airport (icao_code, iata_code, name, municipality, country, latitude, longitude) " +
                        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (icao_code) DO NOTHING",
                rows);
        log.info("Seeded airport reference table with {} rows", rows.size());
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

package com.flighttracker.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Thin key/value store over the app_state table — a small write-through
 * layer for the handful of counters that must survive a process restart
 * now that PollWindowService and HotPollUserBudget otherwise hold their
 * state in plain memory (cloud migration A1 — see PLAN.md §6 item 6: "the
 * daily hot-poll call budget and per-IP hot-poll seconds must survive a
 * restart"). Plain JdbcTemplate rather than JdbcClient: this has no row
 * type of its own worth a record for — just a get/put/prefix-scan over a
 * two-column table — so JdbcClient's extra fluency buys nothing here.
 * Values are always TEXT — callers own their own serialization (a plain
 * number, a small delimited list, whatever fits) since app_state has no
 * opinion about what any given key's value means.
 */
@Repository
public class AppStateRepository {

    private final JdbcTemplate jdbcTemplate;
    private final Clock clock;

    public AppStateRepository(JdbcTemplate jdbcTemplate, Clock clock) {
        this.jdbcTemplate = jdbcTemplate;
        this.clock = clock;
    }

    public Optional<String> get(String key) {
        List<String> rows = jdbcTemplate.query(
                "SELECT value FROM app_state WHERE key = ?",
                (rs, rowNum) -> rs.getString("value"),
                key);
        return rows.stream().findFirst();
    }

    /**
     * Write-through upsert — the whole point of this table is that every
     * caller writes on every change, not on a schedule. updated_at binds
     * from the injected Clock (cloud migration A2, PLAN.md §6 item 4)
     * rather than a SQL-side now() — SQLite has no such function, and this
     * keeps every timestamp write in the app going through one
     * Clock-backed path, testable with Clock.fixed(...).
     */
    public void put(String key, String value) {
        jdbcTemplate.update("""
            INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
            """, key, value, clock.millis());
    }

    /** Every row whose key starts with prefix — for loading a whole family of keys (e.g. one per client IP) back into memory at startup. */
    public Map<String, String> getAllWithPrefix(String prefix) {
        return jdbcTemplate.query(
                "SELECT key, value FROM app_state WHERE key LIKE ?",
                rs -> {
                    Map<String, String> out = new LinkedHashMap<>();
                    while (rs.next()) {
                        out.put(rs.getString("key"), rs.getString("value"));
                    }
                    return out;
                },
                escapeLikePrefix(prefix) + "%");
    }

    // app_state keys are all written by this codebase (never user input),
    // so this is just correctness, not a security boundary — but a key
    // that happened to contain a literal % or _ would otherwise silently
    // widen a prefix scan.
    private static String escapeLikePrefix(String prefix) {
        return prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }
}

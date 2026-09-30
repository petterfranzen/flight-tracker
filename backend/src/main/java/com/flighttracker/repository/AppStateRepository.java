package com.flighttracker.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

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
 * restart"). Plain JdbcTemplate rather than a Spring Data repository: this
 * has no entity of its own, just get/put/prefix-scan over a two-column
 * table, and a JPA @Entity would be pure ceremony for that. Values are
 * always TEXT — callers own their own serialization (a plain number, a
 * small delimited list, whatever fits) since app_state has no opinion
 * about what any given key's value means.
 */
@Repository
public class AppStateRepository {

    private final JdbcTemplate jdbcTemplate;

    public AppStateRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public Optional<String> get(String key) {
        List<String> rows = jdbcTemplate.query(
                "SELECT value FROM app_state WHERE key = ?",
                (rs, rowNum) -> rs.getString("value"),
                key);
        return rows.stream().findFirst();
    }

    /** Write-through upsert — the whole point of this table is that every caller writes on every change, not on a schedule. */
    public void put(String key, String value) {
        jdbcTemplate.update("""
            INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
            """, key, value);
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

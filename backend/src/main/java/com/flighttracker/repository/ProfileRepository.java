package com.flighttracker.repository;

import com.flighttracker.model.Profile;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.util.Optional;

import static com.flighttracker.repository.Timestamps.fromEpochMilli;
import static com.flighttracker.repository.Timestamps.toEpochMilli;

/**
 * The profile table — one row per person who chose to sign in (schema.sql,
 * design §2). Timestamps are stamped from the injected Clock on write, the
 * same convention every repository here follows, so a fixed Clock in a test
 * gives deterministic rows.
 */
@Repository
public class ProfileRepository {

    private final JdbcClient jdbcClient;
    private final Clock clock;

    public ProfileRepository(JdbcClient jdbcClient, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.clock = clock;
    }

    private static Profile mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new Profile(
                rs.getString("id"),
                rs.getString("provider"),
                rs.getString("subject_hash"),
                fromEpochMilli(rs.getLong("created_at")),
                fromEpochMilli(rs.getLong("last_seen_at")));
    }

    public Optional<Profile> findById(String id) {
        return jdbcClient.sql("SELECT * FROM profile WHERE id = :id")
                .param("id", id)
                .query(ProfileRepository::mapRow)
                .optional();
    }

    public Optional<Profile> findByProviderAndSubjectHash(String provider, String subjectHash) {
        return jdbcClient.sql("SELECT * FROM profile WHERE provider = :provider AND subject_hash = :subjectHash")
                .param("provider", provider)
                .param("subjectHash", subjectHash)
                .query(ProfileRepository::mapRow)
                .optional();
    }

    /**
     * Inserts a new profile, or does nothing and returns empty when the
     * (provider, subject_hash) already exists — the unique index uq_profile_identity
     * is the conflict target, so signing in twice with the same provider subject
     * is a no-op rather than an error. RETURNING * (SQLite >= 3.35) lets the
     * caller tell "inserted" apart from "already there" without a second query.
     */
    public Optional<Profile> insertIfAbsent(String id, String provider, String subjectHash) {
        long now = clock.millis();
        return jdbcClient.sql("""
                INSERT INTO profile (id, provider, subject_hash, created_at, last_seen_at)
                VALUES (:id, :provider, :subjectHash, :now, :now)
                ON CONFLICT (provider, subject_hash) DO NOTHING
                RETURNING *
                """)
                .param("id", id)
                .param("provider", provider)
                .param("subjectHash", subjectHash)
                .param("now", now)
                .query(ProfileRepository::mapRow)
                .optional();
    }

    /** Bumps last_seen_at on each successful sign-in. */
    public void touch(String id) {
        jdbcClient.sql("UPDATE profile SET last_seen_at = :now WHERE id = :id")
                .param("now", clock.millis())
                .param("id", id)
                .update();
    }

    public int deleteById(String id) {
        return jdbcClient.sql("DELETE FROM profile WHERE id = :id")
                .param("id", id)
                .update();
    }
}

package com.flighttracker.repository;

import com.flighttracker.model.Favorite;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.util.List;
import java.util.Optional;

import static com.flighttracker.repository.Timestamps.fromEpochMilli;

/**
 * The favorite table (schema.sql, design §2), keyed (profile_id, kind, item_key)
 * the way the frontend already keys a favourite. `data` is the frontend's own
 * JSON, stored verbatim.
 */
@Repository
public class FavoriteRepository {

    private final JdbcClient jdbcClient;
    private final Clock clock;

    public FavoriteRepository(JdbcClient jdbcClient, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.clock = clock;
    }

    private static Favorite mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new Favorite(
                rs.getString("profile_id"),
                rs.getString("kind"),
                rs.getString("item_key"),
                rs.getString("data"),
                fromEpochMilli(rs.getLong("updated_at")));
    }

    public List<Favorite> findByProfileId(String profileId) {
        return jdbcClient.sql("SELECT * FROM favorite WHERE profile_id = :profileId ORDER BY kind, item_key")
                .param("profileId", profileId)
                .query(FavoriteRepository::mapRow)
                .list();
    }

    public Optional<Favorite> find(String profileId, String kind, String itemKey) {
        return jdbcClient.sql("""
                SELECT * FROM favorite WHERE profile_id = :profileId AND kind = :kind AND item_key = :itemKey
                """)
                .param("profileId", profileId)
                .param("kind", kind)
                .param("itemKey", itemKey)
                .query(FavoriteRepository::mapRow)
                .optional();
    }

    /** Adds or replaces one favourite, stamping updated_at. */
    public void upsert(String profileId, String kind, String itemKey, String data) {
        jdbcClient.sql("""
                INSERT INTO favorite (profile_id, kind, item_key, data, updated_at)
                VALUES (:profileId, :kind, :itemKey, :data, :now)
                ON CONFLICT (profile_id, kind, item_key) DO UPDATE SET
                    data = excluded.data,
                    updated_at = excluded.updated_at
                """)
                .param("profileId", profileId)
                .param("kind", kind)
                .param("itemKey", itemKey)
                .param("data", data)
                .param("now", clock.millis())
                .update();
    }

    public int delete(String profileId, String kind, String itemKey) {
        return jdbcClient.sql("""
                DELETE FROM favorite WHERE profile_id = :profileId AND kind = :kind AND item_key = :itemKey
                """)
                .param("profileId", profileId)
                .param("kind", kind)
                .param("itemKey", itemKey)
                .update();
    }

    public int deleteAllForProfile(String profileId) {
        return jdbcClient.sql("DELETE FROM favorite WHERE profile_id = :profileId")
                .param("profileId", profileId)
                .update();
    }

    public long countForProfile(String profileId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM favorite WHERE profile_id = :profileId")
                .param("profileId", profileId)
                .query(Long.class)
                .single();
    }
}

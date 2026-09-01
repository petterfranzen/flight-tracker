package com.flighttracker.repository;

import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.model.FlightPosition;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface FlightPositionRepository extends JpaRepository<FlightPosition, Long> {

    // aircraft_latest_position's columns, explicitly listed (not SELECT *)
    // so the extra landed_since column never leaks into FlightPosition's
    // entity mapping, which doesn't have a field for it. latitude/longitude
    // are COALESCEd with estimated_latitude/estimated_longitude — EVERY
    // reader of this constant gets EstimatorAgent's current best-guess
    // position automatically, with no per-endpoint overlay step to
    // remember (that used to be EstimatedPositionCache.overlay(), applied
    // by some endpoints and not others — the actual root cause of aircraft
    // visibly disagreeing between the individual and clustered map views).
    // observed_at itself is untouched — every consumer that needs "the
    // time of the last REAL report" (dedup, the upsert's own monotonicity
    // guard, the dossier's presumed-landed timer, the frontend's staleness
    // banner) still gets exactly that, never an estimate's computation
    // time.
    String LATEST_COLUMNS = """
        id, icao24, callsign, observed_at,
        COALESCE(estimated_latitude, latitude) AS latitude,
        COALESCE(estimated_longitude, longitude) AS longitude,
        altitude_m, velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source
        """;

    // Same columns, `alp.`-qualified — for queries that JOIN
    // aircraft_latest_position (aliased alp) against another table that
    // could also have an icao24 (or other overlapping-name) column, where
    // the bare LATEST_COLUMNS list above would be ambiguous.
    String LATEST_COLUMNS_ALP = """
        alp.id, alp.icao24, alp.callsign, alp.observed_at,
        COALESCE(alp.estimated_latitude, alp.latitude) AS latitude,
        COALESCE(alp.estimated_longitude, alp.longitude) AS longitude,
        alp.altitude_m, alp.velocity_ms, alp.heading_deg, alp.vertical_rate_ms,
        alp.on_ground, alp.agent_source
        """;

    // Live map, whole world: every aircraft that's still airborne (bounded
    // by staleAirborneCutoff so a truly dead/never-updating icao24 doesn't
    // linger forever — real ADS-B gaps happen, but an aircraft silent that
    // long is presumed lost from the feed, not still flying), or landed
    // within the last landedCutoff window. A silent-and-descending aircraft
    // (see LiveVisibilityWindows.PRESUMED_LANDED_SILENCE) is deliberately
    // NOT excluded here — it keeps showing under the airborne branch
    // (dead-reckoned to its destination and parked there by
    // EstimatorAgent) rather than disappearing the moment it's
    // presumed landed; that presumption only changes how AircraftController
    // describes it, not whether it's on the map. See
    // aircraft_latest_position's schema.sql comment for why this reads a
    // maintained summary table instead of aggregating flight_position's
    // full history on every call.
    @Query(value = "SELECT " + LATEST_COLUMNS + """
        FROM aircraft_latest_position
        WHERE (on_ground = false AND observed_at > :staleAirborneCutoff)
           OR (on_ground = true AND landed_since > :landedCutoff)
        """, nativeQuery = true)
    List<FlightPosition> findLive(@Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                   @Param("landedCutoff") Instant landedCutoff);

    // Same as findLive, further filtered to a lat/lon box — what the
    // frontend actually calls with, passing its current map viewport, so
    // only what's visible is fetched/rendered rather than every aircraft
    // being globally tracked. Filters on the same COALESCE(estimated_*,
    // ...) expression LATEST_COLUMNS selects — filtering on the raw
    // columns instead would place an aircraft whose estimated position has
    // drifted across the viewport edge in the wrong place relative to what
    // was actually asked for. Matched by idx_latest_position_bbox_estimated
    // (an expression index on this exact COALESCE pair), not a plain
    // (latitude, longitude) index.
    @Query(value = "SELECT " + LATEST_COLUMNS + """
        FROM aircraft_latest_position
        WHERE ((on_ground = false AND observed_at > :staleAirborneCutoff)
           OR (on_ground = true AND landed_since > :landedCutoff))
          AND COALESCE(estimated_latitude, latitude) BETWEEN :latMin AND :latMax
          AND COALESCE(estimated_longitude, longitude) BETWEEN :lonMin AND :lonMax
        """, nativeQuery = true)
    List<FlightPosition> findLiveInBounds(@Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                           @Param("landedCutoff") Instant landedCutoff,
                                           @Param("latMin") double latMin,
                                           @Param("latMax") double latMax,
                                           @Param("lonMin") double lonMin,
                                           @Param("lonMax") double lonMax);

    // Zoomed-way-out answer to findLiveInBounds: a client-scoped viewport
    // covering a continent or the whole world can mean tens of thousands
    // of rows — every one of which the frontend would otherwise have to
    // turn into its own React component and feed through
    // leaflet.markercluster's per-marker spatial-indexing algorithm, which
    // is where the real cost was (confirmed: the backend answers a
    // whole-world bbox in ~60ms; it was 2+ seconds of client-side work
    // rendering 20k+ individual markers that made zooming out feel stuck).
    // Aggregating server-side into gridDeg-sized cells cuts what crosses
    // the wire — and what the client has to render — from one row per
    // aircraft to one row per populated cell, typically two to three
    // orders of magnitude fewer. floor(lat/gridDeg)*gridDeg + gridDeg/2
    // (and the same for lon) buckets each aircraft into its cell and
    // reports the cell's center, not the true centroid of the aircraft in
    // it — cheaper to compute and close enough at the zoom level this is
    // used for (individual aircraft aren't distinguishable there anyway).
    // Postgres won't accept the cell-center expression (bucket + gridDeg/2)
    // directly in SELECT while only the bare bucket is in GROUP BY — it
    // doesn't infer that the center is a deterministic function of the
    // group, even though it obviously is. The subquery does the bucketing
    // and GROUP BY on the exact same bucket_lat/bucket_lon expressions,
    // and only the outer query — grouped by nothing, just per aggregated
    // row — offsets each bucket to its center.
    // Buckets on COALESCE(estimated_latitude, latitude) (and longitude) —
    // the same expression LATEST_COLUMNS/findLiveInBounds now read — so a
    // dead-reckoned aircraft lands in the same cluster cell here as the
    // marker findLiveInBounds would place it at once zoomed in. This is
    // the literal fix for clusters and the individual view disagreeing
    // about what's currently visible in a given area.
    @Query(value = """
        SELECT bucket_lat + :gridDeg / 2 AS lat, bucket_lon + :gridDeg / 2 AS lon, count AS count
        FROM (
            SELECT
                floor(COALESCE(estimated_latitude, latitude) / :gridDeg) * :gridDeg AS bucket_lat,
                floor(COALESCE(estimated_longitude, longitude) / :gridDeg) * :gridDeg AS bucket_lon,
                count(*) AS count
            FROM aircraft_latest_position
            WHERE ((on_ground = false AND observed_at > :staleAirborneCutoff)
               OR (on_ground = true AND landed_since > :landedCutoff))
              AND COALESCE(estimated_latitude, latitude) BETWEEN :latMin AND :latMax
              AND COALESCE(estimated_longitude, longitude) BETWEEN :lonMin AND :lonMax
            GROUP BY bucket_lat, bucket_lon
        ) buckets
        """, nativeQuery = true)
    List<ClusterPoint> findLiveClusteredInBounds(@Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                                  @Param("landedCutoff") Instant landedCutoff,
                                                  @Param("latMin") double latMin,
                                                  @Param("latMax") double latMax,
                                                  @Param("lonMin") double lonMin,
                                                  @Param("lonMax") double lonMax,
                                                  @Param("gridDeg") double gridDeg);

    // Backs the search box's autocomplete: live aircraft whose callsign
    // matches the query — the flight-number/callsign field specifically.
    // Airport-based search (origin/destination) is a separate, explicit
    // "advanced search" (see searchByAirport below) rather than folded
    // into this same field, since callsign and airport matching rank
    // differently. Ranking: an exact callsign-prefix match (typing a flight
    // number's beginning, e.g. "SAS21" — the single most common case)
    // outranks every other kind of match; beyond that, alphabetical.
    // Scoped to the same liveness window as findLive — searching up a
    // flight only to find it's not actually trackable right now (nowhere
    // to zoom to) isn't useful.
    @Query(value = "SELECT " + LATEST_COLUMNS + """
        FROM aircraft_latest_position
        WHERE callsign ILIKE :containsPattern
          AND ((on_ground = false AND observed_at > :staleAirborneCutoff)
           OR (on_ground = true AND landed_since > :landedCutoff))
        ORDER BY (callsign ILIKE :prefixPattern) DESC, callsign ASC
        LIMIT :limit
        """, nativeQuery = true)
    List<FlightPosition> searchLive(@Param("containsPattern") String containsPattern,
                                     @Param("prefixPattern") String prefixPattern,
                                     @Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                     @Param("landedCutoff") Instant landedCutoff,
                                     @Param("limit") int limit);

    // Backs the "advanced search" panel's single airport field — matches
    // an aircraft whose origin OR destination airport matches the given
    // pattern (name, IATA code, ICAO code, or city). LEFT JOIN, not INNER,
    // for the same reason as searchLive's old join: dossier enrichment is
    // lazy/on-demand, so an unenriched aircraft must still not blow up the
    // query even though it can never match a non-null route filter.
    // Scoped to the same liveness window as findLive.
    //
    // origin_ap/dest_ap join the airport reference table (~10k rows, seeded
    // from airports.tsv by AirportSeedService) on the aircraft's own ICAO
    // route codes, purely so a query can also match that airport's IATA
    // code or city (e.g. searching "KLR" or "Kalmar" finds a flight whose
    // destination_airport is the ICAO code "ESMQ") — a.origin_airport_name/
    // destination_airport_name alone only ever contain whatever free-text
    // name adsbdb or the OpenSky-fallback backfill happened to produce for
    // that specific aircraft, which has no IATA code and isn't reliably the
    // city name.
    @Query(value = "SELECT " + LATEST_COLUMNS_ALP + """
        FROM aircraft_latest_position alp
        LEFT JOIN aircraft a ON a.icao24 = alp.icao24
        LEFT JOIN airport origin_ap ON origin_ap.icao_code = a.origin_airport
        LEFT JOIN airport dest_ap ON dest_ap.icao_code = a.destination_airport
        WHERE (a.origin_airport ILIKE :pattern
                OR a.origin_airport_name ILIKE :pattern
                OR origin_ap.iata_code ILIKE :pattern
                OR origin_ap.name ILIKE :pattern
                OR origin_ap.municipality ILIKE :pattern
                OR a.destination_airport ILIKE :pattern
                OR a.destination_airport_name ILIKE :pattern
                OR dest_ap.iata_code ILIKE :pattern
                OR dest_ap.name ILIKE :pattern
                OR dest_ap.municipality ILIKE :pattern)
          AND ((alp.on_ground = false AND alp.observed_at > :staleAirborneCutoff)
           OR (alp.on_ground = true AND alp.landed_since > :landedCutoff))
        ORDER BY alp.callsign ASC
        LIMIT :limit
        """, nativeQuery = true)
    List<FlightPosition> searchByAirport(@Param("pattern") String pattern,
                                          @Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                          @Param("landedCutoff") Instant landedCutoff,
                                          @Param("limit") int limit);

    // Keeps aircraft_latest_position in sync — called once per accepted
    // (non-duplicate) flight_position insert, i.e. right after
    // insertIgnoringDuplicate returns a present Optional. The WHERE guard
    // on the UPDATE only lets a report move the row *forward* in time —
    // reports can arrive slightly out of order (two agents, network
    // delays) and this must never regress "latest" to something older.
    // landed_since: reset to this report's time the moment on_ground flips
    // true, carried forward unchanged while it stays true, cleared on the
    // next false. estimated_latitude/estimated_longitude/estimated_at:
    // unconditionally cleared to NULL — a genuine new real report always
    // supersedes any prior dead-reckoned guess immediately, rather than
    // waiting for EstimatorAgent's next cycle to notice and clear it
    // itself. Governed by the same observed_at guard as everything else
    // here, so this never fires out of order either.
    @Modifying
    @Query(value = """
        INSERT INTO aircraft_latest_position
            (icao24, callsign, observed_at, latitude, longitude, altitude_m,
             velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source, landed_since)
        VALUES
            (:icao24, :callsign, :observedAt, :latitude, :longitude, :altitudeM,
             :velocityMs, :headingDeg, :verticalRateMs, :onGround, :agentSource,
             CASE WHEN :onGround THEN CAST(:observedAt AS timestamptz) ELSE NULL END)
        ON CONFLICT (icao24) DO UPDATE SET
            callsign = EXCLUDED.callsign,
            observed_at = EXCLUDED.observed_at,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            altitude_m = EXCLUDED.altitude_m,
            velocity_ms = EXCLUDED.velocity_ms,
            heading_deg = EXCLUDED.heading_deg,
            vertical_rate_ms = EXCLUDED.vertical_rate_ms,
            on_ground = EXCLUDED.on_ground,
            agent_source = EXCLUDED.agent_source,
            landed_since = CASE
                WHEN EXCLUDED.on_ground = false THEN NULL
                WHEN aircraft_latest_position.on_ground = true THEN aircraft_latest_position.landed_since
                ELSE EXCLUDED.observed_at
            END,
            estimated_latitude = NULL,
            estimated_longitude = NULL,
            estimated_at = NULL
        WHERE EXCLUDED.observed_at > aircraft_latest_position.observed_at
        """, nativeQuery = true)
    void upsertLatestPosition(
            @Param("icao24") String icao24,
            @Param("callsign") String callsign,
            @Param("observedAt") Instant observedAt,
            @Param("latitude") double latitude,
            @Param("longitude") double longitude,
            @Param("altitudeM") Double altitudeM,
            @Param("velocityMs") Double velocityMs,
            @Param("headingDeg") Double headingDeg,
            @Param("verticalRateMs") Double verticalRateMs,
            @Param("onGround") boolean onGround,
            @Param("agentSource") String agentSource);

    // Two agents (or two poll cycles of the same agent, when OpenSky hasn't
    // refreshed an aircraft between our polls) can report the exact same
    // (icao24, observed_at, agent_source) tick. A plain save() that relies
    // on catching the resulting DataIntegrityViolationException doesn't
    // work here: Postgres aborts the *whole* transaction on a constraint
    // violation, not just the offending statement, so catching it in Java
    // after the fact still leaves every later save() in the same batch
    // failing too. ON CONFLICT DO NOTHING sidesteps that entirely — the
    // duplicate is a no-op at the SQL level, not an error.
    @Query(value = """
        INSERT INTO flight_position
            (icao24, callsign, observed_at, latitude, longitude, altitude_m,
             velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source)
        VALUES
            (:icao24, :callsign, :observedAt, :latitude, :longitude, :altitudeM,
             :velocityMs, :headingDeg, :verticalRateMs, :onGround, :agentSource)
        ON CONFLICT (icao24, observed_at, agent_source) DO NOTHING
        RETURNING *
        """, nativeQuery = true)
    Optional<FlightPosition> insertIgnoringDuplicate(
            @Param("icao24") String icao24,
            @Param("callsign") String callsign,
            @Param("observedAt") Instant observedAt,
            @Param("latitude") double latitude,
            @Param("longitude") double longitude,
            @Param("altitudeM") Double altitudeM,
            @Param("velocityMs") Double velocityMs,
            @Param("headingDeg") Double headingDeg,
            @Param("verticalRateMs") Double verticalRateMs,
            @Param("onGround") boolean onGround,
            @Param("agentSource") String agentSource);

    // "Current flight time" for the dossier (AircraftController): the
    // earliest airborne report since this aircraft was last known to be on
    // the ground — i.e. this leg's takeoff time, not the first time we
    // ever saw the aircraft. Falls back to the earliest airborne report
    // ever (epoch as the COALESCE floor) for an aircraft we've only ever
    // seen airborne, which likely underestimates flight time a little
    // (we may have started watching mid-flight) but is the best available
    // answer rather than none at all.
    @Query(value = """
        SELECT MIN(observed_at)
        FROM flight_position
        WHERE icao24 = :icao24
          AND on_ground = false
          AND observed_at > COALESCE(
              (SELECT MAX(observed_at) FROM flight_position WHERE icao24 = :icao24 AND on_ground = true),
              to_timestamp(0)
          )
        """, nativeQuery = true)
    Optional<Instant> findCurrentLegTakeoffTime(@Param("icao24") String icao24);

    // "Cruising altitude" for the dossier: the highest altitude reached so
    // far in the current leg (from legStart, i.e. findCurrentLegTakeoffTime
    // above — not this aircraft's entire tracked history, which could span
    // many separate flights). Still meaningful after landing (it's simply
    // that completed flight's peak), so this isn't gated on on_ground.
    @Query(value = "SELECT MAX(altitude_m) FROM flight_position WHERE icao24 = :icao24 AND observed_at >= :legStart",
            nativeQuery = true)
    Optional<Double> findMaxAltitudeSince(@Param("icao24") String icao24, @Param("legStart") Instant legStart);

    // The other input FlightPhaseClassifier needs: altitude at an earlier
    // reference point, to turn into a real trend rather than reading the
    // single latest (possibly noisy) vertical_rate_ms in isolation.
    // Bounded to >= legStart so a short-on-data early flight falls back to
    // "no earlier point yet" (null) rather than reaching back into a
    // previous, unrelated flight leg from this aircraft's older history.
    @Query(value = """
        SELECT altitude_m
        FROM flight_position
        WHERE icao24 = :icao24 AND observed_at >= :legStart AND observed_at <= :atOrBefore
        ORDER BY observed_at DESC
        LIMIT 1
        """, nativeQuery = true)
    Optional<Double> findAltitudeAtOrBefore(@Param("icao24") String icao24,
                                             @Param("legStart") Instant legStart,
                                             @Param("atOrBefore") Instant atOrBefore);

    // On-demand enrichment (AircraftController) needs a callsign to key
    // adsbdb's route lookup by — aircraft_latest_position is the cheap way
    // to get one without touching flight_position's full history.
    @Query(value = "SELECT callsign FROM aircraft_latest_position WHERE icao24 = :icao24", nativeQuery = true)
    Optional<String> findLatestCallsign(@Param("icao24") String icao24);

    // The dossier's ETA calc (AircraftController) needs this aircraft's
    // current position/groundspeed, not just its callsign. Coalesced with
    // any current estimate via LATEST_COLUMNS — the ETA benefits from the
    // more accurate live position, same as every other LATEST_COLUMNS
    // consumer.
    @Query(value = "SELECT " + LATEST_COLUMNS + " FROM aircraft_latest_position WHERE icao24 = :icao24", nativeQuery = true)
    Optional<FlightPosition> findLatestPosition(@Param("icao24") String icao24);

    // Raw (never coalesced with an estimate) lat/lon for one aircraft's
    // last real report. Exists for exactly one caller —
    // AircraftController.describeLikelyStatus's "likely landed near X (N
    // km away at last report)" text, which is documented as describing
    // what the last report actually said, not a projection — reading
    // findLatestPosition's coalesced value there would make that distance
    // a self-fulfilling artifact of EstimatedPositionService's own
    // destination-clipping instead of a genuine last-report fact.
    interface RawLatLon {
        double getLatitude();
        double getLongitude();
    }

    @Query(value = "SELECT latitude, longitude FROM aircraft_latest_position WHERE icao24 = :icao24", nativeQuery = true)
    Optional<RawLatLon> findRawLatestLatLon(@Param("icao24") String icao24);

    // Lets AgentOrchestrator tell a genuinely first-ever boot (empty table,
    // worth blocking startup on one synchronous global sweep so the map
    // isn't empty) apart from every later restart (table already has
    // *some* data, even if a few minutes stale — not worth adding tens of
    // seconds to every redeploy for).
    @Query(value = "SELECT count(*) FROM aircraft_latest_position", nativeQuery = true)
    long countLatestPositions();

    // Usage calc: full ordered history for one aircraft in a window.
    List<FlightPosition> findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(
            String icao24, Instant from, Instant to);

    // Usage calc: history for every aircraft in a window, for the fleet report.
    List<FlightPosition> findByObservedAtBetweenOrderByIcao24AscObservedAtAsc(
            Instant from, Instant to);
}

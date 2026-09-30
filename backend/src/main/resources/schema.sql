-- Flight Tracker schema (SQLite — cloud migration A2, PLAN.md §6)
-- Design goal: every position report is kept (never overwritten), so usage
-- (flight hours, distance flown, utilisation %) can be derived later from
-- the historic series rather than from a "current state" row.
--
-- Every timestamp column below is an INTEGER storing epoch milliseconds
-- UTC — SQLite has no native timestamp type, and this is the one
-- Instant<->long convention the whole app uses (see repository/
-- Timestamps.java). now() has no SQLite equivalent worth relying on for
-- this either: every write binds its own timestamp from a Clock bean
-- instead (PLAN.md §6 item 4), so tests can use a fixed Clock and get
-- deterministic cutoffs.
--
-- Single process now (cloud migration A1), so the advisory-lock dance the
-- Postgres version of this file needed for three containers racing
-- CREATE TABLE on the same cold boot no longer applies — there's only ever
-- one writer starting this script.
--
-- auto_vacuum must be set before this database's first table is created,
-- and — this bit is *not* obvious — before any connection that flips
-- journal_mode to WAL touches the file either, since that switch is
-- itself a transaction that finalizes the page auto_vacuum's value lives
-- on. A pooled DataSource whose connections carry journal_mode=WAL (this
-- app's does) can easily win that race against a plain PRAGMA statement
-- placed here, silently leaving auto_vacuum at SQLite's default (NONE) —
-- confirmed the hard way. So this is no longer set here: see
-- config/SqliteDataSourceConfig.setAutoVacuumOnFreshDatabase, which sets
-- it via a bare, un-pragma'd connection *before* the pooled DataSource
-- (and this script) ever open the file. INCREMENTAL over the default
-- (NONE) or FULL: PositionRetentionService calls PRAGMA
-- incremental_vacuum(2000) after every retention run (see below) to
-- reclaim freed pages in small, predictable steps instead of either
-- leaking free space forever (NONE) or paying a full, blocking VACUUM's
-- cost (FULL would auto-compact on every transaction commit, not just
-- when asked).

CREATE TABLE IF NOT EXISTS aircraft (
    icao24                     TEXT PRIMARY KEY,   -- ICAO 24-bit transponder address, hex
    registration               TEXT,
    model                      TEXT,
    operator                   TEXT,
    -- Dossier enrichment (registration/model/operator via adsbdb.com,
    -- origin/destination via authenticated OpenSky /flights/aircraft),
    -- fetched lazily once per aircraft the first time we see it — see
    -- AircraftEnrichmentService.
    origin_airport             TEXT,
    origin_airport_name        TEXT,   -- from adsbdb's callsign route lookup when available, backfilled from `airport` otherwise — see AirportLookupService
    destination_airport        TEXT,
    destination_airport_name   TEXT,
    -- Coordinates — adsbdb's callsign route lookup returns these alongside
    -- the name/code. destination_airport_lat/lon is what makes ETA
    -- computable (great-circle distance to current position / current
    -- groundspeed) — see AircraftController.
    origin_airport_lat         REAL,
    origin_airport_lon         REAL,
    destination_airport_lat    REAL,
    destination_airport_lon    REAL,
    metadata_fetched_at        INTEGER,
    -- OpenSky-confirmed landing for the current leg, checked lazily the
    -- moment a dossier request lands on an aircraft AircraftController's
    -- own silence+descending heuristic already presumes landed (see
    -- LiveVisibilityWindows.PRESUMED_LANDED_SILENCE) — see
    -- OpenSkyFlightsClient.confirmLanded and AircraftEnrichmentService.
    -- checkLandingIfNeeded. landing_check_observed_at is the last position
    -- report's observed_at this aircraft was checked against; comparing it
    -- to the *current* latest report's observed_at is what both throttles
    -- re-checking (no new report yet means nothing could have changed) and
    -- invalidates a stale confirmation once a new leg's reports start
    -- coming in, without needing an explicit reset anywhere.
    -- landing_confirmed_at is OpenSky's own reported arrival time (null if
    -- never confirmed, including "not checked yet" and "checked, but
    -- OpenSky doesn't show it landed").
    landing_check_observed_at  INTEGER,
    landing_confirmed_at       INTEGER,
    first_seen_at              INTEGER NOT NULL,
    -- No longer maintained after the row is created — the per-sweep bump
    -- was ~2.76M updates/day against a column nothing reads, so it was
    -- removed from both write paths. Effectively "first report seen" now.
    -- Kept rather than dropped only because it's NOT NULL and costs
    -- nothing to leave in place.
    last_seen_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flight_position (
    id               INTEGER PRIMARY KEY,   -- SQLite rowid alias; auto-assigned on NULL insert, same role BIGSERIAL had
    icao24           TEXT NOT NULL REFERENCES aircraft(icao24),
    callsign         TEXT,
    observed_at      INTEGER NOT NULL,      -- when the position was true, not when we inserted it
    latitude         REAL NOT NULL,
    longitude        REAL NOT NULL,
    altitude_m       REAL,
    velocity_ms      REAL,
    heading_deg      REAL,
    vertical_rate_ms REAL,
    on_ground        INTEGER NOT NULL DEFAULT 0,   -- SQLite has no BOOLEAN; 0/1
    agent_source     TEXT NOT NULL,         -- which agent/data source reported this
    inserted_at      INTEGER NOT NULL
);

-- Partial index: this table's overwhelming majority of reads (findLive /
-- LiveStateStore.warmUp, the dossier's leg lookups) only ever care about
-- recent, in-the-air positions, so on_ground = 0 rows are the only ones
-- worth a dedicated observed_at-ordered index.
CREATE INDEX IF NOT EXISTS idx_position_recent ON flight_position (observed_at DESC) WHERE on_ground = 0;

-- Serves PositionRetentionService's rolling retention-window delete
-- predicate. Without it that DELETE (and LiveStateStore.warmUp's own
-- windowed read) would be a full table scan every run.
CREATE INDEX IF NOT EXISTS idx_position_observed_at ON flight_position (observed_at);

-- Serves findCurrentLegTakeoffTime/findAltitudeAtOrBefore-style lookups:
-- both filter by (icao24, on_ground) and scan observed_at.
CREATE INDEX IF NOT EXISTS idx_position_icao_ground_time ON flight_position (icao24, on_ground, observed_at);

-- Prevents a duplicate report if two agents (or two poll cycles) see the
-- same broadcast in the same polling window — ON CONFLICT DO NOTHING keys
-- off exactly this index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_position_icao_time_source
    ON flight_position (icao24, observed_at, agent_source);

-- Static ICAO-code -> name/location reference data (OurAirports, public
-- domain), seeded once from a bundled CSV — see AirportSeedService. Fills
-- the gap adsbdb leaves: adsbdb only ever returns an airport's name as
-- part of a resolved flight-route lookup, with no standalone "look up this
-- code" endpoint, so a route resolved via OpenSky's fallback path (bare
-- codes only, see OpenSkyFlightsClient) previously had no way to get a
-- name at all. See AirportLookupService for how this backfills that gap.
CREATE TABLE IF NOT EXISTS airport (
    icao_code    TEXT PRIMARY KEY,
    iata_code    TEXT,
    name         TEXT NOT NULL,
    municipality TEXT,
    country      TEXT,
    latitude     REAL,
    longitude    REAL
);

-- Small write-through key/value store (see repository/AppStateRepository)
-- for the handful of counters that must survive a process restart even
-- though most former cross-container state lives in plain in-memory
-- fields since cloud migration A1 (PLAN.md §6 item 6). Holds the global
-- hot-poll-daily-call-budget counter (keys 'hotpoll.window_start' /
-- 'hotpoll.call_count') and, one row per client IP, the per-IP
-- hot-poll-seconds-per-ip-per-day budget (keys 'hotpoll.ip.<ip>') — see
-- PollWindowService and HotPollUserBudget respectively.
CREATE TABLE IF NOT EXISTS app_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- aircraft_latest_position, poll_window, viewport_state (all previously
-- unused-but-kept for this exact commit, see cloud migration A1's schema
-- comments) are gone: LiveStateStore, PollWindowService and ViewportService
-- have held this state in memory since A1, and SQLite — unlike Postgres
-- pre-migration — was never asked to serve it, so there's no "drop later"
-- deferral needed here the way A1 had to defer to this migration.

-- Flight Tracker schema
-- Design goal: every position report is kept (never overwritten), so usage
-- (flight hours, distance flown, utilisation %) can be derived later from
-- the historic series rather than from a "current state" row.

-- Concurrent-startup guard: the api, agent, and estimator containers all
-- run this same schema.sql independently at boot (one image, three
-- profiles, no separate migration step — see docker-compose.yml). Every
-- statement below is individually idempotent (IF NOT EXISTS / ADD COLUMN
-- IF NOT EXISTS), but that doesn't make CREATE TABLE safe under real
-- concurrency: two sessions can both pass Postgres's existence check before
-- either commits, then race to insert the same row into the pg_type
-- catalog, and the loser fails with "duplicate key value violates unique
-- constraint pg_type_typname_nsp_index" — seen on a cold multi-container
-- start (CI's blackbox job, and the same race on a fresh production
-- deploy). A session-level advisory lock held for the whole script
-- serializes the three containers' first-boot runs: whichever gets here
-- first does the real DDL, the other two block on this call until it
-- releases (at the very end of the script) and then run through against an
-- already-current schema — a safe no-op, since every statement here really
-- is idempotent on its own once there's no longer a race to lose. 727433 is
-- an arbitrary constant scoped to this app; nothing else here uses
-- pg_advisory_lock.
SELECT pg_advisory_lock(727433);

CREATE TABLE IF NOT EXISTS aircraft (
    icao24          VARCHAR(6) PRIMARY KEY,          -- ICAO 24-bit transponder address, hex
    registration    VARCHAR(16),
    model           VARCHAR(64),
    operator        VARCHAR(128),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dossier enrichment (registration/model/operator via adsbdb.com,
-- origin/destination via authenticated OpenSky /flights/aircraft), fetched
-- lazily once per aircraft the first time we see it — see
-- AircraftEnrichmentService. No migration framework in this project, so
-- these are added with IF NOT EXISTS to stay idempotent against a database
-- that already has the table from before this enrichment existed.
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS origin_airport VARCHAR(8);
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS destination_airport VARCHAR(8);
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS metadata_fetched_at TIMESTAMPTZ;

-- Full airport names — from adsbdb's callsign route lookup when available,
-- backfilled from the local `airport` reference table (see
-- AirportLookupService) when a route only resolved via OpenSky's fallback
-- path (bare codes, no name/coordinates). Nullable: falls back to the
-- ICAO code in the UI on the rare code AirportLookupService doesn't cover.
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS origin_airport_name VARCHAR(128);
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS destination_airport_name VARCHAR(128);

-- Airport coordinates — adsbdb's callsign route lookup returns these
-- alongside the name/code (AdsbdbClient wasn't parsing them; the data was
-- there all along). destination_airport_lat/lon is what makes ETA
-- computable (great-circle distance to current position ÷ current
-- groundspeed) — see AircraftController. Same lazy-enrichment path and
-- null-if-unknown fallback as the other dossier columns above.
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS origin_airport_lat DOUBLE PRECISION;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS origin_airport_lon DOUBLE PRECISION;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS destination_airport_lat DOUBLE PRECISION;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS destination_airport_lon DOUBLE PRECISION;

-- OpenSky-confirmed landing for the current leg, checked lazily the moment
-- a dossier request lands on an aircraft AircraftController's own
-- silence+descending heuristic already presumes landed (see
-- LiveVisibilityWindows.PRESUMED_LANDED_SILENCE) — see
-- OpenSkyFlightsClient.confirmLanded and AircraftEnrichmentService.
-- checkLandingIfNeeded. landing_check_observed_at is the last position
-- report's observed_at this aircraft was checked against; comparing it to
-- the *current* latest report's observed_at is what both throttles
-- re-checking (no new report yet means nothing could have changed) and
-- invalidates a stale confirmation once a new leg's reports start coming
-- in, without needing an explicit reset anywhere. landing_confirmed_at is
-- OpenSky's own reported arrival time (null if never confirmed, including
-- "not checked yet" and "checked, but OpenSky doesn't show it landed").
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS landing_check_observed_at TIMESTAMPTZ;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS landing_confirmed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS flight_position (
    id              BIGSERIAL PRIMARY KEY,
    icao24          VARCHAR(6) NOT NULL REFERENCES aircraft(icao24),
    callsign        VARCHAR(16),
    observed_at     TIMESTAMPTZ NOT NULL,             -- when the position was true, not when we inserted it
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    altitude_m      DOUBLE PRECISION,
    velocity_ms     DOUBLE PRECISION,
    heading_deg     DOUBLE PRECISION,
    vertical_rate_ms DOUBLE PRECISION,
    on_ground       BOOLEAN NOT NULL DEFAULT false,
    agent_source    VARCHAR(32) NOT NULL,             -- which agent/data source reported this
    inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two indexes that matter: "give me everything for this aircraft in
-- time order" (used for the usage calc and for drawing a track) and
-- "give me everything airborne right now" (used for the live map).
CREATE INDEX IF NOT EXISTS idx_position_icao_time ON flight_position (icao24, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_recent ON flight_position (observed_at DESC) WHERE on_ground = false;

-- Serves findLive's "when did this aircraft last fly / start its current
-- landed streak" lookups: both filter by (icao24, on_ground) and scan
-- observed_at, which idx_position_icao_time alone doesn't narrow by ground
-- state.
CREATE INDEX IF NOT EXISTS idx_position_icao_ground_time ON flight_position (icao24, on_ground, observed_at);

-- Prevents an agent from writing a duplicate report if two agents see the
-- same broadcast in the same polling window.
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
    icao_code    VARCHAR(4) PRIMARY KEY,
    iata_code    VARCHAR(3),
    name         VARCHAR(128) NOT NULL,
    municipality VARCHAR(128),
    country      VARCHAR(2),
    latitude     DOUBLE PRECISION,
    longitude    DOUBLE PRECISION
);

COMMENT ON TABLE flight_position IS
    'Append-only. Rows are never updated or deleted by the app; usage metrics are computed from this history.';

-- One row per aircraft, always its most recent report — a materialized
-- "current state" projection kept in sync at write time (see
-- FlightPositionRepository.upsertLatestPosition, called right after every
-- successful flight_position insert). Exists because /api/flights/live now
-- serves global, viewport-filtered traffic: computing "latest per aircraft"
-- via DISTINCT ON over the full (and, globally, unbounded-growing)
-- flight_position history on every map pan doesn't scale, and — more
-- importantly — filtering flight_position by a lat/lon box *before* picking
-- the latest row per aircraft would be outright wrong (it could surface an
-- aircraft's old position from when it was last inside that box, hours ago,
-- as if it were current). A dedicated one-row-per-aircraft table sidesteps
-- both problems: there's only ever one candidate row, so filtering it by
-- bbox is always correct, and the write is O(1) instead of an aggregate scan.
CREATE TABLE IF NOT EXISTS aircraft_latest_position (
    id              BIGSERIAL PRIMARY KEY,
    icao24          VARCHAR(6) NOT NULL UNIQUE REFERENCES aircraft(icao24),
    callsign        VARCHAR(16),
    observed_at     TIMESTAMPTZ NOT NULL,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    altitude_m      DOUBLE PRECISION,
    velocity_ms     DOUBLE PRECISION,
    heading_deg     DOUBLE PRECISION,
    vertical_rate_ms DOUBLE PRECISION,
    on_ground       BOOLEAN NOT NULL,
    agent_source    VARCHAR(32) NOT NULL,
    -- Earliest observed_at of the *current* landed streak — null while
    -- airborne. Carried forward on every on_ground=true upsert while it
    -- stays true, reset to the new observed_at the moment it transitions
    -- from false to true, and cleared back to null on the next false.
    -- Computed incrementally at write time (see the upsert), which is far
    -- cheaper than the old findLive's query-time streak lookup.
    landed_since    TIMESTAMPTZ
);
-- Dead-reckoned "current best position," written by EstimatorAgent
-- (@Profile("estimator"), its own container) on its own schedule,
-- independent of real reports. NULL on all three means "no current
-- estimate, use latitude/longitude as-is" — the common case for a
-- just-landed or destination-less aircraft. Deliberately separate columns
-- rather than overwriting latitude/longitude/observed_at directly: those
-- three are relied on elsewhere (flight_position's dedup key, this table's
-- own upsert monotonicity guard, the dossier's presumed-landed timer and
-- landing-check cache key, the frontend's staleness banner) to mean "the
-- last REAL report," never an estimate's computation time. Every real-
-- report upsert clears these back to NULL (see FlightPositionRepository.
-- upsertLatestPosition and PositionPersistenceService's batched
-- equivalent) so a fresh report always wins immediately; EstimatorAgent
-- recomputes on its own next cycle regardless.
ALTER TABLE aircraft_latest_position ADD COLUMN IF NOT EXISTS estimated_latitude DOUBLE PRECISION;
ALTER TABLE aircraft_latest_position ADD COLUMN IF NOT EXISTS estimated_longitude DOUBLE PRECISION;
ALTER TABLE aircraft_latest_position ADD COLUMN IF NOT EXISTS estimated_at TIMESTAMPTZ;

-- Expression index matching what the bbox-filtered queries actually filter
-- on (COALESCE(estimated_latitude, latitude), same for longitude — see
-- FlightPositionRepository.findLiveInBounds/findLiveClusteredInBounds) —
-- a plain (latitude, longitude) index isn't sargable for that expression.
DROP INDEX IF EXISTS idx_latest_position_bbox;
CREATE INDEX IF NOT EXISTS idx_latest_position_bbox_estimated ON aircraft_latest_position (
    (COALESCE(estimated_latitude, latitude)), (COALESCE(estimated_longitude, longitude))
);
CREATE INDEX IF NOT EXISTS idx_latest_position_ground_state ON aircraft_latest_position (on_ground, observed_at, landed_since);

COMMENT ON TABLE aircraft_latest_position IS
    'One row per aircraft: its most recent report, plus an optional dead-reckoned estimate (estimated_*) written independently by EstimatorAgent. Upserted alongside flight_position, never queried to derive "latest" the expensive way.';

-- Bounded-polling state (see PollWindowService). Now that the API and the
-- polling agent are separate containers/processes, they can no longer
-- share an in-memory AtomicReference for "is the poll window open" — this
-- single-row table is the shared state instead. Both processes run this
-- schema on startup, so the insert is ON CONFLICT DO NOTHING to avoid
-- resetting an already-running agent's window if the api container
-- restarts later.
CREATE TABLE IF NOT EXISTS poll_window (
    id           SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    active_until TIMESTAMPTZ NOT NULL
);
INSERT INTO poll_window (id, active_until) VALUES (1, now())
ON CONFLICT (id) DO NOTHING;

-- Global "Resume Watch" quota — this app is internet-facing and every
-- resume opens a real OpenSky-polling window, so it's a hard cap on
-- OpenSky usage, not just a UX nicety. Tracks the start of the current
-- 15-minute quota window and how many resumes have happened in it — see
-- PollWindowService.restart(). Deliberately DB-backed like active_until
-- above, for the same reason: the "agent" and "api" containers are
-- separate processes and this state has to be visible to both (well,
-- really just "api", which is the only one that calls restart() — but
-- consistent with the rest of this table rather than a special case).
ALTER TABLE poll_window ADD COLUMN IF NOT EXISTS quota_window_start TIMESTAMPTZ;
ALTER TABLE poll_window ADD COLUMN IF NOT EXISTS quota_restart_count INT NOT NULL DEFAULT 0;

-- Global hot-poll call budget — a hard ceiling (flighttracker.agents.
-- hot-poll-daily-call-budget) on hot-poll HTTP calls per rolling 24h,
-- across every caller combined, independent of the poll window and quota
-- above. Same DB-backed reasoning as the rest of this table: the "agent"
-- container is the one that checks and increments this on every poll
-- cycle (see PollWindowService.hotPollBudgetAvailable/recordHotPollCall
-- and AgentOrchestrator.pollAll()), but it's kept alongside the window
-- state it gates rather than in agent-local memory so a container restart
-- doesn't quietly reset a budget meant to survive the whole day.
ALTER TABLE poll_window ADD COLUMN IF NOT EXISTS hot_poll_count_window_start TIMESTAMPTZ;
ALTER TABLE poll_window ADD COLUMN IF NOT EXISTS hot_poll_call_count INT NOT NULL DEFAULT 0;

-- Which lat/lon box the "hot" (frequent, poll-window-gated) OpenSky poll
-- should target — see ViewportService. Reported by the frontend whenever
-- someone pans/zooms the map (GET /api/flights/live with bbox params), so
-- the agent's frequent polling tracks whatever's actually on someone's
-- screen instead of a fixed region. Same single-shared-row simplicity as
-- poll_window: this app has one map, viewed by one person at a time, not a
-- multi-tenant per-session viewport model. Seeded with the app's old fixed
-- default region (roughly Scandinavia/the Baltic) so a fresh deployment
-- shows live traffic immediately, before any browser has reported in.
CREATE TABLE IF NOT EXISTS viewport_state (
    id           SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    lat_min      DOUBLE PRECISION NOT NULL,
    lat_max      DOUBLE PRECISION NOT NULL,
    lon_min      DOUBLE PRECISION NOT NULL,
    lon_max      DOUBLE PRECISION NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO viewport_state (id, lat_min, lat_max, lon_min, lon_max)
VALUES (1, 54.0, 66.0, 10.0, 25.0)
ON CONFLICT (id) DO NOTHING;

-- Releases the lock taken at the top of this script — see that comment.
SELECT pg_advisory_unlock(727433);

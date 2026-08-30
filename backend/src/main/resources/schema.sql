-- Flight Tracker schema
-- Design goal: every position report is kept (never overwritten), so usage
-- (flight hours, distance flown, utilisation %) can be derived later from
-- the historic series rather than from a "current state" row.

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

-- Full airport names (only available via adsbdb's callsign route lookup —
-- the OpenSky-fallback path has no name data, just bare codes). Nullable:
-- falls back to the ICAO code in the UI when absent.
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
CREATE INDEX IF NOT EXISTS idx_latest_position_bbox ON aircraft_latest_position (latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_latest_position_ground_state ON aircraft_latest_position (on_ground, observed_at, landed_since);

COMMENT ON TABLE aircraft_latest_position IS
    'One row per aircraft: its most recent report. Upserted alongside flight_position, never queried to derive "latest" the expensive way.';

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

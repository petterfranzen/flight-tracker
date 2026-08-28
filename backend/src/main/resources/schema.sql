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

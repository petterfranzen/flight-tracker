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

-- Prevents an agent from writing a duplicate report if two agents see the
-- same broadcast in the same polling window.
CREATE UNIQUE INDEX IF NOT EXISTS uq_position_icao_time_source
    ON flight_position (icao24, observed_at, agent_source);

COMMENT ON TABLE flight_position IS
    'Append-only. Rows are never updated or deleted by the app; usage metrics are computed from this history.';

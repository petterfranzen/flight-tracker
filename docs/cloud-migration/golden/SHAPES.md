# Golden contract: endpoint shapes

Captured against `main` (pre-migration) in Phase 0, from the docker-compose
stack (`backend-api`, Postgres, real anonymous OpenSky polling). Values vary
run to run (live flight data, timestamps, counts) — **only the shapes below
are the contract**. A gate's verifier re-captures each endpoint fresh and
diffs field names + types against this file, not against the raw JSON in
this directory (those are samples for reference, most arrays trimmed to
~10-20 entries to keep the repo lean).

## `GET /api/flights/live` → `live.json`
Array of:
```
observedAt   string (ISO-8601 instant)
icao24       string
onGround     boolean
latitude     number
longitude    number
callsign     string | absent (omitted when unknown, per Jackson default)
headingDeg   number | absent
```

## `GET /api/flights/live` with bbox params → `live-bbox.json`
Same shape as `live.json`, filtered to `latMin/latMax/lonMin/lonMax`.

## `GET /api/flights/live/clusters?...&gridDeg=N` → `clusters.json`
Array of:
```
count   integer
lat     number   (grid cell center)
lon     number   (grid cell center)
```

## `GET /api/flights/live/count` → `count.json`
Bare integer (not wrapped in an object), e.g. `11122`.

## `GET /api/agents/status` → `status.json`
Object:
```
active            boolean
secondsRemaining  integer
```

## `GET /api/airports/info?code=<IATA>` → `airport-info.json`
**Note:** keyed by **IATA** code, not ICAO (e.g. `ARN`, not `ESSA`). 404 with
empty body for no match.
Object:
```
icaoCode      string
iataCode      string
name          string
municipality  string
country       string
latitude      number
longitude     number
```

## `GET /api/aircraft/{icao24}` → `aircraft-<icao24>.json`
Object:
```
icao24                    string
registration              string | null
model                     string | null
operator                  string | null
originAirport             string | null       (ICAO)
originAirportName         string | null
originAirportIata         string | null
destinationAirport        string | null       (ICAO)
destinationAirportName    string | null
destinationAirportIata    string | null
flightMinutes             number | null
etaMinutes                number | null
cruisingAltitudeM         number | null
flightPhase               string (enum, e.g. "ON_GROUND")
staleExplanation          string | null
legStartAt                string (ISO-8601) | null
```

## `GET /api/flights/{icao24}/history?from=<Instant>&to=<Instant>` → `history-<icao24>.json`
**Note:** `from`/`to` are required `Instant` query params (ISO-8601, e.g.
`2026-09-29T00:00:00Z`); omitting either → `400` with the standard Spring
error body (`timestamp`, `status`, `error`, `path`).
Array of `FlightPosition`:
```
observedAt   string (ISO-8601 instant)
icao24       string
onGround     boolean
latitude     number
longitude    number
callsign     string | absent
headingDeg   number | absent
```

## `GET /api/usage?from=<Instant>&to=<Instant>` → `usage.json`
Same required-params note as history. Array of:
```
icao24                  string
registration             string | null
positionReports          integer
distanceFlownKm           number
airborneHours             number
averageGroundSpeedKmh     number
```

## Additive-only endpoints (not yet present, A1 adds them)
- `GET /api/health` → `{"status":"UP","version":"<40-char git sha>","db":"UP","lastSweepAt":...}`
- `GET /api/health/sweep` → 200/503, monitoring only

## Standard Spring error body (400/404 style responses)
```
timestamp   string (ISO-8601 instant)
status      integer
error       string
path        string
```

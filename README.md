# Flight Tracker

A single process polls live flight-position sources, writes every report to
an append-only SQLite history, and a map shows live traffic and lets you
trace an aircraft's recent route. Tracking is global: an always-on sweep
(`AgentOrchestrator.pollGlobalSweep`) keeps the database current for every
aircraft worldwide, while a separate, more frequent poll targets whatever's
actually on someone's screen (`ViewportService`, in-memory) — the map only
ever fetches/renders what's within its current viewport, not the whole
world at once. Because every historic position is kept (72h retention), the
`/api/usage` endpoint derives distance flown and airborne hours for any
time window straight from the position history — no separate "usage" table
to keep in sync.

## Stack
- **Backend**: Java 21 / Spring Boot, one process — REST, WebSocket and the scheduled `FlightDataAgent` pollers all in one JVM (no Spring profiles). Live aircraft state (`LiveStateStore`) is an in-memory map, not a DB table; only the persistent position history and a couple of restart-surviving counters (`app_state`) touch the database. Real-time updates to WebSocket clients go through an in-process Spring event (`PositionsPersistedEvent`), not cross-process coordination.
- **Database**: SQLite (WAL mode), one append-only `flight_position` table plus `aircraft`/`airport`/`app_state`
- **Frontend**: Vanilla TypeScript + MapLibre GL (one map: basemap, airports, trail and planes all drawn as GL layers), Vite — no framework

## Run it locally

One process now — it does everything (`api` and `agent` are no longer separate roles).

```bash
# 1. Environment (Neovim, Claude Code, Codex, Gemini CLI) — see setup-cachyos.sh
./setup-cachyos.sh

# 2. Backend
cd backend
mvn spring-boot:run   # REST + WebSocket + pollers on :8080, SQLite file at ./data/flighttracker.db

# 3. Frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — the map opens centred on the Baltic/Stockholm
area, then reports its own viewport as you pan/zoom (see `ViewportService`),
which is what the frequent "hot" poll targets from then on. That's
independent of the always-on global sweep
(`flighttracker.agents.global-sweep-interval-seconds`), which keeps the
database current everywhere regardless of what anyone's looking at.

## Where the map opens

The map opens near the visitor rather than on a fixed view. `GET /api/geo`
(`GeoLocator`) reads Cloudflare's visitor-location headers: `cf-iplatitude` /
`cf-iplongitude` (header names are case-insensitive) when the zone's **"Add
visitor location headers"** managed transform is on (Cloudflare dashboard:
Rules > Settings > Managed Transforms, or Rules > Transform Rules > Managed
Transforms in the older layout); that transform also adds `cf-ipcity`,
`cf-ipcountry`, `cf-ipcontinent`, `cf-region`, `cf-region-code`,
`cf-metro-code`, `cf-postal-code` and `cf-timezone`. Otherwise `cf-ipcountry`,
which is only sent when the transform or the **Network > IP Geolocation**
toggle (country only) is on, mapped to the country's capital. The result is coarse (rounded to 0.1 degree),
never stored or logged, and answered `no-store`. With no headers (local dev)
it returns 204 and the frontend keeps its default view (Stockholm). The
frontend fetches it alongside the world traffic summary under the same short
boot timeout, so it never delays the boot screen (`applyInitialView` in
`main.ts`, `map/initialView.ts`). A VPN shows its exit location.

## Deploying

GitHub Actions builds a single jar (backend + the built frontend bundled
in) on every push and deploys it to a Hetzner VM automatically on green
`main`, over SSH through Cloudflare Access — see
[`deploy/hetzner/README.md`](deploy/hetzner/README.md) for operating that
box (logs, restart, rollback, sqlite3 shell).

## Arrival confirmation providers

After a plane goes silent the estimator only *infers* that it landed
("Landed 92% (inferred)"). `backend/.../service/confirmation/` can turn that
into "Landed (confirmed · source)" and "At gate B14 (confirmed)" by asking an
arrival data provider for the actual touchdown and gate-in times. A provider
is one `@Component`, in one of two shapes; the framework does the rest, so each
provider gets the same protections:

- `ArrivalConfirmationProvider` (per flight): `lookup(ArrivalQuery)` asks about one flight, and the answer is cached by callsign. It declares `callCost()` (default 1) for plans that bill a lookup at several units.
- `AirportArrivalsProvider` (per airport board): `fetchArrivals(airport, boardDate)` returns the whole arrivals board for an airport and board date (the UTC date of the expected touchdown unless the provider overrides `boardDate`) as `BoardEntry`s (callsign, optional IATA flight number and registration, and an `ArrivalInfo`) plus the `costUnits` the call consumed (default 1). One fetch serves every candidate at that airport. The gateway caches boards per (provider, airport, UTC date) for `board-ttl-seconds`; a board is fetched only when a candidate at a covered airport needs confirming and there is no fresh one, never in the background. A provider may keep incremental state (a continuation token); the framework only sees boards. The service matches an aircraft in the cached board without a call, by trimmed upper-case callsign, else by registration (the aircraft table's, from adsbdb) when both sides have one.


- `ArrivalConfirmationService` picks the candidates every `flighttracker.confirmation.interval-seconds` (30): inferred landings, silent aircraft whose predicted touchdown has passed, and aircraft that landed within the last 2 h (for the gate). It makes at most one real call per provider per tick, and only to providers that cover the airport.
- `ConfirmationGateway` caches results (FOUND without a gate time 5 min, with one 12 h, NOT_FOUND 15 min; bounded), keeps a minimum interval between calls (`flighttracker.confirmation.min-interval-seconds`, 30), per-provider budgets in cost units (below) and backs off on throttling or failure, honouring Retry-After. All of it applies to both provider shapes.
- Budgets are per provider and counted in cost units, not calls: `flighttracker.confirmation.providers.<id>.daily-budget` (default: the global `daily-budget`) resets at UTC midnight, and `providers.<id>.monthly-budget` (default: unlimited) on the 1st (UTC). The counters are written through to the `app_state` table on every charge (one key per provider, `confirmation.budget.<id>`), so a restart cannot overspend a monthly quota. At 80% of a monthly budget one `degraded` phase line is logged.
- A confirmation is never downgraded by a later estimate, survives taxiing, and is cleared when the aircraft is seen airborne again. A confirmed touchdown also labels the Phase 2 training row.
- An answer about an earlier landing of the same callsign is ignored: the service drops one whose landing time is more than `skew-tolerance-seconds` before the aircraft's last report, and the gateway does not serve a cached answer older than the expected arrival.
- A confirmed aircraft that is still waiting for its gate is asked about until `gate-wait-minutes` after touchdown, and after every unconfirmed one.

All keys are under `flighttracker.confirmation.` (defaults in brackets):

| Key | Meaning |
| --- | --- |
| `interval-seconds` (30) | How often candidates are picked |
| `min-interval-seconds` (30) | Minimum gap between two real calls to one provider |
| `daily-budget` (300) | Default daily budget per provider, in cost units per UTC day |
| `providers.<id>.daily-budget` (global `daily-budget`) | One provider's daily budget in cost units |
| `providers.<id>.monthly-budget` (unlimited) | One provider's monthly budget in cost units, per UTC month |
| `board-ttl-seconds` (300) | How long a fetched arrivals board is used before it is fetched again |
| `board-recheck-minutes` (15) | A candidate that a board had no (new) answer for, such as a GA aircraft, a callsign not on the board, or an aircraft still waiting for its gate time, cannot trigger another fetch of that board until this long after that board was fetched. It still matches fresher boards that other candidates' fetches bring in |
| `board-max-entries` (100) | Bound of the board cache; the least recently used board goes first |
| `cache-max-entries` (2000) | Bound of the gateway's result cache; the least recently used entries go first |
| `store-max-entries` (5000) | Bound of the in-memory confirmation store; the oldest confirmation goes first |
| `min-landing-probability` (0.5) | Lowest landing probability of a COVERAGE_LOST gap that is asked about |
| `on-ground-window-minutes` (120) | How long after touchdown an aircraft on the ground is asked about |
| `gate-wait-minutes` (45) | After this long since touchdown, a confirmed aircraft without a gate time is no longer asked about |
| `skew-tolerance-seconds` (300) | How far before the aircraft's last report (or expected arrival) a landing time may be and still count |
| `new-flight-grace-seconds` (120) | Grace between a confirmed touchdown and an airborne report that clears it |
| `max-retry-after-minutes` (60) | Cap on a provider's Retry-After |
| `mock.enabled` (false) | The mock provider |
| `mock.not-found-fraction` (0.2) | Share of callsigns the mock answers NOT_FOUND |

Each provider has its own `flighttracker.confirmation.<id>.enabled` flag. A
real provider reads its API key from an environment variable (for example
`FLIGHTTRACKER_CONFIRMATION_<ID>_API_KEY`), set from a GitHub secret and the
deploy environment, and the key is never committed. This section lists each
provider's variable once it is added. Swedavia FlightInfo (a board provider,
below) is the first real one; AeroDataBox (per flight) is planned second. The
candidates and their limits are in
[`docs/agents/provider-research.md`](docs/agents/provider-research.md).

### Swedavia FlightInfo (`swedavia`)

`SwedaviaArrivalsProvider` reads the arrivals board of the ten Swedavia airports
(ARN, BMA, GOT, MMX, LLA, UME, OSD, VBY, RNB, KRN) with one
`GET {base-url}/{IATA}/arrivals/{yyyy-MM-dd}` per airport and day. Boards follow
the **local Swedish date**, so a touchdown is filed under its Europe/Stockholm
date (`AirportArrivalsProvider.boardDate`; other providers keep the UTC date).

- **Key.** Sign up at apideveloper.swedavia.se and subscribe to the FlightInfo
  product (free tier). In production set `SWEDAVIA_API_KEY` (and, because Swedavia
  rotates keys every 6 months, `SWEDAVIA_API_KEY_SECONDARY`) in
  `/etc/flight-tracker/env` on the VM, which the systemd unit reads through its
  `EnvironmentFile`; `deploy/hetzner/env.example` has the commented lines. The key
  is never committed. Without a key the provider is disabled (one INFO line at
  startup). A 401/403 fails that fetch (1 budget unit) and the next attempt, after
  the usual pacing, uses the other key. When every configured key has been
  rejected in a row the provider is off until the next UTC midnight (one
  degraded line says so; a 403 may also mean an exhausted quota).
- **Settings.** `flighttracker.confirmation.swedavia.enabled` (true),
  `.api-key`, `.api-key-secondary`, `.base-url` (`https://api.swedavia.se/flightinfo/v2`).
- **Budgets.** `providers.swedavia.monthly-budget: 9000` (headroom under the free
  10,000 a month; Swedavia blocks the rest of the month once it is exceeded) and
  `daily-budget: 300`. The gateway's 30 s minimum spacing between calls is well
  above the 2 s Swedavia asks for. A board is cached for `board-ttl-seconds` and
  serves every aircraft at that airport. A 429 backs off for its `Retry-After`
  (60 s if absent); a 400 (date outside the window, 7 days back to 90 ahead) is
  NOT_FOUND and is not fetched for dates more than 6 days back. When a daily or
  monthly budget runs out, one degraded line is logged per day (or month).
- **Midnight.** A touchdown near local midnight can appear on the next day's
  board, or under its scheduled date. The ground candidate re-keys on
  `landedSince`, so the worst case is a delay, not a missed confirmation.
- **Naming.** `SWEDAVIA_API_KEY` is a deliberate exception to the
  `FLIGHTTRACKER_CONFIRMATION_<ID>_*` convention: it matches the provider's own
  name for the key.
- **What it confirms.** `arrivalTime.actualUtc` becomes the touchdown time (an
  upper bound: the docs do not say whether it is touchdown or in-block). Swedavia
  has no at-gate status, so the aircraft is taken to be **at the gate when the
  first bag is on the belt** (`baggage.firstBagUtc`, an upper bound on in-block);
  the gate and terminal come from `locationAndStatus`. CAN, DEL and DIV never
  confirm a landing.
- **Not yet verified against the live API** (no key was available): the board's
  date semantics (local or UTC) and timestamp format, where `diIndicator` sits,
  what `actualUtc` means, the over-quota status code, and the real `to` block.
  See [`docs/agents/swedavia-api.md`](docs/agents/swedavia-api.md). The test
  fixtures in `backend/src/test/resources/swedavia/` are reconstructed, not
  recorded.

To see the whole journey locally without a real feed, enable the mock
provider (deterministic from the callsign: touchdown on time, gate 8 minutes
later, about a fifth of callsigns not found, no external calls):

```bash
FLIGHTTRACKER_CONFIRMATION_MOCK_ENABLED=true mvn -f backend/pom.xml spring-boot:run
# or: -Dflighttracker.confirmation.mock.enabled=true
```

## Phase reporting

The backend process prints a one-line marker when what it's doing changes:

```
[phase:populating_data] global sweep
[phase:degraded] OpenSky rate-limited us (429), backing off 30s
```

[docker-monitor](../docker-monitor) used to read these out of the
container log stream so the portfolio's dashboard could show what this
stack is *doing* — plain "running" doesn't distinguish an agent mid-sweep
from an idle one, which matters most on a cold start, where the map is
legitimately empty for the first minute while `seedOnStartup` backfills.
Since the cloud migration, the app runs as a single process under systemd
(Hetzner) or directly (`mvn spring-boot:run`, local dev) — there's no
Docker container to read a log stream from either way anymore. The phase
markers themselves are unchanged (still plain stdout/journald lines); the
docker-monitor integration itself would need updating to tail a different
source if that dashboard view still matters.

`PhaseLogger` (`backend/.../observability/`) emits on transition only, so
the estimator's few-second refresh loop prints one line, not one per
cycle. The vocabulary and the rules are docker-monitor's — see its README
under "Phase reporting" — this repo is just one of the apps that speaks it.

Nothing here depends on docker-monitor running: with nobody reading them,
these are ordinary, fairly useful log lines.

## Where things live
- `backend/.../service/agent/` — the agent interface + orchestrator + the OpenSky implementation. Add a new source by adding one `@Component`.
- `backend/.../service/live/LiveStateStore.java` — in-memory live aircraft state (upserts, landed-streak logic, estimate clearing).
- `backend/.../service/UsageService.java` — turns historic positions into distance/airtime figures.
- `backend/.../service/enrichment/CallsignRouteService.java` — origin/destination per *callsign* (what a flight is), resolved from adsbdb by a paced background walk over every live callsign; backs the dossier's route and the airport search.
- `frontend/src/main.ts` — boot/wiring; `frontend/src/map/` — the MapLibre map and its adapter (`map.ts`, app zoom units, click hit-testing), planes as symbol layers (`planes.ts`), overlap hiding (`declutter.ts`: where planes overlap, only the first discovered is drawn; there are no clusters), route; `frontend/src/ui/` — one module per UI component; design tokens are at the top of each component's adjacent `.css`.
- `backend/.../service/training/` — training data for a future landing model. `EstimatorAgent` hands each new coverage gap (an aircraft near the ground or near a landing candidate that went silent) to `TrainingDataService`, which writes one compact `track_end_feature` row, and a `track_end_label` row (landed or airborne) when the aircraft reports again or a provider confirms. `LandingModel` is the hook for the learned model (the default `NoLandingModel` changes nothing).
- Both training tables are kept `flighttracker.training.retention-days` (default 365) and pruned by `PositionRetentionService`, independent of the 72 h `flight_position` rule. Capture is controlled by `flighttracker.training.enabled`, `max-altitude-m` (default 4000), `capture-delay-seconds` (default 600: a gap is captured only once it has lasted that long) and `max-airborne-label-gap-minutes` (default 30: a longer airborne resume gets no label). Labels skew AIRBORNE until a confirmation provider is enabled, because a landed aircraft that never reports again is evicted without a label.
- `backend/.../service/confirmation/` — arrival confirmation: provider interfaces (per flight and per airport board), gateway (caches, pacing, budgets, backoff), the scheduled service, the confirmation store and the mock provider (see "Arrival confirmation providers").
- `backend/.../observability/PhaseLogger.java` — the phase markers above.
- `docs/neovim-basics.md` — Neovim primer for the config in `nvim/init.lua`.
- `docs/multi-agent-workflow.md` — running Claude Code, Codex, and Gemini CLI on this repo in parallel without them stepping on each other.

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
is one `@Component` implementing `ArrivalConfirmationProvider`; the framework
does the rest, so each provider gets the same protections:

- `ArrivalConfirmationService` picks the candidates every `flighttracker.confirmation.interval-seconds` (30): inferred landings, silent aircraft whose predicted touchdown has passed, and aircraft that landed within the last 2 h (for the gate). It makes at most one real call per provider per tick, and only to providers that cover the airport.
- `ConfirmationGateway` caches results (FOUND without a gate time 5 min, with one 12 h, NOT_FOUND 15 min; bounded), keeps a minimum interval between calls (`flighttracker.confirmation.min-interval-seconds`, 30), a daily call budget per provider (`daily-budget`, 300) and backs off on throttling or failure, honouring Retry-After.
- A confirmation is never downgraded by a later estimate, survives taxiing, and is cleared when the aircraft is seen airborne again. A confirmed touchdown also labels the Phase 2 training row.
- An answer about an earlier landing of the same callsign is ignored: the service drops one whose landing time is more than `skew-tolerance-seconds` before the aircraft's last report, and the gateway does not serve a cached answer older than the expected arrival.
- A confirmed aircraft that is still waiting for its gate is asked about until `gate-wait-minutes` after touchdown, and after every unconfirmed one.

All keys are under `flighttracker.confirmation.` (defaults in brackets):

| Key | Meaning |
| --- | --- |
| `interval-seconds` (30) | How often candidates are picked |
| `min-interval-seconds` (30) | Minimum gap between two real calls to one provider |
| `daily-budget` (300) | Real calls per provider per UTC day (calls, not cost units) |
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
provider's variable once it is added. No real provider is wired yet; the
candidates and their limits are in
[`docs/agents/provider-research.md`](docs/agents/provider-research.md).

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
- `backend/.../service/confirmation/` — arrival confirmation: provider interface, gateway (cache, pacing, budget, backoff), the scheduled service, the confirmation store and the mock provider (see "Arrival confirmation providers").
- `backend/.../observability/PhaseLogger.java` — the phase markers above.
- `docs/neovim-basics.md` — Neovim primer for the config in `nvim/init.lua`.
- `docs/multi-agent-workflow.md` — running Claude Code, Codex, and Gemini CLI on this repo in parallel without them stepping on each other.

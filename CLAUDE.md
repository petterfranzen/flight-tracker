# CLAUDE.md

Agent brief for flight-tracker: one Spring Boot JVM (REST, WebSocket and
the pollers), SQLite, and a vanilla TypeScript + MapLibre GL frontend bundled
into the same jar. `README.md` covers the architecture.

## Invariants

- **`flight_position` is append-only.** Never update rows. The only delete
  is the 72h retention prune in `PositionRetentionService`. `UsageService`
  (`/api/usage`) derives distance and airborne hours from the full history.
- **New position sources implement `FlightDataAgent`**
  (`backend/src/main/java/com/flighttracker/service/agent/`) as a
  `@Component`. `AgentOrchestrator` gets every one injected, so don't wire
  a source in by hand.
- **Live state is in memory** (`service/live/LiveStateStore`), not a table.
  WebSocket pushes go through the in-process `PositionsPersistedEvent`
  (published by `PositionPersistenceService`, consumed by
  `LiveFeedBroadcaster`).
- **Routes are keyed by callsign:** the `callsign_route` table,
  `CallsignRouteService` and `CallsignRouteRepository`. The `aircraft`
  table's `origin_*`/`destination_*` columns are legacy.
  `AircraftEnrichmentService` writes them as null, and `AircraftController`
  overrides them with the callsign route (`withRoute`). Don't read them.
- **WebSocket wire format: one `LiveFrame` JSON per frame**
  (`LiveFeedBroadcaster`): marker fields only, no altitude/speed/vertical rate (the selected plane polls those). `blackbox-tests/live-feed.test.js` and the
  frontend depend on it.
- **`/api/health` `version` is the git SHA** (`-Dgit.sha` → build-info →
  `HealthController`). `deploy/hetzner/deploy.sh` waits for exactly that
  value before declaring a deploy healthy.
- **One theme, cyberpunk.** Its tokens live in
  `frontend/src/components/FlightMap.css` (`:root[data-theme="cyberpunk"]`
  over the `:root` defaults; `index.html` sets the attribute). Use the
  `var(--…)` tokens; don't add new hard-coded colours.
- **The map is one MapLibre GL map** behind the `FlightMap` adapter in
  `frontend/src/map/map.ts` (no Leaflet). The app speaks Leaflet zoom units
  (256 px tiles): app zoom = MapLibre zoom + 1. Only the adapter converts;
  nothing else touches the GL map's zoom. Zoom is fractional, so round it
  wherever it is a key or an index (view caches, prefetch, icon sizes);
  requests use whole levels. Tests reach the adapter as `._flightMap` on
  `.map-container` (`tests/helpers.ts` `withMap`).
- **Planes and airports are GL layers, not DOM** (`map/planes.ts`,
  `ui/defaultAirports.ts`; images drawn from the theme tokens). Which
  planes are drawn is `main.ts` `renderAircraftLayer` + `declutter.ts`
  (MapLibre symbol collision can't apply its rule, see the Stage C log in
  `docs/agent-tasks/maplibre-native-progress.md`); the layers draw that
  set and `setData` only when it changed, never per frame. Clicks go
  through the adapter's hit test (`addHitTarget`). Tests read what was
  drawn with `renderedPlanes()` / `renderedAirports()` (helpers.ts), never
  DOM selectors.

## Environment

- Backend: Java 21 + Maven.
- Frontend and blackbox tests: Node 24, as in CI (`frontend/.nvmrc`).
  Cloud sessions ship Node 22, which builds and tests identically.

## Running things

These are the same commands as `.github/workflows/build-deploy.yml`.

```bash
# Frontend: build, then the Playwright suite against a mocked API
# (every request is served from frontend/tests/fixtures/; no backend needed)
cd frontend && npm ci && npm run build
npm run test:e2e
npm run test:perf        # tests/perf.spec.ts, @perf tag, one worker; its own CI step
npm run test:scenarios   # tests/scenarios/, @scenario tag, one worker; its own CI step (~3 min)

# Backend (+ -Pwith-frontend to pack frontend/dist into the jar)
cd backend && mvn -B verify -Pwith-frontend

# Blackbox: run the jar, reopen the poll window, run the suite
FLIGHTTRACKER_DB_PATH=/tmp/ft.db SERVER_ADDRESS=127.0.0.1 TRUST_LOCAL=true \
  java -Xmx512m -jar backend/target/flight-tracker.jar &
# wait for: curl -fsS http://127.0.0.1:8080/api/health
curl -sf -X POST http://127.0.0.1:8080/api/agents/restart
BASE_URL=http://127.0.0.1:8080 node --test 'blackbox-tests/**/*.test.js'
```

**Cloud sessions:** the SessionStart hook (`scripts/cloud-setup.sh`)
installs the toolchain. Playwright's browser CDN is unreachable from the
cloud, so the hook exports `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`,
and `playwright.config.ts` launches that browser. If Playwright says
Chromium is missing, run `export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`.
`tests/production-build.spec.ts` fetches from `tiles.openfreemap.org`,
which is blocked in the cloud, so expect that one failure there. Don't run
`playwright install`.

## UI testing browser: Helium, never Vivaldi

Vivaldi is the human's daily browser, so never launch or automate it.
Helium is the browser for agent-driven UI testing on the human's machines:

```bash
cd frontend && npx playwright test --config=playwright.helium.config.ts
```

`playwright.helium.config.ts` checks `$HELIUM_PATH` first, then common
per-OS install paths, and runs one worker. If Helium is installed somewhere
else, set `HELIUM_PATH` rather than editing the config. Cloud sessions use
the bundled Chromium instead (see above).

## Where agents run

- `docs/cloud-agents.md`: cloud sessions vs. `@claude` in GitHub Actions.
- `docs/agent-tasks/`: queued briefs. "Do `docs/agent-tasks/<file>.md`".
- `docs/multi-agent-workflow.md`: several local agents in parallel.

## Guardrails

- Work on a branch and open a PR. **Never push to or merge into `main`**:
  a push to `main` deploys to production.
- Never put deploy keys or Cloudflare tokens anywhere an agent runs.
- Before handing back a frontend change, run `npm run build && npm run test:e2e && npm run test:perf && npm run test:scenarios`.
  `test:e2e` skips the `@perf` and `@scenario` tests, but CI runs both, and the
  scenario journeys assert on what the map draws (e.g. cluster icons), so a UI
  change can leave them red while `test:e2e` is green.

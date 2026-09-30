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
- **Frontend**: Vanilla TypeScript + Leaflet (MapLibre for the basemap), Vite — no framework

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

## Deploying

GitHub Actions builds a single jar (backend + the built frontend bundled
in) on every push and deploys it to a Hetzner VM automatically on green
`main`, over SSH through Cloudflare Access — see
[`deploy/hetzner/README.md`](deploy/hetzner/README.md) for operating that
box (logs, restart, rollback, sqlite3 shell).

## Phase reporting

The backend process prints a one-line marker when what it's doing changes:

```
[phase:populating_data] global sweep
[phase:degraded] OpenSky rate-limited us (429), backing off 30s
```

[docker-monitor](../docker-monitor) reads these out of the container log
stream so the portfolio's dashboard can show what this stack is *doing* —
Docker itself can only say "running", which doesn't distinguish an agent
mid-sweep from an idle one. That distinction matters most on a cold start,
where the map is legitimately empty for the first minute while
`seedOnStartup` backfills.

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
- `frontend/src/main.ts` — boot/wiring; `frontend/src/map/` — Leaflet map, markers, clusters, route; `frontend/src/ui/` — one module per UI component; design tokens are at the top of each component's adjacent `.css`.
- `backend/.../observability/PhaseLogger.java` — the phase markers above.
- `docs/neovim-basics.md` — Neovim primer for the config in `nvim/init.lua`.
- `docs/multi-agent-workflow.md` — running Claude Code, Codex, and Gemini CLI on this repo in parallel without them stepping on each other.

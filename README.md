# Flight Tracker

Agents poll live flight-position sources, write every report to an
append-only Postgres history, and a React map shows live traffic and lets
you trace an aircraft's recent route. Tracking is global: an always-on
sweep (`AgentOrchestrator.pollGlobalSweep`) keeps the database current for
every aircraft worldwide, while a separate, more frequent poll targets
whatever's actually on someone's screen (`ViewportService`) — the map only
ever fetches/renders what's within its current viewport, not the whole
world at once. Because every historic position is kept, the `/api/usage`
endpoint derives distance flown and airborne hours for any time window
straight from the position history — no separate "usage" table to keep in
sync.

## Stack
- **Backend**: Java 21 / Spring Boot, split into two roles by `SPRING_PROFILES_ACTIVE` from one build — `api` (REST + WebSocket) and `agent` (the scheduled `FlightDataAgent` pollers). They coordinate only through Postgres: `PollWindowService` (bounded-polling state) and `LISTEN`/`NOTIFY` (live position feed — see `PositionNotificationListener`), not a broker or a direct call, since they're separate processes/containers.
- **Database**: PostgreSQL, one append-only `flight_position` table
- **Frontend**: React + TypeScript + Leaflet, Vite

## Run it locally

Needs both backend roles running — neither does anything useful alone (`api` has nothing to show without `agent` writing positions; `agent` has no UI without `api`).

```bash
# 1. Environment (Neovim, Claude Code, Codex, Gemini CLI, Postgres) — see setup-cachyos.sh
./setup-cachyos.sh

# 2. Backend — two processes, two terminals
cd backend
SPRING_PROFILES_ACTIVE=api mvn spring-boot:run      # terminal A: REST + WebSocket on :8080
SPRING_PROFILES_ACTIVE=agent mvn spring-boot:run    # terminal B: headless poller, no port

# 3. Frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — the map opens centred on the Baltic/Stockholm
area, then reports its own viewport as you pan/zoom (see `ViewportService`
and `viewport_state` in `schema.sql`), which is what the frequent "hot"
poll targets from then on. That's independent of the always-on global
sweep (`flighttracker.agents.global-sweep-interval-seconds`), which keeps
the database current everywhere regardless of what anyone's looking at.

## Deploying

`docker compose up --build` (repo root) covers local/dev use. For running
this unattended on a NAS via prebuilt images from CI, see
[`deploy/README.md`](deploy/README.md).

## Phase reporting

Each backend container prints a one-line marker when what it's doing
changes:

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
- `backend/.../service/UsageService.java` — turns historic positions into distance/airtime figures.
- `frontend/src/components/FlightMap.tsx` — the map; design tokens are at the top of the adjacent `.css`.
- `backend/.../observability/PhaseLogger.java` — the phase markers above.
- `docs/neovim-basics.md` — Neovim primer for the config in `nvim/init.lua`.
- `docs/multi-agent-workflow.md` — running Claude Code, Codex, and Gemini CLI on this repo in parallel without them stepping on each other.

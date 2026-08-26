# Flight Tracker

Agents poll live flight-position sources, write every report to an
append-only Postgres history, and a React map (styled like a well-worn
1930s aviation survey chart) shows live traffic and lets you trace an
aircraft's recent route. Because every historic position is kept, the
`/api/usage` endpoint derives distance flown and airborne hours for any
time window straight from the position history — no separate "usage"
table to keep in sync.

## Stack
- **Backend**: Java 21 / Spring Boot, scheduled `FlightDataAgent` pollers, WebSocket push
- **Database**: PostgreSQL, one append-only `flight_position` table
- **Frontend**: React + TypeScript + Leaflet, Vite

## Run it locally

```bash
# 1. Environment (Neovim, Claude Code, Codex, Gemini CLI, Postgres) — see setup-cachyos.sh
./setup-cachyos.sh

# 2. Backend
cd backend
mvn spring-boot:run

# 3. Frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — the map centres on the bounding box configured
in `application.yml` (`flighttracker.agents.opensky.bbox`, defaults to the
Baltic/Stockholm area).

## Deploying

`docker compose up --build` (repo root) covers local/dev use. For running
this unattended on a NAS via prebuilt images from CI, see
[`deploy/README.md`](deploy/README.md).

## Where things live
- `backend/.../service/agent/` — the agent interface + orchestrator + the OpenSky implementation. Add a new source by adding one `@Component`.
- `backend/.../service/UsageService.java` — turns historic positions into distance/airtime figures.
- `frontend/src/components/IndianaJonesMap.tsx` — the map; theme tokens are at the top of the adjacent `.css`.
- `docs/neovim-basics.md` — Neovim primer for the config in `nvim/init.lua`.
- `docs/multi-agent-workflow.md` — running Claude Code, Codex, and Gemini CLI on this repo in parallel without them stepping on each other.


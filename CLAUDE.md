# CLAUDE.md

Agent-facing brief for working on flight-tracker. Read alongside `README.md`
(architecture/stack) and `docs/multi-agent-workflow.md` (running multiple
agents on this repo in parallel via worktrees).

## Invariants — don't break these

- `flight_position` is append-only. Never add code that updates or deletes
  existing rows; historic-usage figures (`UsageService`, `/api/usage`)
  depend on every report being preserved.
- New position sources implement `FlightDataAgent`
  (`backend/.../service/agent/`) and register automatically as a Spring
  `@Component` — don't wire a new source in by hand elsewhere.
- Frontend theme tokens live at the top of `frontend/src/components/FlightMap.css`.
  Don't hardcode colours in other components.
- `api` and `agent` (the two `SPRING_PROFILES_ACTIVE` roles) only talk to
  each other through Postgres (`PollWindowService`, `LISTEN`/`NOTIFY`) —
  never add a direct call between them.

## Environment

- Backend: Java 21 / Spring Boot / Maven.
- Frontend: Node — use the version pinned in `frontend/.nvmrc` (currently
  20; `nvm use` picks it up). Playwright itself refuses to run on Node <20
  even though some deps only require ^18, so don't downgrade this.
- macOS dev machines won't have Node 20 by default — `nvm install 20` once,
  it coexists fine with whatever else `nvm ls` shows.

## Running things

- **Frontend only, mocked-API tests** (`frontend/tests/*.spec.ts` except
  the blackbox suite): no backend, no docker-compose needed —
  `playwright.config.ts` boots the Vite dev server itself and every
  request is intercepted from fixtures. `cd frontend && npm ci && npx
  playwright test`.
- **Full stack** (real backend, `blackbox-tests/`): `docker compose up
  --build` from repo root, per README.
- **Backend alone**: two terminals, `SPRING_PROFILES_ACTIVE=api
  mvn spring-boot:run` and `SPRING_PROFILES_ACTIVE=agent mvn
  spring-boot:run` — neither role is useful without the other.

## Browser for UI testing: Helium, never Vivaldi

The human's daily-driver browser is Vivaldi — don't launch or automate it.
Helium is the dedicated browser for agent-driven UI testing (it has the
Claude browser extension installed).

`frontend/playwright.helium.config.ts` extends the base Playwright config
with `launchOptions.executablePath` pointed at Helium — it checks
`$HELIUM_PATH` first, then common per-OS install paths. Run the UI suite
against it with:

```bash
cd frontend
npx playwright test --config=playwright.helium.config.ts
```

If Helium isn't at one of the built-in candidate paths on a given machine,
set `HELIUM_PATH` rather than editing the config.

## Multi-agent parallel work

See `docs/multi-agent-workflow.md` for the full worktree + tmux setup. In
short: one git worktree and one terminal pane per agent, split along the
seams in that doc's table (backend/`FlightDataAgent` work vs. frontend map
work vs. tests/docs), never two agents editing the same file in the same
turn.

## Guardrails

- Don't push to `origin` or merge a worktree branch back to `main`
  unattended — surface the diff and let the human review before either.
  This repo has a real GitHub remote; treat pushes as visible, hard-to-
  reverse actions.
- Run the mocked-API Playwright suite (fast, no infra) before handing back
  any frontend change; only reach for `docker compose` / blackbox tests
  when the change touches real backend behavior.

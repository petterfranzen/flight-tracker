# Contributing to flight-tracker

One Spring Boot JVM (REST, WebSocket and the pollers) with a vanilla
TypeScript + MapLibre GL frontend bundled into the same jar.
[`README.md`](README.md) covers the architecture. [`CLAUDE.md`](CLAUDE.md)
(also `AGENTS.md`, a symlink to it) is the agent brief and the authority on
invariants and test rules: read it before your first change.

## Prerequisites

- Java 21 and Maven (backend).
- Node 24 (frontend and blackbox tests); `frontend/.nvmrc` pins it. Node 22
  builds and tests identically.

## Build and test

These are the commands `.github/workflows/build-deploy.yml` runs.

```bash
# Frontend: Playwright runs against a mocked API, no backend needed
cd frontend
npm ci
npm run build
npm run test:e2e
npm run test:perf
npm run test:scenarios

# Backend, with the built frontend packed into the jar
# (CI also passes -Dgit.sha=<commit>, which becomes /api/health "version")
cd backend
mvn -B verify -Pwith-frontend

# Blackbox: run the jar, reopen the poll window, run the suite
FLIGHTTRACKER_DB_PATH=/tmp/ft.db SERVER_ADDRESS=127.0.0.1 TRUST_LOCAL=true \
  java -Xmx512m -jar backend/target/flight-tracker.jar &
curl -fsS http://127.0.0.1:8080/api/health        # wait until it answers
curl -sf -X POST http://127.0.0.1:8080/api/agents/restart
BASE_URL=http://127.0.0.1:8080 node --test 'blackbox-tests/**/*.test.js'
```

Locally, run only the fast checks for what you changed: `npm run build`, the
changed Playwright spec, and the changed backend test class
(`mvn -B -q test -Dtest=ClassName`). CI runs the full suites.

In a cloud or agent sandbox where Playwright cannot find Chromium, set
`PW_CHROMIUM_PATH` as described in [`CLAUDE.md`](CLAUDE.md) and
[`docs/cloud-agents.md`](docs/cloud-agents.md). Never run
`playwright install` there.

## Invariants

The short list; [`CLAUDE.md`](CLAUDE.md) has the reasoning and the details.

- `flight_position` is append-only; the only delete is the 72 h retention prune.
- Schema changes are additive and backward-compatible for one release
  (`SchemaMigrationGuardTest` enforces it).
- A new position source is a `FlightDataAgent` `@Component`; don't wire it in
  by hand.
- Live state is in memory (`LiveStateStore`), not a table.
- Routes are keyed by callsign (`callsign_route`); the `aircraft` table's
  `origin_*`/`destination_*` columns are legacy.
- The WebSocket sends one `LiveFrame` JSON per frame, marker fields only.
- `/api/health` `version` is the git SHA; the deploy script waits for it.
- One theme (cyberpunk): use the `var(--...)` tokens in
  `frontend/src/components/FlightMap.css`, no new hard-coded colours.
- One MapLibre GL map behind the `FlightMap` adapter in
  `frontend/src/map/map.ts`; planes and airports are GL layers, not DOM.

## Writing tests that don't flake

CI runs two workers on shared vCPUs with software WebGL, so timers land late.

- Start map specs with `waitForMapReady(page)`.
- Wait for state (`expect.poll`, `toPass()`), not for a duration. A fixed
  sleep is fine only before asserting that something did not happen.
- Before handing back a new or changed spec, run it under contention:
  `npx playwright test <file> --repeat-each=5 --workers=4`.

More in [`CLAUDE.md`](CLAUDE.md); see also
[`docs/popping-harness.md`](docs/popping-harness.md).

## Branches and pull requests

- Work on a branch and open a PR against `main`. Never push to `main`:
  **a merge or push to `main` deploys to production.**
- The workflow runs on pull requests and on pushes to `main`, nowhere else.
  Park known-broken work on a `wip/<topic>` branch (no PR, no CI).
- Push once per finished piece of work; each push starts a ~12 minute run and
  cancels the one in progress on that branch.
- Merge only when CI is green on the head. CI retries a failed test once; a
  test that passes only on the retry shows as a "flaky" annotation, so find
  its race instead of relying on the retry.
- Agents never merge; a human does. See
  [`docs/cloud-agents.md`](docs/cloud-agents.md) and
  [`docs/multi-agent-workflow.md`](docs/multi-agent-workflow.md) for how
  agents work here.

## Secrets and security

The repo is public. Never put a secret, token, key or private hostname in a
commit, issue or PR. Report a vulnerability to the maintainer privately, not in
a public issue.

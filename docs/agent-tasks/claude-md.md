# CLAUDE.md / AGENTS.md for the single-JVM stack

Supersedes PR #67 (`gh pr diff 67`), whose content describes the old
multi-container architecture: Spring profiles, Postgres LISTEN/NOTIFY,
React, docker-compose.

Branch: `docs/claude-md` from `origin/main`.

## Do
1. **`CLAUDE.md`**: an agent brief that reads in under two minutes. Check every
   claim against the code, not against #67.
   - **Invariants:** `flight_position` is append-only (`UsageService`, `/api/usage`);
     new sources implement `FlightDataAgent` as a `@Component`; live state is
     in-memory (`LiveStateStore`) and pushes go through `PositionsPersistedEvent`;
     routes (origin/destination) are keyed by callsign (`callsign_route` table,
     `CallsignRouteService`), not stored per aircraft — the aircraft table's route
     columns are legacy and unread;
     WebSocket wire format is one `FlightPosition` per frame (the blackbox suite
     depends on it); `/api/health` `version` is the git SHA `deploy.sh` waits for;
     theme tokens live in one place (find it).
   - **Environment:** Java 21 + Maven, Node 24 (as in CI). Pin `frontend/.nvmrc` to `24`.
   - **Running things:** the exact commands from `.github/workflows/build-deploy.yml`:
     frontend build + Playwright (mocked API, includes `perf.spec.ts`); `mvn -B verify`
     (`-Pwith-frontend` to bundle); blackbox (start the jar, then
     `node --test 'blackbox-tests/**/*.test.js'`).
   - **UI testing browser:** Helium for agent-driven UI testing, never Vivaldi (the
     human's daily browser). Keep `frontend/playwright.helium.config.ts` from #67
     (`$HELIUM_PATH` + per-OS candidates, `workers: 1`), adapted to the current
     `playwright.config.ts`. It only applies on the human's machines; cloud
     sessions use bundled Chromium.
   - **Where agents run:** link `docs/cloud-agents.md` and `docs/agent-tasks/`. Don't
     duplicate them.
   - **Guardrails:** branch + PR; never push to or merge into `main` (it deploys);
     never put deploy keys or Cloudflare tokens anywhere an agent runs.
2. **`AGENTS.md`**: a symlink to `CLAUDE.md`.
3. **`docs/multi-agent-workflow.md`**: make it match the current code. If most of it
   is obsolete, cut it down rather than patch it.
4. `cd frontend && npm run build && npm run test:e2e` still passes. Every path and
   command you cite exists.
5. Open a PR titled "Add CLAUDE.md/AGENTS.md for the single-JVM stack" saying it
   supersedes #67. Delete this brief in the same PR.

# Final Gate verification — PASS

**Date:** 2026-10-01
**Branch:** `feat/cloud-migration` @ `75932b7` ("docs: Phase M complete, Final Gate verification in progress")
**Verifier environment note:** the worktree assigned to this agent
(`.claude/worktrees/agent-a72ed1382362327c3`) was checked out on an
unrelated branch (`worktree-agent-a72ed1382362327c3`, airport-zoom-density/
phase-logging history — nothing to do with this migration). `feat/cloud-
migration` was already checked out in the primary repo directory, which
this agent is barred from touching. Verification was instead run from a
throwaway detached-HEAD worktree at `feat/cloud-migration`'s tip
(`/private/tmp/claude-501/.../scratchpad/final-gate-verify`), sharing the
same object database as the main repo, so all results below are against
the real, current `feat/cloud-migration` content. This report file itself
only exists in that throwaway worktree — it was not committed (committing
would have required moving the `feat/cloud-migration` ref out from under
the primary checkout, which felt like the wrong call for a read-only
verifier to make unilaterally). Someone with access to the primary repo
should copy this file in and commit it, or re-run this gate from a
properly-placed worktree.

## Checklist results

### Re-run of A1+A2+B1+C1 on the merged tree
- `mvn -B clean verify -Pwith-frontend` (after `npm run build` in
  `frontend/` first — see note below): **BUILD SUCCESS**, **72/72 tests
  green**, 0 failures/errors/skipped.
- Single process, no `SPRING_PROFILES_ACTIVE` set: confirmed via startup
  log — `No active profile set, falling back to 1 default profile:
  "default"`. SQLite only; `FLIGHTTRACKER_DB_PATH` pointed at a scratch
  file, no Postgres/docker involved.
- Blackbox suite (`blackbox-tests/`, `node --test` against the live jar,
  `BASE_URL=http://localhost:8080`): **16/16 passed** (the one WS frame
  wait is documented as inconclusive-not-failure when no live traffic
  arrives in the window, which is expected and not a failure).
- Golden shapes vs. `docs/cloud-migration/golden/SHAPES.md`: spot-checked
  every documented endpoint not already covered by the blackbox suite —
  `/api/flights/live/count` (bare integer), `/api/flights/live/clusters`,
  `/api/agents/status` (`{active, secondsRemaining}`), `/api/airports/info
  ?code=ARN` (IATA-keyed, full object shape), `/api/health/sweep` (200).
  `/api/health` returned `{"status":"UP","version":"dev","db":"UP",
  "lastSweepAt":...}` — shape matches; `version` is `"dev"` rather than a
  40-char sha only because this is a local build with no CI-injected git
  sha, not a shape mismatch. All match.
- `grep -rn "@Profile\|LISTEN\|NOTIFY\|PGConnection" backend/src/main` →
  **empty**.
- `grep -rni "postgres\|jpa\|hibernate" backend/` (excluding `target/`
  build output) → every hit is a comment/docstring explaining what the
  code *replaced* (e.g. `AircraftRepository.java`: "Cloud migration A2:
  JdbcClient + record, replacing the Spring Data JPA..."); `pom.xml` has
  zero matches (no Postgres driver, no JPA/Hibernate starter dependency).
  **PASS.**
- `TRUST_LOCAL=false` + `CF-Connecting-IP` rate-limit test: `POST
  /api/agents/restart` with header `CF-Connecting-IP: 203.0.113.42` against
  the running jar (`TRUST_LOCAL` unset → defaults to `false` per
  `application.yml`'s `trust-local: ${TRUST_LOCAL:false}`) — requests 1-3
  returned `200`, request 4 returned `429`. Matches
  `restart-per-ip-per-minute: 3` in `application.yml`. **PASS.**
- WebSocket idle ≥150s with keepalives: opened a real `ws://127.0.0.1:8080
  /ws/live` connection with Node's native `WebSocket` and held it idle for
  155s — still open at the end, no close event. `LiveFeedBroadcaster
  .sendKeepalive()` sends a native WS ping frame every 30s
  (`@Scheduled(fixedDelay = 30_000)`), well inside the window. **PASS.**
- Frontend: `grep -rn "react" frontend/package.json frontend/src` (exact
  checklist command, case-sensitive) → **empty**. `package.json` has only
  `leaflet`/`maplibre-gl`/`@maplibre/maplibre-gl-leaflet` as deps, no React.
  `npm run build` → clean (`tsc -b && vite build`, 0 errors; only an
  informational Rollup chunk-size warning, not an error). `npm run
  test:e2e` (Playwright) → **17/17 passed** in 40.5s.
- `actionlint` on `.github/workflows/` (only `build-deploy.yml` remains) →
  **clean, exit 0**.
- `shellcheck deploy/hetzner/*.sh` → **clean, exit 0**.
- `deploy/hetzner/test/run.sh` → **20/20 checks passed** (deploy, rollback,
  checksum/injection/oversize rejection, pruning, status/rollback verbs).
- `deploy/hetzner/build-cloud-init.sh` regenerated `cloud-init.yaml` with
  **zero diff** against the committed version.

### Single jar serves SPA + API + WS on one port (new for this gate)
Built with `-Pwith-frontend` **after** first running `npm run build` in
`frontend/` — the `with-frontend` Maven profile only *copies* a pre-built
`frontend/dist` into `BOOT-INF/classes/static`; it does not build the
frontend itself (confirmed in `backend/pom.xml`'s `copy-resources`
execution). This is worth flagging: **a `mvn -Pwith-frontend` run with no
prior `npm run build` silently produces a jar with no SPA in it** (no
error, no warning — `frontend/dist` just doesn't exist, so the resources
plugin copies nothing). First build attempt without the frontend built
first confirmed this: `jar tf` showed no `static/` entries at all,
`GET /` would have 404'd. After building the frontend and rebuilding the
jar, `jar tf target/flight-tracker.jar | grep static` showed
`index.html` and all `assets/*.js`/`*.css`.

Ran the jar standalone (`FLIGHTTRACKER_DB_PATH=<scratch>/ft.db java -jar
backend/target/flight-tracker.jar`) and hit all three surfaces from the
one process on port 8080:
- `GET /` → `200`, `Content-Type: text/html`, real `index.html` (the built
  SPA shell).
- `GET /api/health` → `200`, `{"status":"UP","version":"dev","db":"UP",...}`.
- `ws://127.0.0.1:8080/ws/live` → real WebSocket upgrade succeeds (Node
  native `WebSocket` client, `open` event fires); a plain GET (no upgrade
  headers) to the same path returns `400`, not `404`, confirming the
  endpoint is mapped and rejecting non-upgrade requests correctly.

**Single-jar-serves-everything verified: yes** — but only after building
the frontend first, which the Maven profile does not do automatically.
Worth a one-line addition to `README.md`/`deploy/hetzner/README.md` or
the CI workflow's own comments if it isn't already spelled out somewhere
a future `mvn -Pwith-frontend` runner would see it first — I did find the
instruction in `blackbox-tests/README.md`'s "Running against the real jar"
section (`cd backend && mvn -B package -Pwith-frontend -DskipTests` is
listed *after* an implicit build-frontend-first step isn't actually shown
there either, so even that doc doesn't spell out the `npm run build`
prerequisite explicitly). Non-blocking since the CI workflow
(`build-deploy.yml`) was already verified at C1 gate to build the frontend
before the backend — this is a local-dev-ergonomics note, not a shipped-
behavior gap.

### Obsolete files removed, nothing references them
`git ls-files | grep -iE "docker-compose|dockerfile|nginx"` → empty; no
`docker-compose*`/`Dockerfile*`/`nginx.conf` on disk at all (tracked or
not). `.github/workflows/` contains only `build-deploy.yml` — the old
`docker-publish.yml`/`blackbox-tests.yml` are gone.

`git ls-files -z | xargs -0 grep -l "docker-compose\|docker compose\|FROM
node\|FROM eclipse-temurin\|nginx"` (tracked files only, excluding
`docs/cloud-migration/reports/*`) turned up 13 files. Read every one in
context: all are explanatory comments/docs describing what the migration
*removed* (e.g. `ClientIpResolver.java`'s javadoc explaining why nginx's
`X-Real-IP` setup is gone, `deploy/README.md`'s "previous NAS deployment
... is retired" paragraph, `PLAN.md`'s own checklist and history). None
are live references to files that still need to exist. **Obsolete files
confirmed removed, no dangling references: yes.**

### README updated
`README.md`'s "Run it locally" section: single `cd backend && mvn
spring-boot:run` (REST+WS+pollers on :8080, SQLite file), single `cd
frontend && npm install && npm run dev` — no mention of two processes/
profiles, no Postgres, no NAS. "Deploying" section: GitHub Actions builds
one jar with the frontend bundled in and deploys to a Hetzner VM over SSH
through Cloudflare Access — no NAS/GHCR/docker-compose. **README updated
correctly: yes.**

One stale line, non-blocking and outside the two sections the checklist
asks about: the "Phase reporting" section still says "[docker-monitor]
reads these out of the **container log stream**" — the Hetzner deploy
(`deploy/hetzner/flight-tracker.service`) runs the jar directly under
systemd/journald, not a container, so that phrase is now inaccurate. Low
stakes (describes an external, out-of-repo dashboard tool's integration,
not this app's own behavior) but worth a follow-up edit.

### Merge structure
`git log --oneline --merges feat/cloud-migration`:
```
1a1f1b3 Merge feat/cm-ci into feat/cloud-migration (C1)
46b0a54 Merge feat/cm-frontend into feat/cloud-migration (B1)
01aca34 Merge feat/cm-backend into feat/cloud-migration (A1+A2)
```
All three `--no-ff`, followed by `141b65c` (Phase M cleanup) and `75932b7`
(this gate's docs commit) on top. `git diff 1d5868c..HEAD --stat` (Phase 0
baseline commit `1d5868c "docs: Phase 0 baseline — all green, no ASK
needed"` to current tip): 131 files changed, touching `backend/`,
`frontend/`, `deploy/`, `.github/`, `docker-compose.yml` (deleted), and
`README.md` — nothing looks like a silently dropped work package.

## Concerns (non-blocking)
- `mvn -Pwith-frontend` does not build the frontend itself — it only
  copies a pre-existing `frontend/dist`. A dev running just that one
  command gets a silently SPA-less jar with no error. CI already does the
  right thing (frontend build before backend, verified at C1); this is
  purely a footgun for local reproduction of "the one true jar" that isn't
  spelled out end-to-end in any single doc.
- `README.md`'s "Phase reporting" section still says docker-monitor reads
  a "container log stream" — Hetzner prod now runs under systemd/
  journald, not a container. Cosmetic, doesn't affect functionality.
- This report was not committed onto `feat/cloud-migration` because of
  the worktree/branch mismatch described at the top — flagging so it
  doesn't get lost.

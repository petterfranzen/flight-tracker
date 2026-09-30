# Gate C1 verification — ci-deployer

Branch verified: `feat/cm-ci` @ f5b676a (worktree
`.claude/worktrees/agent-a16ce2130860c1b40`), checked against
`feat/cloud-migration` @ 1d5868c via a detached `git worktree add --detach`
checkout at the same SHA. Verifier: automated Gate C1 review, 2026-09-30.

## Result: PASS

All checklist items C1 can control on its own branch pass. The two items
that require A1's `/api/health` endpoint and a real GitHub Actions run are
**deferred to Final Gate**, per PLAN §4/§9's parallel-worktree design — not
failures.

## Checklist

- [x] `actionlint` clean on all workflows (`build-deploy.yml`,
      `blackbox-tests.yml`, `docker-publish.yml`). `actionlint` run from repo
      root: exit 0, no output.
- [x] `shellcheck deploy/hetzner/*.sh` clean. Ran against `build-cloud-init.sh`,
      `deploy.sh`, `test/run.sh`: exit 0, no output.
- [x] `yamllint -d relaxed` clean on `cloud-init.yaml`. Ran inside an
      `ubuntu:24.04` container (via `colima nerdctl`). Exit 0 — only
      `line-length` warnings (relaxed profile permits these; no errors).
- [x] `systemd-analyze verify` on `flight-tracker.service`, in the same
      container (with a dummy executable `/usr/bin/java`, dummy
      `flighttracker` user, and the paths the unit's `ConditionPathExists`
      and `EnvironmentFile` require stubbed out). Exit 0, no diagnostics.
- [x] `deploy/hetzner/test/run.sh` passes: 20/20 checks, including good jar,
      bad checksum, oversize input (`FT_MAX_JAR_BYTES=1000`), injection
      attempt (`deploy <sha> <sum>; rm -rf /` correctly rejected with usage
      exit 64 — `SSH_ORIGINAL_COMMAND` is split with `read -r -a` and matched
      by `${#args[@]}:${args[0]}`, so the trailing shell metacharacters never
      reach a shell), unhealthy start → rollback (exit 2), `rollback` verb,
      `status` verb, and the newly added release-pruning case (6th release
      written evicts exactly the oldest untracked one, keeps 5 on disk).
      Confirmed working via Bash's `run_in_background: true` (foreground
      execution in this sandbox couldn't reach the backgrounded Python
      health-check server's socket, exactly as C1's report flagged).
- [x] `build-cloud-init.sh` regenerates `cloud-init.yaml` with no diff.
      Verified with `git diff --exit-code deploy/hetzner/cloud-init.yaml`
      after re-running the script: clean.
- [x] `visudo -c` on `sudoers-deploy`: parsed OK (bonus check, in the PLAN's
      security-requirements list, run alongside the container checks).
- [x] `mvn -B verify` (default, no profile): 40/40 tests pass,
      `target/flight-tracker.jar` built (finalName honored). Confirmed the
      default build does **not** pull in frontend/static content (`mvn clean
      verify -DskipTests` with no profile → no `static/` entries in the jar).
- [x] `mvn -B verify -Pwith-frontend -DskipTests` with a synthetic
      `frontend/dist/{index.html,app.js}`: build succeeds, jar contains
      `BOOT-INF/classes/static/index.html` and `app.js` — the
      `maven-resources-plugin` copy-resources binding works as designed.
- [x] `build-info` / `git.sha` wiring, end to end: default build produces
      `META-INF/build-info.properties` with `build.git.sha=dev`; rebuilding
      with `-Dgit.sha=abc123deadbeefabc123deadbeefabc123deadb` produces
      `build.git.sha=abc123deadbeefabc123deadbeefabc123deadb` in the jar.
      This is exactly the key (`git.sha`) and default (`dev`) PLAN.md §7
      lines 320-322 specify, and matches what a `BuildProperties` bean would
      read for `GET /api/health`'s `version` field (PLAN.md §7 line 186-189).
      A1's `/api/health` isn't implemented yet on `feat/cm-backend` (checked:
      no `git.sha`/`BuildProperties`/`api/health` hits there), so this can't
      be checked against a real consumer yet — but C1's half of the contract
      is correct and matches the spec verbatim.

## Deferred to Final Gate (not failures)

- **"Workflow run on the PR: `frontend`, `backend`, `blackbox` green;
  `deploy` skipped (not `main`)."** No branch was pushed and no PR opened —
  correct per PLAN's orchestrator instructions (one PR, opened after Phase
  M). `blackbox` cannot go green on `feat/cm-ci` alone because it starts the
  packaged jar and curls `/api/health`, which doesn't exist until A1 lands
  on the merged tree. Verified instead, on this branch alone, that: the job
  graph is correctly wired (`deploy` needs `[backend, blackbox, cloud-init]`;
  `blackbox` needs `backend`; `backend` needs `frontend`); `actionlint`
  passes on the workflow; and the `blackbox` job's own logic (start jar,
  poll `/api/health`, run `node --test blackbox-tests/**/*.test.js`) is
  unchanged from `feat/cloud-migration` except for the pinned action
  versions.
- **"`/api/health` `version` equals the SHA passed to Maven (check the jar
  from the workflow run)."** No real workflow run exists yet (no push/PR).
  Verified the mechanism directly instead (see build-info check above): the
  jar's `build-info.properties` `git.sha` property equals whatever
  `-Dgit.sha=...` Maven was invoked with, which is exactly what
  `build-deploy.yml`'s `backend` job passes
  (`mvn -B verify -Pwith-frontend -Dgit.sha=${{ github.sha }}`). This will
  resolve automatically once A1's `/api/health` reads
  `buildProperties.get("git.sha")` and the two branches merge.

## Out-of-scope edits

None. `git diff feat/cloud-migration...feat/cm-ci --stat` touches only:
`.github/workflows/build-deploy.yml`, `backend/pom.xml` (only the
`<properties><git.sha>`, `<build>`, and new `<profiles>` blocks — no
dependency/plugin-version changes elsewhere), `deploy/README.md`,
`deploy/hetzner/{README.md (new), build-cloud-init.sh, cloud-init.yaml,
deploy.sh, sudoers-deploy, test/run.sh}`. All within C1's owned paths.

## Security requirements (PLAN's brief, checked directly)

- **Deploy SSH key restricted to `deploy.sh`, no pty/forwarding**:
  `cloud-init.yaml` line 28:
  `command="/opt/flight-tracker/bin/deploy.sh",restrict <GITHUB DEPLOY PUBLIC KEY>`.
  OpenSSH's `restrict` implies `no-port-forwarding,no-X11-forwarding,
  no-agent-forwarding,no-pty,no-user-rc` — matches the requirement in one
  token. Key material itself is a deliberately unfilled `<...>` placeholder
  (expected; flagged in the hand-off).
- **Deploy user's sudo limited to restart+status only**:
  `sudoers-deploy`:
  `deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart flight-tracker, /usr/bin/systemctl status flight-tracker`
  — exactly those two subcommands, nothing else. `visudo -c` parses it OK.
- **No secret echoed in any script/workflow log line**: read `deploy.sh` in
  full — `log()` only ever prints sha/size/status text, never secret
  material (there is none to leak; the deploy key's forced command receives
  no credentials). Read `build-deploy.yml`'s `deploy` job in full —
  `DEPLOY_SSH_KEY`/`DEPLOY_KNOWN_HOSTS`/`CF_ACCESS_CLIENT_ID`/
  `CF_ACCESS_CLIENT_SECRET` are written to files with `chmod 600`/piped into
  `ssh`'s `ProxyCommand` env, never `echo`'d or otherwise printed; this part
  of the workflow is unchanged from `feat/cloud-migration` except for action
  version pins. Grepped the full branch diff for password/secret/token/key
  literal-assignment patterns: none found beyond legitimate
  `${{ secrets.* }}` references.
- **App binds 127.0.0.1 only**: `flight-tracker.service`:
  `Environment=SERVER_ADDRESS=127.0.0.1` and `SERVER_PORT=8080`; the
  workflow's `blackbox` job also sets `SERVER_ADDRESS=127.0.0.1` when
  running the jar standalone. No `0.0.0.0` or unbound listener anywhere in
  the diff.

## Concerns (non-blocking)

- None found in C1's own scope. The only real gaps are the two explicitly
  deferred items above, which are structural to the parallel-worktree
  design and will resolve at Final Gate once A1 lands and the tree merges.
- Minor observation, not a defect: `cloud-init.yaml`'s two placeholders
  (`<YOUR PERSONAL SSH PUBLIC KEY>`, `<GITHUB DEPLOY PUBLIC KEY>`) are
  correctly unfilled for a template, but nothing in CI enforces they get
  filled before a real `terraform`/manual apply — worth a reminder in the
  Phase M / deploy runbook, not a C1 blocker.

## Environment notes for reproducibility

- Toolchain: `JAVA_HOME=~/.local/toolchains/temurin-21`, Maven 3.9.16,
  actionlint 1.7.12, shellcheck 0.11.0, all via
  `~/.local/toolchains/{bin,maven/bin,temurin-21/Contents/Home/bin}` on PATH.
- No `docker` CLI on this host; used `colima nerdctl -- run` against an
  already-pulled `ubuntu:24.04` image for the yamllint/systemd-analyze/
  visudo checks. Colima only bind-mounts `$HOME` by default (`mounts: []` →
  "Colima default behaviour: $HOME is mounted as writable" in
  `~/.colima/default/colima.yaml`), so the verification checkout had to live
  under `$HOME` (not `/private/tmp`) for `-v` volume mounts to see it.
- Verification was done from a `git worktree add --detach feat/cm-ci`
  checkout (the branch itself was already checked out, locked, in another
  agent's worktree) — removed after use; no files were left behind in the
  `feat/cm-ci` worktree or branch.

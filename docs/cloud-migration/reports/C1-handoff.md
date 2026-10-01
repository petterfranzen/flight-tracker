## ci-deployer · C1 · PASS

Branch / last commit: `feat/cm-ci` @ f5b676a (branched from `feat/cloud-migration` @ 1d5868c; 4 commits: 8a2f0f7, 6c789cd, 8023824, f5b676a)

What changed (by file group):
- `backend/pom.xml` (`<build>`/`<profiles>` only): `<finalName>flight-tracker</finalName>`; `spring-boot-maven-plugin` `build-info` goal writing `git.sha` (property defaults to `dev`, CI passes `-Dgit.sha=$GITHUB_SHA`) into `META-INF/build-info.properties` for A1's `/api/health` to read via `BuildProperties.get("git.sha")`; new `with-frontend` profile (`maven-resources-plugin` copy-resources) copying `../frontend/dist` → `target/classes/static` at `process-resources`. Default build (no profile) untouched.
- `.github/workflows/build-deploy.yml`: pinned `actions/setup-java` v5→**v6**, `actions/upload-artifact` v5→**v7**, `actions/download-artifact` v5→**v8** — checked each repo's `/releases/latest` directly, none were guesses; `checkout@v7`/`setup-node@v7` confirmed already current. Added a `cloud-init` job (regenerates `cloud-init.yaml`, fails on `git diff --exit-code`) and put it in `deploy`'s `needs:` alongside `backend`/`blackbox`.
- `deploy/hetzner/deploy.sh`: portability fixes — `stat -c %s` → `wc -c`, `find -printf` → `ls -t`, `mv -T` → `mv -f`. These GNU-only flags are correct on the Ubuntu target but meant `test/run.sh` couldn't run at all on this dev machine (no GNU coreutils); no behavior change on Linux. Also: `status` verb now runs `sudo systemctl status flight-tracker` (new `status_service()`, mirrors `restart_service()`'s `FT_*` override pattern) instead of only guessing from symlinks + `/api/health`.
- `deploy/hetzner/sudoers-deploy`: added `systemctl status flight-tracker` alongside `restart` — matches the required "deploy's sudo is limited to restarting/status" scope exactly (was restart-only). `visudo -c` parses it OK.
- `deploy/hetzner/build-cloud-init.sh`: `indent()` no longer pads blank lines with trailing spaces (was producing yamllint `trailing-spaces` errors in the generated file).
- `deploy/hetzner/cloud-init.yaml`: regenerated only, no manual edits.
- `deploy/hetzner/test/run.sh`: added a release-pruning case — 3 more successful deploys (6 releases total ever written) assert the oldest unreferenced jar is pruned, exactly 5 remain on disk, and current/previous survive. mtimes pinned with `touch -t` so "oldest" isn't a coin-flip on however fast the suite happens to run. 13 → 20 checks.
- `deploy/hetzner/README.md` (new): logs, restart, rollback (both `ssh flight rollback` and doing it directly on-box as yourself), status, `sqlite3 -readonly` shell, disk usage, on-disk layout, firewall/access model.
- `deploy/README.md`: pointer at the top to the new file, noting this NAS guide stays accurate only until Phase M's cutover.

Contract impact: none. No application code, HTTP/WS API, frontend, or DOM touched — only `pom.xml` `<build>`/`<profiles>`, `.github/workflows/**`, `deploy/hetzner/**`.

Tests run + result:
- `mvn -B verify` (no profile): PASS, same 40/40 tests as the Phase 0 baseline, ~7.6s, produces `backend/target/flight-tracker.jar`.
- `mvn -B verify -Pwith-frontend -DskipTests` with a synthetic `frontend/dist`: PASS, confirmed `target/classes/static/{index.html,assets/*}` present; synthetic dist removed after, `git status` clean.
- `actionlint`: clean on all 3 workflows.
- `shellcheck deploy/hetzner/*.sh deploy/hetzner/test/*.sh`: clean.
- `deploy/hetzner/build-cloud-init.sh && git diff --exit-code deploy/hetzner/cloud-init.yaml`: clean, no drift.
- `deploy/hetzner/test/run.sh`: **20/20 passed**, run 3× across edits, consistently green.
- `systemd-analyze verify deploy/hetzner/flight-tracker.service`: clean, via a throwaway `ubuntu:24.04` container (`colima nerdctl`) with a stub `/usr/bin/java` and `flighttracker` user.
- `yamllint -d relaxed deploy/hetzner/cloud-init.yaml`: clean (0 errors; line-length warnings only, expected under relaxed mode).
- `visudo -c -f deploy/hetzner/sudoers-deploy`: parsed OK.

**Environment note for whoever verifies this next:** `deploy/hetzner/test/run.sh` backgrounds a small Python HTTP server (`&`) to fake systemd. In this sandboxed Bash tool, a plain `&`-backgrounded process's listening socket is not reachable from the same tool invocation's foreground continuation — but it is reachable when the whole script is launched via `run_in_background: true` instead. Property of this sandbox, not the script.

Numbers:
- `mvn verify`: ~7.6s, 40/40 tests (matches baseline).
- `deploy/hetzner/test/run.sh`: 20/20, a few seconds total.
- Action pins changed: setup-java v5→v6, upload-artifact v5→v7, download-artifact v5→v8 (all confirmed via GitHub's releases API, non-prerelease).

Needs from other agents:
- **backend-consolidator (A1)** owns `GET /api/health`, `SERVER_ADDRESS`/`TRUST_LOCAL`, and (A2) `FLIGHTTRACKER_DB_PATH`. Until those land on this tree, the workflow's `blackbox` job — and Gate C1's "workflow run on the PR: frontend/backend/blackbox green" and "`/api/health` version equals the SHA" checklist items — can't go green for real. `frontend`, `backend` (mvn build+package), and the new `cloud-init` job all pass standalone today; `blackbox`/`deploy` need A1/A2's pieces. Per PLAN §7 this is expected — the Final gate on the merged tree is where that fully closes, not Gate C1 in isolation.
- Confirm the lookup key: pom.xml's `<additionalProperties><git.sha>` produces `build.git.sha` in the raw properties file, which Spring's `BuildProperties.get("git.sha")` reads (prefix stripped automatically) — that's the API A1's health endpoint should call.
- Relaying only: WebSocket keepalive frame shape is a coordination point between A1 (step 9) and B1 (step 5) per PLAN.

Files to delete in Phase M (flagging only, not deleted):
- `.github/workflows/blackbox-tests.yml`
- `.github/workflows/docker-publish.yml`
(Both still run on PRs today; PLAN §6 C1.6 says retire only in Phase M.)

Open risks:
- Two Gate C1 items are genuinely blocked on A1/A2 landing, not on anything in C1's scope.
- Branch was not pushed and no PR/real GitHub Actions run was triggered — `deploy`'s `environment: production` gate means a `main` push would attempt a real deploy; nothing instructed opening a PR at this stage (PLAN's own design opens one PR at the end, after Phase M).
- `cloud-init.yaml`'s two placeholders (`<YOUR PERSONAL SSH PUBLIC KEY>`, `<GITHUB DEPLOY PUBLIC KEY>`) are deliberately unfilled — Petter's hosting guide fills them at provisioning time.

**Secrets and variables for Petter's hosting guide (verified against the actual workflow):**
- Environment `production` secrets: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`
- Repository variable: `DEPLOY_SSH_HOSTNAME` (e.g. `flight-ssh.pastabake.cloud`)
- SSH host alias baked into the workflow's `~/.ssh/config`: `flight-tracker-vm` (must match what `DEPLOY_KNOWN_HOSTS` and the VM's actual host key use for `HostKeyAlias`)

# Cloud migration: orchestrator status

Live resumability anchor. If a session gets cut off, a fresh Claude Code
session should read this file first, then `docs/cloud-migration/PLAN.md`,
then check `git branch -a` and the other files in this directory before doing
anything else.

## Local toolchain (this machine only, not committed)

The machine had no `mvn`/`node`/`npm`/`docker`/`actionlint`/`shellcheck` on
PATH, and Homebrew couldn't build some deps from source (missing Xcode
Command Line Tools — `xcode-select --install` would fix it, but that's an
interactive GUI installer so it wasn't run). Installed official prebuilt
binaries instead, self-contained under `~/.local/toolchains/`:

- Temurin JDK 21.0.12.1
- Apache Maven 3.9.16
- Node.js 24.21.0
- shellcheck 0.11.0, actionlint 1.7.12 (both static binaries)

**A fresh shell/session must run this first:**
```bash
source ~/.local/toolchains/env.sh
```
That exports `JAVA_HOME` and prepends all the above to `PATH`. Verify with
`java -version && mvn -v && node -v && npm -v && shellcheck --version && actionlint -version`.

**Docker Desktop (v4.5.0 / engine 20.10.12, set up back in 2022) is dead.**
Launched fine but its VM networking is broken (`docker pull` hangs forever,
no progress) — plausibly just stale after years dormant. Quit it
(`osascript -e 'quit app "Docker"'`) and don't use it.

**Using Colima + containerd + nerdctl instead**, started with:
```bash
colima start --runtime containerd --cpu 4 --memory 4 --disk 30
```
`docker-compose.yml` works via `colima nerdctl -- compose <args>` (nerdctl
runs *inside* the VM via SSH — no host-side `docker`/`nerdctl` binary needed).
There is no `docker` CLI on this host and no `docker compose` — every compose
command in PLAN.md/agent files that says `docker compose ...` should be run
as `colima nerdctl -- compose ...` here instead. `docker stats` becomes
`colima nerdctl -- stats`.

**Why not plain Homebrew:** this machine's only Homebrew (`/usr/local/bin/brew`)
is the **Intel/Rosetta build** (no native `/opt/homebrew` install), and
separately this exact macOS version ("Tahoe") has few prebuilt bottles yet
(Homebrew Tier 3) — formulas needing a from-source build (`docker`, `nerdctl`,
`go`, `maven`'s `openjdk` dep, ...) fail without Xcode Command Line Tools
(`xcode-select --install`, an interactive GUI install, not run). Lima and
Colima got installed via Homebrew first (bottled fine) but as **x86_64
binaries under Rosetta**, which `limactl` itself refuses to run under
("please reinstall lima with native arch") — so those were replaced with
native arm64 binaries downloaded straight from the lima-vm/lima and
abiosoft/colima GitHub releases into `~/.local/toolchains/`, same as the
other tools. `env.sh` already puts these ahead of the Rosetta Homebrew ones
on PATH.

If a fresh session finds `colima status` failing, run the `colima start`
command above and wait (VM boot + nerdctl provisioning takes a few minutes).

## Progress

| Phase / Gate | Status | Notes |
|---|---|---|
| Bundle copied to `feat/cloud-migration`, toolchain set up | ✅ done | this commit |
| Phase 0 (baseline + golden contract) | ✅ done | all green, see `00-baseline.md`; no 🔒 ASK |
| A1 backend-consolidator | ✅ reported PASS | 8 commits, 70/70 unit tests, live-verified against real Postgres (blackbox 16/16, golden shapes match, rate-limit fix confirmed live, WS keepalive confirmed live ≥155s). See `A1-handoff.md`. Caught and fixed a real bug (warm-up SQL column alias) that only live testing surfaced, not `mvn verify` alone. |
| Gate A1 | ✅ **PASS** | independently verified, see `A1-verify-1.md`. RSS ~442MB (vs baseline 1,068MB/3 JVMs) — confirms consolidation win. Verifier wrote a raw RFC-6455 WS client to directly observe PING/PONG control frames. One golden-shape discrepancy (`/history` has 12 fields vs SHAPES.md's 7) investigated and confirmed pre-existing, not a regression — SHAPES.md needs a correction at some point, not urgent. |
| A2 sqlite-migrator | ✅ reported PASS | 3 commits, 72/72 tests, Postgres/JPA fully gone. See `A2-handoff.md`. Another real bug caught by live testing only (SQLite auto_vacuum PRAGMA startup-ordering race). Sweep insert 70-71ms for ~11.4k rows (budget 2s). Early RSS ~208-218MB vs A1's 442MB Postgres-backed — verifier needs its own 20-min steady-state reading per Gate A2. |
| Gate A2 | ⏳ verifying | needs a genuine 20-minute live run per checklist |
| B1 frontend-vanilla | ✅ reported PASS | 2 commits, 17/17 Playwright specs, two real bugs found+fixed during port. See `B1-handoff.md`. **Bundle-size target (≤60KB gzip) not met — 82KB, well-explained** (Leaflet alone is ~42KB, airport dataset chunk ~23.5KB, both kept per PLAN; app code itself is only ~18KB). Needs Petter's call on the target, not blocking — matches Gate B1 checklist wording "target met or explained." |
| Gate B1 | ✅ **PASS** | independently verified, see `B1-verify-1.md`. Verifier rebuilt both before/after bundles from clean `npm ci` and independently measured Leaflet's own gzip footprint (42,661B) — confirms the bundle-size explanation checks out. 2 non-blocking concerns noted: no dedicated theme-toggle UI test (pre-existing, not a regression), airport markers lose Tab-key reachability (documented trade-off). |
| C1 ci-deployer | ✅ reported PASS | 4 commits, 20/20 local checks green. See `C1-handoff.md`. Two checklist items (workflow `blackbox` green, `/api/health` version) are structurally blocked on A1/A2 landing — expected per PLAN, deferred to Final Gate. |
| Gate C1 | ✅ **PASS** | independently verified, see `C1-verify-1.md`. Two items deferred to Final Gate (structural to parallel-worktree design, not failures): live `blackbox` CI green, `/api/health` version match — both need A1's `/api/health` to exist first. |
| Phase M merge | not started | |
| Final gate | not started | |
| PR opened | not started | |

Update the table above (and commit) as each stage completes. Hand-off
reports and verifier reports land in this same directory per PLAN §8/§7.

**If resuming after an interruption while A1/B1/C1 show "in progress":** a
killed session's background subagents are gone — there is nothing to
reconnect to. Instead: `git worktree list` to find `wt/backend`,
`wt/frontend`, `wt/ci`; `cd` into each and `git log --oneline` to see how
far that agent got (each was instructed to commit after every green step).
If a worktree has real commits, spawn a fresh agent for that package with a
prompt telling it to `cd` into the *existing* worktree (don't recreate it),
read its own branch's commit log plus PLAN.md, and continue from wherever it
left off, rather than starting the package over. If a worktree is empty or
missing, just re-spawn that package from scratch per the instructions below.

## Branch map (once streams start)

- `feat/cloud-migration` — orchestrator branch, this repo root
- `feat/cm-backend` — backend-consolidator (A1) then sqlite-migrator (A2), worktree `wt/backend`
- `feat/cm-frontend` — frontend-vanilla (B1), worktree `wt/frontend`
- `feat/cm-ci` — ci-deployer (C1), worktree `wt/ci`

Check `git worktree list` and `git log --oneline` on each branch to see how
far a stream got before any interruption.

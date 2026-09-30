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

Docker Desktop was already installed (v4.5.0 / engine 20.10.12, set up back
in 2022) but not running. Started with `open -a Docker`; daemon takes
~10-60s to come up after launch — poll `docker info` until it succeeds. If a
fresh session finds `docker` not responding, run `open -a Docker` and wait
before starting Phase 0's `docker compose` steps.

## Progress

| Phase / Gate | Status | Notes |
|---|---|---|
| Bundle copied to `feat/cloud-migration`, toolchain set up | ✅ done | this commit |
| Phase 0 (baseline + golden contract) | ⏳ in progress | |
| A1 backend-consolidator | not started | |
| Gate A1 | not started | |
| A2 sqlite-migrator | not started | |
| Gate A2 | not started | |
| B1 frontend-vanilla | not started | |
| Gate B1 | not started | |
| C1 ci-deployer | not started | |
| Gate C1 | not started | |
| Phase M merge | not started | |
| Final gate | not started | |
| PR opened | not started | |

Update the table above (and commit) as each stage completes. Hand-off
reports and verifier reports land in this same directory per PLAN §8/§7.

## Branch map (once streams start)

- `feat/cloud-migration` — orchestrator branch, this repo root
- `feat/cm-backend` — backend-consolidator (A1) then sqlite-migrator (A2), worktree `wt/backend`
- `feat/cm-frontend` — frontend-vanilla (B1), worktree `wt/frontend`
- `feat/cm-ci` — ci-deployer (C1), worktree `wt/ci`

Check `git worktree list` and `git log --oneline` on each branch to see how
far a stream got before any interruption.

# Running several local agents in parallel

For several agents on one machine (Claude Code, Codex, Antigravity CLI and
so on). For cloud sessions, see `docs/cloud-agents.md`.

Agents that share a working directory overwrite each other's edits. Give
each one its own **git worktree** and its own terminal pane, and split the
work so that no two agents edit the same file.

## One worktree and one pane per agent

```bash
cd flight-tracker
git worktree add ../flight-tracker-backend  -b feat/backend-thing
git worktree add ../flight-tracker-frontend -b feat/frontend-thing

tmux new-session -s flighttracker
tmux split-window -h
# pane 1: cd ../flight-tracker-backend  && claude
# pane 2: cd ../flight-tracker-frontend && codex
```

## Split along real seams

| Area | Paths |
|---|---|
| Position sources | a new `FlightDataAgent` in `backend/src/main/java/com/flighttracker/service/agent/` |
| Persistence and history | `repository/`, `schema.sql`, `UsageService`, `PositionRetentionService` |
| Live state and push | `service/live/`, `LiveFeedBroadcaster`, `ViewportService` |
| Frontend map | `frontend/src/map/` |
| Frontend panels | `frontend/src/ui/`, plus the matching `frontend/src/components/*.css` |
| Tests | `frontend/tests/`, `blackbox-tests/` |

Every agent reads the same brief: `CLAUDE.md`, with `AGENTS.md` as a
symlink to it.

## Merging

Each worktree branch goes through a PR, the same as any other change. CI
(`build-deploy.yml`) is the gate, and merging to `main` deploys, so a human
merges. Merge one PR at a time and rebuild in between. The usual collision
is a shared type: `RawPositionReport`, `FlightPosition` (Java), or
`frontend/src/types/flight.ts`.

```bash
git worktree remove ../flight-tracker-backend
git worktree remove ../flight-tracker-frontend
```

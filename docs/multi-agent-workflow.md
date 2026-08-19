# Running Claude Code, Codex, and Antigravity CLI together

Three agents editing the same working directory at once is how you get
conflicting edits and confusing diffs. The fix is cheap: give each agent
its own **git worktree** (a second checkout of the same repo, different
folder, same history) and its own **tmux pane**, and use `AgentOrchestrator`'s
`FlightDataAgent` interface as the natural seam to split work along.

## 1. One worktree per agent

```bash
cd flight-tracker
git worktree add ../flight-tracker-claude      -b feat/backend-agents
git worktree add ../flight-tracker-codex       -b feat/frontend-map
git worktree add ../flight-tracker-antigravity -b feat/tests-and-docs
```

Each folder is a full, independent checkout — an agent running `rm -rf` or
a bad refactor in one worktree can't touch the others. Merge back to `main`
with normal PRs/`git merge` when a branch is ready.

## 2. One tmux window per agent

```bash
tmux new-session -s flighttracker
tmux split-window -h
tmux split-window -v
# pane 1
cd ../flight-tracker-claude      && claude
# pane 2
cd ../flight-tracker-codex       && codex
# pane 3
cd ../flight-tracker-antigravity && agy
```

Your 49" ultrawide is genuinely the right hardware for this — three panes
side by side with room to spare.

## 3. Split the work along real seams, not artificial ones

Don't ask two agents to edit the same file — that's where you'll get merge
conflicts and wasted work. This codebase has natural boundaries already:

| Agent | Good fit | Why |
|---|---|---|
| Claude Code | `AgentOrchestrator`, a new `FlightDataAgent` implementation, the usage-calculation logic, schema changes | Backend correctness, multi-file refactors, anything touching the persistence model |
| Codex | `IndianaJonesMap.tsx` / `.css`, new frontend views, the WebSocket client | Frontend iteration loops well with Codex's edit-review cycle |
| Antigravity CLI (`agy`) | Integration tests, the README, a second `FlightDataAgent` (e.g. an ADS-B Exchange source) to compare against OpenSky | Shares Gemini's large-context harness, and `/agents` lets it fan a task like "write tests for every FlightDataAgent" out to concurrent subagents on its own |

That table is a starting point, not a rule — the point is that each agent
owns a set of files no one else is touching that turn.

## 4. Keep them honest with a shared brief

Drop an `AGENTS.md` (Codex and Antigravity CLI both read this by
convention) and a `CLAUDE.md` (Claude Code reads this) in the repo root —
even a shared symlink of the same file works — describing:

- the schema is append-only (`flight_position` rows are never updated/deleted)
- new data sources implement `FlightDataAgent` and get registered automatically via Spring
- frontend theme tokens live at the top of `IndianaJonesMap.css` — don't hardcode colours elsewhere

This is the cheapest lever you have for keeping three separately-run agents
converging on the same architecture instead of drifting apart.

## 5. Merging

```bash
cd flight-tracker
git merge feat/backend-agents
git merge feat/frontend-map
git merge feat/tests-and-docs
git worktree remove ../flight-tracker-claude
git worktree remove ../flight-tracker-codex
git worktree remove ../flight-tracker-antigravity
```

Merge one at a time and run the build between merges — that's when you'll
catch the rare case where two agents touched the same shared type
(`RawPositionReport`, the TS `FlightPosition` interface) in incompatible ways.

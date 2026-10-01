# Running Claude Code agents off the laptop

Two ways to run agent work somewhere other than the Mac. They're billed
differently, so pick by what you're doing.

| | Cloud sessions | GitHub Actions (`@claude`) |
|---|---|---|
| Runs on | Anthropic-managed VM | GitHub-hosted runner |
| Start from | claude.ai/code, the Claude app, or a local session spawning a remote agent | `@claude` in an issue, PR comment or review |
| Billing | Cloud-session credit first, then plan usage | Plan usage (`CLAUDE_CODE_OAUTH_TOKEN`) |
| Good for | Multi-step work, orchestration, several agents in parallel | One-shot fixes and answers on a specific issue or PR |
| Output | A branch + PR | A branch + PR, or a comment |

Either way the gate is the same: `build-deploy.yml` runs on the PR, and
only a human merge to `main` deploys.

## Cloud sessions

The repo is cloned fresh into a VM. `.claude/settings.json` runs
`scripts/cloud-setup.sh` on session start; it does nothing locally and, in
the cloud (`CLAUDE_CODE_REMOTE=true`), installs whatever's missing from the
CI toolchain: JDK 21, Maven, Node (22+; CI uses 24), `npm ci`, Playwright
Chromium and the Maven dependencies. Each step is best-effort. On the
default network level NodeSource and Playwright's browser CDN are blocked,
so the script keeps the image's Node 22 and points Playwright at the
pre-installed `/opt/pw-browsers/chromium` (`PW_CHROMIUM_PATH`). After that the same commands as CI work:

```bash
(cd frontend && npm run build && npm run test:e2e)
(cd backend && mvn -B verify)
```

The blackbox suite needs the jar running locally; see the `blackbox` job in
`build-deploy.yml` for the exact steps.

Agent briefs in `.claude/agents/` and commands in `.claude/commands/` are
part of the checkout, so they work in cloud sessions too.

**Starting work from any device:** queued tasks live in `docs/agent-tasks/`.
Open claude.ai/code (or the Claude app, or Claude Code on the Linux box),
pick this repo, and say "Do `docs/agent-tasks/<file>.md`". Because the briefs
are in git, nothing depends on the machine you start from.

**Network:** the cloud environment must allow the package registries
(Maven Central, npm, NodeSource, Playwright CDN). The default "trusted"
network level covers these. Agents can't reach the production VM, and
shouldn't need to.

**Secrets:** none are needed to build or test. Never add deploy keys or
Cloudflare tokens to the cloud environment.

## Working cost-effectively

Every turn re-reads the whole conversation, including each GitHub wake-up
and scheduled check-in. Long sessions are what cost the most, not the
amount of work done in them.

**Plan with Opus, build with Sonnet.**
- **Opus:** defining plans, investigation, debugging, design, anything
  fuzzy ("why does zoom always redraw"). The output of an Opus session is
  ideally a brief in `docs/agent-tasks/` (or a PR when the fix is small).
- **Sonnet:** everything well specified. That includes executing a brief,
  merging, closing superseded PRs, small fixes, dependency bumps, CI
  fixes with a known cause, and any session one agent spawns for another.
  The model is chosen when a session starts, so pick Sonnet in the
  session picker, or pass it when spawning (`create_session` `model`).

**Rules:**
1. **One session per PR or topic, then start fresh.** `CLAUDE.md`, the
   briefs and the PR descriptions carry the context. Don't carry an old
   PR's history into new work.
2. **Briefs for anything non-trivial.** A file in `docs/agent-tasks/` with
   acceptance criteria and a `Model:` line lets a fresh Sonnet session do
   it without a long conversation.
3. **Let GitHub do the waiting.** Use GitHub auto-merge for PRs already
   approved in principle, and GitHub's failure emails for deploys.
   Subscribe a session to a PR only when you want review comments or CI
   failures fixed automatically; each wake-up costs a full turn.
4. **Reproduce CI locally first.** Run the same suites as CI before
   pushing; tests must not depend on hosts the cloud blocks (stub them, as
   `tests/scenarios/harness.ts` does). A red CI round trip costs ~7 min
   plus a wake-up.
5. **Fan out only for work that is truly independent:** separate files, no
   ordering between them. Each spawned session starts cold.

```
Idea / bug
   ├─ well-defined ─► brief (Model: sonnet) ─► fresh Sonnet session ─► PR + auto-merge
   └─ fuzzy ───────► Opus session: plan/investigate ─► brief or PR
CI red ─► GitHub email ─► reopen that session: "fix CI"
```

## GitHub Actions

`.github/workflows/claude.yml` runs `anthropics/claude-code-action@v1` when
the repo owner writes `@claude` in an issue or PR. The runner has the same
toolchain as CI, so Claude can run the tests before it pushes.

One-time setup (repo admin):

```bash
claude setup-token          # prints a long-lived OAuth token for your plan
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo petterfranzen/flight-tracker
```

…and install the Claude GitHub app on the repo (https://github.com/apps/claude),
or run `/install-github-app` in Claude Code, which does both.

## Guardrails (both)

- Work on a branch and open a PR. Never push to or merge into `main`:
  a push to `main` deploys to production.
- Each agent owns its own paths; split work so two agents never edit the
  same file.
- Hand back with what changed, what was tested and what wasn't.

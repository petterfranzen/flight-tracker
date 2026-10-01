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
CI toolchain: JDK 21, Maven, Node 24, `npm ci`, Playwright Chromium and the
Maven dependencies. After that the same commands as CI work:

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

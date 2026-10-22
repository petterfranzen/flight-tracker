# Brief: sync app secrets from GitHub to the Hetzner VM on deploy

Queued 2026-10-22. Start when the human says "do env-sync".

## Why
API keys (`SWEDAVIA_API_KEY`, `SWEDAVIA_API_KEY_SECONDARY`, `AERODATABOX_API_KEY`) live in `/etc/flight-tracker/env` on the VM. Today you add or rotate one by SSH or the Hetzner console and edit it by hand. Hetzner has no secrets store. GitHub already holds the deploy credentials, so it can hold these too, and the deploy can write them to the VM.

```mermaid
flowchart LR
    S[GitHub environment 'production' secrets] --> J[deploy job]
    J -->|"ssh flight env-sync (stdin)"| D[deploy.sh env-sync]
    D -->|"sudo, allowlisted names only"| H[/usr/local/sbin/flight-tracker-env-sync]
    H --> E[/etc/flight-tracker/env, root:flighttracker 0640/]
    J -->|then the usual| R["ssh flight deploy SHA SUM"]
```

## Scope
1. **`.github/workflows/build-deploy.yml`, `deploy` job:** before the deploy step, a step that pipes `NAME=value` lines from `secrets.*` (the `production` environment) to `ssh flight env-sync` on stdin.
   - Never put secrets on the command line: `SSH_ORIGINAL_COMMAND` and `ps` would show them.
   - Skip names whose secret is empty. Unset means "leave the current value", not "delete it".
   - The deploy step that follows restarts the app anyway, so env-sync doesn't restart it.
2. **`deploy/hetzner/deploy.sh`:** a new verb `1:env-sync)` that reads stdin and runs `sudo /usr/local/sbin/flight-tracker-env-sync`.
3. **New root-owned helper `deploy/hetzner/flight-tracker-env-sync` (0755):**
   - Reads `NAME=value` lines and accepts only names in a hard-coded allowlist (the three keys above). It rejects any other name, a newline or NUL in a value, and a value over 512 bytes, and exits non-zero without touching the file.
   - Merges the accepted names into the existing env file, keeping every other line (comments and hand-set values).
   - Writes atomically (temp file in `/etc/flight-tracker`, `chown root:flighttracker`, `chmod 0640`, `mv`). It is a no-op when nothing changed.
   - Logs which names changed, never their values, via `logger -t env-sync`.
4. **`deploy/hetzner/sudoers-deploy`:** add exactly `/usr/local/sbin/flight-tracker-env-sync` (no arguments) to the deploy user's rule.
5. **`build-cloud-init.sh`:** add the helper; regenerate `cloud-init.yaml` (CI checks drift).
6. **Docs:** `deploy/hetzner/README.md` (how to add a key: GitHub → Settings → Environments → production → secret; the existing-VM one-time install of the helper and the sudoers line) and the README's config section. Update `docs/agents/HUMAN-TODO.md`.

## Not in scope
- Deleting keys from the VM (do that by hand), arbitrary variables, `FLIGHTTRACKER_*` settings.
- Any other secret store (Vault, Infisical, systemd credentials: considered, overkill for one box).

## Constraints
- CLAUDE.md guardrails: never push to or merge into main, and never put deploy keys or Cloudflare tokens anywhere an agent runs. Agents write the code; the human adds the secrets in GitHub.
- The existing VM needs a one-time install (helper and sudoers). Until then `env-sync` fails. The deploy step must treat that as a warning, not a failed deploy, so a merge before the install still ships.

## Tests
- A shell test for the helper (under `deploy/hetzner/tests/` or a CI step, against a temp env file):
  - an allowlisted name is added, and an existing one is replaced, with other lines kept;
  - an unknown name, a newline in a value, or an oversized value is rejected and the file is untouched;
  - owner and mode are preserved;
  - a no-op leaves the mtime unchanged.
- `shellcheck` on `deploy.sh` and the helper.
- `git diff --exit-code deploy/hetzner/cloud-init.yaml` after regeneration.
- Manual, after merge: add a dummy secret, deploy, then check `journalctl -t env-sync` on the VM.

## Prerequisite
CI's SSH to the VM through Cloudflare Access must work (see HUMAN-TODO 0b). Check the first deploy after the cloudflared update.

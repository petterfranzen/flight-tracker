# To do: coverage-gap work (human)

Saved 2026-10-12, updated 2026-10-22, refreshed 2026-11-07 against `main`.

The coverage-gap PRs are all merged (#120–#126, 2026-10-22). What is left is
human work only: the VM steps, the repo settings and the live API keys.
Finished items have moved to **Done** at the end.

## 0. Security: cloudflared and Dependabot
- [ ] If you reset the root password for the console, lock it again: `passwd -l root`.
- [ ] Run the one-time block in `deploy/hetzner/README.md` → "Updates" on the VM.
      #126 is merged, so the auto-update config and the restart hook are on `main`;
      this step installs them, after which cloudflared is patched nightly. It needs
      SSH (or the console).
- [ ] Repo Settings → Code security: turn on **Dependabot alerts** and **Dependabot security updates**.
      The Dependabot config is merged in #126; only the two settings toggles are yours.

## 0b. Fix SSH from your machine (found 2026-10-22)
`ssh` to both the IP and the hostname hangs, without timing out. The one-time VM
step above needs SSH (or the console), and so does every CI deploy.

Expected, not a fault:
- **IP:** `ufw` drops port 22 once bootstrap is over. A silent hang is what a dropped port looks like.
- **Hostname `flight-ssh.pastabake.cloud` with plain `ssh`:** that name points at Cloudflare's edge, which doesn't serve SSH on port 22. The connection has to go through `cloudflared`.

Steps:
- [ ] Install `cloudflared` on your machine (`brew install cloudflared`, or Cloudflare's package for your OS).
- [ ] Add this to `~/.ssh/config`:
      ```
      Host flight-ssh.pastabake.cloud
        User petter
        ProxyCommand cloudflared access ssh --hostname %h
      ```
- [ ] Run `ssh flight-ssh.pastabake.cloud`. A browser opens for the Cloudflare Access login the first time.
- [ ] If it still hangs or fails, check from the Hetzner console:
  - `systemctl status cloudflared` and `journalctl -u cloudflared -n 50`: is the tunnel connected, with no errors since the update?
  - `systemctl status ssh` and `ss -tlnp | grep ':22'`: is sshd listening?
  - Cloudflare Zero Trust → Networks → Tunnels → this tunnel → Public hostnames: `flight-ssh.pastabake.cloud` should map to `ssh://localhost:22`.
  - Zero Trust → Access → Applications: is your email allowed on the SSH app?
- [ ] Check that CI deploys still get through: the last `deploy` job on main uses this same path (with a service token).
- [ ] Tell Claude what you find. If the config block works, it goes into `deploy/hetzner/README.md`.

## 1. Swedavia (recommended): free, 10 Swedish airports
#120–#124 are merged and deployed, so the provider is live and only waits for
the key, which is already in `/etc/flight-tracker/env` (see **Done**).
- [ ] Create an account at https://apideveloper.swedavia.se
- [ ] Subscribe to the **FlightInfo** product, free tier (10,000 calls/month), and copy the subscription key.
- [ ] Read their terms (licence, caching, attribution). They weren't published publicly.

## 2. AeroDataBox (optional): global fallback
- [ ] Subscribe to the **Basic** plan (free: 400 units/month, about 7 lookups/day) at https://rapid.aerodatabox.com
- [ ] Copy the RapidAPI key.
- [ ] Add it to `/etc/flight-tracker/env`: `AERODATABOX_API_KEY=your-key`
- [ ] `sudo systemctl restart flight-tracker`
- Note: the free plan is non-commercial only (the required credit link is already in the UI). Pro is about $8/month if the site is ever monetised.

## 3. Check it works
Both providers are still **not yet verified against the live API**: no real call
has been made, so the open items in `docs/agents/swedavia-api.md` and
`docs/agents/aerodatabox-api.md`, and the "Not yet verified against the live API"
notes in `README.md`, stand until a key exists.
- [ ] Watch the server log after the restart. A rejected key logs a "degraded" line.
- [ ] Select a plane that just landed at Arlanda and watch its status upgrade to "Landed (confirmed · Swedavia)" or "At gate … (confirmed)".
- [ ] Tell Claude the keys are live. It will:
  - check the open items against the real APIs (`docs/agents/swedavia-api.md`, `docs/agents/aerodatabox-api.md`);
  - replace the reconstructed test fixtures with real responses.

## 4. After a day live
- [ ] Check the training-data volume: `sqlite3 /var/lib/flight-tracker/flighttracker.db "SELECT COUNT(*) FROM track_end_feature"`. If it grows too fast, lower `retention-days` or `max-altitude-m`.

## Later
- [ ] Route search (e.g. London → Barcelona): the brief is ready in `docs/agent-tasks/route-search.md` on branch `wip/route-search-brief`. Say "start route search".
- [ ] Secrets from GitHub to the VM on deploy, so adding or rotating a key needs no SSH. The brief is ready in `docs/agent-tasks/env-sync.md` on branch `wip/env-sync-brief`. Say "do env-sync". It needs CI's SSH working (0b).

## Done
- [x] Patch cloudflared on the VM: done 2026-10-22 from the Hetzner web console.
- [x] Merge #126 (VM auto-updates and Dependabot config): merged 2026-10-22.
- [x] Review and merge the coverage-gap PRs: #120 (phase 1), #121 (phase 2), #122 (phase 3), #124 (Swedavia), #125 (AeroDataBox), #123 (CLAUDE.md rules) and #126 — all merged into `main` on 2026-10-22.
- [x] Add `SWEDAVIA_API_KEY` to `/etc/flight-tracker/env` on the VM (done 2026-10-22), with `SWEDAVIA_API_KEY_SECONDARY=…` if you get a second key (keys rotate every 6 months). The first deploy after #124 merged picks it up.

# To do: coverage-gap work (human)

Saved 2026-10-12, updated 2026-10-22. Tick these off as you go.

## 0. Security: patch cloudflared on the VM now (no merge needed)
- [x] Patch cloudflared: done 2026-10-22 from the Hetzner web console.
- [ ] If you reset the root password for the console, lock it again: `passwd -l root`.
- [ ] Merge #126, then run the one-time block in `deploy/hetzner/README.md` → "Updates". It installs the auto-update config, so cloudflared is patched nightly from then on.
- [ ] Repo Settings → Code security: turn on **Dependabot alerts** and **Dependabot security updates**.

## 0b. Fix SSH from your machine (found 2026-10-22)
`ssh` to both the IP and the hostname hangs, without timing out. #126's one-time step needs SSH (or the console), and so does every CI deploy.

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

## 1. Review and merge the PRs (in this order)
- [ ] #120: Phase 1, physics estimate, uncertainty cone, status UI
- [ ] #121: Phase 2, training-data capture
- [ ] #122: Phase 3, confirmation framework and mock provider
- [ ] #124: Swedavia provider
- [ ] #125: AeroDataBox provider and credit link
- [ ] #123: CLAUDE.md working rules (independent, any time)
- [ ] #126: VM auto-updates and Dependabot (independent, any time)

Each PR is stacked on the one before. GitHub retargets the next PR when you merge one.

## 2. Swedavia (recommended): free, 10 Swedish airports
Needs #120 to #124 merged and deployed first. Until then the key does nothing.
- [ ] Create an account at https://apideveloper.swedavia.se
- [ ] Subscribe to the **FlightInfo** product, free tier (10,000 calls/month), and copy the subscription key.
- [ ] Read their terms (licence, caching, attribution). They weren't published publicly.
- [ ] On the Hetzner VM, add the key to `/etc/flight-tracker/env`:
      `SWEDAVIA_API_KEY=your-key`
      (and `SWEDAVIA_API_KEY_SECONDARY=…` if you get a second key; keys rotate every 6 months)
- [ ] `sudo systemctl restart flight-tracker`

## 3. AeroDataBox (optional): global fallback
- [ ] Subscribe to the **Basic** plan (free: 400 units/month, about 7 lookups/day) at https://rapid.aerodatabox.com
- [ ] Copy the RapidAPI key.
- [ ] Add it to `/etc/flight-tracker/env`: `AERODATABOX_API_KEY=your-key`
- [ ] `sudo systemctl restart flight-tracker`
- Note: the free plan is non-commercial only (the required credit link is already in the UI). Pro is about $8/month if the site is ever monetised.

## 4. Check it works
- [ ] Watch the server log after the restart. A rejected key logs a "degraded" line.
- [ ] Select a plane that just landed at Arlanda and watch its status upgrade to "Landed (confirmed · Swedavia)" or "At gate … (confirmed)".
- [ ] Tell Claude the keys are live. It will:
  - check the open items against the real APIs (`docs/agents/swedavia-api.md`, `docs/agents/aerodatabox-api.md`);
  - replace the reconstructed test fixtures with real responses.

## 5. After a day live
- [ ] Check the training-data volume: `sqlite3 /var/lib/flight-tracker/flighttracker.db "SELECT COUNT(*) FROM track_end_feature"`. If it grows too fast, lower `retention-days` or `max-altitude-m`.

## Later
- [ ] Route search (e.g. London → Barcelona): the brief is ready in `docs/agent-tasks/route-search.md` on branch `wip/route-search-brief`. Say "start route search".

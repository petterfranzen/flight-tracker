# To do: coverage-gap work (human)

Saved 2026-10-12, updated 2026-10-22. Tick these off as you go.

## 0. Security: patch cloudflared on the VM now (no merge needed)
- [ ] SSH in, then run:
      `sudo apt-get update && sudo apt-get install --only-upgrade -y cloudflared && cloudflared --version && sudo systemctl restart cloudflared`
      (the tunnel drops for a few seconds)
- [ ] Merge #126, then run the one-time block in `deploy/hetzner/README.md` → "Updates". It installs the auto-update config, so cloudflared is patched nightly from then on.
- [ ] Repo Settings → Code security: turn on **Dependabot alerts** and **Dependabot security updates**.

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

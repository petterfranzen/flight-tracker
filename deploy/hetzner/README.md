# Operating the Hetzner box

One systemd unit, one JVM, one SQLite file. This is the day-to-day
cheat-sheet once the VM exists and CI has deployed at least once; setting up
the VM itself (Hetzner + Cloudflare Access + DNS) is Petter's hosting guide,
not this file.

Layout on the box:

```
/opt/flight-tracker/bin/deploy.sh        forced command for the deploy SSH key (root-owned, 0755)
/opt/flight-tracker/app/current.jar      symlink -> releases/<sha>.jar
/opt/flight-tracker/app/previous.jar     symlink -> releases/<sha>.jar (rollback target)
/opt/flight-tracker/app/releases/        up to 5 kept jars, oldest pruned after each successful deploy
/etc/flight-tracker/env                  OPENSKY_CLIENT_ID/SECRET (root:flighttracker, 0640)
/etc/systemd/system/flight-tracker.service
/var/lib/flight-tracker/                 StateDirectory: flighttracker.db (+ -wal/-shm)
```

All commands below assume you're SSHed in as `petter` (full sudo). The
`deploy` user has no interactive shell — its key can only ever run
`deploy.sh`, which is also how you can drive it yourself without going
through CI, by setting `SSH_ORIGINAL_COMMAND` the same way sshd would:

```bash
sudo SSH_ORIGINAL_COMMAND=status   /opt/flight-tracker/bin/deploy.sh
sudo SSH_ORIGINAL_COMMAND=rollback /opt/flight-tracker/bin/deploy.sh
```

## Logs

```bash
journalctl -u flight-tracker -f              # follow
journalctl -u flight-tracker -n 200 --no-pager
journalctl -u flight-tracker --since "1 hour ago"
```

## Restart

```bash
sudo systemctl restart flight-tracker
systemctl status flight-tracker --no-pager
```

This is exactly what `deploy.sh` itself does on a deploy — restarting by
hand doesn't change `current.jar`, it just re-launches whatever it already
points at.

## Rollback

Points `current.jar` back at `previous.jar`, restarts, and health-checks the
result (fails loudly — exit 3 — if that release is unhealthy too):

```bash
sudo SSH_ORIGINAL_COMMAND=rollback /opt/flight-tracker/bin/deploy.sh
```

This is the same `rollback` verb CI's `deploy` job would run over SSH
(`ssh flight rollback`); running it locally skips the Cloudflare Access hop
but does the exact same thing. There's only one rollback slot — `previous.jar`
— so rolling back twice in a row just flips back to what you started with.

## Status

```bash
sudo SSH_ORIGINAL_COMMAND=status /opt/flight-tracker/bin/deploy.sh
```

Prints `current`/`previous` release SHAs, the live `/api/health` response,
and (via the `deploy` user's scoped sudo) `systemctl status flight-tracker`.
Equivalent to running `curl -s 127.0.0.1:8080/api/health | jq` yourself —
the app never listens on anything but loopback, so this has to run on the
box, not from your laptop.

## SQLite shell

The app holds the DB open in WAL mode the whole time it's running; open it
`-readonly` unless you specifically mean to write:

```bash
sudo sqlite3 -readonly /var/lib/flight-tracker/flighttracker.db
sqlite> .tables
sqlite> select count(*) from flight_position;
sqlite> select count(*) from aircraft;
```

(`sudo` because the file is `flighttracker:flighttracker`-owned, mode 0750
via `StateDirectory=flight-tracker`; root can always read it.)

## Disk usage

```bash
df -h /                                          # overall
sudo du -sh /var/lib/flight-tracker              # DB + WAL/SHM
sudo du -sh /opt/flight-tracker/app/releases      # kept jars (≤5, ~50 MB each)
sudo du -ah /var/lib/flight-tracker | sort -rh | head   # biggest files in the DB dir
```

If the DB directory is growing faster than expected, retention
(`flighttracker.retention.hours`) and the nightly `PRAGMA optimize` /
post-retention `PRAGMA incremental_vacuum` are the first things to check —
see `PositionRetentionService`. `flighttracker.db-wal` staying large between
checkpoints usually just means the app is busy; `PRAGMA wal_checkpoint(TRUNCATE)`
runs automatically after every retention pass.

## Firewall / access

The box has no public inbound port: `ufw` denies everything except what
`cloudflared` tunnels in, and the app binds `127.0.0.1:8080` only (see
`flight-tracker.service`). All SSH — CI's deploy key and your own — goes
through `cloudflared access ssh` against Cloudflare Access; there is nothing
listening on a public port 22 once bootstrap is done (see the comment next
to the `ufw allow 22/tcp` rule in `cloud-init.yaml`).

# Graceful shutdown on restart

Every deploy restarts the systemd unit (`deploy/hetzner/*.service`,
`TimeoutStopSec=30`). `backend/src/main/resources/application.yml` doesn't set
`server.shutdown`, so a restart can cut off an in-flight poll, a retention
batch or an SQLite write. Since PR #70, WebSocket sends also run on virtual
threads (`LiveFeedBroadcaster`). This is the still-relevant part of closed
PR #65.

Branch: `fix/graceful-shutdown` from `origin/main`.

## Do
1. Set `server.shutdown: graceful` and `spring.lifecycle.timeout-per-shutdown-phase`
   well under 30 s (e.g. `20s`). Add a one-line comment tying it to `TimeoutStopSec`.
2. Make scheduled pollers and the retention job finish their current run on
   shutdown and not start a new one. Use
   `spring.task.scheduling.shutdown.await-termination` (+ `await-termination-period`)
   if needed.
3. Make `LiveFeedBroadcaster` close WebSocket sessions cleanly on shutdown, with
   close code 1001 (going away), so browsers reconnect right away rather than
   timing out. Check its virtual-thread executor doesn't block shutdown.
4. Add a test where practical, for example that the broadcaster closes sessions
   with 1001 when the context closes.
5. `cd backend && mvn -B verify` passes. Open a PR titled "Graceful shutdown on
   restart" that references #65. Delete this brief in the same PR.

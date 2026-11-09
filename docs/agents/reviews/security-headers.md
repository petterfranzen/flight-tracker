# Security review: HTTP response headers, WebSocket and rate-limit bypass

Independent review by Ishikawa (agent), 2026-11-07. Scope: the HTTP-layer
attack surface of the public site — response headers, the `/ws/live`
WebSocket, input validation, and the per-IP rate limiters. Reviewed commit
`2c3a284` (`origin/main`). **Review only — no production change, no scanning
of the live host, no load or fuzzing against production.**

## Answer

The app ships **no security response headers at all** — no CSP, no
`X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy`, no
`frame-ancestors`/`X-Frame-Options`. Its WebSocket accepts **any `Origin`**
(`setAllowedOrigins("*")`) and imposes **no per-IP connection cap**, so a
single page can open an unbounded number of sockets. Input validation and the
error paths are in good shape (neutral bodies, bounded request sizes, clamped
grid/limit params, no `Server`/framework fingerprint), and the rate limiters
**cannot be bypassed in the current production topology**: `TRUST_LOCAL`
defaults to `false` and Cloudflare's edge sets `CF-Connecting-IP`, which
`ClientIpResolver` prefers over the client-supplied `X-Forwarded-For` /
`X-Real-IP`. The residual rate-limit risk is a deployment footgun, not a live
hole (finding M4). Fixes for the HIGH/MEDIUM items are below as
ready-to-apply diffs.

## Update (2026-11-08): remediation status

Since this review the HIGH/MEDIUM items have been fixed and deployed. The
following are **live in production**:

- **Fix A — security headers** (#172): the filter runs on every response,
  including the `/ws/live` 101 handshake.
- **Fix B — WebSocket Origin allow-list** (#172): `setAllowedOrigins` is now an
  explicit allow-list, so the unauthenticated cross-origin socket is closed.
- **Fix C — per-IP WebSocket connection cap** (#176): the per-IP count is taken
  atomically and a slot is released on every close path, so one page cannot hold
  an unbounded number of sockets.
- **Profile data and row caps** (#175): shipped — profile writes are checked for
  size, row count, `flight_date`/`kind` shape and JSON well-formedness before
  the login API is exposed (the profile feature flag itself is still off).

#176 also addressed M4 (client-IP trust) and L8. The diffs below are kept for
the record; fix C as originally drafted leaked a slot in the close paths, so
its entry below has been corrected to the single-`release()` shape #176 shipped.

## Method

Built the frontend-bundled jar from `2c3a284` (`mvn -DskipTests package
-Pwith-frontend`) and ran it locally on `127.0.0.1:58080` with `TRUST_LOCAL`
**unset** (the production default). Headers captured with `curl -D -` and raw
sockets; the WebSocket probed with a raw handshake/frame client (so `Origin`
and frame sizes could be controlled exactly). A second instance was started
with the global restart quota raised, to isolate the per-IP limiter from the
global one. No requests were sent to the live host.

## 1. Response headers (evidence)

Every response carries only framework defaults. Nothing sets
`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `X-Frame-Options` or `Strict-Transport-Security`.

| Request | Status | Headers (verbatim, minus `Date`) |
|---|---|---|
| `GET /` | 200 | `Cache-Control: no-cache`, `Last-Modified`, `Accept-Ranges: bytes`, `Content-Type: text/html;charset=UTF-8`, `Content-Language: en-US`, `Content-Length: 1470` |
| `GET /some/route` (SPA fallback) | 200 | as `/` (`Content-Type: text/html`) |
| `GET /assets/index-*.js` | 200 | `Cache-Control: max-age=31536000, public, immutable`, `Content-Type: text/javascript`, `Last-Modified`, `Accept-Ranges`, `Content-Length` |
| `GET /api/health` | 200 | `Content-Type: application/json`, `Transfer-Encoding: chunked` |
| `GET /api/flights/live?...` | 200 | `Content-Type: application/json`, `Content-Length: 2` |
| `GET /api/aircraft/zzzzzz` (controller 404) | 404 | `Content-Length: 0` (bodyless) |
| `GET /api/usage?from=notadate&to=...` | 400 | `Cache-Control: no-store`, `Content-Type: application/json;charset=UTF-8`, `Connection: close`, body `{"error":"Bad Request"}` |
| `GET /error` | 500 | `Cache-Control: no-store`, `Content-Type: application/json;charset=UTF-8`, `Connection: close`, body `{"error":"Internal Server Error"}` |
| malformed request line / header (raw socket) | 400 | `Content-Length: 0`, `Connection: close` |
| `POST` to a GET-only path (raw) | 405 | `Allow: GET, HEAD`, `Cache-Control: no-store`, JSON `{"error":"Method Not Allowed"}` |

Notable **passes**:

- **No `Server` header and no `X-Application-Context`** on any response, HTTP
  or the WebSocket 101 handshake — no Tomcat/Spring version or app-context
  leak. `QuietErrorReportValve` + `GenericErrorController` (from #109/#156) do
  their job: error bodies are neutral, and container-level rejects are empty.
- **Cache-Control is correct per class**: `no-cache` for `index.html`, a year
  `immutable` for hashed assets, `no-store` for errors and per-visitor JSON
  (`/api/geo`). No change needed.
- No Actuator: `/actuator`, `/actuator/env`, `/env` all fall through to the SPA
  (`200 text/html`), nothing is exposed.
- `Content-Language: en-US` on `/` is a minor fingerprint (framework default)
  but harmless; not raised as a finding.

### Where HSTS belongs

**Cloudflare, not the app.** The app binds `127.0.0.1:8080` and speaks plain
HTTP over loopback; TLS terminates at Cloudflare's edge and the app never sees
an `https` request, so an app-set `Strict-Transport-Security` would be both
meaningless (the browser only sees the edge's response) and never sent on the
first hop. HSTS must be turned on in the Cloudflare zone (SSL/TLS → Edge
Certificates → HSTS, or a Transform Rule adding the header) — see brief D.

## 2. WebSocket (`/ws/live`)

`WebSocketConfig` registers `broadcaster` with `.setAllowedOrigins("*")`.

| Probe | Result |
|---|---|
| handshake `Origin: https://evil.example` | **101 Switching Protocols** (accepted) |
| handshake `Origin: null` | 101 |
| handshake `Origin: http://127.0.0.1:9999` (cross-origin, different port) | 101 |
| handshake with no `Origin` | 101 |
| handshake, `GET /ws/other` | 200 (SPA fallback, not upgraded) |
| 80 concurrent connections from one IP | **80/80 opened**, none closed by the server |
| 1 KiB / 8 KiB text frame sent | accepted (inbound is ignored — no `handleTextMessage`) |
| **8193 B** text frame | closed by server, code **1009**, "too big for the output buffer" |
| unmasked client frame | closed, protocol error (1002) |
| unknown opcode `0x3` | closed, protocol error (1002) |
| slow client (1 byte of a frame header, held 3 s) | connection stays open |

Notes:

- **Message-size limit present and sane**: exactly 8192 B inbound (Tomcat's
  default `maxTextMessageBufferSize`). Inbound messages are never read
  (`LiveFeedBroadcaster` extends `TextWebSocketHandler` without overriding
  `handleTextMessage`), so there is no unbounded inbound path. Outbound
  buffering is already bounded per session (1 MiB `DROP`, 10 s send limit).
- **No per-IP connection cap** (80/80). Combined with M2 (any origin), one
  page/script can open sockets without limit.
- **No origin enforcement** (M2): a browser page on any site can open the feed
  and read live aircraft. The feed data is public, so this is
  confidentiality-light, but it is a cross-origin, unauthenticated socket with
  no per-origin or per-IP bound.

## 3. Input validation and rate limiting

Validation probes (local jar):

| Request | Status | Comment |
|---|---|---|
| `/api/flights/live` absurd bbox (±999999) | 200 | bbox only filters the in-memory live set; no unbounded work |
| `/api/flights/live?latMin=abc` | 400 | Spring type conversion |
| `/api/flights/live/clusters?gridDeg=-99999` | 200 | clamped to `[0.5, 40]` in `FlightController` |
| `/api/flights/live/overview?limit=999999999&perCell=999999` | 200 | clamped to `[0,2000]` / `[1,20]` |
| `/api/flights/search?q=` 8 000 chars | 200 | in-memory substring match (no SQL LIKE, no escaping needed) |
| `/api/flights/search?q=` 16 000+ chars | 400 | Tomcat rejects the oversized request line |
| `/api/aircraft/<100 000-char path>` | 400 | Tomcat rejects the oversized URI |
| 20 KB request header | 400 | Tomcat rejects the oversized header |
| `/api/usage?from=1970…&to=2999…` | 200 | window is bounded by the 72 h retention |
| `/api/usage?from=2026-01-01` (date, not Instant) | 400 | |
| `/api/schedule/search?date=notadate` | 503 | `available()` (no API key) short-circuits before date parsing — 400 would be more accurate, cosmetic |

No 500s, no injection, no unbounded work found. There are **no explicit
bounds** on `lat/lon` (`/api/flights/live`) or on `code` (`/api/airports/info`)
or on `q` length, but each is harmless in practice (they only narrow/shorten an
in-memory result set, and Tomcat caps the request line at ~8 KB). Low priority.

### `TRUST_LOCAL` defaults to false — confirmed

- `application.yml`: `trust-local: ${TRUST_LOCAL:false}`.
- `deploy/hetzner/flight-tracker.service`: `Environment=TRUST_LOCAL=false`.
- `deploy/hetzner/cloud-init.yaml`: `Environment=TRUST_LOCAL=false`.
- Live, with `TRUST_LOCAL` unset: `POST /api/agents/restart` from `127.0.0.1`
  gave `200, 200, 200, 429, 429` — the loopback caller is **not** exempt, i.e.
  the local exemption is off. (`AgentController` computes
  `local = trustLocal && isLocal(ip)`.)

### `X-Forwarded-For` — trusted by the app, not exploitable behind Cloudflare

`ClientIpResolver.resolve()` returns the first non-blank of
`CF-Connecting-IP` → `X-Real-IP` → `X-Forwarded-For` → `remoteAddr`, and the
rate limiters key on that. A second local instance with the *global* restart
quota raised isolates the per-IP limiter:

- Fixed spoof `X-Forwarded-For: 203.0.113.9`, four calls → `200, 200, 200, 429`
  (the per-IP limiter fires on the 4th, as for a real client).
- **Rotating** `X-Forwarded-For: 203.0.113.1..6`, six calls → `200 ×6` (every
  request seen as a new client, the per-IP limiter never fires).

So the app **does** trust client-supplied `X-Forwarded-For` when
`CF-Connecting-IP` is absent. In production this is **not** a live bypass:
every request arrives through `cloudflared`, and Cloudflare's edge sets
`CF-Connecting-IP` to the real visitor IP on every proxied request, which the
resolver prefers — so a visitor cannot choose their own limiter key. It
becomes a bypass only if the app is ever reachable without Cloudflare, or
behind another proxy that forwards `X-Real-IP`/`X-Forwarded-For` without
setting `CF-Connecting-IP`. Two code smells worth fixing regardless:
`X-Forwarded-For` is read as the **leftmost** (client-controlled) value — the
wrong end for a proxy-appended chain — and the trust decision is hard-coded
rather than gated on a "behind a trusted proxy" flag. See brief E.

Also note the global backstops (`PollWindowService` restart quota 3/15 min,
`hot-poll-daily-call-budget` 3000/day) bound total OpenSky usage even if a
per-IP limit were dodged — so the worst case of the XFF trust is bounded.

---

## Findings

### HIGH

**H1 — No security headers on any response.** No CSP, no
`X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy`, no
`frame-ancestors`/`X-Frame-Options`. The app serves an SPA and JSON with no
defence-in-depth headers: nothing mitigates an injected-script XSS, nothing
stops MIME sniffing, and the site can be framed (clickjacking). Evidence: the
header table in §1. Fix: **diff A**.

### MEDIUM

**M2 — WebSocket accepts any `Origin`.** `WebSocketConfig` uses
`setAllowedOrigins("*")`; a handshake from `https://evil.example` (and `null`,
and a different port) returns 101. Any page can open `/ws/live` and read the
live feed. Impact is bounded by the data being public, but it is a
cross-origin, unauthenticated socket. Fix: **diff B**.

**M3 — No per-IP connection cap on `/ws/live`.** 80 concurrent connections
from one IP were all accepted and held. A single page or script can open
sockets without limit (each with a 1 MiB outbound buffer). Fix: **diff C**.

**M4 — Rate-limit identity trusts client-supplied proxy headers.** The
resolver falls back to `X-Real-IP`/`X-Forwarded-For` and reads XFF's
client-controlled leftmost value. Not exploitable behind Cloudflare today
(§3), but a deployment footgun if the tunnel is ever bypassed or another proxy
is introduced. Fix: **brief E**.

**M5 — HSTS is not set anywhere.** Not an app-layer defect (see §1), but it
must be turned on at Cloudflare or the site is downgradeable. Fix: **brief D**.

### LOW

**L6 — No explicit bounds on `lat/lon`, `q`/`code` length.** Harmless today
(§3): the values only narrow in-memory result sets and Tomcat caps the request
line. Worth a `@Validated`/`@Min`/`@Max` pass if these ever feed SQL or
arithmetic.

**L7 — Unknown `/api/*` paths return the SPA (`200 text/html`)**, not 404, so
a typo'd API path is indistinguishable from the app shell. Cosmetic; by
design (the SPA fallback), noted only for completeness.

**L8 — `RestartRateLimiter`/`HotPollUserBudget` IP-key maps are never
pruned.** A long-lived process with many distinct spoofed IPs grows the map
unboundedly. Only reachable if M4's header trust is abused; fine at this scale.

---

## Ready-to-apply fixes

### Diff A — security headers (HIGH, H1) — **shipped in #172, live in production**

New file `backend/src/main/java/com/flighttracker/config/SecurityHeadersFilter.java`:

```java
package com.flighttracker.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Defence-in-depth response headers, added to every response (SPA, JSON and
 * the WebSocket 101 handshake alike — all pass through the servlet chain).
 *
 * <p>HSTS is deliberately absent: the app speaks plain HTTP on loopback and
 * TLS terminates at Cloudflare, so the header must be set at the edge (see
 * docs/agents/reviews/security-headers.md, brief D).
 *
 * <p>The CSP ships as {@code Content-Security-Policy-Report-Only} first: the
 * MapLibre basemap loads vector tiles and glyphs from
 * {@code tiles.openfreemap.org} and the app injects inline styles, so the
 * policy must be observed against the real app (and the Playwright suites)
 * before it is enforced. Promote the header name once a clean report-only run
 * is confirmed.
 */
@Component
public class SecurityHeadersFilter extends OncePerRequestFilter {

    private static final String CSP = String.join("; ",
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://tiles.openfreemap.org",
            "connect-src 'self' https://tiles.openfreemap.org",
            "worker-src 'self' blob:",
            "manifest-src 'self'",
            "font-src 'self'");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        response.setHeader("Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
        // Enforces clickjacking protection now, independent of the report-only CSP below.
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Content-Security-Policy-Report-Only", CSP);
        chain.doFilter(request, response);
    }
}
```

CSP rationale: `script-src 'self'` (the production `index.html` has no inline
scripts — only module `<script src>` tags); `style-src` needs
`'unsafe-inline'` because MapLibre writes element styles at runtime;
`img-src`/`connect-src` allow `https://tiles.openfreemap.org` (the basemap's
vector tiles and glyphs, per `frontend/src/cyberpunkMapStyle.ts`);
`worker-src 'self' blob:` covers the bundled MapLibre worker and the service
worker. If you would rather not carry `'unsafe-inline'` for styles, that is a
separate, larger frontend change (nonce/hash the styles) — out of scope here.

### Diff B — WebSocket origin enforcement (MEDIUM, M2) — **shipped in #172, live in production**

`setAllowedOrigins(...)` is enough and needs no custom interceptor: Spring's
`OriginHandshakeInterceptor` allows a handshake whose `Origin` matches the
allow-list **or is absent** (`WebUtils.isSameOrigin` returns `true` for a null
`Origin`), and rejects any other origin with 403. So the blackbox suite — which
connects with Node's global `WebSocket` and sends no `Origin` — keeps working
unchanged, while a browser on any other site is rejected. **Verified locally**
against a build with this change (see the note under the table below).

`WebSocketConfig`:

```java
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final LiveFeedBroadcaster broadcaster;
    private final String[] allowedOrigins;

    public WebSocketConfig(LiveFeedBroadcaster broadcaster,
                           @Value("${flighttracker.ws.allowed-origins}") String allowedOrigins) {
        this.broadcaster = broadcaster;
        this.allowedOrigins = Arrays.stream(allowedOrigins.split(","))
                .map(String::trim).filter(s -> !s.isEmpty()).toArray(String[]::new);
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // Browsers always send Origin; any origin not listed here is rejected
        // with 403 (a request with no Origin is allowed — non-browser clients).
        registry.addHandler(broadcaster, "/ws/live").setAllowedOrigins(allowedOrigins);
    }
}
```

Add `@Value` / `Arrays` imports. `application.yml` (under `flighttracker:`):

```yaml
  ws:
    # Origins allowed to open /ws/live. The public site plus the local dev
    # origins (the browser sends Origin even for a localhost page, so those
    # must be listed or local dev gets a 403).
    allowed-origins: ${FLIGHTTRACKER_WS_ALLOWED_ORIGINS:https://flight.pastabake.cloud,http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173}
```

Verified against a local build with `setAllowedOrigins("https://flight.pastabake.cloud")`:

| Handshake `Origin` | Result |
|---|---|
| *(absent)* | 101 (allowed — blackbox suite unaffected) |
| `https://flight.pastabake.cloud` | 101 |
| `https://evil.example` | **403** |
| `null` | **403** |
| `http://127.0.0.1:8080` | 403 (so the dev origins above are needed for local dev) |

### Diff C — per-IP WebSocket connection cap (MEDIUM, M3) — **shipped in #176, live in production**

> **Corrected 2026-11-09 (second-reviewer must-fix).** As first drafted this
> diff leaked a slot: it decremented the per-IP counter in
> `afterConnectionClosed` **only when `sessions.remove(id) != null`**, but
> `closeQuietly()` removes the session before `close()` — so a slow-client
> eviction (`SessionLimitExceededException`) and a send-failure eviction never
> decremented, and each such socket held one of the 8 slots for the life of the
> process. The version below decrements in **exactly one place**: a single
> idempotent `release(session)` that every close path calls, and only the caller
> whose `sessions.remove(id)` finds the entry gives the slot back — so it can
> never double-count or go negative. This is the shape #176 shipped.

In `backend/src/main/java/com/flighttracker/service/LiveFeedBroadcaster.java`.
The patch below is against the review's baseline `2c3a284`; `git apply --check`
is clean there and the result compiles and is exercised by the test beneath it.

```diff
diff --git a/backend/src/main/java/com/flighttracker/service/LiveFeedBroadcaster.java b/backend/src/main/java/com/flighttracker/service/LiveFeedBroadcaster.java
index f7421e5..fe3b40e 100644
--- a/backend/src/main/java/com/flighttracker/service/LiveFeedBroadcaster.java
+++ b/backend/src/main/java/com/flighttracker/service/LiveFeedBroadcaster.java
@@ -25,6 +25,7 @@ import org.springframework.web.socket.handler.SessionLimitExceededException;
 import org.springframework.web.socket.handler.TextWebSocketHandler;
 
 import java.io.IOException;
+import java.net.InetSocketAddress;
 import java.util.ArrayList;
 import java.util.List;
 import java.util.Map;
@@ -92,8 +93,23 @@ public class LiveFeedBroadcaster extends TextWebSocketHandler implements SmartLi
     // behind a stalled client's blocked write, so it can't be open-ended.
     static final long CLOSE_TIMEOUT_MS = 2_000;
 
-    // Decorated sessions, keyed by the raw session's id.
-    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
+    // Cap concurrent live-feed sockets per client IP so one page (or one
+    // script) cannot open an unbounded number of them. Cloudflare's edge sets
+    // CF-Connecting-IP on the upgrade request too; behind cloudflared the raw
+    // remote address is loopback for every visitor, so the header is the only
+    // per-client signal — same reasoning as ClientIpResolver.
+    static final int MAX_CONNECTIONS_PER_IP = 8;
+
+    // A registered session and the client IP it was counted under.
+    private record Registered(WebSocketSession session, String ip) { }
+
+    // Registered sessions, keyed by the raw session's id. Whoever removes an
+    // entry (release) is the one that gives its slot back, so each session is
+    // counted out exactly once however many close paths fire.
+    private final Map<String, Registered> sessions = new ConcurrentHashMap<>();
+    // Open sessions per client IP, never above MAX_CONNECTIONS_PER_IP. Entries
+    // are removed at zero, so the map only holds IPs with a live socket.
+    private final Map<String, Integer> connectionCountByIp = new ConcurrentHashMap<>();
     private final ExecutorService sendExecutor = Executors.newVirtualThreadPerTaskExecutor();
     private final ViewportService viewportService;
     private volatile boolean running;
@@ -117,14 +133,79 @@ public class LiveFeedBroadcaster extends TextWebSocketHandler implements SmartLi
             closeQuietly(session, CloseStatus.GOING_AWAY);
             return;
         }
-        sessions.put(session.getId(), new ConcurrentWebSocketSessionDecorator(
+        String ip = clientIp(session);
+        if (!acquire(ip)) {
+            // Not registered — there is no slot to release on its close.
+            closeQuietly(session, CloseStatus.SERVICE_OVERLOAD); // 1013, "try again later"
+            return;
+        }
+        sessions.put(session.getId(), new Registered(new ConcurrentWebSocketSessionDecorator(
                 session, SEND_TIME_LIMIT_MS, BUFFER_SIZE_LIMIT_BYTES,
-                ConcurrentWebSocketSessionDecorator.OverflowStrategy.DROP));
+                ConcurrentWebSocketSessionDecorator.OverflowStrategy.DROP), ip));
+        // A client that hung up between the slot being taken and the entry
+        // being stored has already had its close callback find nothing to
+        // release; give the slot back here instead of leaking it.
+        if (!session.isOpen()) {
+            release(session);
+        }
     }
 
     @Override
     public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
-        sessions.remove(session.getId());
+        release(session);
+    }
+
+    @Override
+    public void handleTransportError(WebSocketSession session, Throwable exception) {
+        // The container normally follows with afterConnectionClosed, but a slot
+        // must not depend on that; release() is idempotent.
+        release(session);
+    }
+
+    /** Takes a slot for ip, or refuses when it already holds MAX_CONNECTIONS_PER_IP. */
+    private boolean acquire(String ip) {
+        boolean[] taken = {false};
+        connectionCountByIp.compute(ip, (k, n) -> {
+            int open = n == null ? 0 : n;
+            if (open >= MAX_CONNECTIONS_PER_IP) return n;
+            taken[0] = true;
+            return open + 1;
+        });
+        return taken[0];
+    }
+
+    /**
+     * Forgets the session and gives its IP slot back — exactly once. Only the
+     * caller whose remove() finds the entry decrements, so afterConnectionClosed,
+     * a transport error, closeQuietly (slow-client / send-failure eviction) and
+     * stop() can all call this for the same session. A session that was never
+     * registered (refused over the cap, or turned away while stopping) holds no
+     * slot and is a no-op.
+     */
+    private void release(WebSocketSession session) {
+        Registered removed = sessions.remove(session.getId());
+        if (removed != null) {
+            connectionCountByIp.computeIfPresent(removed.ip(), (k, n) -> n <= 1 ? null : n - 1);
+        }
+    }
+
+    /** Open sessions counted against ip (for tests and diagnostics). */
+    int connectionsFor(String ip) {
+        return connectionCountByIp.getOrDefault(ip, 0);
+    }
+
+    /** Number of IPs holding a slot; 0 when nothing is connected (for tests). */
+    int trackedIps() {
+        return connectionCountByIp.size();
+    }
+
+    private static String clientIp(WebSocketSession session) {
+        String cf = session.getHandshakeHeaders().getFirst("CF-Connecting-IP");
+        if (cf != null && !cf.isBlank()) {
+            return cf.trim();
+        }
+        InetSocketAddress remote = session.getRemoteAddress();
+        return remote == null ? "unknown" : remote.getAddress().getHostAddress();
     }
 
     /**
@@ -152,7 +233,7 @@ public class LiveFeedBroadcaster extends TextWebSocketHandler implements SmartLi
             }
         }
         if (messages.isEmpty()) return;
-        sessions.values().forEach(s -> sendExecutor.execute(() -> sendAll(s, messages)));
+        sessions.values().forEach(r -> sendExecutor.execute(() -> sendAll(r.session(), messages)));
     }
 
     // Cloudflare Tunnel's own idle-close window (~100s) is what this
@@ -172,7 +253,7 @@ public class LiveFeedBroadcaster extends TextWebSocketHandler implements SmartLi
     void sendKeepalive() {
         if (sessions.isEmpty()) return;
         List<WebSocketMessage<?>> ping = List.of(new PingMessage());
-        sessions.values().forEach(s -> sendExecutor.execute(() -> sendAll(s, ping)));
+        sessions.values().forEach(r -> sendExecutor.execute(() -> sendAll(r.session(), ping)));
     }
 
     /**
@@ -198,7 +279,7 @@ public class LiveFeedBroadcaster extends TextWebSocketHandler implements SmartLi
     }
 
     private void closeQuietly(WebSocketSession session, CloseStatus status) {
-        sessions.remove(session.getId());
+        release(session);
         try {
             session.close(status);
         } catch (IOException | RuntimeException ignored) {
@@ -230,8 +311,7 @@ public class LiveFeedBroadcaster extends TextWebSocketHandler implements SmartLi
     public void stop() {
         stopping = true;
         running = false;
-        List<WebSocketSession> open = new ArrayList<>(sessions.values());
-        sessions.clear();
+        List<WebSocketSession> open = sessions.values().stream().map(Registered::session).toList();
         if (open.isEmpty()) return;
         CompletableFuture<?>[] closes = open.stream()
                 .map(s -> CompletableFuture.runAsync(() -> closeQuietly(s, CloseStatus.GOING_AWAY), sendExecutor))
```

Notes: `acquire(ip)` takes a slot atomically with `compute` (never above the
cap, also under concurrent connects); a socket refused over the cap is closed
1013 **before** it is registered, so its own close callback has nothing to
release; `clientIp(session)` prefers the handshake's `CF-Connecting-IP` and
falls back to the remote address (`java.net.InetSocketAddress` import added).
`connectionsFor(ip)` / `trackedIps()` are package-private hooks for the test.
`8` is a suggestion — the frontend opens one socket per tab.

**Verified locally (2026-11-09)** against the real `LiveFeedBroadcaster` — a
new `PerIpCapReleaseTest` (5 tests, run with
`mvn -o test -Dtest=PerIpCapReleaseTest`) drives every close path, including a
`sendMessage` that throws exactly what the decorated session throws in
production:

| Path exercised | Counter after |
|---|---|
| normal close (`afterConnectionClosed`) | 0 |
| slow client — `sendMessage` throws `SessionLimitExceededException`, then evicted by `closeQuietly` | 0, and a following close callback leaves it 0 (idempotent) |
| send failure — `sendMessage` throws `IOException` | 0 |
| shutdown — `stop()` with 3 sockets across 2 IPs | 0 |
| over cap — 9th connect refused 1013 | stays 8; the refused socket's own close callback frees nothing |

To prove the test bites, `closeQuietly()` was reverted to the original
`sessions.remove(id)` (no decrement): the same file then runs **3/5 red** — slow
client, send failure and shutdown all leave the counter at 1 — and **5/5 green**
with the diff above.

### Brief D — HSTS at Cloudflare (MEDIUM, M5)

The app cannot set HSTS (plain HTTP on loopback; see §1). Enable it in the
Cloudflare zone for `pastabake.cloud`:

- SSL/TLS → Edge Certificates → **HTTP Strict Transport Security**: enable,
  `max-age` 31536000, `includeSubDomains` on. **Do not** enable `preload`
  unless you intend to commit the domain to the preload list (hard to undo).
- Or, if you want it scoped to this host only, a Transform Rule (Modify
  Response Header → Add `Strict-Transport-Security`) on the hostname.

Verify from outside: `curl -sI https://flight.pastabake.cloud/ | grep -i
strict-transport`.

### Brief E — trust proxy headers only behind a trusted proxy (MEDIUM, M4)

In production the current behaviour is safe (Cloudflare sets
`CF-Connecting-IP`, which wins). To remove the footgun:

1. Gate the `X-Real-IP` / `X-Forwarded-For` fallbacks on an explicit
   "behind a trusted proxy" flag (default off), leaving only `remoteAddr`
   when the app is not behind a proxy. Cloudflare-fronted deployments keep
   trusting `CF-Connecting-IP`.
2. When a fallback is used, take the **right-most** `X-Forwarded-For` entry
   (the one the last trusted hop appended), not the left-most
   client-controlled one, or switch to Spring's
   `server.forward-headers-strategy` / `ForwardedHeaderFilter`, which apply
   the standard rules.

This is a small, self-contained change in `ClientIpResolver.resolve()` plus a
config flag; no behaviour change in the current deployment.

## Uncertain

- **Cloudflare HSTS state**: I could not check the live zone (no prod access);
  brief D assumes it is off, consistent with the app setting no headers. Verify
  in the dashboard.
- **Cloudflare overwriting `CF-Connecting-IP` on WebSocket upgrades**: assumed
  (it does so on proxied HTTP); not verifiable from a local jar. Diff C falls
  back to the remote address if the header is absent, so it degrades safely.
- **CSP completeness**: the report-only policy is built from the origins the
  frontend actually uses (`tiles.openfreemap.org`, self, blob/data). It must be
  observed against the running app and the Playwright suites before enforcement
  — it is intentionally shipped report-only.
- The local jar was built from `2c3a284` with the frontend rebuilt from the
  same tree; behaviour is expected identical to production, but the production
  build's `git.sha`/profile wiring was not exercised.

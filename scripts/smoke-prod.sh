#!/usr/bin/env bash
# Post-deploy smoke test for the flight-tracker production deployment.
#
# Run it after a deploy (and as part of the daily check-in) to prove the box is
# actually serving: the running version, the two live-traffic endpoints, the
# WebSocket feed, and the front page. Read-only and fast — every request is a
# GET, nothing is restarted, nothing is written, and a healthy run finishes in
# well under 90 seconds.
#
#   scripts/smoke-prod.sh                          # daily check-in
#   scripts/smoke-prod.sh <sha>                    # after a deploy: expect that SHA
#   scripts/smoke-prod.sh --url http://127.0.0.1:8080 --timeout 20
#
# Exit codes: 0 every check passed · 1 one or more checks failed (one line each)
#             · 2 bad usage. The full contract is in docs/smoke-test.md.
#
# Environment overrides (all optional):
#   SMOKE_BASE_URL / BASE_URL      base URL (default the production host)
#   SMOKE_EXPECTED_SHA / GITHUB_SHA  the SHA the deploy shipped
#   SMOKE_BBOX=latMin,latMax,lonMin,lonMax   box the map opens on (default Stockholm)
#   SMOKE_WS_TIMEOUT               seconds to wait for a WebSocket frame (default 30)
#   SMOKE_HTTP_TIMEOUT             per-request timeout in seconds (default 15)
#   SMOKE_PAGE_SETTLE_MS           extra wait after page load (default 7000)
#   SMOKE_MIN_ACTIVE/MAX_ACTIVE    plausible range for the overview's active count
#   SMOKE_MIN_LIVE/MAX_LIVE        plausible range for /live's row count
#   SMOKE_CSP_REPORT_ONLY          true while the CSP roll-back is on: expect
#                                  Content-Security-Policy-Report-Only (default false)
#   SMOKE_WS_ORIGIN                Origin to present on /ws/live (default: the
#                                  origin of the base URL, i.e. the public site)
#   SMOKE_WS_BAD_ORIGIN            Origin that must be refused (default
#                                  https://evil.example)
#   PW_CHROMIUM_PATH               Chromium to drive (default: Playwright's own)
#   NODE_PATH / SMOKE_NODE_PATH    where to find the playwright module
set -uo pipefail

PROG="smoke-prod"
DEFAULT_BASE="https://flight.pastabake.cloud"

BASE="${SMOKE_BASE_URL:-${BASE_URL:-$DEFAULT_BASE}}"
EXPECTED_SHA="${SMOKE_EXPECTED_SHA:-${EXPECTED_SHA:-${GITHUB_SHA:-}}}"
HTTP_TIMEOUT="${SMOKE_HTTP_TIMEOUT:-10}"
WS_TIMEOUT="${SMOKE_WS_TIMEOUT:-30}"
PAGE_SETTLE_MS="${SMOKE_PAGE_SETTLE_MS:-7000}"
# latMin,latMax,lonMin,lonMax — the Baltic/Stockholm box the app itself falls
# back to (ViewportService.DEFAULT), so live traffic there is a fair sample.
BBOX="${SMOKE_BBOX:-54,66,10,25}"
MIN_ACTIVE="${SMOKE_MIN_ACTIVE:-1}"
MAX_ACTIVE="${SMOKE_MAX_ACTIVE:-20000}"
MIN_LIVE="${SMOKE_MIN_LIVE:-1}"
MAX_LIVE="${SMOKE_MAX_LIVE:-100000}"
# The CSP roll-back (FLIGHTTRACKER_CSP_REPORT_ONLY on the box) moves the policy
# from the enforcing header to the report-only one. The script cannot see the
# server's environment, so the operator says which state to expect.
CSP_REPORT_ONLY="${SMOKE_CSP_REPORT_ONLY:-false}"

usage() {
  cat <<EOF
Usage: $PROG [--url URL] [--sha SHA] [--timeout SECONDS] [<sha>]

Checks a running flight-tracker deployment: /api/health's version, the
security headers, the live overview and /live for the Stockholm box, a
WebSocket LiveFrame opened with the public site's Origin, a foreign Origin
refused with 403, and the front page in Playwright. Read-only; exit 1 lists
one line per failed check.
EOF
}

while (( $# )); do
  case "$1" in
    --url)      BASE="${2:-}"; shift 2 ;;
    --url=*)    BASE="${1#*=}"; shift ;;
    --sha)      EXPECTED_SHA="${2:-}"; shift 2 ;;
    --sha=*)    EXPECTED_SHA="${1#*=}"; shift ;;
    --timeout)  WS_TIMEOUT="${2:-}"; shift 2 ;;
    --timeout=*) WS_TIMEOUT="${1#*=}"; shift ;;
    -h|--help)  usage; exit 0 ;;
    -*)         printf '%s: unknown option %s\n' "$PROG" "$1" >&2; usage >&2; exit 2 ;;
    *)          if [[ -n "$EXPECTED_SHA" ]]; then
                  printf '%s: unexpected extra argument %s\n' "$PROG" "$1" >&2; usage >&2; exit 2
                fi
                EXPECTED_SHA="$1"; shift ;;
  esac
done

BASE="${BASE%/}"
# scheme://host[:port] of the base URL — what a browser on the site sends as
# Origin, and what the box must have on flighttracker.ws.allowed-origins.
origin_of() {
  local url="${1#*://}" scheme="${1%%://*}"
  printf '%s://%s' "$scheme" "${url%%/*}"
}
WS_ORIGIN="${SMOKE_WS_ORIGIN:-$(origin_of "$BASE")}"
WS_BAD_ORIGIN="${SMOKE_WS_BAD_ORIGIN:-https://evil.example}"
if [[ -z "$BASE" ]]; then
  printf '%s: empty --url\n' "$PROG" >&2; exit 2
fi
if [[ -n "$EXPECTED_SHA" && ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s: expected SHA must be 40 lowercase hex chars, got %s\n' "$PROG" "$EXPECTED_SHA" >&2
  exit 2
fi

IFS=',' read -r LAT_MIN LAT_MAX LON_MIN LON_MAX <<<"$BBOX"
for v in "$LAT_MIN" "$LAT_MAX" "$LON_MIN" "$LON_MAX"; do
  if [[ ! "$v" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    printf '%s: SMOKE_BBOX must be latMin,latMax,lonMin,lonMax — got "%s"\n' "$PROG" "$BBOX" >&2
    exit 2
  fi
done
BBOX_QS="latMin=$LAT_MIN&latMax=$LAT_MAX&lonMin=$LON_MIN&lonMax=$LON_MAX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/smoke-prod.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
ok()   { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# ---- small helpers ---------------------------------------------------------

# fetch URL OUTFILE -> prints the HTTP status ("000" if the request never
# completed), leaving stderr in OUTFILE.err for the caller to quote.
fetch() {
  local url="$1" out="$2" code
  code="$(curl -sS --max-time "$HTTP_TIMEOUT" -o "$out" -w '%{http_code}' "$url" 2>"$out.err")" || true
  printf '%s' "${code:-000}"
}

# Run a command under a wall-clock limit when coreutils' timeout is available.
run_limited() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

# print_header FILE NAME -> value of the last response's NAME header, matched
# case-insensitively and exactly (so Content-Security-Policy never matches
# Content-Security-Policy-Report-Only). Prints nothing when absent.
print_header() {
  awk -v want="$(printf '%s' "$2" | tr 'A-Z' 'a-z')" '
    {
      line = $0; sub(/\r$/, "", line)
      i = index(line, ":")
      if (i == 0) next
      name = substr(line, 1, i - 1); sub(/[ \t]+$/, "", name)
      if (tolower(name) != want) next
      v = substr(line, i + 1); sub(/^[ \t]+/, "", v)
      found = v
    }
    END { if (found != "") print found }
  ' "$1"
}

# One line of curl's own error, for a request that never got an answer.
curl_hint() {
  [[ -s "$1" ]] && printf ' (%s)' "$(tail -1 "$1")"
  return 0
}

resolve_node_path() {
  local dirs=() d joined=""
  [[ -n "${SMOKE_NODE_PATH:-}" ]] && dirs+=("$SMOKE_NODE_PATH")
  dirs+=("$ROOT/frontend/node_modules" "$ROOT/node_modules")
  if [[ -n "${NODE_PATH:-}" ]]; then IFS=':' read -r -a extra <<<"$NODE_PATH"; dirs+=("${extra[@]}"); fi
  if command -v npm >/dev/null 2>&1; then dirs+=("$(npm root -g 2>/dev/null)"); fi
  dirs+=("/usr/local/lib/node_modules")
  for d in "${dirs[@]}"; do
    [[ -n "$d" && -d "$d" ]] || continue
    joined="${joined:+$joined:}$d"
  done
  printf '%s' "$joined"
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [[ -n "$NODE_BIN" ]]; then
  NODE_PATH_RESOLVED="$(resolve_node_path)"
  [[ -n "$NODE_PATH_RESOLVED" ]] && export NODE_PATH="$NODE_PATH_RESOLVED"
fi

HELPER="$WORK/checks.cjs"
cat > "$HELPER" <<'JS'
#!/usr/bin/env node
// Helper for scripts/smoke-prod.sh — the two checks that need a real browser
// and a real WebSocket client (Node 22+ has both). Prints one JSON object on
// stdout; the shell script decides what counts as a failure, so this exits
// non-zero only for a crash it could not report any other way.
"use strict";

const [mode, ...rest] = process.argv.slice(2);
const firstLine = (s) => String(s).split("\n")[0].slice(0, 300);

async function pageCheck(baseUrl, settleMs) {
  const fs = require("fs");
  const { chromium } = require("playwright");
  const opts = { args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  const exec = process.env.PW_CHROMIUM_PATH;
  if (exec && fs.existsSync(exec)) opts.executablePath = exec;
  const browser = await chromium.launch(opts);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(firstLine(m.text())); });
    page.on("pageerror", (e) => errors.push("uncaught: " + firstLine(e.message)));
    const resp = await page.goto(baseUrl + "/", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(settleMs);
    return {
      mode: "page",
      status: resp ? resp.status() : 0,
      title: await page.title(),
      canvas: await page.locator("canvas").count(),
      errors,
    };
  } finally {
    await browser.close();
  }
}

// A raw WebSocket handshake, so the request carries the Origin header a
// browser sends. Node's global WebSocket cannot set headers, and the header is
// the whole point of this check: behind Cloudflare the app sees plain HTTP, so
// the public https origin is only accepted because it is on the allow-list.
function upgradeRequest(baseUrl, origin) {
  const crypto = require("crypto");
  const u = new URL(baseUrl);
  const lib = u.protocol === "https:" ? require("https") : require("http");
  const key = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: "/ws/live",
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
          Origin: origin,
        },
      },
      (res) => {
        // Not an upgrade: Spring's Origin interceptor answers 403 here.
        res.resume();
        resolve({ status: res.statusCode, socket: null });
      },
    );
    req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

// Split incoming bytes into WebSocket frames and hand back each text payload.
// Server frames are unmasked, so no unmasking is needed; fragmented frames are
// reassembled only far enough to find the first complete text frame.
function frameReader(onText) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (opcode === 0x1) onText(payload.toString("utf8"));
    }
  };
}

async function wsOriginCheck(baseUrl, origin, badOrigin, bboxQuery, timeoutMs) {
  // The server filters its broadcast by the last reported viewport, and the
  // front page (checked just before) opens the poll window the feed rides on.
  const report = () => fetch(`${baseUrl}/api/flights/live?${bboxQuery}`).catch(() => {});
  await report();
  const started = Date.now();
  let good;
  try {
    const conn = await upgradeRequest(baseUrl, origin);
    if (conn.status !== 101 || !conn.socket) {
      good = { status: conn.status, ok: false, error: `handshake answered ${conn.status}, expected 101` };
    } else {
      good = await new Promise((resolve) => {
        let settled = false;
        const finish = (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(reporter);
          try { conn.socket.destroy(); } catch { /* already gone */ }
          resolve(r);
        };
        const timer = setTimeout(
          () => finish({ status: 101, ok: false, ms: Date.now() - started, error: `no LiveFrame within ${timeoutMs}ms` }),
          timeoutMs,
        );
        const reporter = setInterval(report, 5000);
        const feed = frameReader((text) => finish({ status: 101, ok: true, ms: Date.now() - started, frame: text }));
        if (conn.head && conn.head.length) feed(conn.head);
        conn.socket.on("data", feed);
        conn.socket.on("error", (e) => finish({ status: 101, ok: false, ms: Date.now() - started, error: "socket error: " + firstLine((e && e.message) || e) }));
        conn.socket.on("close", () => finish({ status: 101, ok: false, ms: Date.now() - started, error: "socket closed before a frame" }));
      });
    }
  } catch (e) {
    good = { status: 0, ok: false, error: "handshake failed: " + firstLine((e && e.message) || e) };
  }

  // A foreign Origin must be refused outright, and refused with 403 — a 101
  // here means the allow-list is not being applied at all.
  let bad;
  try {
    const conn = await upgradeRequest(baseUrl, badOrigin);
    try { if (conn.socket) conn.socket.destroy(); } catch { /* already gone */ }
    bad = { status: conn.status };
  } catch (e) {
    bad = { status: 0, error: "handshake failed: " + firstLine((e && e.message) || e) };
  }

  return { mode: "wsorigin", origin, badOrigin, good, bad };
}

(async () => {
  try {
    let result;
    if (mode === "page") result = await pageCheck(rest[0], Number(rest[1] || 7000));
    else if (mode === "wsorigin") result = await wsOriginCheck(rest[0], rest[1], rest[2], rest[3], Number(rest[4] || 30000));
    else result = { mode, error: "unknown helper mode" };
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ mode, error: "helper failed: " + firstLine((e && e.message) || e) }));
    process.exit(0);
  }
})();
JS

# ---- checks ----------------------------------------------------------------

check_health() {
  local before=$FAILURES body="$WORK/health.json" code status db version
  code="$(fetch "$BASE/api/health" "$body")"
  if [[ "$code" != 200 ]]; then
    fail "health: GET /api/health answered $code$(curl_hint "$body.err")"
    return
  fi
  if ! jq -e . "$body" >/dev/null 2>&1; then
    fail "health: response is not JSON"
    return
  fi
  status="$(jq -r '.status // empty' "$body")"
  db="$(jq -r '.db // empty' "$body")"
  version="$(jq -r '.version // empty' "$body")"
  [[ "$status" == "UP" ]] || fail "health: status is '${status:-missing}', expected UP"
  [[ "$db" == "UP" ]] || fail "health: database is '${db:-missing}', expected UP"
  if [[ -n "$EXPECTED_SHA" ]]; then
    [[ "$version" == "$EXPECTED_SHA" ]] || fail "health: version '$version' is not the deployed SHA '$EXPECTED_SHA'"
  elif [[ ! "$version" =~ ^[0-9a-f]{40}$ ]]; then
    fail "health: version '$version' is not a 40-char git SHA (production should report the deployed commit, not 'dev')"
  fi
  if (( FAILURES == before )); then ok "health: status=UP db=UP version=$version"; fi
}

check_overview() {
  local before=$FAILURES body="$WORK/overview.json" code planes clusters active bad
  code="$(fetch "$BASE/api/flights/live/overview?$BBOX_QS" "$body")"
  if [[ "$code" != 200 ]]; then
    fail "overview: GET /api/flights/live/overview answered $code$(curl_hint "$body.err")"
    return
  fi
  if ! jq -e '(.planes | type == "array") and (.clusters | type == "array")' "$body" >/dev/null 2>&1; then
    fail "overview: response is not JSON with planes/clusters arrays"
    return
  fi
  planes="$(jq '.planes | length' "$body")"
  clusters="$(jq '.clusters | length' "$body")"
  active="$(jq '(.planes | length) + ([.clusters[].count] | add // 0)' "$body")"
  bad="$(jq '[.planes[] | select((.latitude | type) != "number" or (.longitude | type) != "number" or .latitude < -90 or .latitude > 90 or .longitude < -180 or .longitude > 180)] | length' "$body")"
  (( bad == 0 )) || fail "overview: $bad plane(s) carry an out-of-range or non-numeric position"
  (( active >= MIN_ACTIVE )) || fail "overview: active count $active for $BBOX_QS is below $MIN_ACTIVE — no live traffic in the box"
  (( active <= MAX_ACTIVE )) || fail "overview: active count $active for $BBOX_QS is above $MAX_ACTIVE — implausible"
  if (( FAILURES == before )); then ok "overview: planes=$planes clusters=$clusters active=$active ($BBOX_QS)"; fi
}

check_live() {
  local before=$FAILURES body="$WORK/live.json" code rows bad
  code="$(fetch "$BASE/api/flights/live?$BBOX_QS" "$body")"
  if [[ "$code" != 200 ]]; then
    fail "live: GET /api/flights/live answered $code$(curl_hint "$body.err")"
    return
  fi
  if ! jq -e 'type == "array"' "$body" >/dev/null 2>&1; then
    fail "live: response is not a JSON array"
    return
  fi
  rows="$(jq 'length' "$body")"
  bad="$(jq '[.[] | select((.latitude | type) != "number" or (.longitude | type) != "number" or .latitude < -90 or .latitude > 90 or .longitude < -180 or .longitude > 180)] | length' "$body")"
  (( bad == 0 )) || fail "live: $bad row(s) carry an out-of-range or non-numeric position"
  (( rows >= MIN_LIVE )) || fail "live: $rows row(s) for $BBOX_QS is below $MIN_LIVE — the live set is empty"
  (( rows <= MAX_LIVE )) || fail "live: $rows row(s) for $BBOX_QS is above $MAX_LIVE — implausible"
  if (( FAILURES == before )); then ok "live: rows=$rows ($BBOX_QS)"; fi
}

check_page() {
  local before=$FAILURES out="$WORK/page.json" status title canvas nerr
  if [[ -z "$NODE_BIN" ]]; then
    fail "front page: cannot run Playwright (node not found on PATH)"
    return
  fi
  if ! run_limited 60 "$NODE_BIN" "$HELPER" page "$BASE" "$PAGE_SETTLE_MS" >"$out" 2>"$out.err"; then
    fail "front page: Playwright run failed: $(tail -1 "$out.err" 2>/dev/null)"
    return
  fi
  if ! jq -e . "$out" >/dev/null 2>&1; then
    fail "front page: Playwright helper produced no result"
    return
  fi
  if [[ -n "$(jq -r '.error // empty' "$out")" ]]; then
    fail "front page: $(jq -r '.error' "$out")"
    return
  fi
  status="$(jq -r '.status // 0' "$out")"
  title="$(jq -r '.title // ""' "$out")"
  canvas="$(jq -r '.canvas // 0' "$out")"
  nerr="$(jq -r '.errors | length' "$out")"
  (( status < 400 )) || fail "front page: HTTP $status"
  (( canvas >= 1 )) || fail "front page: no map canvas rendered"
  (( nerr == 0 )) || fail "front page: $nerr console error(s), first: $(jq -r '.errors[0]' "$out")"
  if (( FAILURES == before )); then ok "front page: HTTP $status title='$title' canvas=$canvas console errors=$nerr"; fi
}

check_headers() {
  local before=$FAILURES url label out code name value
  local csp_name="Content-Security-Policy"
  [[ "$CSP_REPORT_ONLY" == "true" ]] && csp_name="Content-Security-Policy-Report-Only"

  for url in "$BASE/" "$BASE/api/health"; do
    label="${url#"$BASE"}"; label="${label:-/}"
    out="$WORK/hdr$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '_').txt"
    before=$FAILURES
    code="$(curl -sS --max-time "$HTTP_TIMEOUT" -o /dev/null -D "$out" -w '%{http_code}' "$url" 2>"$out.err")" || true
    if [[ "${code:-000}" == "000" ]]; then
      fail "headers: GET $label never answered$(curl_hint "$out.err")"
      continue
    fi
    for name in "$csp_name" X-Content-Type-Options Referrer-Policy Permissions-Policy; do
      value="$(print_header "$out" "$name")"
      if [[ -z "$value" ]]; then
        fail "headers: $label (HTTP $code) is missing $name"
      fi
    done
    if [[ "$CSP_REPORT_ONLY" == "true" && -n "$(print_header "$out" 'Content-Security-Policy')" ]]; then
      fail "headers: $label carries an enforcing Content-Security-Policy while SMOKE_CSP_REPORT_ONLY=true — the roll-back is in the wrong state"
    fi
    if (( FAILURES == before )); then
      ok "headers: $label has $csp_name, X-Content-Type-Options, Referrer-Policy, Permissions-Policy"
    fi
  done
}

check_ws_origin() {
  local before=$FAILURES out="$WORK/ws-origin.json" status bad_status ms frame why
  local status_json active remaining
  if [[ -z "$NODE_BIN" ]]; then
    fail "websocket: cannot run the Origin handshake checks (node not found on PATH)"
    return
  fi
  if ! run_limited $((WS_TIMEOUT + 20)) "$NODE_BIN" "$HELPER" wsorigin \
        "$BASE" "$WS_ORIGIN" "$WS_BAD_ORIGIN" "$BBOX_QS" "$((WS_TIMEOUT * 1000))" >"$out" 2>"$out.err"; then
    fail "websocket: Origin handshake check failed to run: $(tail -1 "$out.err" 2>/dev/null)"
    return
  fi
  if ! jq -e . "$out" >/dev/null 2>&1; then
    fail "websocket: Origin handshake check produced no result"
    return
  fi
  if [[ -n "$(jq -r '.error // empty' "$out" 2>/dev/null)" ]]; then
    fail "websocket: $(jq -r '.error' "$out")"
    return
  fi

  # 1. The public site's own Origin: 101 and a first LiveFrame.
  status="$(jq -r '.good.status // 0' "$out")"
  before=$FAILURES
  if [[ "$status" != "101" ]]; then
    fail "websocket: handshake with Origin $WS_ORIGIN answered $status, expected 101 ($(jq -r '.good.error // "no detail"' "$out")) — is $WS_ORIGIN on FLIGHTTRACKER_WS_ALLOWED_ORIGINS?"
  elif [[ "$(jq -r '.good.ok // false' "$out")" != "true" ]]; then
    why="$(jq -r '.good.error // "no LiveFrame received"' "$out")"
    # Frames are only pushed while the backend's hot poll runs, and that window
    # is opened by the front page (the check just above) unless the shared
    # restart quota is already spent — quote its state so a closed window reads
    # as itself rather than as a dead deployment.
    status_json="$(curl -sS --max-time "$HTTP_TIMEOUT" "$BASE/api/agents/status" 2>/dev/null || true)"
    status_json="${status_json:-{}}"
    active="$(printf '%s' "$status_json" | jq -r '.active // "unknown"' 2>/dev/null)" || active="unknown"
    remaining="$(printf '%s' "$status_json" | jq -r '.secondsRemaining // "unknown"' 2>/dev/null)" || remaining="unknown"
    fail "websocket: Origin $WS_ORIGIN opened the socket but $why (poll window active=$active, secondsRemaining=$remaining — frames are only pushed while hot polling runs, which opening the map starts)"
  else
    ms="$(jq -r '.good.ms // 0' "$out")"
    frame="$(jq -r '.good.frame' "$out")"
    if ! printf '%s' "$frame" | jq -e '
          (.icao24 | type == "string") and (.icao24 | length > 0)
          and (.observedAt | type == "string")
          and (.latitude | type == "number") and (.latitude >= -90) and (.latitude <= 90)
          and (.longitude | type == "number") and (.longitude >= -180) and (.longitude <= 180)
          and (.onGround | type == "boolean")' >/dev/null 2>&1; then
      fail "websocket: first frame with Origin $WS_ORIGIN is not a LiveFrame: ${frame:0:200}"
    fi
  fi
  if (( FAILURES == before )); then
    ok "websocket: 101 with Origin $WS_ORIGIN, LiveFrame after ${ms}ms: ${frame:0:200}"
  fi

  # 2. A foreign Origin: refused with 403 (a 101 means the allow-list is off).
  bad_status="$(jq -r '.bad.status // 0' "$out")"
  if [[ "$bad_status" != "403" ]]; then
    fail "websocket: handshake with Origin $WS_BAD_ORIGIN answered $bad_status, expected 403 — the Origin allow-list is not rejecting a foreign site"
  else
    ok "websocket: 403 for Origin $WS_BAD_ORIGIN"
  fi
}

printf '%s: %s (expected sha: %s)\n' "$PROG" "$BASE" "${EXPECTED_SHA:-any}"
started_at=$SECONDS
check_health
check_headers
check_overview
check_live
# The front page goes first of the last two on purpose: loading it is what opens
# the backend's poll window, and the WebSocket feed has nothing to push without it.
check_page
check_ws_origin
elapsed=$((SECONDS - started_at))

if (( FAILURES == 0 )); then
  printf '%s: PASS — %s healthy in %ds\n' "$PROG" "$BASE" "$elapsed"
  exit 0
fi
printf '%s: FAIL — %d check(s) failed in %ds\n' "$PROG" "$FAILURES" "$elapsed"
exit 1

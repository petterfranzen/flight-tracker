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

usage() {
  cat <<EOF
Usage: $PROG [--url URL] [--sha SHA] [--timeout SECONDS] [<sha>]

Checks a running flight-tracker deployment: /api/health's version, the live
overview and /live for the Stockholm box, a WebSocket LiveFrame, and the
front page in Playwright. Read-only; exit 1 lists one line per failed check.
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

async function wsCheck(baseUrl, bboxQuery, timeoutMs) {
  // Report the box first: the server filters its broadcast by the last
  // reported viewport, and a map nobody has open reports nothing. Loading the
  // front page (the check just before this one) is what opens the poll window
  // the feed rides on.
  const report = () => fetch(`${baseUrl}/api/flights/live?${bboxQuery}`).catch(() => {});
  await report();
  const started = Date.now();
  return await new Promise((resolve) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/ws/live");
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(reporter);
      try { ws.close(); } catch { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(
      () => done({ mode: "ws", ok: false, ms: Date.now() - started, error: `no LiveFrame within ${timeoutMs}ms` }),
      timeoutMs,
    );
    // Any other visitor's map overwrites the single shared viewport, so keep
    // re-reporting ours for as long as we wait.
    const reporter = setInterval(report, 5000);
    ws.addEventListener("error", (e) => {
      const msg = firstLine((e && e.message) || "") || "connection failed";
      done({ mode: "ws", ok: false, ms: Date.now() - started, error: "websocket error: " + msg });
    });
    ws.addEventListener("close", (e) => done({ mode: "ws", ok: false, ms: Date.now() - started, error: `websocket closed (${e.code}) before a frame` }));
    ws.addEventListener("message", (ev) => done({ mode: "ws", ok: true, ms: Date.now() - started, frame: String(ev.data) }));
  });
}

(async () => {
  try {
    let result;
    if (mode === "page") result = await pageCheck(rest[0], Number(rest[1] || 7000));
    else if (mode === "ws") result = await wsCheck(rest[0], rest[1], Number(rest[2] || 30000));
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

check_websocket() {
  local before=$FAILURES out="$WORK/ws.json" frame ms why status_json active remaining
  if [[ -z "$NODE_BIN" ]]; then
    fail "websocket: cannot run the WebSocket check (node not found on PATH)"
    return
  fi
  if ! run_limited $((WS_TIMEOUT + 20)) "$NODE_BIN" "$HELPER" ws "$BASE" "$BBOX_QS" "$((WS_TIMEOUT * 1000))" >"$out" 2>"$out.err"; then
    fail "websocket: check failed to run: $(tail -1 "$out.err" 2>/dev/null)"
    return
  fi
  if [[ "$(jq -r '.ok // false' "$out" 2>/dev/null)" != "true" ]]; then
    why="$(jq -r '.error // "no LiveFrame received"' "$out" 2>/dev/null)"
    # The feed only pushes while the backend's hot poll is running, and that
    # window is opened by the front page (the check just above) unless the
    # shared restart quota is already spent — quote its state so a closed
    # window reads as itself rather than as a dead deployment.
    status_json="$(curl -sS --max-time "$HTTP_TIMEOUT" "$BASE/api/agents/status" 2>/dev/null || true)"
    status_json="${status_json:-{}}"
    active="$(printf '%s' "$status_json" | jq -r '.active // "unknown"' 2>/dev/null)" || active="unknown"
    remaining="$(printf '%s' "$status_json" | jq -r '.secondsRemaining // "unknown"' 2>/dev/null)" || remaining="unknown"
    fail "websocket: $why (poll window active=$active, secondsRemaining=$remaining — frames are only pushed while hot polling runs, which opening the map starts)"
    return
  fi
  ms="$(jq -r '.ms // 0' "$out")"
  frame="$(jq -r '.frame' "$out")"
  if ! printf '%s' "$frame" | jq -e '
        (.icao24 | type == "string") and (.icao24 | length > 0)
        and (.observedAt | type == "string")
        and (.latitude | type == "number") and (.latitude >= -90) and (.latitude <= 90)
        and (.longitude | type == "number") and (.longitude >= -180) and (.longitude <= 180)
        and (.onGround | type == "boolean")' >/dev/null 2>&1; then
    fail "websocket: frame is not a LiveFrame: ${frame:0:200}"
    return
  fi
  if (( FAILURES == before )); then ok "websocket: LiveFrame after ${ms}ms: ${frame:0:200}"; fi
}

printf '%s: %s (expected sha: %s)\n' "$PROG" "$BASE" "${EXPECTED_SHA:-any}"
started_at=$SECONDS
check_health
check_overview
check_live
# The front page goes first of the last two on purpose: loading it is what opens
# the backend's poll window, and the WebSocket feed has nothing to push without it.
check_page
check_websocket
elapsed=$((SECONDS - started_at))

if (( FAILURES == 0 )); then
  printf '%s: PASS — %s healthy in %ds\n' "$PROG" "$BASE" "$elapsed"
  exit 0
fi
printf '%s: FAIL — %d check(s) failed in %ds\n' "$PROG" "$FAILURES" "$elapsed"
exit 1

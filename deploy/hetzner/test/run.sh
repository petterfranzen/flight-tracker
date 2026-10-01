#!/usr/bin/env bash
# Exercises deploy.sh without systemd: a fake "restart" starts a tiny HTTP
# server that reports the version of whatever current.jar points at, unless the
# jar's content contains UNHEALTHY. Run: deploy/hetzner/test/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"; trap 'kill "$(cat "$work/pid" 2>/dev/null)" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir -p "$work/app/releases"
port=18080

cat > "$work/restart" <<R
#!/usr/bin/env bash
kill "\$(cat "$work/pid" 2>/dev/null)" 2>/dev/null || true
sleep 0.3
jar="\$(readlink -f "$work/app/current.jar")"
grep -q UNHEALTHY "\$jar" && exit 0
ver="\$(basename "\$jar" .jar)"
python3 -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b=json.dumps({'status':'UP','version':'\$ver'}).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1',$port),H).serve_forever()" &
echo \$! > "$work/pid"
R
chmod +x "$work/restart"

export FT_APP_DIR="$work/app" FT_HEALTH_URL="http://127.0.0.1:$port/api/health" \
       FT_HEALTH_TIMEOUT_S=6 FT_MAX_JAR_BYTES=1000 FT_RESTART_CMD="$work/restart"
d() { SSH_ORIGINAL_COMMAND="$1" "$here/../deploy.sh"; }
sha() { printf '%040x' "$1"; }
jar() { printf 'jar %s %s\n' "$1" "${2:-}" > "$work/$1.jar"; sha256sum "$work/$1.jar" | cut -d' ' -f1; }
pass=0; fail=0
check() { local name="$1" want="$2"; shift 2; set +e; "$@" >"$work/out" 2>&1; local got=$?; set -e
  if [[ "$got" == "$want" ]]; then pass=$((pass+1)); echo "ok   $name"; else fail=$((fail+1)); echo "FAIL $name (exit $got, want $want)"; cat "$work/out"; fi; }

A=$(sha 1); B=$(sha 2); C=$(sha 3)
sa=$(jar "$A"); sb=$(jar "$B"); sc=$(jar "$C" UNHEALTHY)

check "usage: empty command"        64 d ""
check "usage: injection attempt"    64 d "deploy $A $sa; rm -rf /"
check "usage: bad sha"              64 d "deploy nothex $sa"
check "first deploy"                0  bash -c "SSH_ORIGINAL_COMMAND='deploy $A $sa' '$here/../deploy.sh' < '$work/$A.jar'"
check "checksum mismatch rejected"  1  bash -c "SSH_ORIGINAL_COMMAND='deploy $B $sa' '$here/../deploy.sh' < '$work/$B.jar'"
check "second deploy"               0  bash -c "SSH_ORIGINAL_COMMAND='deploy $B $sb' '$here/../deploy.sh' < '$work/$B.jar'"
check "unhealthy deploy rolls back" 2  bash -c "SSH_ORIGINAL_COMMAND='deploy $C $sc' '$here/../deploy.sh' < '$work/$C.jar'"
check "current is B after rollback" 0  test "$(basename "$(readlink -f "$work/app/current.jar")" .jar)" = "$B"
head -c 2000 /dev/zero > "$work/big.jar"; sbig=$(sha256sum "$work/big.jar" | cut -d' ' -f1)
check "oversize jar rejected"       1  bash -c "SSH_ORIGINAL_COMMAND='deploy $(sha 4) $sbig' '$here/../deploy.sh' < '$work/big.jar'"
check "rollback verb"               0  d "rollback"
check "current is A after rollback" 0  test "$(basename "$(readlink -f "$work/app/current.jar")" .jar)" = "$A"
check "status verb"                 0  d "status"
check "no temp files left"          0  test -z "$(find "$work/app/releases" -name '.incoming.*')"

# --- release pruning (deploy.sh keeps KEEP_RELEASES=5 on disk) ---
# A, B, C are already on disk from above. Pin their mtimes first so pruning
# order is deterministic regardless of how fast the checks above actually
# ran (same-second mtimes would otherwise make "oldest" a coin flip).
touch -t 202601010000.00 "$work/app/releases/$A.jar"
touch -t 202601010000.01 "$work/app/releases/$B.jar"
touch -t 202601010000.02 "$work/app/releases/$C.jar"
D=$(sha 5); E=$(sha 6); F=$(sha 7)
sd=$(jar "$D"); se=$(jar "$E"); sf=$(jar "$F")
check "third deploy"  0 bash -c "SSH_ORIGINAL_COMMAND='deploy $D $sd' '$here/../deploy.sh' < '$work/$D.jar'"
touch -t 202601010000.03 "$work/app/releases/$D.jar"
check "fourth deploy" 0 bash -c "SSH_ORIGINAL_COMMAND='deploy $E $se' '$here/../deploy.sh' < '$work/$E.jar'"
touch -t 202601010000.04 "$work/app/releases/$E.jar"
# F is the 6th release ever written (A..F); its successful deploy's
# prune_releases should evict exactly the oldest one not linked by
# current/previous — A — and leave the other 5.
check "fifth deploy (6th release on disk, prunes the oldest)" 0 \
  bash -c "SSH_ORIGINAL_COMMAND='deploy $F $sf' '$here/../deploy.sh' < '$work/$F.jar'"
check "oldest release (A) pruned"   1 test -e "$work/app/releases/$A.jar"
check "5 releases remain on disk"   0 test "$(find "$work/app/releases" -maxdepth 1 -name '*.jar' | wc -l | tr -d ' ')" = 5
check "current is F after prune"    0 test "$(basename "$(readlink -f "$work/app/current.jar")" .jar)" = "$F"
check "previous (E) not pruned"     0 test -e "$work/app/releases/$E.jar"

echo "$pass passed, $fail failed"; (( fail == 0 ))

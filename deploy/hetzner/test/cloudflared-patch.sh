#!/usr/bin/env bash
# Drives cloudflared-patch.sh against a stub apt (PATH-prepended fake
# dpkg-query/apt-cache/apt-get) and a throwaway state dir, so it runs anywhere.
# Regression guard for the superseded-candidate wedge found in review: a stamp
# whose version apt no longer offers must not kill the script under `set -e` —
# the new candidate is re-stamped and held for its own 24 h. Also checks that
# --dry-run leaves no trace. Run: deploy/hetzner/test/cloudflared-patch.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../cloudflared-patch.sh"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

bindir="$work/bin"; mkdir -p "$bindir"
cat > "$bindir/dpkg-query" <<'R'
#!/usr/bin/env bash
printf '%s' "${STUB_INSTALLED:-}"
R
cat > "$bindir/apt-cache" <<'R'
#!/usr/bin/env bash
printf '  Candidate: %s\n' "${STUB_CANDIDATE:-}"
R
cat > "$bindir/apt-get" <<R
#!/usr/bin/env bash
echo "\$@" >> "$work/apt-get.calls"
exit 0
R
chmod +x "$bindir"/*
export PATH="$bindir:$PATH"

pass=0; fail=0; out=""; STATE=""
run() { # run <want-rc> <label> -- args...
  local want="$1" label="$2"; shift 2
  set +e; out="$("$script" "$@" 2>&1)"; local rc=$?; set -e
  if [ "$rc" = "$want" ]; then pass=$((pass+1)); echo "ok   $label"
  else fail=$((fail+1)); echo "FAIL $label (exit $rc, want $want)"; printf '%s\n' "$out" | sed 's/^/     /'; fi
}
has()  { case "$out" in *"$2"*) pass=$((pass+1)); echo "ok   $1" ;;
                       *) fail=$((fail+1)); echo "FAIL $1 (missing \"$2\"): $out" ;; esac; }
stamp()  { mkdir -p "$STATE"; printf '%s %s\n' "$1" "$2" > "$STATE/cloudflared-candidate"; }
use_state() { STATE="$1"; export FT_CLOUDFLARED_STATE_DIR="$1"; }
now() { date +%s; }

export STUB_INSTALLED=1.0 STUB_CANDIDATE=2.0

# --- the review's case: a superseded candidate (stamp 1.5, apt now offers 2.0) ---
use_state "$work/state"
stamp 1.5 "$(( $(now) - 90000 ))"        # aged 25 h, and no longer the candidate

run 0 "--status survives a superseded stamp" --status
has "--status names the new candidate" "candidate 2.0"
has "--status calls it not yet seen" "not yet seen"

run 0 "normal run re-stamps the superseded candidate"
has "re-stamp prints the hold" "2.0 is new; holding it for 24 h"
if [ "$(cut -d' ' -f1 "$STATE/cloudflared-candidate")" = 2.0 ]; then pass=$((pass+1)); echo "ok   stamp now records 2.0"
else fail=$((fail+1)); echo "FAIL stamp still: $(cat "$STATE/cloudflared-candidate")"; fi
if [ ! -e "$work/apt-get.calls" ]; then pass=$((pass+1)); echo "ok   re-stamp ran no apt-get"
else fail=$((fail+1)); echo "FAIL apt-get ran during the hold: $(cat "$work/apt-get.calls")"; fi

run 0 "the freshly re-stamped 2.0 is then held"
has "held for the full window" "holding 2.0; 24 h to go"

# --- --dry-run changes nothing ---
use_state "$work/dry"
run 0 "--dry-run on a brand-new candidate reports the hold" --dry-run
has "--dry-run prints the hold" "2.0 is new; holding it for 24 h"
if [ ! -e "$work/dry" ]; then pass=$((pass+1)); echo "ok   --dry-run created no state dir"
else fail=$((fail+1)); echo "FAIL --dry-run created $work/dry"; fi

use_state "$work/state"
stamp 2.0 "$(( $(now) - 90000 ))"
rm -f "$work/apt-get.calls"
run 0 "--dry-run past the window says would upgrade" --dry-run
has "--dry-run says would upgrade" "would upgrade 1.0 -> 2.0"
if [ "$(cut -d' ' -f1 "$STATE/cloudflared-candidate")" = 2.0 ]; then pass=$((pass+1)); echo "ok   --dry-run kept the stamp"
else fail=$((fail+1)); echo "FAIL --dry-run changed the stamp"; fi
if [ ! -e "$work/apt-get.calls" ]; then pass=$((pass+1)); echo "ok   --dry-run ran no apt-get"
else fail=$((fail+1)); echo "FAIL --dry-run ran apt-get"; fi

echo "$pass passed, $fail failed"; (( fail == 0 ))

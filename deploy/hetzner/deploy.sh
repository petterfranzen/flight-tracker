#!/usr/bin/env bash
# Forced command for the CI deploy key (see authorized_keys in cloud-init.yaml).
# The deploy key can run nothing but this script, and SSH_ORIGINAL_COMMAND is
# treated as hostile input.
#
#   ssh flight "deploy <40-char git sha> <sha256 of jar>" < flight-tracker.jar
#   ssh flight "rollback"
#   ssh flight "status"
#
# Exit codes: 0 ok · 1 error · 2 new release unhealthy, rolled back ·
#             3 rollback target unhealthy too (site is down, investigate) · 64 usage
set -euo pipefail
umask 022

# FT_* overrides exist only for deploy/hetzner/test/run.sh. They are safe in
# production because sshd does not pass client-supplied environment variables
# (no PermitUserEnvironment, and AcceptEnv only covers LANG/LC_*).
APP_DIR="${FT_APP_DIR:-/opt/flight-tracker/app}"
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current.jar"
PREVIOUS="$APP_DIR/previous.jar"
SERVICE=flight-tracker
HEALTH_URL="${FT_HEALTH_URL:-http://127.0.0.1:8080/api/health}"
HEALTH_TIMEOUT_S="${FT_HEALTH_TIMEOUT_S:-90}"
MAX_JAR_BYTES="${FT_MAX_JAR_BYTES:-$((200 * 1024 * 1024))}"
KEEP_RELEASES=5

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $1" >&2; exit "${2:-1}"; }
usage() { die "usage: deploy <git-sha> <sha256> | rollback | status" 64; }

restart_service() {
  if [[ -n "${FT_RESTART_CMD:-}" ]]; then "$FT_RESTART_CMD"; else sudo -n /usr/bin/systemctl restart "$SERVICE"; fi
}

sha_of_link() { basename "$(readlink -f "$1")" .jar; }

# Waits until /api/health reports status UP and the expected version.
wait_healthy() {
  local want="$1" deadline=$((SECONDS + HEALTH_TIMEOUT_S)) body
  while (( SECONDS < deadline )); do
    if body=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null) &&
       jq -e --arg v "$want" '.status == "UP" and .version == $v' >/dev/null <<<"$body"; then
      log "healthy: $body"
      return 0
    fi
    sleep 3
  done
  log "not healthy after ${HEALTH_TIMEOUT_S}s (last response: ${body:-none})"
  return 1
}

# Atomically points $1 (a symlink path) at $2.
relink() {
  local link="$1" target="$2" tmp
  tmp="$(dirname "$link")/.$(basename "$link").tmp"
  ln -sfn "$target" "$tmp"
  mv -Tf "$tmp" "$link"
}

prune_releases() {
  local keep_current keep_previous f
  keep_current="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  keep_previous="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
  # Newest first; skip the newest KEEP_RELEASES and anything still linked.
  while IFS= read -r f; do
    [[ "$f" == "$keep_current" || "$f" == "$keep_previous" ]] && continue
    rm -f -- "$f" && log "pruned $(basename "$f")"
  done < <(find "$RELEASES" -maxdepth 1 -name '*.jar' -printf '%T@ %p\n' \
             | sort -rn | tail -n +$((KEEP_RELEASES + 1)) | cut -d' ' -f2-)
}

cmd_deploy() {
  local sha="$1" sum="$2" tmp size prev="" old_previous=""
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "git sha must be 40 lowercase hex chars" 64
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || die "sha256 must be 64 lowercase hex chars" 64

  tmp="$(mktemp "$RELEASES/.incoming.XXXXXX")"
  trap 'rm -f -- "$tmp"' EXIT

  # Read at most MAX+1 bytes so an oversized upload is detected, not truncated.
  head -c $((MAX_JAR_BYTES + 1)) > "$tmp"
  size=$(stat -c %s "$tmp")
  (( size > 0 )) || die "no jar received on stdin"
  (( size <= MAX_JAR_BYTES )) || die "jar exceeds ${MAX_JAR_BYTES} bytes"
  printf '%s  %s\n' "$sum" "$tmp" | sha256sum -c --quiet - || die "checksum mismatch"

  mv -f -- "$tmp" "$RELEASES/$sha.jar"
  trap - EXIT
  chmod 0644 "$RELEASES/$sha.jar"
  log "received $sha ($size bytes), checksum ok"

  if [[ -L "$CURRENT" ]]; then
    prev="$(readlink -f "$CURRENT")"
  fi
  if [[ -L "$PREVIOUS" ]]; then
    old_previous="$(readlink -f "$PREVIOUS")"
  fi
  if [[ -n "$prev" && "$prev" != "$RELEASES/$sha.jar" ]]; then
    relink "$PREVIOUS" "$prev"
  fi
  relink "$CURRENT" "$RELEASES/$sha.jar"

  log "restarting $SERVICE on $sha"
  restart_service
  if wait_healthy "$sha"; then
    prune_releases
    log "deployed $sha"
    return 0
  fi

  if [[ -z "$prev" || "$prev" == "$RELEASES/$sha.jar" ]]; then
    die "release $sha unhealthy and there is no previous release to roll back to" 3
  fi
  log "rolling back to $(basename "$prev" .jar)"
  relink "$CURRENT" "$prev"
  # Put "previous" back too, so a later `rollback` doesn't target the release
  # that is running right now.
  if [[ -n "$old_previous" ]]; then relink "$PREVIOUS" "$old_previous"; else rm -f -- "$PREVIOUS"; fi
  restart_service
  wait_healthy "$(basename "$prev" .jar)" || die "rollback target is unhealthy too" 3
  die "release $sha was unhealthy; rolled back to $(basename "$prev" .jar)" 2
}

cmd_rollback() {
  [[ -L "$PREVIOUS" ]] || die "no previous release recorded"
  local cur prev
  cur="$(readlink -f "$CURRENT")"
  prev="$(readlink -f "$PREVIOUS")"
  relink "$CURRENT" "$prev"
  relink "$PREVIOUS" "$cur"
  restart_service
  wait_healthy "$(sha_of_link "$CURRENT")" || die "rolled-back release is unhealthy" 3
  log "rolled back to $(sha_of_link "$CURRENT")"
}

cmd_status() {
  local link label
  for label in current previous; do
    link="$APP_DIR/$label.jar"
    if [[ -L "$link" ]]; then log "$label: $(sha_of_link "$link")"; else log "$label: none"; fi
  done
  curl -fsS --max-time 3 "$HEALTH_URL" || log "health endpoint not answering"
  echo
}

main() {
  local -a args=()
  read -r -a args <<< "${SSH_ORIGINAL_COMMAND:-}" || true
  case "${#args[@]}:${args[0]:-}" in
    3:deploy)   cmd_deploy "${args[1]}" "${args[2]}" ;;
    1:rollback) cmd_rollback ;;
    1:status)   cmd_status ;;
    *)          usage ;;
  esac
}

main

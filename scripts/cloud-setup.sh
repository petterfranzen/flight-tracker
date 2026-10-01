#!/usr/bin/env bash
# Prepares a Claude Code cloud session (claude.ai/code, or a remote agent
# started from the CLI) to build and test this repo: Java 21 + Maven for
# backend/, Node 24 + Playwright Chromium for frontend/ and blackbox-tests/.
# Same toolchain as .github/workflows/build-deploy.yml.
#
# Runs from the SessionStart hook in .claude/settings.json, only when
# CLAUDE_CODE_REMOTE=true, so local sessions are untouched. Idempotent:
# installs only what's missing, so a resumed session starts fast.
set -euo pipefail

[[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]] || exit 0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
log() { echo "[cloud-setup] $*" >&2; }
SUDO=""; [[ $EUID -ne 0 ]] && command -v sudo >/dev/null && SUDO="sudo"

java_major() { java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1; }
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

jm="$(command -v java >/dev/null && java_major || true)"
if [[ -z "$jm" || "$jm" -lt 21 ]]; then
  log "installing JDK 21"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq openjdk-21-jdk-headless
fi

if ! command -v mvn >/dev/null; then
  log "installing Maven"
  $SUDO apt-get install -y -qq maven
fi

nm="$(node_major || true)"
if [[ -z "$nm" || "$nm" -lt 24 ]]; then
  log "installing Node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs
fi

log "frontend dependencies"
(cd "$ROOT/frontend" && npm ci --no-audit --no-fund --loglevel=error)
(cd "$ROOT/frontend" && npx playwright install --with-deps chromium >/dev/null)

log "backend dependencies"
(cd "$ROOT/backend" && mvn -B -q dependency:go-offline >/dev/null) || log "maven prefetch failed; mvn will fetch on demand"

log "ready: java $(java_major), node $(node -v), $(mvn -v 2>/dev/null | head -1)"

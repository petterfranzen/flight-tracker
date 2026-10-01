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

# Every step is best-effort: a cloud environment's network policy may block
# a download (NodeSource and Playwright's CDN are blocked on the default
# "trusted" level), and one failed step shouldn't stop the rest. Each one
# logs what it did or why it couldn't.
try() { "$@" || { log "step failed (continuing): $*"; return 0; }; }

jm="$(command -v java >/dev/null && java_major || true)"
if [[ -z "$jm" || "$jm" -lt 21 ]]; then
  log "installing JDK 21"
  try $SUDO apt-get update -qq
  try $SUDO apt-get install -y -qq openjdk-21-jdk-headless
fi

if ! command -v mvn >/dev/null; then
  log "installing Maven"
  try $SUDO apt-get install -y -qq maven
fi

# CI uses Node 24, but 22 builds and tests this repo identically (the cloud
# image ships 22, and NodeSource isn't reachable to upgrade it), so only an
# older Node triggers an install.
nm="$(node_major || true)"
if [[ -z "$nm" || "$nm" -lt 22 ]]; then
  log "installing Node 24"
  try bash -c "curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO bash - >/dev/null && $SUDO apt-get install -y -qq nodejs"
fi

log "frontend dependencies"
try bash -c "cd '$ROOT/frontend' && npm ci --no-audit --no-fund --loglevel=error"

# Playwright's own Chromium if it can be downloaded; otherwise the image's
# pre-installed one, passed to playwright.config.ts via PW_CHROMIUM_PATH
# (written to CLAUDE_ENV_FILE so every later command in the session sees it).
if (cd "$ROOT/frontend" && npx playwright install --with-deps chromium >/dev/null 2>&1); then
  log "playwright chromium installed"
elif [[ -x /opt/pw-browsers/chromium ]]; then
  log "playwright CDN unreachable; using pre-installed /opt/pw-browsers/chromium"
  [[ -n "${CLAUDE_ENV_FILE:-}" ]] && echo "export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium" >> "$CLAUDE_ENV_FILE"
else
  log "no Chromium available; Playwright tests won't run in this session"
fi

log "backend dependencies"
try bash -c "cd '$ROOT/backend' && mvn -B -q dependency:go-offline >/dev/null"

log "ready: java $(java_major), node $(node -v 2>/dev/null), $(mvn -v 2>/dev/null | head -1)"

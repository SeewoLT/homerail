#!/usr/bin/env bash
# Rebuild HomeRail and restart local services after syncing from GitHub.
#
# Triggered by .githooks/post-merge (git pull) and post-rewrite (git pull --rebase).
#
# Environment:
#   HOMERAIL_SKIP_POST_SYNC_REBUILD=1   Skip this hook entirely
#   HOMERAIL_FORCE_POST_SYNC_REBUILD=1   Force rebuild even when no relevant files changed
#   HOMERAIL_AUTO_START_ON_SYNC=0       Do not auto-start services when none were running
#   HOMERAIL_HOME                       Log/state directory (default: ~/.homerail)
set -euo pipefail

if [ "${HOMERAIL_SKIP_POST_SYNC_REBUILD:-}" = "1" ]; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

LOG_DIR="${HOMERAIL_HOME:-$HOME/.homerail}/logs"
LOG_FILE="$LOG_DIR/post-sync-rebuild.log"
mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a "$LOG_FILE"
}

stage_error() {
  local stage="$1"
  local file="$2"
  local line
  line="$(grep -E -v '^(npm warn|npm notice|$|\[|>|added [0-9]+ packages|found [0-9]+ vulnerabilities|To address|Run `npm audit`|)' "$file" | tail -n 1)"
  if [ -z "$line" ]; then
    line="$(tail -n 1 "$file" 2>/dev/null || true)"
  fi
  if [ -n "$line" ]; then
    log "$stage failed: $line"
  else
    log "$stage failed"
  fi
}

run_stage() {
  local stage="$1"
  shift
  local outfile
  outfile="$(mktemp)"
  if "$@" >"$outfile" 2>&1; then
    log "$stage done"
    rm -f "$outfile"
    return 0
  fi
  stage_error "$stage" "$outfile"
  cat "$outfile" >>"$LOG_FILE"
  rm -f "$outfile"
  return 1
}

resolve_from_ref() {
  if git rev-parse --verify ORIG_HEAD >/dev/null 2>&1; then
    printf '%s\n' ORIG_HEAD
    return
  fi
  if git rev-parse --verify HEAD@{1} >/dev/null 2>&1; then
    printf '%s\n' HEAD@{1}
    return
  fi
  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    printf '%s\n' HEAD~1
    return
  fi
  printf '%s\n' ""
}

changed_files() {
  local from_ref="$1"
  if [ -z "$from_ref" ]; then
    return 0
  fi
  git diff --name-only "$from_ref" HEAD
}

needs_install() {
  local from_ref="$1"
  changed_files "$from_ref" | grep -Eq '(^|/)package-lock\.json$|(^|/)package\.json$' || return 1
}

needs_build() {
  local from_ref="$1"
  if [ -z "$from_ref" ]; then
    return 0
  fi
  changed_files "$from_ref" | grep -Eq \
    '(^|/)package\.json$|(^|/)package-lock\.json$|\.(ts|tsx|js|mjs|cjs|vue|yaml|yml|toml)$' \
    || return 1
}

run_hr() {
  local cli="$REPO_ROOT/homerail_cli/dist/cli.js"
  if [ -f "$cli" ]; then
    node "$cli" "$@"
    return
  fi
  if command -v hr >/dev/null 2>&1; then
    hr "$@"
    return
  fi
  log "HomeRail CLI not found; skipping service restart."
  return 1
}

runtime_was_active() {
  local cli="$REPO_ROOT/homerail_cli/dist/cli.js"
  [ -f "$cli" ] || return 1
  node "$cli" --json runtime status 2>/dev/null | node -e "
    let input = '';
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        const status = JSON.parse(input);
        const active = Boolean(
          status.managerPidRunning
          || status.managerHealthy
          || status.nodePidRunning
          || status.uiPidRunning
          || status.uiHttpsPidRunning
          || status.uiHttpPidRunning
        );
        process.exit(active ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  "
}

ui_was_active() {
  local cli="$REPO_ROOT/homerail_cli/dist/cli.js"
  [ -f "$cli" ] || return 1
  node "$cli" --json runtime status 2>/dev/null | node -e "
    let input = '';
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        const status = JSON.parse(input);
        const uiActive = Boolean(
          status.uiPidRunning || status.uiHttpsPidRunning || status.uiHttpPidRunning
        );
        process.exit(uiActive ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  "
}

SYNC_KIND="${1:-sync}"
FROM_REF="$(resolve_from_ref)"
log "post-sync-rebuild triggered ($SYNC_KIND) from=${FROM_REF:-unknown}"

FORCE_REBUILD=0
if [ "${HOMERAIL_FORCE_POST_SYNC_REBUILD:-}" = "1" ] || [ "$SYNC_KIND" = "force" ]; then
  FORCE_REBUILD=1
fi

if [ "$FORCE_REBUILD" -ne 1 ] && ! needs_build "$FROM_REF"; then
  log "No build-relevant changes detected; skipping rebuild."
  exit 0
fi

WAS_ACTIVE=0
UI_ACTIVE=0
if runtime_was_active; then
  WAS_ACTIVE=1
fi
if ui_was_active; then
  UI_ACTIVE=1
fi

if [ "$WAS_ACTIVE" -eq 1 ] || needs_install "$FROM_REF" || [ "$FORCE_REBUILD" -eq 1 ]; then
  log "Stopping local services before rebuild"
  run_hr runtime stop >>"$LOG_FILE" 2>&1 || true
  sleep 2
fi

if [ "$FORCE_REBUILD" -eq 1 ]; then
  log "Install deps"
  run_stage "Install deps" npm run install:all
elif needs_install "$FROM_REF"; then
  log "Install deps"
  run_stage "Install deps" npm run install:all
fi

log "Build"
run_stage "Build" npm run build

SHOULD_START=0
AUTO_START_ON_SYNC="${HOMERAIL_AUTO_START_ON_SYNC:-1}"
if [ "$FORCE_REBUILD" -eq 1 ]; then
  SHOULD_START=1
elif [ "$WAS_ACTIVE" -eq 1 ]; then
  SHOULD_START=1
elif [ "$AUTO_START_ON_SYNC" != "0" ]; then
  SHOULD_START=1
fi

if [ "$SHOULD_START" -eq 0 ]; then
  log "Services were not running; build complete. Set HOMERAIL_AUTO_START_ON_SYNC=0 to keep them stopped."
  exit 0
fi

START_ARGS=(start --ui)

log "Starting services: hr ${START_ARGS[*]}"
if ! run_stage "Start services" run_hr "${START_ARGS[@]}"; then
  exit 1
fi
log "post-sync-rebuild finished successfully"

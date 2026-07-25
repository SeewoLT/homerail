#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

git config core.hooksPath .githooks

for hook in post-merge post-rewrite; do
  chmod +x ".githooks/$hook"
done
chmod +x scripts/post-sync-rebuild.sh

echo "Git hooks installed (core.hooksPath=.githooks)"
echo "After git pull / sync, HomeRail will rebuild and restart services with 'hr start --ui'."
echo "Logs: \${HOMERAIL_HOME:-\$HOME/.homerail}/logs/post-sync-rebuild.log"
echo ""
echo "Optional:"
echo "  HOMERAIL_AUTO_START_ON_SYNC=0   keep services stopped after rebuild"
echo "  HOMERAIL_SKIP_POST_SYNC_REBUILD=1   disable the hook for one sync"

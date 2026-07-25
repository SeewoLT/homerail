# Install repo git hooks that rebuild and restart HomeRail after git pull / sync.
$ErrorActionPreference = "Stop"

$Root = git rev-parse --show-toplevel
Set-Location $Root

git config core.hooksPath .githooks

Write-Host "Git hooks installed (core.hooksPath=.githooks)"
Write-Host "After git pull / sync, HomeRail will rebuild and restart services with `hr start --ui`."
Write-Host "Logs: `$env:HOMERAIL_HOME\logs\post-sync-rebuild.log (default: ~\.homerail\logs\post-sync-rebuild.log)"
Write-Host ""
Write-Host "Optional environment variables:"
Write-Host "  HOMERAIL_AUTO_START_ON_SYNC=0         keep services stopped after rebuild"
Write-Host "  HOMERAIL_SKIP_POST_SYNC_REBUILD=1     disable the hook for one sync"

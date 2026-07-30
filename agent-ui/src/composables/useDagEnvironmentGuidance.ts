import type {
  DagEnvironmentReasonCode,
  DagEnvironmentStatus,
} from '@/api/services/dag-environment-api'

/**
 * Resolve the structured reason code that should drive guidance for a DAG
 * environment status snapshot.
 *
 * Docker availability wins over worker-image state: when the daemon itself is
 * unavailable there is no point describing an image problem, and the recovery
 * action is platform-specific (start Docker) rather than rebuilding an image.
 * Worker-image staleness expressed only via `reason`/`compatibility` (no
 * explicit `reason_code`) is normalized to `worker_image_stale` so callers share
 * one enum.
 */
export function dagEnvironmentReasonCode(
  status: DagEnvironmentStatus | null | undefined,
): DagEnvironmentReasonCode | undefined {
  if (!status) return undefined
  return (
    status.docker?.reason_code
    ?? status.worker_image?.reason_code
    ?? (
      status.worker_image?.reason === 'stale'
      || status.worker_image?.compatibility === 'stale'
        ? 'worker_image_stale'
        : undefined
    )
  )
}

/**
 * Map a DAG environment status to the i18n key for platform-specific recovery
 * guidance, or `null` when no dedicated guidance applies. The returned key is
 * always under `settings.environment.guidance.*` so the pill and the settings
 * panel render identical copy for the same failure.
 */
export function dagEnvironmentGuidanceKey(
  status: DagEnvironmentStatus | null | undefined,
  reason?: DagEnvironmentReasonCode,
): string | null {
  if (!status) return null
  const resolved = reason ?? dagEnvironmentReasonCode(status)
  if (!resolved) return null
  const platform = status.platform
  switch (resolved) {
    case 'docker_cli_missing':
      if (platform === 'win32') return 'settings.environment.guidance.installWindows'
      if (platform === 'darwin') return 'settings.environment.guidance.installMac'
      return 'settings.environment.guidance.installLinux'
    case 'docker_daemon_unavailable':
      if (platform === 'win32') return 'settings.environment.guidance.startWindows'
      if (platform === 'darwin') return 'settings.environment.guidance.startMac'
      return 'settings.environment.guidance.startLinux'
    case 'docker_permission_denied':
      return 'settings.environment.guidance.permissionLinux'
    case 'docker_linux_engine_required':
      return 'settings.environment.guidance.linuxEngineWindows'
    case 'worker_source_unavailable':
      return 'settings.environment.guidance.sourceUnavailable'
    case 'worker_image_missing':
    case 'worker_image_stale':
    case 'worker_image_incompatible':
    case 'worker_image_build_failed':
      return `settings.environment.guidance.${resolved}`
    default:
      return 'settings.environment.guidance.checkFailed'
  }
}

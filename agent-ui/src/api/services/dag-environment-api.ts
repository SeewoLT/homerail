import { http, type ApiResponse } from '../clients/http-client'

export type DagEnvironmentReasonCode =
  | 'docker_cli_missing'
  | 'docker_daemon_unavailable'
  | 'docker_permission_denied'
  | 'docker_linux_engine_required'
  | 'docker_check_failed'
  | 'worker_source_unavailable'
  | 'worker_image_missing'
  | 'worker_image_stale'
  | 'worker_image_incompatible'
  | 'worker_image_build_failed'

export type DagEnvironmentCompatibility = 'current' | 'stale' | 'incompatible' | 'unknown'

export interface DagEnvironmentImage {
  id: string
  tags: string[]
  created_at?: string
  size_bytes?: number
  os?: string
  architecture?: string
  source_fingerprint?: string
  worker_version?: string
  protocol_version?: string
  image_revision?: string
  compatibility: DagEnvironmentCompatibility
  selected: boolean
}

export interface DagEnvironmentWorker {
  worker_id: string
  status: string
  registered_at: number
  worker_version?: string
  protocol_version?: string
  source_fingerprint?: string
  image_revision?: string
  compatibility: DagEnvironmentCompatibility
}

export interface DagEnvironmentStatus {
  revision: number
  updated_at: number
  platform: 'win32' | 'darwin' | 'linux' | string
  docker: {
    status: 'unknown' | 'checking' | 'ready' | 'error'
    reason_code?: DagEnvironmentReasonCode
    message: string
    client_version?: string
    server_version?: string
    os_type?: string
    architecture?: string
    checked_at?: number
  }
  source: {
    available: boolean
    repo_root: string
    fingerprint?: string
    worker_version?: string
    protocol_version: string
    image_revision?: string
  }
  worker_image: {
    status: 'unknown' | 'checking' | 'building' | 'ready' | 'error' | 'skipped'
    image: string
    reason?: string
    reason_code?: DagEnvironmentReasonCode
    message: string
    started_at?: number
    updated_at?: number
    error?: string
    compatibility?: DagEnvironmentCompatibility
  }
  images: DagEnvironmentImage[]
  workers: DagEnvironmentWorker[]
  build?: {
    operation_id: string
    status: 'queued' | 'running' | 'succeeded' | 'failed'
    started_at: number
    finished_at?: number
    logs: string[]
    error?: string
  }
}

function isDagEnvironmentStatus(value: unknown): value is DagEnvironmentStatus {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DagEnvironmentStatus>
  return typeof candidate.revision === 'number'
    && Boolean(candidate.docker)
    && Boolean(candidate.source)
    && Boolean(candidate.worker_image)
    && Array.isArray(candidate.images)
    && Array.isArray(candidate.workers)
}

export async function getDagEnvironment(): Promise<ApiResponse<DagEnvironmentStatus>> {
  const readiness = await http.get<{
    checks?: { dag_resources?: unknown }
  }>('/api/manager-agent/readiness')
  const snapshot = readiness.data?.checks?.dag_resources
  if (isDagEnvironmentStatus(snapshot)) {
    return {
      success: readiness.success,
      message: readiness.message,
      data: snapshot,
    }
  }
  // A Manager upgrading from the legacy worker_image-only snapshot can still
  // serve the authoritative environment endpoint during the transition.
  return http.get<DagEnvironmentStatus>('/api/dag/environment')
}

export function checkDagEnvironment(): Promise<ApiResponse<DagEnvironmentStatus>> {
  return http.post<DagEnvironmentStatus>('/api/dag/environment/check', {})
}

export function buildDagWorkerImage(): Promise<ApiResponse<DagEnvironmentStatus>> {
  return http.post<DagEnvironmentStatus>('/api/dag/environment/build', {})
}

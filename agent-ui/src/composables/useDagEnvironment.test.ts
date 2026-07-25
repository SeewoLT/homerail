import { describe, expect, it } from 'vitest'
import {
  dagEnvironmentErrorMessage,
  shouldApplyDagEnvironmentStatus,
} from './useDagEnvironment'
import type { DagEnvironmentStatus } from '@/api/services/dag-environment-api'

function status(revision: number): DagEnvironmentStatus {
  return {
    revision,
    updated_at: revision,
    platform: 'linux',
    docker: { status: 'ready', message: 'ready' },
    source: {
      available: true,
      repo_root: '/repo',
      fingerprint: 'fingerprint',
      protocol_version: '0.1.0',
    },
    worker_image: {
      status: 'ready',
      image: 'homerail-worker:latest',
      message: 'ready',
    },
    images: [],
    workers: [],
  }
}

describe('DAG environment event ordering', () => {
  it('accepts the first and strictly newer snapshots', () => {
    expect(shouldApplyDagEnvironmentStatus(null, status(1))).toBe(true)
    expect(shouldApplyDagEnvironmentStatus(status(1), status(2))).toBe(true)
  })

  it('ignores duplicate and stale websocket snapshots', () => {
    expect(shouldApplyDagEnvironmentStatus(status(3), status(3))).toBe(false)
    expect(shouldApplyDagEnvironmentStatus(status(3), status(2))).toBe(false)
  })

  it('extracts structured API errors instead of rendering object coercion', () => {
    expect(dagEnvironmentErrorMessage({
      response: { data: { error: 'Docker is unavailable' } },
    })).toBe('Docker is unavailable')
  })
})

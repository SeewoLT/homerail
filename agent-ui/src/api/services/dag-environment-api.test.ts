import { afterEach, describe, expect, it, vi } from 'vitest'
import { http } from '../clients/http-client'
import {
  getDagEnvironment,
  type DagEnvironmentStatus,
} from './dag-environment-api'

afterEach(() => {
  vi.restoreAllMocks()
})

function snapshot(revision: number): DagEnvironmentStatus {
  return {
    revision,
    updated_at: revision,
    platform: 'linux',
    docker: {
      status: 'ready',
      message: 'Docker is ready.',
    },
    source: {
      available: true,
      protocol_version: '0.1.0',
      repo_root: '/repo',
    },
    worker_image: {
      status: 'ready',
      image: 'homerail-worker:latest',
      message: 'Worker image is ready.',
    },
    images: [],
    workers: [],
  }
}

describe('DAG environment API', () => {
  it('reuses the Manager readiness snapshot on initial load', async () => {
    const current = snapshot(7)
    const get = vi.spyOn(http, 'get').mockResolvedValue({
      success: true,
      data: { checks: { dag_resources: current } },
    })

    await expect(getDagEnvironment()).resolves.toEqual({
      success: true,
      message: undefined,
      data: current,
    })
    expect(get).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledWith('/api/manager-agent/readiness')
  })

  it('falls back to the environment endpoint for a legacy readiness snapshot', async () => {
    const current = snapshot(8)
    const get = vi.spyOn(http, 'get')
      .mockResolvedValueOnce({
        success: true,
        data: {
          checks: {
            dag_resources: {
              worker_image: {
                status: 'unknown',
                image: 'homerail-worker:latest',
                message: 'Not checked.',
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({ success: true, data: current })

    await expect(getDagEnvironment()).resolves.toEqual({ success: true, data: current })
    expect(get).toHaveBeenNthCalledWith(1, '/api/manager-agent/readiness')
    expect(get).toHaveBeenNthCalledWith(2, '/api/dag/environment')
  })
})

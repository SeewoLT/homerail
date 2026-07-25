import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import type { DagEnvironmentStatus } from '@/api/services/dag-environment-api'
import DagEnvironmentSettings from './DagEnvironmentSettings.vue'

const api = vi.hoisted(() => ({
  status: null as DagEnvironmentStatus | null,
  check: vi.fn(),
  build: vi.fn(),
}))

vi.mock('@/api/clients/events-ws', () => ({
  voiceWs: {
    on: vi.fn(() => () => {}),
    connect: vi.fn(),
  },
}))

vi.mock('@/api/services/dag-environment-api', () => ({
  getDagEnvironment: vi.fn(async () => ({ data: api.status })),
  checkDagEnvironment: api.check,
  buildDagWorkerImage: api.build,
}))

function baseStatus(): DagEnvironmentStatus {
  return {
    revision: 1,
    updated_at: Date.now(),
    platform: 'linux',
    docker: {
      status: 'ready',
      message: 'Docker Linux engine is available.',
      server_version: '28.1.0',
      os_type: 'linux',
      architecture: 'amd64',
    },
    source: {
      available: true,
      repo_root: '/repo',
      fingerprint: 'source-123',
      worker_version: '0.1.0',
      protocol_version: '0.1.0',
    },
    worker_image: {
      status: 'ready',
      image: 'homerail-worker:latest',
      message: 'ready',
      compatibility: 'current',
    },
    images: [{
      id: 'sha256:abc123',
      tags: ['homerail-worker:latest'],
      size_bytes: 1024,
      source_fingerprint: 'source-123',
      worker_version: '0.1.0',
      protocol_version: '0.1.0',
      compatibility: 'current',
      selected: true,
    }],
    workers: [],
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('DagEnvironmentSettings', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'zh-Hans'
    api.status = baseStatus()
    api.check.mockReset()
    api.build.mockReset()
    api.check.mockResolvedValue({ data: api.status })
    api.build.mockResolvedValue({ data: api.status })
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  async function mount(): Promise<HTMLElement> {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(DagEnvironmentSettings)
    app.use(i18n)
    app.mount(root)
    await flush()
    return root
  }

  it('shows relevant HomeRail image metadata and enables asynchronous rebuild', async () => {
    const element = await mount()

    expect(element.textContent).toContain('homerail-worker:latest')
    expect(element.textContent).toContain('source-123')
    expect(element.textContent).toContain('当前版本')

    element.querySelector<HTMLButtonElement>('[data-testid="dag-environment-build"]')?.click()
    await flush()
    expect(api.build).toHaveBeenCalledTimes(1)
  })

  it('keeps a 202 build response preparing until a terminal event arrives', async () => {
    api.build.mockResolvedValue({
      data: {
        ...baseStatus(),
        revision: 2,
        worker_image: {
          status: 'building',
          image: 'homerail-worker:latest',
          message: 'Building homerail-worker:latest.',
        },
        build: {
          operation_id: 'build-1',
          status: 'running',
          started_at: Date.now(),
          logs: ['Building'],
        },
      },
    })
    const element = await mount()
    const button = element.querySelector<HTMLButtonElement>('[data-testid="dag-environment-build"]')!

    button.click()
    await flush()

    expect(element.textContent).toContain('正在构建 Worker 镜像')
    expect(element.textContent).not.toContain('Building homerail-worker:latest.')
    expect(button.disabled).toBe(true)
  })

  it('shows Windows-specific Docker guidance and prevents a build while unavailable', async () => {
    api.status = {
      ...baseStatus(),
      platform: 'win32',
      docker: {
        status: 'error',
        reason_code: 'docker_daemon_unavailable',
        message: 'Docker unavailable',
      },
      worker_image: {
        status: 'error',
        image: 'homerail-worker:latest',
        reason_code: 'docker_daemon_unavailable',
        message: 'Docker unavailable',
      },
      images: [],
    }
    const element = await mount()

    expect(element.textContent).toContain('请启动 Docker Desktop')
    expect(element.querySelector<HTMLButtonElement>('[data-testid="dag-environment-build"]')?.disabled).toBe(true)
  })

  it('renders unknown readiness as localized and actionable instead of using Manager text', async () => {
    api.status = {
      ...baseStatus(),
      docker: {
        status: 'unknown',
        message: 'Docker environment has not been checked yet.',
      },
      worker_image: {
        status: 'unknown',
        image: 'homerail-worker:latest',
        message: 'DAG worker image status has not been checked yet.',
      },
      images: [],
    }
    const element = await mount()

    expect(element.textContent).toContain('尚未确认 DAG 运行环境是否就绪')
    expect(element.textContent).toContain('请点击“重新检查”')
    expect(element.textContent).not.toContain('DAG worker image status has not been checked yet.')
    expect(element.querySelector<HTMLButtonElement>('[data-testid="dag-environment-build"]')?.disabled).toBe(true)
  })

  it('renders stale readiness as a localized rebuild action instead of using Manager text', async () => {
    api.status = {
      ...baseStatus(),
      worker_image: {
        status: 'error',
        image: 'homerail-worker:latest',
        reason: 'stale',
        reason_code: 'worker_image_stale',
        compatibility: 'stale',
        message: 'homerail-worker:latest does not match the current HomeRail source.',
      },
      images: [{
        ...baseStatus().images[0]!,
        compatibility: 'stale',
      }],
    }
    const element = await mount()

    expect(element.textContent).toContain('Worker 镜像需要针对当前 HomeRail 版本重新构建')
    expect(element.textContent).toContain('镜像与当前 HomeRail 源码不一致，请重新构建')
    expect(element.textContent).not.toContain('does not match the current HomeRail source')
    expect(element.querySelector<HTMLButtonElement>('[data-testid="dag-environment-build"]')?.disabled).toBe(false)
  })
})

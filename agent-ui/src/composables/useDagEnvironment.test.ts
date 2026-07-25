import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import {
  dagEnvironmentErrorMessage,
  shouldApplyDagEnvironmentStatus,
  useDagEnvironment,
  type DagEnvironmentState,
} from './useDagEnvironment'
import type { DagEnvironmentStatus } from '@/api/services/dag-environment-api'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Set<(message: unknown) => void>>(),
  connect: vi.fn(),
  get: vi.fn(),
  check: vi.fn(),
  build: vi.fn(),
}))

vi.mock('@/api/clients/events-ws', () => ({
  voiceWs: {
    on(type: string, handler: (message: unknown) => void) {
      const handlers = mocks.handlers.get(type) ?? new Set()
      handlers.add(handler)
      mocks.handlers.set(type, handlers)
      return () => handlers.delete(handler)
    },
    connect: mocks.connect,
  },
}))

vi.mock('@/api/services/dag-environment-api', () => ({
  getDagEnvironment: mocks.get,
  checkDagEnvironment: mocks.check,
  buildDagWorkerImage: mocks.build,
}))

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

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function emit(type: string, message: unknown): void {
  for (const handler of [...(mocks.handlers.get(type) ?? [])]) handler(message)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
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

describe('useDagEnvironment lifecycle', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null
  let stateRef: DagEnvironmentState | null = null

  beforeEach(() => {
    mocks.handlers.clear()
    mocks.connect.mockClear()
    mocks.get.mockReset()
    mocks.check.mockReset()
    mocks.build.mockReset()
    mocks.check.mockResolvedValue({ data: status(2) })
    mocks.build.mockResolvedValue({ data: status(2) })
    stateRef = null
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    stateRef = null
  })

  async function mountHarness(): Promise<DagEnvironmentState> {
    root = document.createElement('div')
    document.body.appendChild(root)
    const Harness = defineComponent({
      setup() {
        stateRef = useDagEnvironment()
        return () => h('div')
      },
    })
    app = createApp(Harness)
    app.mount(root)
    await flush()
    if (!stateRef) throw new Error('DAG environment state was not mounted')
    return stateRef
  }

  it('loads the authoritative snapshot when mounted', async () => {
    mocks.get.mockResolvedValue({ data: status(1) })

    const state = await mountHarness()

    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(state.status.value?.revision).toBe(1)
  })

  it('applies a newer Manager event immediately', async () => {
    mocks.get.mockResolvedValue({ data: status(1) })
    const state = await mountHarness()

    emit('dag:resource_status_updated', {
      type: 'dag:resource_status_updated',
      payload: { revision: 2, status: status(2) },
    })
    await flush()

    expect(state.status.value?.revision).toBe(2)
  })

  it('refreshes the authoritative snapshot after a reconnect hello', async () => {
    mocks.get
      .mockResolvedValueOnce({ data: status(1) })
      .mockResolvedValueOnce({ data: status(4) })
    const state = await mountHarness()

    emit('manager:events_connected', {
      type: 'manager:events_connected',
      payload: {},
    })
    await flush()

    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(state.status.value?.revision).toBe(4)
  })

  it('does not let an older HTTP snapshot overwrite a newer event', async () => {
    const initial = deferred<{ data: DagEnvironmentStatus }>()
    mocks.get.mockReturnValueOnce(initial.promise)
    const state = await mountHarness()

    emit('dag:resource_status_updated', {
      type: 'dag:resource_status_updated',
      payload: { revision: 5, status: status(5) },
    })
    await flush()
    expect(state.status.value?.revision).toBe(5)

    initial.resolve({ data: status(1) })
    await flush()
    expect(state.status.value?.revision).toBe(5)

    emit('dag:resource_status_updated', {
      type: 'dag:resource_status_updated',
      payload: { revision: 4, status: status(4) },
    })
    await flush()
    expect(state.status.value?.revision).toBe(5)
  })
})

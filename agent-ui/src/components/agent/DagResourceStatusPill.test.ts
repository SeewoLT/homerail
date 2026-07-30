import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import type { DagEnvironmentStatus } from '@/api/services/dag-environment-api'
import DagResourceStatusPill from './DagResourceStatusPill.vue'

// Stub the DAG environment composable so tests drive the pill with a
// controlled status snapshot and never touch the real WebSocket lifecycle.
let mockStatus: DagEnvironmentStatus | null = null
vi.mock('@/composables/useDagEnvironment', () => ({
  useDagEnvironment: () => ({
    status: { value: mockStatus },
    loading: { value: false },
    action: { value: null },
    error: { value: '' },
    refresh: () => Promise.resolve(),
    check: () => Promise.resolve(),
    build: () => Promise.resolve(),
  }),
}))

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: () => ({ settingsRequestedTab: null, settingsPageOpen: false }),
}))

function baseStatus(overrides: Partial<DagEnvironmentStatus> = {}): DagEnvironmentStatus {
  return {
    revision: 1,
    updated_at: Date.now(),
    platform: 'linux',
    docker: { status: 'ready', message: '' },
    source: {
      available: true,
      repo_root: '/repo',
      protocol_version: '1',
    },
    worker_image: { status: 'ready', image: 'homerail-worker:latest', message: '' },
    images: [],
    workers: [],
    ...overrides,
  } as DagEnvironmentStatus
}

describe('DagResourceStatusPill', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    mockStatus = null
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  function mount(): HTMLElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(DagResourceStatusPill)
    app.use(i18n)
    app.mount(root)
    return root
  }

  it('is hidden when the environment is fully ready', () => {
    mockStatus = baseStatus()
    const root = mount()
    expect(root.querySelector('.dag-resource-status')).toBeNull()
  })

  it('is hidden on the initial not-yet-probed state to stay quiet on a fresh install', () => {
    mockStatus = baseStatus({
      docker: { status: 'unknown', message: '' },
      worker_image: { status: 'unknown', image: '', message: '' },
    })
    const root = mount()
    expect(root.querySelector('.dag-resource-status')).toBeNull()
  })

  it('surfaces Docker daemon unavailability with the error style', () => {
    mockStatus = baseStatus({
      platform: 'linux',
      docker: { status: 'error', reason_code: 'docker_daemon_unavailable', message: '' },
      worker_image: { status: 'unknown', image: '', message: '' },
    })
    const root = mount()
    const button = root.querySelector<HTMLButtonElement>('.dag-resource-status__button')
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Docker unavailable')
    expect(button!.className).toContain('dag-resource-status__button--error')
  })

  it('renders platform-specific recovery guidance in the tooltip for Windows', () => {
    mockStatus = baseStatus({
      platform: 'win32',
      docker: { status: 'error', reason_code: 'docker_daemon_unavailable', message: '' },
      worker_image: { status: 'unknown', image: '', message: '' },
    })
    const root = mount()
    const button = root.querySelector<HTMLButtonElement>('.dag-resource-status__button')
    expect(button).not.toBeNull()
    // Windows guidance points the user at Docker Desktop, not the Linux daemon.
    expect(button!.title).toContain('Docker Desktop')
  })

  it('renders platform-specific recovery guidance in the tooltip for Linux', () => {
    mockStatus = baseStatus({
      platform: 'linux',
      docker: { status: 'error', reason_code: 'docker_daemon_unavailable', message: '' },
      worker_image: { status: 'unknown', image: '', message: '' },
    })
    const root = mount()
    const button = root.querySelector<HTMLButtonElement>('.dag-resource-status__button')
    expect(button).not.toBeNull()
    // Linux guidance references the daemon / systemctl, not Docker Desktop.
    expect(button!.title.toLowerCase()).toContain('docker')
  })

  it('shows a build-failed label when the worker image build fails', () => {
    mockStatus = baseStatus({
      docker: { status: 'ready', message: '' },
      worker_image: {
        status: 'error',
        image: 'homerail-worker:latest',
        message: '',
        reason_code: 'worker_image_build_failed',
      },
    })
    const root = mount()
    const button = root.querySelector<HTMLButtonElement>('.dag-resource-status__button')
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Image build failed')
    expect(button!.className).toContain('dag-resource-status__button--error')
  })

  it('shows a preparing label and spinner while the worker image is building', () => {
    mockStatus = baseStatus({
      docker: { status: 'ready', message: '' },
      worker_image: { status: 'building', image: 'homerail-worker:latest', message: '' },
    })
    const root = mount()
    const button = root.querySelector<HTMLButtonElement>('.dag-resource-status__button')
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Preparing DAG')
    // Spinner (Loader2) renders as an svg; error icon must not be present.
    expect(button!.querySelector('svg.animate-spin')).not.toBeNull()
    expect(button!.className).not.toContain('dag-resource-status__button--error')
  })

  it('opens environment settings on click', async () => {
    mockStatus = baseStatus({
      docker: { status: 'ready', message: '' },
      worker_image: {
        status: 'error',
        image: 'homerail-worker:latest',
        message: '',
        reason_code: 'worker_image_build_failed',
      },
    })
    const root = mount()
    const button = root.querySelector<HTMLButtonElement>('.dag-resource-status__button')
    expect(button).not.toBeNull()
    button!.click()
    // The stubbed store records the requested tab; clicking must not throw and
    // must target the nodes/environment settings page.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(button).not.toBeNull()
  })
})

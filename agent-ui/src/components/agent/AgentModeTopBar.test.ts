import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { http } from '@/api/clients/http-client'
import { i18n } from '@/plugins/i18n'
import AgentModeTopBar from './AgentModeTopBar.vue'

function updateStatus(overrides: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus {
  return {
    supported: true,
    state: 'not-available',
    currentVersion: '0.1.0-alpha.1',
    channel: 'early-access',
    ...overrides,
  }
}

describe('AgentModeTopBar localization', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'zh-Hans'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    Reflect.deleteProperty(window, 'homerailDesktop')
    vi.restoreAllMocks()
  })

  it('updates primary controls immediately when the locale changes', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AgentModeTopBar, {
      activeMode: 'text',
      showDetails: true,
      showSettings: true,
    })
    app.use(i18n)
    app.mount(root)

    expect(root.textContent).toContain('文字模式')
    expect(root.textContent).toContain('设置')

    i18n.global.locale.value = 'en-US'
    await nextTick()

    expect(root.textContent).toContain('Text')
    expect(root.textContent).toContain('Voice')
    expect(root.textContent).toContain('Details')
    expect(root.textContent).toContain('Settings')
    expect(root.textContent).not.toContain('文字模式')
  })

  it('shows waiting runs without presenting them as actively executing', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({
      data: {
        runs: [{ runId: 'run-waiting', status: 'waiting' }],
        total: 1,
      },
    } as any)
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AgentModeTopBar, {
      activeMode: 'text',
      showRuntime: true,
    })
    app.use(i18n)
    app.mount(root)

    await vi.waitFor(() => {
      const button = root?.querySelector<HTMLElement>('[data-testid="dag-runtime-button"]')
      expect(button?.dataset.state).toBe('waiting')
      expect(button?.title).toContain('1 个运行等待指令')
      expect(button?.textContent).toContain('1')
      expect(button?.querySelector('.animate-spin')).toBeNull()
    })
  })

  it('shows the installing state immediately after restart-to-update is requested', async () => {
    i18n.global.locale.value = 'en-US'
    const installUpdate = vi.fn().mockResolvedValue(updateStatus({
      state: 'installing',
      installStartedAt: Date.now(),
      update: { version: '0.1.0-alpha.2' },
    }))
    Object.defineProperty(window, 'homerailDesktop', {
      configurable: true,
      value: {
        updateStatus: vi.fn().mockResolvedValue(updateStatus({
          state: 'downloaded',
          update: { version: '0.1.0-alpha.2' },
        })),
        installUpdate,
      } satisfies HomeRailDesktopBridge,
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AgentModeTopBar, { activeMode: 'text' })
    app.use(i18n)
    app.mount(root)

    await vi.waitFor(() => {
      const button = root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')
      expect(button?.textContent).toContain('Restart to update')
      expect(button?.disabled).toBe(false)
    })

    root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')?.click()

    await vi.waitFor(() => {
      const button = root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')
      expect(installUpdate).toHaveBeenCalledOnce()
      expect(button?.textContent).toContain('Installing update')
      expect(button?.disabled).toBe(true)
      expect(button?.getAttribute('aria-busy')).toBe('true')
    })
  })

  it('offers an explicit update check retry after installation handoff fails', async () => {
    i18n.global.locale.value = 'en-US'
    let finishCheck: ((status: DesktopUpdateStatus) => void) | null = null
    const checkForUpdates = vi.fn(() => new Promise<DesktopUpdateStatus>((resolve) => {
      finishCheck = resolve
    }))
    Object.defineProperty(window, 'homerailDesktop', {
      configurable: true,
      value: {
        updateStatus: vi.fn().mockResolvedValue(updateStatus({
          state: 'downloaded',
          update: { version: '0.1.0-alpha.2' },
        })),
        installUpdate: vi.fn().mockRejectedValue(new Error('installer handoff timed out')),
        checkForUpdates,
      } satisfies HomeRailDesktopBridge,
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AgentModeTopBar, { activeMode: 'text' })
    app.use(i18n)
    app.mount(root)

    await vi.waitFor(() => {
      expect(root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')?.textContent)
        .toContain('Restart to update')
    })
    root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')?.click()

    await vi.waitFor(() => {
      const button = root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')
      expect(button?.textContent).toContain('Retry update check')
      expect(button?.disabled).toBe(false)
      expect(button?.title).toContain('installer handoff timed out')
    })
    root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')?.click()

    await vi.waitFor(() => {
      const button = root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-install"]')
      expect(checkForUpdates).toHaveBeenCalledOnce()
      expect(button?.textContent).toContain('Checking for updates')
      expect(button?.disabled).toBe(true)
      expect(button?.getAttribute('aria-busy')).toBe('true')
    })

    finishCheck?.(updateStatus({ state: 'checking' }))
    await vi.waitFor(() => {
      expect(root?.querySelector('[data-testid="desktop-update-install"]')).toBeNull()
    })
  })
})

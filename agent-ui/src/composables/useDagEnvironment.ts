import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { voiceWs } from '@/api/clients/events-ws'
import {
  buildDagWorkerImage,
  checkDagEnvironment,
  getDagEnvironment,
  type DagEnvironmentStatus,
} from '@/api/services/dag-environment-api'

interface DagEnvironmentEventPayload {
  revision?: number
  status?: DagEnvironmentStatus
}

export interface DagEnvironmentState {
  status: Ref<DagEnvironmentStatus | null>
  loading: Ref<boolean>
  action: Ref<'check' | 'build' | null>
  error: Ref<string>
  refresh: () => Promise<void>
  check: () => Promise<void>
  build: () => Promise<void>
}

export function shouldApplyDagEnvironmentStatus(
  current: DagEnvironmentStatus | null,
  incoming: DagEnvironmentStatus,
): boolean {
  return !current || incoming.revision > current.revision
}

export function dagEnvironmentErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  if (cause && typeof cause === 'object') {
    const value = cause as {
      message?: unknown
      error?: unknown
      response?: { data?: { message?: unknown; error?: unknown } }
    }
    const candidate = value.response?.data?.error
      ?? value.response?.data?.message
      ?? value.error
      ?? value.message
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return 'Unable to load the DAG runtime environment.'
}

export function useDagEnvironment(): DagEnvironmentState {
  const status = ref<DagEnvironmentStatus | null>(null)
  const loading = ref(false)
  const action = ref<'check' | 'build' | null>(null)
  const error = ref('')
  let environmentUnsubscribe: (() => void) | null = null
  let connectedUnsubscribe: (() => void) | null = null

  function apply(incoming: DagEnvironmentStatus): void {
    if (shouldApplyDagEnvironmentStatus(status.value, incoming)) {
      status.value = incoming
    }
  }

  async function refresh(): Promise<void> {
    loading.value = status.value === null
    try {
      const response = await getDagEnvironment()
      apply(response.data)
      error.value = ''
    } catch (cause) {
      error.value = dagEnvironmentErrorMessage(cause)
    } finally {
      loading.value = false
    }
  }

  async function check(): Promise<void> {
    action.value = 'check'
    try {
      const response = await checkDagEnvironment()
      apply(response.data)
      error.value = ''
    } catch (cause) {
      error.value = dagEnvironmentErrorMessage(cause)
    } finally {
      action.value = null
    }
  }

  async function build(): Promise<void> {
    action.value = 'build'
    try {
      const response = await buildDagWorkerImage()
      apply(response.data)
      error.value = ''
    } catch (cause) {
      error.value = dagEnvironmentErrorMessage(cause)
    } finally {
      action.value = null
    }
  }

  onMounted(() => {
    environmentUnsubscribe = voiceWs.on<DagEnvironmentEventPayload>('dag:resource_status_updated', message => {
      if (message.payload?.status) apply(message.payload.status)
    })
    connectedUnsubscribe = voiceWs.on('manager:events_connected', () => {
      // The authoritative snapshot closes any event gap from reconnect.
      void refresh()
    })
    voiceWs.connect()
    void refresh()
  })

  onBeforeUnmount(() => {
    environmentUnsubscribe?.()
    connectedUnsubscribe?.()
  })

  return { status, loading, action, error, refresh, check, build }
}

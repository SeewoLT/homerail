<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Container,
  Hammer,
  Loader2,
  RefreshCw,
  Server,
} from 'lucide-vue-next'
import { useDagEnvironment } from '@/composables/useDagEnvironment'
import type {
  DagEnvironmentCompatibility,
  DagEnvironmentReasonCode,
} from '@/api/services/dag-environment-api'

const { t, locale } = useI18n()
const { status, loading, action, error, check, build } = useDagEnvironment()

const busy = computed(() =>
  status.value?.build?.status === 'queued'
  || status.value?.build?.status === 'running'
)
const ready = computed(() =>
  status.value?.docker.status === 'ready'
  && status.value?.worker_image.status === 'ready'
)
const canBuild = computed(() =>
  status.value?.docker.status === 'ready'
  && status.value?.source.available === true
  && !busy.value
)
const selectedImage = computed(() => status.value?.images.find(image => image.selected))

function compatibilityLabel(value: DagEnvironmentCompatibility): string {
  return t(`settings.environment.compatibility.${value}`)
}

function compatibilityClass(value: DagEnvironmentCompatibility): string {
  if (value === 'current') return 'text-[var(--hr-success)] border-[var(--hr-success-border)] bg-[var(--hr-success-soft)]'
  if (value === 'incompatible') return 'text-[var(--hr-danger)] border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)]'
  if (value === 'stale') return 'text-[var(--hr-warning)] border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)]'
  return 'text-[var(--hr-text-3)] border-[var(--hr-border)] bg-[var(--hr-surface-2)]'
}

function guidanceKey(reason: DagEnvironmentReasonCode | undefined): string | null {
  if (!reason) return null
  if (reason === 'docker_cli_missing') {
    if (status.value?.platform === 'win32') return 'settings.environment.guidance.installWindows'
    if (status.value?.platform === 'darwin') return 'settings.environment.guidance.installMac'
    return 'settings.environment.guidance.installLinux'
  }
  if (reason === 'docker_daemon_unavailable') {
    if (status.value?.platform === 'win32') return 'settings.environment.guidance.startWindows'
    if (status.value?.platform === 'darwin') return 'settings.environment.guidance.startMac'
    return 'settings.environment.guidance.startLinux'
  }
  if (reason === 'docker_permission_denied') return 'settings.environment.guidance.permissionLinux'
  if (reason === 'docker_linux_engine_required') return 'settings.environment.guidance.linuxEngineWindows'
  if (reason === 'worker_source_unavailable') return 'settings.environment.guidance.sourceUnavailable'
  if (
    reason === 'worker_image_missing'
    || reason === 'worker_image_stale'
    || reason === 'worker_image_incompatible'
    || reason === 'worker_image_build_failed'
  ) return `settings.environment.guidance.${reason}`
  return 'settings.environment.guidance.checkFailed'
}

const guidance = computed(() => {
  const reason = status.value?.docker.reason_code ?? status.value?.worker_image.reason_code
  const key = guidanceKey(reason)
  return key ? t(key) : ''
})

function formatSize(value: number | undefined): string {
  if (!value) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function formatDate(value: string | number | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function shortId(value: string | undefined): string {
  if (!value) return '—'
  return value.replace(/^sha256:/, '').slice(0, 12)
}
</script>

<template>
  <div class="space-y-5" data-testid="dag-environment-settings">
    <div
      class="rounded-xl border p-5"
      :class="ready
        ? 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)]'
        : 'border-[var(--hr-border)] bg-[var(--hr-surface-1)]'"
    >
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex min-w-0 gap-3">
          <div
            class="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg border"
            :class="ready
              ? 'border-[var(--hr-success-border)] text-[var(--hr-success)]'
              : 'border-[var(--hr-border)] text-[var(--hr-text-2)]'"
          >
            <Loader2 v-if="loading || status?.docker.status === 'checking'" class="h-5 w-5 animate-spin" />
            <CheckCircle2 v-else-if="ready" class="h-5 w-5" />
            <AlertTriangle v-else class="h-5 w-5 text-[var(--hr-warning)]" />
          </div>
          <div class="min-w-0">
            <h3 class="font-semibold text-[var(--hr-text-1)]">{{ t('settings.environment.statusTitle') }}</h3>
            <p class="mt-1 text-sm leading-6 text-[var(--hr-text-2)]">
              {{ status?.worker_image.message || t('settings.environment.loading') }}
            </p>
            <p v-if="guidance" class="mt-2 text-sm leading-6 text-[var(--hr-warning)]">{{ guidance }}</p>
            <p v-if="error" class="mt-2 text-sm text-[var(--hr-danger)]">{{ error }}</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            data-testid="dag-environment-check"
            class="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-2)] px-3 text-sm text-[var(--hr-text-1)] transition-colors hover:border-[var(--hr-border-strong)] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="action !== null || busy"
            @click="check"
          >
            <Loader2 v-if="action === 'check'" class="h-4 w-4 animate-spin" />
            <RefreshCw v-else class="h-4 w-4" />
            {{ t('settings.environment.check') }}
          </button>
          <button
            type="button"
            data-testid="dag-environment-build"
            class="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] px-3 text-sm font-medium text-[var(--hr-accent)] transition-colors hover:border-[var(--hr-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canBuild"
            @click="build"
          >
            <Loader2 v-if="busy || action === 'build'" class="h-4 w-4 animate-spin" />
            <Hammer v-else class="h-4 w-4" />
            {{ selectedImage ? t('settings.environment.rebuild') : t('settings.environment.build') }}
          </button>
        </div>
      </div>

      <div class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-panel)] p-3">
          <div class="text-xs text-[var(--hr-text-3)]">{{ t('settings.environment.dockerEngine') }}</div>
          <div class="mt-1 text-sm font-medium text-[var(--hr-text-1)]">
            {{ status?.docker.status === 'ready' ? t('settings.environment.available') : t('settings.environment.unavailable') }}
          </div>
          <div class="mt-1 text-xs text-[var(--hr-text-3)]">
            {{ status?.docker.server_version || '—' }} · {{ status?.docker.os_type || '—' }}/{{ status?.docker.architecture || '—' }}
          </div>
        </div>
        <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-panel)] p-3">
          <div class="text-xs text-[var(--hr-text-3)]">{{ t('settings.environment.selectedImage') }}</div>
          <div class="mt-1 truncate font-mono text-sm text-[var(--hr-text-1)]">{{ status?.worker_image.image || '—' }}</div>
          <div class="mt-1 text-xs text-[var(--hr-text-3)]">{{ shortId(selectedImage?.id) }}</div>
        </div>
        <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-panel)] p-3">
          <div class="text-xs text-[var(--hr-text-3)]">{{ t('settings.environment.sourceFingerprint') }}</div>
          <div class="mt-1 font-mono text-sm text-[var(--hr-text-1)]">{{ status?.source.fingerprint || '—' }}</div>
          <div class="mt-1 text-xs text-[var(--hr-text-3)]">Worker {{ status?.source.worker_version || '—' }}</div>
        </div>
        <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-panel)] p-3">
          <div class="text-xs text-[var(--hr-text-3)]">{{ t('settings.environment.protocolVersion') }}</div>
          <div class="mt-1 font-mono text-sm text-[var(--hr-text-1)]">{{ status?.source.protocol_version || '—' }}</div>
          <div class="mt-1 text-xs text-[var(--hr-text-3)]">
            {{ t('settings.environment.connectedWorkers', { count: status?.workers.length || 0 }) }}
          </div>
        </div>
      </div>
    </div>

    <div class="overflow-hidden rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)]">
      <div class="flex items-center gap-2 border-b border-[var(--hr-border)] px-4 py-3">
        <Box class="h-4 w-4 text-[var(--hr-accent)]" />
        <h3 class="font-medium text-[var(--hr-text-1)]">{{ t('settings.environment.imagesTitle') }}</h3>
        <span class="ml-auto text-xs text-[var(--hr-text-3)]">{{ status?.images.length || 0 }}</span>
      </div>
      <div v-if="status?.images.length" class="divide-y divide-[var(--hr-border)]">
        <div
          v-for="image in status.images"
          :key="image.id"
          class="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate font-mono text-sm text-[var(--hr-text-1)]">{{ image.tags.join(', ') || shortId(image.id) }}</span>
              <span v-if="image.selected" class="rounded-full border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--hr-accent)]">
                {{ t('settings.environment.inUse') }}
              </span>
            </div>
            <div class="mt-1 text-xs text-[var(--hr-text-3)]">{{ shortId(image.id) }} · {{ formatSize(image.size_bytes) }} · {{ formatDate(image.created_at) }}</div>
          </div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span class="text-[var(--hr-text-3)]">{{ t('settings.environment.workerVersion') }}</span>
            <span class="font-mono text-[var(--hr-text-2)]">{{ image.worker_version || '—' }}</span>
            <span class="text-[var(--hr-text-3)]">{{ t('settings.environment.protocolVersion') }}</span>
            <span class="font-mono text-[var(--hr-text-2)]">{{ image.protocol_version || '—' }}</span>
            <span class="text-[var(--hr-text-3)]">{{ t('settings.environment.fingerprint') }}</span>
            <span class="font-mono text-[var(--hr-text-2)]">{{ image.source_fingerprint || '—' }}</span>
          </div>
          <div>
            <span class="inline-flex rounded-full border px-2.5 py-1 text-xs" :class="compatibilityClass(image.compatibility)">
              {{ compatibilityLabel(image.compatibility) }}
            </span>
          </div>
        </div>
      </div>
      <div v-else class="px-4 py-8 text-center text-sm text-[var(--hr-text-3)]">
        {{ status?.docker.status === 'ready' ? t('settings.environment.noImages') : t('settings.environment.imagesUnavailable') }}
      </div>
    </div>

    <div class="overflow-hidden rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)]">
      <div class="flex items-center gap-2 border-b border-[var(--hr-border)] px-4 py-3">
        <Server class="h-4 w-4 text-[var(--hr-accent)]" />
        <h3 class="font-medium text-[var(--hr-text-1)]">{{ t('settings.environment.workersTitle') }}</h3>
      </div>
      <div v-if="status?.workers.length" class="divide-y divide-[var(--hr-border)]">
        <div v-for="worker in status.workers" :key="worker.worker_id" class="grid gap-3 px-4 py-3 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <div class="font-mono text-sm text-[var(--hr-text-1)]">{{ worker.worker_id }}</div>
            <div class="mt-1 text-xs text-[var(--hr-text-3)]">{{ worker.status }} · {{ formatDate(worker.registered_at) }}</div>
          </div>
          <div class="text-xs text-[var(--hr-text-2)]">
            Worker {{ worker.worker_version || '—' }} · Protocol {{ worker.protocol_version || '—' }}
            <div class="mt-1 font-mono text-[var(--hr-text-3)]">{{ worker.source_fingerprint || '—' }}</div>
          </div>
          <span class="h-fit rounded-full border px-2.5 py-1 text-xs" :class="compatibilityClass(worker.compatibility)">
            {{ compatibilityLabel(worker.compatibility) }}
          </span>
        </div>
      </div>
      <div v-else class="px-4 py-8 text-center text-sm text-[var(--hr-text-3)]">{{ t('settings.environment.noWorkers') }}</div>
    </div>

    <details v-if="status?.build" class="rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)]" :open="busy || status.build.status === 'failed'">
      <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-[var(--hr-text-1)]">
        <Container class="h-4 w-4 text-[var(--hr-accent)]" />
        {{ t('settings.environment.buildLog') }}
        <span class="ml-auto text-xs text-[var(--hr-text-3)]">{{ t(`settings.environment.buildStatus.${status.build.status}`) }}</span>
      </summary>
      <pre class="max-h-72 overflow-auto border-t border-[var(--hr-border)] bg-[var(--hr-bg)] p-4 text-xs leading-5 text-[var(--hr-text-2)]">{{ status.build.logs.join('\n') }}</pre>
    </details>
  </div>
</template>

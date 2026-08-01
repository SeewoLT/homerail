<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Hammer, Loader2 } from 'lucide-vue-next'
import { useDagEnvironment } from '@/composables/useDagEnvironment'
import {
  dagEnvironmentGuidanceKey,
  dagEnvironmentReasonCode,
} from '@/composables/useDagEnvironmentGuidance'
import { useAgentStore } from '@/stores/agent-store'
import { cn } from '@/lib/utils'

const { t } = useI18n()
const store = useAgentStore()
const { status } = useDagEnvironment()
const workerImage = computed(() => status.value?.worker_image ?? null)

// Docker unavailability is the most common DAG failure mode and is what users
// need an actionable hint for. The pill must surface it even when the worker
// image itself has not been probed yet (status unknown/skipped).
const dockerUnavailable = computed(() => status.value?.docker.status === 'error')

const preparing = computed(() => {
  const worker = workerImage.value?.status
  return worker === 'checking' || worker === 'building'
})

const reasonCode = computed(() => dagEnvironmentReasonCode(status.value))

const visible = computed(() => {
  // While Docker or the worker image is actively being prepared, always show.
  if (preparing.value) return true
  // Docker daemon problems always surface, regardless of worker-image state.
  if (dockerUnavailable.value) return true
  const worker = workerImage.value?.status
  if (worker === 'error' || worker === 'skipped') return true
  // Suppress the initial, not-yet-probed state so a fresh install is quiet.
  if (worker === 'unknown' && !reasonCode.value) return false
  return worker !== 'ready'
})

const label = computed(() => {
  if (preparing.value) return t('dag.resources.preparingShort')
  switch (reasonCode.value) {
    case 'docker_cli_missing':
    case 'docker_daemon_unavailable':
    case 'docker_permission_denied':
    case 'docker_linux_engine_required':
    case 'docker_check_failed':
      return t('dag.resources.dockerUnavailable')
    case 'worker_image_missing':
      return t('dag.resources.imageMissing')
    case 'worker_image_stale':
    case 'worker_image_incompatible':
      return t('dag.resources.imageStale')
    case 'worker_image_build_failed':
      return t('dag.resources.buildFailed')
    case 'worker_source_unavailable':
      return t('dag.resources.sourceUnavailable')
    default:
      if (workerImage.value?.status === 'skipped') return t('dag.resources.preparation')
      return t('dag.resources.resources')
  }
})

const title = computed(() => {
  // Prefer platform-specific recovery guidance so the tooltip alone is enough
  // to tell the user what to do (start Docker on Windows, etc.).
  const guidanceKey = dagEnvironmentGuidanceKey(status.value, reasonCode.value)
  if (guidanceKey) return t(guidanceKey)
  if (!status.value) return t('dag.resources.manage')
  if (preparing.value) return t('dag.resources.preparingDescription')
  if (workerImage.value?.status === 'skipped') return t('dag.resources.skipped')
  return t('dag.resources.manageDescription')
})

const isError = computed(() => dockerUnavailable.value || workerImage.value?.status === 'error')

function openEnvironmentSettings(): void {
  store.settingsRequestedTab = 'nodes'
  store.settingsPageOpen = true
}
</script>

<template>
  <div v-if="visible" class="dag-resource-status">
    <button
      type="button"
      class="dag-resource-status__button"
      :class="cn(isError && 'dag-resource-status__button--error')"
      :title="title"
      @click="openEnvironmentSettings"
    >
      <Loader2 v-if="preparing" class="h-4 w-4 animate-spin" />
      <AlertTriangle v-else-if="isError" class="h-4 w-4" />
      <Hammer v-else class="h-4 w-4" />
      <span>{{ label }}</span>
    </button>
  </div>
</template>

<style scoped>
.dag-resource-status {
  position: relative;
}

.dag-resource-status__button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 2.25rem;
  padding: 0 0.75rem;
  border-radius: 9999px;
  border: 1px solid var(--hr-accent-border);
  background: var(--hr-accent-soft);
  color: var(--hr-accent);
  font-size: 0.82rem;
  transition: background 160ms ease, border-color 160ms ease;
}

.dag-resource-status__button:hover {
  border-color: var(--hr-accent);
  background: color-mix(in srgb, var(--hr-accent) 18%, transparent);
}

.dag-resource-status__button--error {
  border-color: var(--hr-warning-border);
  background: var(--hr-warning-soft);
  color: var(--hr-warning);
}

</style>

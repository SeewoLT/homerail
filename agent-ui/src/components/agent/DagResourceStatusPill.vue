<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Hammer, Loader2 } from 'lucide-vue-next'
import { useDagEnvironment } from '@/composables/useDagEnvironment'
import { useAgentStore } from '@/stores/agent-store'
import { cn } from '@/lib/utils'

const { t } = useI18n()
const store = useAgentStore()
const { status } = useDagEnvironment()
const workerImage = computed(() => status.value?.worker_image ?? null)

const visible = computed(() => {
  const status = workerImage.value?.status
  return status !== 'ready'
})

const preparing = computed(() => {
  const status = workerImage.value?.status
  return status === 'checking' || status === 'building'
})

const label = computed(() => {
  if (preparing.value) return t('dag.resources.preparingShort')
  if (workerImage.value?.status === 'error') return t('dag.resources.resources')
  return t('dag.resources.preparation')
})

const title = computed(() => {
  if (!workerImage.value) return t('dag.resources.manage')
  if (preparing.value) return t('dag.resources.preparingDescription')
  if (workerImage.value.status === 'error') return t('dag.resources.manageDescription')
  if (workerImage.value.status === 'skipped') return t('dag.resources.skipped')
  return t('dag.resources.manageDescription')
})

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
      :class="cn(workerImage?.status === 'error' && 'dag-resource-status__button--error')"
      :title="title"
      @click="openEnvironmentSettings"
    >
      <Loader2 v-if="preparing" class="h-4 w-4 animate-spin" />
      <AlertTriangle v-else-if="workerImage?.status === 'error'" class="h-4 w-4" />
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

<template>
  <div class="card p-5">
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-semibold text-slate-200">Configuration</h3>
      <button class="btn-primary text-xs" :disabled="saving" @click="save">
        <svg v-if="saving" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {{ saving ? 'Saving...' : 'Save' }}
      </button>
    </div>

    <!-- Editable non-sensitive fields -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 mb-5">
      <div>
        <label class="label">Base URL</label>
        <input v-model="local.baseUrl" class="input" placeholder="enterprise.localhost" />
      </div>
      <div>
        <label class="label">Port</label>
        <input v-model="local.port" class="input" placeholder="3000 (blank for HTTPS)" />
      </div>
      <div>
        <label class="label">Organization</label>
        <input v-model="local.organization" class="input" placeholder="waltid" />
      </div>
      <div>
        <label class="label">Tenant</label>
        <input v-model="local.tenant" class="input" placeholder="<org>-tenant01 (auto)" />
      </div>
      <div>
        <label class="label">Admin Email</label>
        <input v-model="local.adminEmail" class="input" type="email" placeholder="admin@walt.id" />
      </div>
    </div>

    <!-- Sensitive env var status (read-only) -->
    <div>
      <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
        Sensitive credentials — set via server env vars
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <EnvVarRow name="WALT_ADMIN_PASSWORD" :set="envStatus.adminPassword" />
        <EnvVarRow name="WALT_SUPERADMIN_EMAIL" :set="envStatus.superadminEmail" />
        <EnvVarRow name="WALT_SUPERADMIN_PASSWORD" :set="envStatus.superadminPassword" />
        <EnvVarRow name="WALT_SUPERADMIN_TOKEN" :set="envStatus.superadminToken" />
      </div>
    </div>

    <div v-if="saved" class="mt-3 flex items-center gap-1.5 text-xs text-emerald-400">
      <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
      </svg>
      Configuration saved
    </div>
  </div>
</template>

<script setup lang="ts">
import { useConfig } from '~/composables/useConfig'
import type { WaltConfig } from '~/types'

const { config, envStatus, saveConfig } = useConfig()

const local = reactive<WaltConfig>({ ...config.value })
const saving = ref(false)
const saved = ref(false)

watch(config, (v) => Object.assign(local, v), { immediate: true })

async function save() {
  saving.value = true
  saved.value = false
  await saveConfig({ ...local })
  saving.value = false
  saved.value = true
  setTimeout(() => (saved.value = false), 2500)
}
</script>

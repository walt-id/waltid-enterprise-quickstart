<template>
  <div class="flex flex-col min-h-screen">
    <header class="px-6 py-5 border-b border-slate-800 flex-shrink-0">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold text-white">Run Logs</h1>
          <p class="text-sm text-slate-500 mt-0.5">Browse CLI execution logs and HTTP traces</p>
        </div>
        <button class="btn-secondary" @click="refresh">
          <svg class="w-3.5 h-3.5" :class="loading ? 'animate-spin' : ''" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>
    </header>

    <div class="flex-1 p-6 overflow-y-auto">
      <div v-if="loading" class="flex items-center justify-center py-20">
        <div class="w-6 h-6 border-2 border-slate-700 border-t-brand-500 rounded-full animate-spin" />
      </div>

      <div v-else-if="runs.length === 0" class="flex flex-col items-center justify-center py-20 text-center">
        <div class="w-16 h-16 rounded-2xl bg-slate-900 flex items-center justify-center mb-4">
          <svg class="w-8 h-8 text-slate-600" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
          </svg>
        </div>
        <p class="text-slate-400 font-medium">No log runs found</p>
        <p class="text-slate-600 text-sm mt-1">Run a CLI command to generate logs</p>
        <NuxtLink to="/commands" class="btn-primary mt-4 text-sm">Go to Commands</NuxtLink>
      </div>

      <div v-else>
        <!-- Group by date -->
        <div v-for="(group, date) in grouped" :key="date" class="mb-8">
          <div class="flex items-center gap-3 mb-3">
            <span class="text-sm font-semibold text-slate-400">{{ date }}</span>
            <div class="flex-1 h-px bg-slate-800" />
            <span class="text-xs text-slate-600">{{ group.length }} run{{ group.length !== 1 ? 's' : '' }}</span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            <NuxtLink
              v-for="run in group"
              :key="run.dir"
              :to="`/logs/${run.dir}`"
              class="card p-4 hover:border-slate-600 hover:bg-slate-900/80 transition-all group"
            >
              <div class="flex items-start justify-between gap-2 mb-3">
                <div class="w-9 h-9 rounded-lg bg-brand-900/30 flex items-center justify-center flex-shrink-0">
                  <svg class="w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <span class="badge badge-slate font-mono">#{{ String(run.count).padStart(3, '0') }}</span>
              </div>

              <div class="font-mono text-xs text-slate-400 mb-2 truncate group-hover:text-slate-300 transition">
                {{ run.dir }}
              </div>

              <div class="flex items-center gap-3 text-xs text-slate-600">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  {{ run.fileCount }} files
                </span>
              </div>
            </NuxtLink>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { LogRun } from '~/types'

definePageMeta({ layout: 'default' })

const runs = ref<LogRun[]>([])
const loading = ref(true)

const grouped = computed(() => {
  const result: Record<string, LogRun[]> = {}
  for (const run of runs.value) {
    if (!result[run.date]) result[run.date] = []
    result[run.date].push(run)
  }
  return result
})

async function refresh() {
  loading.value = true
  try {
    runs.value = await $fetch<LogRun[]>('/api/logs')
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
</script>

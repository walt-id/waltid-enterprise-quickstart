<template>
  <div class="flex flex-col min-h-screen">
    <!-- Header -->
    <header class="px-6 py-5 border-b border-slate-800 flex-shrink-0">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold text-white">Dashboard</h1>
          <p class="text-sm text-slate-500 mt-0.5">Walt.id Enterprise CLI — run & monitor</p>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-600 font-mono">{{ config.baseUrl }}</span>
          <span v-if="config.organization" class="badge badge-blue">{{ config.organization }}</span>
        </div>
      </div>
    </header>

    <div class="flex-1 p-6 space-y-6 overflow-y-auto">
      <!-- Stats row -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="card p-4">
          <div class="text-xs text-slate-500 mb-1">Total Commands</div>
          <div class="text-2xl font-semibold text-white">{{ totalCommands }}</div>
        </div>
        <div class="card p-4">
          <div class="text-xs text-slate-500 mb-1">Log Runs</div>
          <div class="text-2xl font-semibold text-white">{{ logRuns.length }}</div>
        </div>
        <div class="card p-4">
          <div class="text-xs text-slate-500 mb-1">Last Run Status</div>
          <div class="flex items-center gap-2 mt-1">
            <span
              v-if="lastRunStatus === 'running'"
              class="flex items-center gap-1.5 text-amber-400 font-medium"
            >
              <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              Running
            </span>
            <span
              v-else-if="lastRunStatus === 'success'"
              class="flex items-center gap-1.5 text-emerald-400 font-medium"
            >
              <span class="w-2 h-2 rounded-full bg-emerald-400" />
              Success
            </span>
            <span
              v-else-if="lastRunStatus === 'failed'"
              class="flex items-center gap-1.5 text-red-400 font-medium"
            >
              <span class="w-2 h-2 rounded-full bg-red-400" />
              Failed
            </span>
            <span v-else class="text-slate-600 text-sm">—</span>
          </div>
        </div>
        <div class="card p-4">
          <div class="text-xs text-slate-500 mb-1">Organization</div>
          <div class="text-sm font-medium text-white truncate">{{ config.organization || '—' }}</div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div>
        <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Quick Actions</h2>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            class="card p-4 text-left hover:border-red-800 transition-all group disabled:opacity-50"
            :disabled="isRunning"
            @click="runCommand('--recreate')"
          >
            <div class="flex items-center gap-2 mb-2">
              <span class="w-8 h-8 rounded-lg bg-red-900/40 flex items-center justify-center">
                <svg class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </span>
              <span class="font-medium text-sm text-slate-200">Full Recreate</span>
              <span class="badge badge-red text-[10px] ml-auto">Destructive</span>
            </div>
            <p class="text-xs text-slate-500">Drop DB, re-initialize, setup all resources and run primary use case</p>
          </button>

          <button
            class="card p-4 text-left hover:border-blue-800 transition-all group disabled:opacity-50"
            :disabled="isRunning"
            @click="runCommand('--setup-all')"
          >
            <div class="flex items-center gap-2 mb-2">
              <span class="w-8 h-8 rounded-lg bg-blue-900/40 flex items-center justify-center">
                <svg class="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </span>
              <span class="font-medium text-sm text-slate-200">Setup All</span>
            </div>
            <p class="text-xs text-slate-500">Create all services and resources in dependency order</p>
          </button>

          <button
            class="card p-4 text-left hover:border-emerald-800 transition-all group disabled:opacity-50"
            :disabled="isRunning"
            @click="runCommand('--run-all')"
          >
            <div class="flex items-center gap-2 mb-2">
              <span class="w-8 h-8 rounded-lg bg-emerald-900/40 flex items-center justify-center">
                <svg class="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
                </svg>
              </span>
              <span class="font-medium text-sm text-slate-200">Run All</span>
            </div>
            <p class="text-xs text-slate-500">Full mDL issue + verify end-to-end credential flow</p>
          </button>
        </div>
      </div>

      <!-- Terminal + Recent Logs split -->
      <div class="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <!-- Terminal (wider) -->
        <div class="lg:col-span-3 h-96">
          <TerminalOutput
            :lines="output"
            :is-running="isRunning"
            :exit-code="exitCode"
            :command="activeCommand"
            @clear="clear"
          />
        </div>

        <!-- Recent runs -->
        <div class="lg:col-span-2 card p-4 flex flex-col">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold text-slate-300">Recent Runs</h3>
            <NuxtLink to="/logs" class="text-xs text-brand-400 hover:text-brand-300 transition">View all →</NuxtLink>
          </div>

          <div v-if="logRunsLoading" class="flex-1 flex items-center justify-center">
            <div class="w-5 h-5 border-2 border-slate-700 border-t-brand-500 rounded-full animate-spin" />
          </div>

          <div v-else-if="logRuns.length === 0" class="flex-1 flex items-center justify-center text-sm text-slate-600">
            No runs yet
          </div>

          <div v-else class="space-y-2 overflow-y-auto flex-1">
            <NuxtLink
              v-for="run in logRuns.slice(0, 8)"
              :key="run.dir"
              :to="`/logs/${run.dir}`"
              class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800 transition group"
            >
              <div class="w-8 h-8 rounded-lg bg-slate-800 group-hover:bg-slate-700 flex items-center justify-center flex-shrink-0 transition">
                <svg class="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-mono text-slate-300 truncate">{{ run.dir }}</div>
                <div class="text-xs text-slate-600">{{ run.fileCount }} files</div>
              </div>
            </NuxtLink>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useCommandStream } from '~/composables/useCommandStream'
import { useConfig } from '~/composables/useConfig'
import { ALL_COMMANDS } from '~/data/commands'
import type { LogRun } from '~/types'

definePageMeta({ layout: 'default' })

const { state, run, clear } = useCommandStream()
const { config, toEnv } = useConfig()

const output = computed(() => state.output)
const isRunning = computed(() => state.isRunning)
const exitCode = computed(() => state.exitCode)
const activeCommand = computed(() => state.command)

const totalCommands = ALL_COMMANDS.length

const lastRunStatus = computed(() => {
  if (state.isRunning) return 'running'
  if (state.exitCode === 0) return 'success'
  if (state.exitCode !== null) return 'failed'
  return 'idle'
})

const logRuns = ref<LogRun[]>([])
const logRunsLoading = ref(true)

async function loadLogs() {
  logRunsLoading.value = true
  try {
    logRuns.value = await $fetch<LogRun[]>('/api/logs')
  } catch {
    logRuns.value = []
  } finally {
    logRunsLoading.value = false
  }
}

function runCommand(cmd: string) {
  run(cmd, toEnv())
  // Refresh logs after a short delay
  setTimeout(loadLogs, 2000)
}

onMounted(loadLogs)
</script>

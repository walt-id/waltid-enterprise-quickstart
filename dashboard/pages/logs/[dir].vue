<template>
  <div class="flex flex-col min-h-screen">
    <!-- Header -->
    <header class="px-6 py-5 border-b border-slate-800 flex-shrink-0">
      <div class="flex items-center gap-3">
        <NuxtLink to="/logs" class="text-slate-500 hover:text-slate-300 transition">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </NuxtLink>
        <div>
          <h1 class="text-xl font-semibold text-white font-mono">{{ dir }}</h1>
          <p class="text-sm text-slate-500 mt-0.5">{{ files.length }} log files</p>
        </div>
      </div>
    </header>

    <div class="flex-1 overflow-hidden">
      <!-- Tab bar -->
      <div class="flex border-b border-slate-800 px-6">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="px-4 py-3 text-sm font-medium border-b-2 transition -mb-px"
          :class="activeTab === tab.id
            ? 'border-brand-500 text-brand-400'
            : 'border-transparent text-slate-500 hover:text-slate-300'"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
          <span v-if="tab.count !== undefined" class="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-500">
            {{ tab.count }}
          </span>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6" style="max-height: calc(100vh - 160px)">
        <!-- HTTP Log tab -->
        <div v-if="activeTab === 'http'">
          <div v-if="httpLogLoading" class="flex items-center justify-center py-10">
            <div class="w-5 h-5 border-2 border-slate-700 border-t-brand-500 rounded-full animate-spin" />
          </div>
          <div v-else-if="httpLogError" class="text-red-400 text-sm">{{ httpLogError }}</div>
          <div v-else-if="httpLog.length === 0" class="text-slate-600 text-sm text-center py-10">
            No HTTP log found (walt-http-log.json)
          </div>
          <div v-else class="space-y-2">
            <!-- Summary stats -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <div class="card p-3 text-center">
                <div class="text-xl font-semibold text-white">{{ httpLog.length }}</div>
                <div class="text-xs text-slate-500 mt-0.5">Total Requests</div>
              </div>
              <div class="card p-3 text-center">
                <div class="text-xl font-semibold text-emerald-400">{{ successCount }}</div>
                <div class="text-xs text-slate-500 mt-0.5">Successful</div>
              </div>
              <div class="card p-3 text-center">
                <div class="text-xl font-semibold text-red-400">{{ errorCount }}</div>
                <div class="text-xs text-slate-500 mt-0.5">Errors</div>
              </div>
              <div class="card p-3 text-center">
                <div class="text-xl font-semibold text-blue-400">{{ uniqueHosts }}</div>
                <div class="text-xs text-slate-500 mt-0.5">Hosts</div>
              </div>
            </div>

            <HttpLogEntry
              v-for="(entry, i) in httpLog"
              :key="i"
              :entry="entry"
              :index="i"
            />
          </div>
        </div>

        <!-- Files tab -->
        <div v-else-if="activeTab === 'files'">
          <!-- Group by step -->
          <div
            v-for="(group, cmd) in filesByCommand"
            :key="cmd"
            class="mb-6"
          >
            <div class="flex items-center gap-2 mb-2">
              <span class="text-xs font-mono font-semibold text-slate-400 bg-slate-800 px-2 py-1 rounded">
                {{ cmd }}
              </span>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                v-for="file in group"
                :key="file.name"
                class="card p-3 text-left hover:border-slate-600 transition group"
                @click="viewFile(file.name)"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="badge text-[10px] flex-shrink-0"
                    :class="file.type === 'request' ? 'badge-blue' : file.type === 'response' ? 'badge-green' : 'badge-slate'"
                  >
                    {{ file.type === 'request' ? 'REQ' : file.type === 'response' ? 'RES' : file.type }}
                  </span>
                  <span class="text-xs font-mono text-slate-400 group-hover:text-slate-200 truncate transition">
                    {{ file.name }}
                  </span>
                </div>
              </button>
            </div>
          </div>

          <!-- Misc files -->
          <div v-if="miscFiles.length > 0">
            <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Other</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                v-for="file in miscFiles"
                :key="file.name"
                class="card p-3 text-left hover:border-slate-600 transition"
                @click="viewFile(file.name)"
              >
                <span class="text-xs font-mono text-slate-400">{{ file.name }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- File viewer modal -->
    <Teleport to="body">
      <div
        v-if="viewingFile"
        class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
        @click.self="viewingFile = null"
      >
        <div class="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
          <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800">
            <span class="font-mono text-sm text-slate-300">{{ viewingFileName }}</span>
            <button class="text-slate-500 hover:text-slate-300 transition" @click="viewingFile = null">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="overflow-y-auto flex-1 p-5">
            <pre class="text-xs font-mono text-slate-300 leading-relaxed whitespace-pre-wrap break-all">{{ formatContent(viewingFile) }}</pre>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import type { LogFile, HttpLogEntry as HttpLogEntryType } from '~/types'

definePageMeta({ layout: 'default' })

const route = useRoute()
const dir = computed(() => route.params.dir as string)

const files = ref<LogFile[]>([])
const httpLog = ref<HttpLogEntryType[]>([])
const httpLogLoading = ref(false)
const httpLogError = ref<string | null>(null)
const activeTab = ref<'http' | 'files'>('http')
const viewingFile = ref<unknown>(null)
const viewingFileName = ref('')

const tabs = computed(() => [
  { id: 'http' as const, label: 'HTTP Log', count: httpLog.value.length },
  { id: 'files' as const, label: 'Files', count: files.value.length },
])

const filesByCommand = computed(() => {
  const result: Record<string, LogFile[]> = {}
  for (const f of files.value) {
    if (f.type === 'request' || f.type === 'response') {
      const key = `${String(f.step).padStart(3, '0')} — ${f.command}`
      if (!result[key]) result[key] = []
      result[key].push(f)
    }
  }
  return result
})

const miscFiles = computed(() =>
  files.value.filter((f) => f.type !== 'request' && f.type !== 'response'),
)

const successCount = computed(() => httpLog.value.filter((e) => e.response.status < 300).length)
const errorCount = computed(() => httpLog.value.filter((e) => e.response.status >= 400).length)
const uniqueHosts = computed(() => {
  const hosts = new Set<string>()
  for (const e of httpLog.value) {
    try {
      hosts.add(new URL(e.request.url).hostname)
    } catch {
      hosts.add(e.request.url.split('/')[2] ?? '?')
    }
  }
  return hosts.size
})

async function loadFiles() {
  try {
    files.value = await $fetch<LogFile[]>(`/api/logs/${dir.value}`)
  } catch {
    files.value = []
  }
}

async function loadHttpLog() {
  httpLogLoading.value = true
  httpLogError.value = null
  try {
    const data = await $fetch<HttpLogEntryType[]>(`/api/logs/${dir.value}/walt-http-log.json`)
    httpLog.value = Array.isArray(data) ? data : []
  } catch (e: unknown) {
    if ((e as { statusCode?: number })?.statusCode === 404) {
      httpLog.value = []
    } else {
      httpLogError.value = 'Failed to load HTTP log'
    }
  } finally {
    httpLogLoading.value = false
  }
}

async function viewFile(fileName: string) {
  viewingFileName.value = fileName
  try {
    viewingFile.value = await $fetch(`/api/logs/${dir.value}/${fileName}`)
  } catch {
    viewingFile.value = { error: 'Failed to load file' }
  }
}

function formatContent(content: unknown) {
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

onMounted(async () => {
  await Promise.all([loadFiles(), loadHttpLog()])
})
</script>

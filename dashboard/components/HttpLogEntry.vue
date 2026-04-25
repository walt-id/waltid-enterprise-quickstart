<template>
  <div class="card overflow-hidden">
    <!-- Header row -->
    <button
      class="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 transition text-left"
      @click="open = !open"
    >
      <!-- Method badge -->
      <span
        class="font-mono text-xs font-semibold px-2 py-0.5 rounded w-14 text-center flex-shrink-0"
        :class="methodClass"
      >{{ entry.request.method }}</span>

      <!-- Status -->
      <span
        class="font-mono text-xs font-medium px-2 py-0.5 rounded flex-shrink-0"
        :class="statusClass"
      >{{ entry.response.status }}</span>

      <!-- URL -->
      <span class="text-xs text-slate-400 truncate flex-1 font-mono">{{ urlPath }}</span>

      <!-- Timestamp -->
      <span class="text-xs text-slate-600 flex-shrink-0 font-mono">{{ formattedTime }}</span>

      <!-- Toggle -->
      <svg
        class="w-4 h-4 text-slate-600 flex-shrink-0 transition-transform"
        :class="open ? 'rotate-180' : ''"
        fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <!-- Expanded detail -->
    <div v-if="open" class="border-t border-slate-800">
      <div class="grid grid-cols-2 divide-x divide-slate-800">
        <!-- Request -->
        <div class="p-4">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Request</div>
          <div class="space-y-3">
            <div>
              <div class="text-xs text-slate-600 mb-1">URL</div>
              <code class="text-xs font-mono text-blue-400 break-all">{{ entry.request.url }}</code>
            </div>
            <div v-if="entry.request.body">
              <div class="text-xs text-slate-600 mb-1">Body</div>
              <pre class="text-xs font-mono text-slate-300 bg-slate-950 p-3 rounded-lg overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">{{ formatJson(entry.request.body) }}</pre>
            </div>
            <div v-if="Object.keys(sanitizedHeaders(entry.request.headers)).length > 0">
              <div class="text-xs text-slate-600 mb-1">Headers</div>
              <pre class="text-xs font-mono text-slate-400 bg-slate-950 p-3 rounded-lg overflow-x-auto max-h-32 overflow-y-auto leading-relaxed">{{ formatJson(sanitizedHeaders(entry.request.headers)) }}</pre>
            </div>
          </div>
        </div>

        <!-- Response -->
        <div class="p-4">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Response</div>
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm font-semibold" :class="entry.response.status < 300 ? 'text-emerald-400' : entry.response.status < 400 ? 'text-yellow-400' : 'text-red-400'">
                {{ entry.response.status }}
              </span>
              <span class="text-xs text-slate-500">{{ entry.response.statusText }}</span>
            </div>
            <div v-if="entry.response.data">
              <div class="text-xs text-slate-600 mb-1">Body</div>
              <pre class="text-xs font-mono text-slate-300 bg-slate-950 p-3 rounded-lg overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">{{ formatJson(entry.response.data) }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { HttpLogEntry } from '~/types'

const props = defineProps<{ entry: HttpLogEntry; index: number }>()

const open = ref(false)

const methodClass = computed(() => {
  const m = props.entry.request.method
  return {
    GET: 'bg-blue-900/50 text-blue-400',
    POST: 'bg-emerald-900/50 text-emerald-400',
    PUT: 'bg-yellow-900/50 text-yellow-400',
    PATCH: 'bg-orange-900/50 text-orange-400',
    DELETE: 'bg-red-900/50 text-red-400',
  }[m] ?? 'bg-slate-800 text-slate-400'
})

const statusClass = computed(() => {
  const s = props.entry.response.status
  if (s < 300) return 'bg-emerald-900/50 text-emerald-400'
  if (s < 400) return 'bg-yellow-900/50 text-yellow-400'
  return 'bg-red-900/50 text-red-400'
})

const urlPath = computed(() => {
  try {
    const url = new URL(props.entry.request.url)
    return url.pathname + url.search
  } catch {
    return props.entry.request.url
  }
})

const formattedTime = computed(() => {
  try {
    return new Date(props.entry.timestamp).toLocaleTimeString()
  } catch {
    return props.entry.timestamp
  }
})

function formatJson(data: unknown) {
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

function sanitizedHeaders(headers: Record<string, string>) {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lower = k.toLowerCase()
    if (lower === 'authorization') {
      result[k] = '[REDACTED]'
    } else {
      result[k] = v
    }
  }
  return result
}
</script>

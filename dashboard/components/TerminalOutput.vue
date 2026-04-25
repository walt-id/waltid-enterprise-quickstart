<template>
  <div class="flex flex-col h-full bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
    <!-- Terminal header -->
    <div class="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex-shrink-0">
      <div class="flex items-center gap-3">
        <div class="flex gap-1.5">
          <div class="w-3 h-3 rounded-full bg-red-500/70" />
          <div class="w-3 h-3 rounded-full bg-yellow-500/70" />
          <div class="w-3 h-3 rounded-full bg-green-500/70" />
        </div>
        <span class="text-xs font-mono text-slate-500">
          <template v-if="command">npx tsx walt.ts {{ command }}</template>
          <template v-else>terminal</template>
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="isRunning"
          class="flex items-center gap-1.5 text-xs text-amber-400"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          Running
        </span>
        <span
          v-else-if="exitCode === 0"
          class="flex items-center gap-1.5 text-xs text-emerald-400"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Exit 0 — OK
        </span>
        <span
          v-else-if="exitCode !== null"
          class="flex items-center gap-1.5 text-xs text-red-400"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-red-400" />
          Exit {{ exitCode }}
        </span>
        <button
          v-if="lines.length > 0"
          class="text-xs text-slate-500 hover:text-slate-300 transition px-2 py-0.5 rounded hover:bg-slate-800"
          @click="$emit('clear')"
        >
          Clear
        </button>
      </div>
    </div>

    <!-- Output area -->
    <div
      ref="outputEl"
      class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed min-h-0"
    >
      <div v-if="lines.length === 0" class="text-slate-600 select-none">
        <span class="text-slate-700">$</span> Waiting for command...
      </div>

      <div v-for="(line, i) in lines" :key="i" class="flex gap-2 group">
        <span class="text-slate-700 select-none flex-shrink-0 w-5 text-right">{{ i + 1 }}</span>
        <span
          class="break-all whitespace-pre-wrap flex-1"
          :class="lineClass(line)"
          v-html="formatLine(line.data)"
        />
      </div>

      <div v-if="isRunning" class="flex gap-2 mt-1">
        <span class="text-slate-700 select-none w-5 text-right">{{ lines.length + 1 }}</span>
        <span class="text-slate-500 animate-pulse">▋</span>
      </div>
    </div>

    <!-- Footer stats -->
    <div
      v-if="lines.length > 0 || exitCode !== null"
      class="flex items-center gap-4 px-4 py-2 bg-slate-900 border-t border-slate-800 flex-shrink-0 text-xs text-slate-500"
    >
      <span>{{ lines.length }} lines</span>
      <span v-if="errorCount > 0" class="text-red-400">{{ errorCount }} errors</span>
      <span v-if="warnCount > 0" class="text-yellow-400">{{ warnCount }} warnings</span>
      <span v-if="okCount > 0" class="text-emerald-400">{{ okCount }} OK</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OutputLine } from '~/types'

const props = defineProps<{
  lines: readonly OutputLine[]
  isRunning: boolean
  exitCode: number | null
  command?: string | null
}>()

defineEmits<{ clear: [] }>()

const outputEl = ref<HTMLElement>()

watch(
  () => props.lines.length,
  async () => {
    await nextTick()
    if (outputEl.value) {
      outputEl.value.scrollTop = outputEl.value.scrollHeight
    }
  },
)

function lineClass(line: OutputLine) {
  if (line.type === 'stderr') return 'text-red-400'
  if (line.type === 'info') return 'text-slate-500 italic'
  // Parse walt.ts log prefixes
  const d = line.data
  if (d.includes('[OK]')) return 'text-emerald-400'
  if (d.includes('[ERROR]')) return 'text-red-400'
  if (d.includes('[WARN]')) return 'text-yellow-400'
  if (d.includes('[SKIP]')) return 'text-slate-500'
  if (d.includes('[CONFIG]')) return 'text-cyan-400'
  if (d.includes('[SYSTEM]')) return 'text-orange-400'
  if (d.includes('[SETUP]')) return 'text-blue-400'
  if (d.includes('[RUN]')) return 'text-purple-400'
  if (d.includes('[INFO]')) return 'text-sky-400'
  return 'text-slate-300'
}

function formatLine(data: string) {
  // Escape HTML
  const escaped = data
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
}

const errorCount = computed(() =>
  props.lines.filter((l) => l.type === 'stderr' || l.data.includes('[ERROR]')).length,
)
const warnCount = computed(() => props.lines.filter((l) => l.data.includes('[WARN]')).length)
const okCount = computed(() => props.lines.filter((l) => l.data.includes('[OK]')).length)
</script>

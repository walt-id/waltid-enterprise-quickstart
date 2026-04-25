<template>
  <div
    class="group relative card p-3.5 transition-all duration-150 hover:border-slate-700"
    :class="[
      command.disabled ? 'opacity-50' : '',
      isActive ? 'ring-1 ring-brand-500 border-brand-800' : '',
    ]"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-medium text-slate-200 leading-tight">{{ command.label }}</span>
          <span
            v-if="command.danger"
            class="badge badge-red text-[10px]"
          >Destructive</span>
          <span
            v-if="command.disabled"
            class="badge badge-slate text-[10px]"
          >{{ command.disabledNote ?? 'Disabled' }}</span>
          <span
            v-if="isActive"
            class="badge badge-yellow text-[10px]"
          >Running</span>
        </div>
        <p class="text-xs text-slate-500 mt-1 leading-snug">{{ command.description }}</p>
        <code class="text-[10px] text-slate-600 font-mono mt-1.5 block">{{ command.flag }}</code>
      </div>

      <button
        :disabled="command.disabled || isRunning"
        class="flex-shrink-0 transition"
        :class="command.danger ? 'btn-danger' : 'btn-primary'"
        @click="$emit('run', command.flag)"
      >
        <svg v-if="isActive" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <svg v-else class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
        </svg>
        {{ isActive ? 'Running' : 'Run' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CommandDef } from '~/types'

const props = defineProps<{
  command: CommandDef
  isRunning: boolean
  activeCommand: string | null
}>()

defineEmits<{ run: [flag: string] }>()

const isActive = computed(() => props.activeCommand === props.command.flag && props.isRunning)
</script>

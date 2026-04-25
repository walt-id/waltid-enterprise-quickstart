<template>
  <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-800">
    <span
      class="w-1.5 h-1.5 rounded-full flex-shrink-0"
      :class="set ? 'bg-emerald-400' : 'bg-red-500'"
    />
    <code class="text-xs font-mono text-slate-400 flex-1 truncate">{{ name }}</code>
    <span class="text-xs" :class="set ? 'text-emerald-500' : 'text-red-500'">
      {{ set ? 'set' : 'missing' }}
    </span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ name: string; set: boolean }>()
</script>

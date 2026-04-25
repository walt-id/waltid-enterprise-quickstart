<template>
  <aside class="w-56 flex-shrink-0 flex flex-col bg-slate-900 border-r border-slate-800 h-screen sticky top-0">
    <!-- Logo -->
    <div class="px-4 py-5 border-b border-slate-800">
      <div class="flex items-center gap-2.5">
        <img src="~/assets/img.png" alt="Walt.id" class="h-7 w-auto flex-shrink-0" />
        <div class="text-xs text-slate-500 leading-none">Enterprise CLI</div>
      </div>
    </div>

    <!-- Nav -->
    <nav class="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
      <NuxtLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all group"
        :class="isActive(item.to) ? 'bg-brand-600/20 text-brand-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'"
      >
        <component :is="item.icon" class="w-4 h-4 flex-shrink-0" />
        {{ item.label }}
        <span
          v-if="item.badge"
          class="ml-auto text-xs px-1.5 py-0.5 rounded-full"
          :class="isActive(item.to) ? 'bg-brand-500/30 text-brand-300' : 'bg-slate-700 text-slate-400'"
        >{{ item.badge }}</span>
      </NuxtLink>

      <div class="pt-3 pb-1 px-3">
        <div class="text-xs font-medium text-slate-600 uppercase tracking-wider">Commands</div>
      </div>

      <NuxtLink
        v-for="cat in categories"
        :key="cat.to"
        :to="cat.to"
        class="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-all"
        :class="isActive(cat.to) ? 'bg-brand-600/20 text-brand-400 font-medium' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'"
      >
        <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="cat.dot" />
        {{ cat.label }}
      </NuxtLink>
    </nav>

    <!-- Status indicator + logout -->
    <div class="px-4 py-3 border-t border-slate-800 space-y-2">
      <div class="flex items-center gap-2">
        <div
          class="w-2 h-2 rounded-full flex-shrink-0 transition-colors"
          :class="isRunning ? 'bg-amber-400 animate-pulse' : exitCode === 0 ? 'bg-emerald-400' : exitCode !== null ? 'bg-red-400' : 'bg-slate-600'"
        />
        <span class="text-xs text-slate-500 truncate">
          <template v-if="isRunning">Running {{ currentCmd }}</template>
          <template v-else-if="exitCode === 0">Last run: OK</template>
          <template v-else-if="exitCode !== null">Last run: Failed ({{ exitCode }})</template>
          <template v-else>Idle</template>
        </span>
      </div>
      <button
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition"
        @click="logout"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
        </svg>
        Sign out ({{ authUser }})
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import {
  HomeIcon,
  CommandLineIcon,
  FolderOpenIcon,
} from '@heroicons/vue/24/outline'
import { COMMAND_CATEGORIES } from '~/data/commands'
import { useCommandStream } from '~/composables/useCommandStream'

const route = useRoute()
const { state } = useCommandStream()
const { authUser, logout } = useAuth()
const isRunning = computed(() => state.isRunning)
const exitCode = computed(() => state.exitCode)
const currentCmd = computed(() => state.command?.replace('--', '') ?? '')

const navItems = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/commands', label: 'Command Runner', icon: CommandLineIcon },
  { to: '/logs', label: 'Run Logs', icon: FolderOpenIcon },
]

const categories = COMMAND_CATEGORIES.map((cat) => ({
  label: cat.label,
  to: `/commands#${cat.id}`,
  dot: {
    red: 'bg-red-500',
    blue: 'bg-blue-500',
    green: 'bg-emerald-500',
    purple: 'bg-purple-500',
    orange: 'bg-orange-500',
  }[cat.color] ?? 'bg-slate-500',
}))

function isActive(to: string) {
  if (to.includes('#')) return false
  if (to === '/') return route.path === '/'
  return route.path.startsWith(to)
}
</script>

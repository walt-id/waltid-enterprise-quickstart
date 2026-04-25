<template>
  <div class="flex flex-col min-h-screen">
    <!-- Header -->
    <header class="px-6 py-5 border-b border-slate-800 flex-shrink-0">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold text-white">Command Runner</h1>
          <p class="text-sm text-slate-500 mt-0.5">Execute CLI commands and stream real-time output</p>
        </div>
        <button
          v-if="isRunning"
          class="btn-danger"
          @click="stop"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          Stop
        </button>
      </div>
    </header>

    <div class="flex flex-1 min-h-0 overflow-hidden">
      <!-- Left: commands -->
      <div class="w-96 flex-shrink-0 flex flex-col border-r border-slate-800 overflow-y-auto">
        <!-- Config toggle -->
        <div class="px-4 py-3 border-b border-slate-800">
          <button
            class="w-full flex items-center justify-between text-sm text-slate-400 hover:text-slate-200 transition"
            @click="showConfig = !showConfig"
          >
            <span class="font-medium">Configuration</span>
            <svg
              class="w-4 h-4 transition-transform"
              :class="showConfig ? 'rotate-180' : ''"
              fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        <div v-if="showConfig" class="px-4 py-4 border-b border-slate-800 bg-slate-900/50">
          <ConfigPanel />
        </div>

        <!-- Category sections -->
        <div class="flex-1 overflow-y-auto divide-y divide-slate-800">
          <div
            v-for="cat in categories"
            :key="cat.id"
            :id="cat.id"
          >
            <!-- Category header -->
            <button
              class="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 transition text-left"
              @click="toggleCategory(cat.id)"
            >
              <span
                class="w-2 h-2 rounded-full flex-shrink-0"
                :class="catDot(cat.color)"
              />
              <span class="text-sm font-semibold text-slate-200 flex-1">{{ cat.label }}</span>
              <span class="text-xs text-slate-600">{{ cat.commands.length }}</span>
              <svg
                class="w-4 h-4 text-slate-600 transition-transform flex-shrink-0"
                :class="openCats.includes(cat.id) ? 'rotate-180' : ''"
                fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            <!-- Commands list -->
            <div v-if="openCats.includes(cat.id)" class="px-3 pb-3 space-y-2">
              <CommandCard
                v-for="cmd in cat.commands"
                :key="cmd.flag"
                :command="cmd"
                :is-running="isRunning"
                :active-command="activeCommand"
                @run="runCommand"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Right: terminal -->
      <div class="flex-1 flex flex-col p-4 min-w-0">
        <div class="h-full">
          <TerminalOutput
            :lines="output"
            :is-running="isRunning"
            :exit-code="exitCode"
            :command="activeCommand"
            @clear="clear"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { COMMAND_CATEGORIES } from '~/data/commands'
import { useCommandStream } from '~/composables/useCommandStream'
import { useConfig } from '~/composables/useConfig'

definePageMeta({ layout: 'default' })

const { state, run, stop, clear } = useCommandStream()
const { toEnv } = useConfig()

const output = computed(() => state.output)
const isRunning = computed(() => state.isRunning)
const exitCode = computed(() => state.exitCode)
const activeCommand = computed(() => state.command)

const showConfig = ref(false)
const openCats = ref<string[]>(COMMAND_CATEGORIES.map((c) => c.id)) // all open by default

const categories = COMMAND_CATEGORIES

function toggleCategory(id: string) {
  if (openCats.value.includes(id)) {
    openCats.value = openCats.value.filter((c) => c !== id)
  } else {
    openCats.value = [...openCats.value, id]
  }
}

function catDot(color: string) {
  return {
    red: 'bg-red-500',
    blue: 'bg-blue-500',
    green: 'bg-emerald-500',
    purple: 'bg-purple-500',
    orange: 'bg-orange-500',
  }[color] ?? 'bg-slate-500'
}

function runCommand(flag: string) {
  run(flag, toEnv())
}
</script>

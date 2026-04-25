import type { OutputLine } from '~/types'

export interface RunState {
  output: OutputLine[]
  isRunning: boolean
  exitCode: number | null
  command: string | null
  startedAt: string | null
}

const state = reactive<RunState>({
  output: [],
  isRunning: false,
  exitCode: null,
  command: null,
  startedAt: null,
})

let activeEventSource: EventSource | null = null

export function useCommandStream() {
  async function run(cmd: string, env: Record<string, string> = {}) {
    if (state.isRunning) {
      activeEventSource?.close()
    }

    state.output = []
    state.isRunning = true
    state.exitCode = null
    state.command = cmd
    state.startedAt = new Date().toISOString()

    // Step 1: POST to get a single-use job token
    let jobId: string
    try {
      const result = await $fetch<{ jobId: string }>('/api/execute/start', {
        method: 'POST',
        body: { cmd, env },
      })
      jobId = result.jobId
    } catch (e: unknown) {
      const msg = (e as { statusMessage?: string })?.statusMessage ?? 'Failed to start command'
      state.output.push({ type: 'stderr', data: msg, timestamp: new Date().toISOString() })
      state.isRunning = false
      state.exitCode = -1
      return
    }

    // Step 2: open SSE stream — no sensitive data in URL
    const es = new EventSource(`/api/execute/stream?jobId=${encodeURIComponent(jobId)}`)
    activeEventSource = es

    es.onmessage = (event) => {
      try {
        const line: OutputLine = JSON.parse(event.data)
        if (line.type === 'exit') {
          state.exitCode = parseInt(line.data)
          state.isRunning = false
          es.close()
          activeEventSource = null
        } else {
          state.output.push(line)
        }
      } catch {
        // ignore parse errors
      }
    }

    es.onerror = () => {
      state.isRunning = false
      state.exitCode = -1
      es.close()
      activeEventSource = null
    }
  }

  function stop() {
    activeEventSource?.close()
    activeEventSource = null
    state.isRunning = false
  }

  function clear() {
    state.output = []
    state.exitCode = null
    state.command = null
    state.startedAt = null
  }

  return { state: readonly(state), run, stop, clear }
}

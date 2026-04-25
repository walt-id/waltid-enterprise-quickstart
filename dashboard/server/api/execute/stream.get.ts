import { spawn } from 'child_process'
import { resolve } from 'path'

export default defineEventHandler(async (event) => {
  const { jobId } = getQuery(event) as { jobId?: string }

  if (!jobId || !/^[0-9a-f]{32}$/.test(jobId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid job ID' })
  }

  const job = claimJob(jobId)
  if (!job) {
    throw createError({ statusCode: 404, statusMessage: 'Job not found or expired' })
  }

  const { res, req } = event.node

  // No wildcard CORS — same-origin only
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const config = useRuntimeConfig()
  const cliPath = resolve(process.cwd(), config.cliPath)

  // Build env: start from a clean base (not full process.env) to avoid leaking
  // host secrets, then explicitly inject what the CLI needs.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    // Non-sensitive overrides from the client-submitted job
    ...job.env,
    // Sensitive values — injected server-side from env vars only
    ...(process.env.WALT_ADMIN_PASSWORD && { ADMIN_PASSWORD: process.env.WALT_ADMIN_PASSWORD }),
    ...(process.env.WALT_SUPERADMIN_EMAIL && { EMAIL: process.env.WALT_SUPERADMIN_EMAIL }),
    ...(process.env.WALT_SUPERADMIN_PASSWORD && { PASSWORD: process.env.WALT_SUPERADMIN_PASSWORD }),
    ...(process.env.WALT_SUPERADMIN_TOKEN && { SUPERADMIN_TOKEN: process.env.WALT_SUPERADMIN_TOKEN }),
  }

  function sendEvent(type: string, data: string) {
    const payload = JSON.stringify({ type, data, timestamp: new Date().toISOString() })
    res.write(`data: ${payload}\n\n`)
  }

  sendEvent('info', `Executing: npx tsx walt.ts ${job.cmd}`)

  const proc = spawn('npx', ['tsx', 'walt.ts', job.cmd], {
    cwd: cliPath,
    env,
    shell: false, // prevents shell injection even if cmd somehow contained metacharacters
  })

  proc.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line) sendEvent('stdout', line)
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line) sendEvent('stderr', line)
    }
  })

  proc.on('error', (err) => {
    sendEvent('stderr', `Process error: ${err.message}`)
    sendEvent('exit', '-1')
    res.end()
  })

  proc.on('close', (code) => {
    sendEvent('exit', String(code ?? -1))
    res.end()
  })

  req.on('close', () => proc.kill('SIGTERM'))
})

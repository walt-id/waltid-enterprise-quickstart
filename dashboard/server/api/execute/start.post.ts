export default defineEventHandler(async (event) => {
  const body = await readBody<{ cmd: string; env?: Record<string, string> }>(event)
  const { cmd, env = {} } = body ?? {}

  // Strict whitelist — only known CLI flags are accepted
  if (!cmd || !VALID_COMMAND_FLAGS.has(cmd)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid or unknown command flag' })
  }

  // Only allow non-sensitive overrides from the client.
  // Credentials are injected server-side from process.env.
  const ALLOWED_ENV_KEYS = new Set(['BASE_URL', 'PORT', 'ORGANIZATION', 'TENANT', 'ADMIN_EMAIL'])
  const safeEnv: Record<string, string> = {}
  for (const key of ALLOWED_ENV_KEYS) {
    if (env[key]) safeEnv[key] = String(env[key])
  }

  const jobId = createJob(cmd, safeEnv)
  return { jobId }
})

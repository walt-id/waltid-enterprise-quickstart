import { writeFileSync } from 'fs'
import { resolve } from 'path'

// Only non-sensitive fields may be saved to disk
const ALLOWED_KEYS = new Set(['baseUrl', 'port', 'organization', 'tenant', 'adminEmail'])

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)

  const safe: Record<string, unknown> = {}
  for (const key of ALLOWED_KEYS) {
    if (key in body) safe[key] = body[key]
  }

  const configPath = resolve(process.cwd(), '.walt-config.json')
  writeFileSync(configPath, JSON.stringify(safe, null, 2))
  return { ok: true }
})

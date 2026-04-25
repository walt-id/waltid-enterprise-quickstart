import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const DEFAULTS = {
  baseUrl: 'enterprise.localhost',
  port: '',
  organization: 'waltid',
  tenant: '',
  adminEmail: 'admin@walt.id',
}

export default defineEventHandler(() => {
  // Non-sensitive config from disk
  const configPath = resolve(process.cwd(), '.walt-config.json')
  let stored: Partial<typeof DEFAULTS> = {}
  if (existsSync(configPath)) {
    try {
      stored = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
      stored = {}
    }
  }

  // Server-side env var status — booleans only, never the values themselves
  return {
    ...DEFAULTS,
    ...stored,
    envStatus: {
      adminPassword: !!process.env.WALT_ADMIN_PASSWORD,
      superadminEmail: !!process.env.WALT_SUPERADMIN_EMAIL,
      superadminPassword: !!process.env.WALT_SUPERADMIN_PASSWORD,
      superadminToken: !!process.env.WALT_SUPERADMIN_TOKEN,
    },
  }
})

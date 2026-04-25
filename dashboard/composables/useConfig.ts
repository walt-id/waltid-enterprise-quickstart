import type { WaltConfig, ConfigResponse, EnvStatus } from '~/types'

const DEFAULT_CONFIG: WaltConfig = {
  baseUrl: 'enterprise.localhost',
  port: '',
  organization: 'waltid',
  tenant: '',
  adminEmail: 'admin@walt.id',
}

export function useConfig() {
  const config = useState<WaltConfig>('walt-config', () => ({ ...DEFAULT_CONFIG }))
  const envStatus = useState<EnvStatus>('walt-env-status', () => ({
    adminPassword: false,
    superadminEmail: false,
    superadminPassword: false,
    superadminToken: false,
  }))

  async function loadConfig() {
    try {
      const data = await $fetch<ConfigResponse>('/api/config')
      if (data) {
        const { envStatus: es, ...cfg } = data
        config.value = cfg
        envStatus.value = es
      }
    } catch {
      // use defaults
    }
  }

  async function saveConfig(updates: Partial<WaltConfig>) {
    config.value = { ...config.value, ...updates }
    try {
      await $fetch('/api/config', { method: 'POST', body: config.value })
    } catch (e) {
      console.error('Failed to save config', e)
    }
  }

  /** Non-sensitive env overrides sent to /api/execute/start */
  function toEnv(): Record<string, string> {
    const c = config.value
    return {
      BASE_URL: c.baseUrl,
      PORT: c.port,
      ORGANIZATION: c.organization,
      TENANT: c.tenant,
      ADMIN_EMAIL: c.adminEmail,
    }
  }

  return { config, envStatus, loadConfig, saveConfig, toEnv }
}

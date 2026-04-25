

/** Non-sensitive runtime config editable from the UI */
export interface WaltConfig {
  baseUrl: string
  port: string
  organization: string
  tenant: string
  adminEmail: string
}

/** Which sensitive env vars are present on the server (boolean only) */
export interface EnvStatus {
  adminPassword: boolean
  superadminEmail: boolean
  superadminPassword: boolean
  superadminToken: boolean
}

export interface ConfigResponse extends WaltConfig {
  envStatus: EnvStatus
}

export interface OutputLine {
  type: 'stdout' | 'stderr' | 'exit' | 'info'
  data: string
  timestamp: string
}

export interface CommandDef {
  flag: string
  label: string
  description: string
  danger?: boolean
  disabled?: boolean
  disabledNote?: string
}

export interface CommandCategory {
  id: string
  label: string
  color: 'red' | 'blue' | 'green' | 'purple' | 'orange'
  icon: string
  description: string
  commands: CommandDef[]
}

export interface LogRun {
  dir: string
  date: string
  count: number
  fileCount: number
  path: string
}

export interface HttpLogEntry {
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body?: unknown
  }
  response: {
    status: number
    statusText: string
    headers: Record<string, string>
    data?: unknown
  }
  timestamp: string
}

export interface LogFile {
  name: string
  type: 'request' | 'response' | 'http-log' | 'other'
  step?: number
  command?: string
}

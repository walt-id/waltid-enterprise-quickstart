import { randomBytes } from 'crypto'

interface Session {
  createdAt: number
}

const sessions = new Map<string, Session>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 h

export function createSession(): string {
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { createdAt: Date.now() })
  return token
}

export function validateSession(token: string): boolean {
  const session = sessions.get(token)
  if (!session) return false
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token)
    return false
  }
  return true
}

export function deleteSession(token: string) {
  sessions.delete(token)
}

// Purge expired sessions every hour
setInterval(() => {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token)
  }
}, 60 * 60 * 1000)

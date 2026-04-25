import { timingSafeEqual } from 'crypto'

// In-memory rate limiter: max 10 failed attempts per IP per 15 min
const attempts = new Map<string, { count: number; resetAt: number }>()
const MAX_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000

function getClientIp(event: { node: { req: { socket?: { remoteAddress?: string } } } }): string {
  return (
    getHeader(event, 'x-forwarded-for')?.split(',')[0].trim() ??
    getHeader(event, 'x-real-ip') ??
    event.node.req.socket?.remoteAddress ??
    'unknown'
  )
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const record = attempts.get(ip)
  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }
  if (record.count >= MAX_ATTEMPTS) return true
  record.count++
  return false
}

function resetAttempts(ip: string) {
  attempts.delete(ip)
}

function safeEqual(a: string, b: string): boolean {
  // Pad to same length to avoid length-based timing leak
  const maxLen = Math.max(a.length, b.length)
  const bufA = Buffer.alloc(maxLen)
  const bufB = Buffer.alloc(maxLen)
  bufA.write(a)
  bufB.write(b)
  return timingSafeEqual(bufA, bufB)
}

export default defineEventHandler(async (event) => {
  const ip = getClientIp(event)

  if (isRateLimited(ip)) {
    throw createError({ statusCode: 429, statusMessage: 'Too many login attempts. Try again later.' })
  }

  const body = await readBody<{ username: string; password: string }>(event)
  const { username, password } = body ?? {}

  if (!username || !password) {
    throw createError({ statusCode: 400, statusMessage: 'username and password are required' })
  }

  const expectedUser = process.env.DASHBOARD_USER ?? 'admin'
  const expectedPass = process.env.DASHBOARD_PASSWORD ?? ''

  if (!expectedPass) {
    throw createError({
      statusCode: 503,
      statusMessage: 'DASHBOARD_PASSWORD environment variable is not set',
    })
  }

  const valid = safeEqual(username, expectedUser) && safeEqual(password, expectedPass)

  if (!valid) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }

  resetAttempts(ip)

  const token = createSession()
  const isSecure = process.env.NODE_ENV === 'production'

  setCookie(event, 'walt-session', token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60,
    path: '/',
  })

  return { ok: true }
})

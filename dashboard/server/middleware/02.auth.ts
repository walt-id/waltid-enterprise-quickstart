/**
 * Session guard for all /api/ routes except /api/auth/*.
 * Page routes are NOT guarded here — the SPA shell must load freely
 * so the client-side route middleware can redirect to /login.
 */
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname

  // Only guard API routes
  if (!path.startsWith('/api/')) return

  // Public auth endpoints
  if (path.startsWith('/api/auth/')) return

  // All other API routes require a valid session cookie
  const cookie = getCookie(event, 'walt-session')
  if (!validateSession(cookie ?? '')) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})

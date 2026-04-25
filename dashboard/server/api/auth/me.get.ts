export default defineEventHandler((event) => {
  const token = getCookie(event, 'walt-session')
  if (!token || !validateSession(token)) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' })
  }
  return { authenticated: true, user: process.env.DASHBOARD_USER ?? 'admin' }
})

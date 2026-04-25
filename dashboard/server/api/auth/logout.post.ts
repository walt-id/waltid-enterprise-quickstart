export default defineEventHandler((event) => {
  const token = getCookie(event, 'walt-session')
  if (token) deleteSession(token)

  deleteCookie(event, 'walt-session', { path: '/' })
  return { ok: true }
})

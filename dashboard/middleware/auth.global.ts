export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return

  const { check } = useAuth()
  const authed = await check()
  if (!authed) {
    return navigateTo('/login')
  }
})

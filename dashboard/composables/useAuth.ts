export function useAuth() {
  // useState must be called inside the composable function, not at module level,
  // so it runs within the Nuxt app context.
  const isAuthenticated = useState('auth-state', () => false)
  const authChecked = useState('auth-checked', () => false)
  const authUser = useState('auth-user', () => '')

  async function check(): Promise<boolean> {
    if (authChecked.value) return isAuthenticated.value
    try {
      const data = await $fetch<{ authenticated: boolean; user: string }>('/api/auth/me')
      isAuthenticated.value = data.authenticated
      authUser.value = data.user
    } catch {
      isAuthenticated.value = false
    }
    authChecked.value = true
    return isAuthenticated.value
  }

  async function logout() {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // ignore
    }
    isAuthenticated.value = false
    authChecked.value = false
    authUser.value = ''
    await navigateTo('/login')
  }

  return {
    isAuthenticated: readonly(isAuthenticated),
    authUser: readonly(authUser),
    check,
    logout,
  }
}

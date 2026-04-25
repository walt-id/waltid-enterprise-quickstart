<template>
  <div class="min-h-screen flex items-center justify-center bg-slate-950 px-4">
    <div class="w-full max-w-sm">
      <!-- Logo -->
      <div class="flex flex-col items-center gap-2 mb-8">
        <img src="~/assets/img.png" alt="Walt.id" class="h-10 w-auto" />
        <div class="text-xs text-slate-500 tracking-wide">Enterprise Dashboard</div>
      </div>

      <div class="card p-6">
        <h1 class="text-base font-semibold text-white mb-5">Sign in</h1>

        <form class="space-y-4" @submit.prevent="login">
          <div>
            <label class="label">Username</label>
            <input
              v-model="username"
              class="input"
              type="text"
              autocomplete="username"
              placeholder="admin"
              :disabled="loading"
              required
            />
          </div>

          <div>
            <label class="label">Password</label>
            <input
              v-model="password"
              class="input"
              type="password"
              autocomplete="current-password"
              placeholder="••••••••"
              :disabled="loading"
              required
            />
          </div>

          <div
            v-if="error"
            class="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-red-400 text-sm"
          >
            <svg class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
            </svg>
            {{ error }}
          </div>

          <button
            type="submit"
            class="btn-primary w-full justify-center py-2"
            :disabled="loading"
          >
            <svg v-if="loading" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {{ loading ? 'Signing in...' : 'Sign in' }}
          </button>
        </form>
      </div>

      <p class="text-center text-xs text-slate-600 mt-4">
        Credentials are set via <code class="font-mono text-slate-500">DASHBOARD_USER</code> / <code class="font-mono text-slate-500">DASHBOARD_PASSWORD</code>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const { check } = useAuth()

// Redirect if already logged in
onMounted(async () => {
  const authed = await check()
  if (authed) navigateTo('/')
})

async function login() {
  error.value = ''
  loading.value = true
  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    })
    // Invalidate cache so auth.global.ts re-checks
    useState('auth-checked').value = false
    await navigateTo('/')
  } catch (e: unknown) {
    const status = (e as { statusCode?: number })?.statusCode
    if (status === 429) {
      error.value = 'Too many attempts. Try again later.'
    } else if (status === 503) {
      error.value = 'Server misconfiguration: DASHBOARD_PASSWORD not set.'
    } else {
      error.value = 'Invalid username or password.'
    }
  } finally {
    loading.value = false
  }
}
</script>

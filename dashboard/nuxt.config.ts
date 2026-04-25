export default defineNuxtConfig({
  devtools: { enabled: false },
  devServer: { port: 3003 },
  modules: ['@nuxtjs/tailwindcss'],

  runtimeConfig: {
    cliPath: '../cli',
  },

  nitro: {
    experimental: {
      asyncContext: true,
    },
  },

  // Disable SSR — the app runs as a SPA served by the Nitro server,
  // so API calls automatically carry the session cookie.
  ssr: false,

  app: {
    head: {
      title: 'Walt.id Enterprise Dashboard',
      meta: [{ name: 'description', content: 'Walt.id Enterprise CLI Dashboard' }],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
        },
      ],
    },
  },

  compatibilityDate: '2024-11-01',
})
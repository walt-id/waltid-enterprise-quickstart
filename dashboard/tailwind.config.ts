import type { Config } from 'tailwindcss'

export default {
  content: [
    './components/**/*.{js,vue,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './composables/**/*.{js,ts}',
    './app.vue',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        brand: {
          50: '#f0f5ff',
          100: '#e0eaff',
          200: '#c7d8fe',
          300: '#a5bcfd',
          400: '#8198fb',
          500: '#6370f6',
          600: '#4f4eeb',
          700: '#433fd0',
          800: '#3735a8',
          900: '#302f85',
          950: '#1e1d4f',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
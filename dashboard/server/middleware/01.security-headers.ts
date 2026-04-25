/**
 * Adds security headers to every response.
 * Numbered 01 so it runs before the auth middleware.
 */
export default defineEventHandler((event) => {
  const headers = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-XSS-Protection': '1; mode=block',
    // Relaxed CSP: allows fonts.googleapis.com for Inter/JetBrains Mono
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",   // Nuxt inlines hydration scripts
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  }

  for (const [key, value] of Object.entries(headers)) {
    setResponseHeader(event, key, value)
  }
})

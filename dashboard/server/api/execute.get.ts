// Replaced by /api/execute/start (POST) + /api/execute/stream (GET).
// This stub ensures the old endpoint no longer responds.
export default defineEventHandler(() => {
  throw createError({ statusCode: 410, statusMessage: 'Gone — use /api/execute/start and /api/execute/stream' })
})

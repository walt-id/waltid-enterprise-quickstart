import { readdirSync, statSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import type { LogRun } from '~/types'

export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  const cliPath = resolve(process.cwd(), config.cliPath)

  if (!existsSync(cliPath)) {
    return []
  }

  const entries = readdirSync(cliPath)
  const runs: LogRun[] = []

  for (const dir of entries) {
    const match = dir.match(/^walt-log-(\d{4}-\d{2}-\d{2})-(\d{3})$/)
    if (!match) continue

    const fullPath = join(cliPath, dir)
    const stat = statSync(fullPath)
    if (!stat.isDirectory()) continue

    const files = readdirSync(fullPath)
    runs.push({
      dir,
      date: match[1],
      count: parseInt(match[2]),
      fileCount: files.length,
      path: fullPath,
    })
  }

  return runs.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    return b.count - a.count
  })
})

import { readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import type { LogFile } from '~/types'

export default defineEventHandler((event) => {
  const dir = getRouterParam(event, 'dir') as string

  // Sanitize: only allow walt-log-* pattern
  if (!dir || !/^walt-log-\d{4}-\d{2}-\d{2}-\d{3}$/.test(dir)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid log directory' })
  }

  const config = useRuntimeConfig()
  const cliPath = resolve(process.cwd(), config.cliPath)
  const dirPath = join(cliPath, dir)

  if (!existsSync(dirPath)) {
    throw createError({ statusCode: 404, statusMessage: 'Log directory not found' })
  }

  const files = readdirSync(dirPath).sort()
  const result: LogFile[] = files.map((name) => {
    const reqMatch = name.match(/^(\d+)-(.+)-request\.json$/)
    const resMatch = name.match(/^(\d+)-(.+)-response\.json$/)

    if (reqMatch) {
      return { name, type: 'request', step: parseInt(reqMatch[1]), command: reqMatch[2] }
    } else if (resMatch) {
      return { name, type: 'response', step: parseInt(resMatch[1]), command: resMatch[2] }
    } else if (name === 'walt-http-log.json') {
      return { name, type: 'http-log' }
    }
    return { name, type: 'other' }
  })

  return result
})

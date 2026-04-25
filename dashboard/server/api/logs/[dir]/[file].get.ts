import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'

export default defineEventHandler((event) => {
  const dir = getRouterParam(event, 'dir') as string
  const file = getRouterParam(event, 'file') as string

  if (!dir || !/^walt-log-\d{4}-\d{2}-\d{2}-\d{3}$/.test(dir)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid log directory' })
  }

  if (!file || !/^[\w.-]+\.json$/.test(file)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid file name' })
  }

  const config = useRuntimeConfig()
  const cliPath = resolve(process.cwd(), config.cliPath)
  const filePath = join(cliPath, dir, file)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, statusMessage: 'File not found' })
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return readFileSync(filePath, 'utf-8')
  }
})

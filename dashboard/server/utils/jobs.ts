import { randomBytes } from 'crypto'

export interface Job {
  cmd: string
  env: Record<string, string>
  createdAt: number
}

const jobs = new Map<string, Job>()
const JOB_TTL_MS = 30_000 // 30 s to open the SSE stream

export function createJob(cmd: string, env: Record<string, string>): string {
  const id = randomBytes(16).toString('hex')
  jobs.set(id, { cmd, env, createdAt: Date.now() })
  setTimeout(() => jobs.delete(id), JOB_TTL_MS)
  return id
}

/** Claim a job — each token is single-use */
export function claimJob(id: string): Job | null {
  const job = jobs.get(id)
  if (!job) return null
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    jobs.delete(id)
    return null
  }
  jobs.delete(id) // consumed
  return job
}

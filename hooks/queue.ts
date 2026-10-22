// Part of the prompt-scheduler plugin. Derived from seanrobertwright/claude-mods (auto-resume) and longmaba/no-limit (MIT); see NOTICE.
// Pure rules of the queue: who fires what, when. No `$`; the store and the clock stay in register.tsx.
import type { SchedulerJob as Job } from '../../types'
import { formatIn, formatWhen } from './schedule.ts'
import type { TzOffset } from './schedule.ts'

/** An owner silent this long (no heartbeat) is presumed gone: a session of the same directory adopts its jobs. */
export const ADOPT_AFTER_MS = 2 * 60_000

export function isJob(x: unknown): x is Job {
  if (typeof x !== 'object' || x === null) return false
  const j = x as Record<string, unknown>
  return (
    typeof j.id === 'string' &&
    typeof j.text === 'string' &&
    (j.kind === 'at' || j.kind === 'done' || j.kind === 'reset') &&
    (j.dueAt === undefined || typeof j.dueAt === 'number') &&
    typeof j.sessionId === 'string' &&
    typeof j.cwd === 'string' &&
    typeof j.createdAt === 'number'
  )
}

/** Four hex digits not in `taken`. */
export function newId(taken: readonly string[], rand: () => number = Math.random): string {
  for (let i = 0; i < 200; i++) {
    const id = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')
    if (!taken.includes(id)) return id
  }
  throw new Error('no free job id')
}

export type TickInput = {
  jobs: readonly Job[]
  now: number
  sessionId: string
  cwd: string
  /** Last heartbeat of each session, by id. */
  alive: Readonly<Record<string, number>>
  /** While a usage limit is active: when it lifts (resume time, grace included). */
  limitUntil?: number
  /** Most a job may be overdue and still be sent. */
  catchUpMs: number
  /** Whether a due job waits out a usage limit (default true); false sends it into the limit. */
  holdDuringLimit?: boolean
}

export type TickPlan = {
  /** Jobs taken over from a silent session (already carrying this sessionId). */
  adopt: Job[]
  /** `reset` jobs that learned their time (already carrying `dueAt`). */
  materialize: Job[]
  /** Due during a limit: moved to when it lifts (already carrying the new `dueAt`). */
  postpone: Job[]
  /** Overdue beyond the catch-up window: to be told about and dropped. */
  expire: Job[]
  /** Due and ours: to be removed from the store, then sent. */
  fire: Job[]
}

/** Decides one poll. Pure: the caller applies the plan to the store. */
export function planTick(input: TickInput): TickPlan {
  const { now, sessionId, cwd, alive, limitUntil, catchUpMs } = input
  const plan: TickPlan = { adopt: [], materialize: [], postpone: [], expire: [], fire: [] }
  const sorted = [...input.jobs].sort((a, b) => (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt) || a.createdAt - b.createdAt)

  for (const original of sorted) {
    let job = original
    if (job.sessionId !== sessionId) {
      const seen = alive[job.sessionId]
      const isSilent = seen === undefined || now - seen > ADOPT_AFTER_MS
      if (job.cwd !== cwd || !isSilent) continue
      job = { ...job, sessionId }
      plan.adopt.push(job)
    }
    if (job.kind === 'done') continue
    if (job.dueAt === undefined) {
      if (limitUntil !== undefined) plan.materialize.push({ ...job, dueAt: limitUntil })
      continue
    }
    if (now < job.dueAt) continue
    if (input.holdDuringLimit !== false && limitUntil !== undefined && now < limitUntil) {
      plan.postpone.push({ ...job, dueAt: limitUntil })
      continue
    }
    if (now - job.dueAt > catchUpMs) plan.expire.push(job)
    else plan.fire.push(job)
  }
  return plan
}

/** Earliest time among jobs that have one. */
export function nextDue(jobs: readonly Job[]): number | undefined {
  let next: number | undefined
  for (const job of jobs) if (job.dueAt !== undefined && (next === undefined || job.dueAt < next)) next = job.dueAt
  return next
}

/** `/schedule-cancel <id|all>`: `all`, a four-hex id, or undefined. */
export function parseCancel(arg: string): 'all' | string | undefined {
  const a = arg.trim().toLowerCase()
  if (a === 'all' || a === 'todo' || a === 'todos') return 'all'
  return /^[0-9a-f]{4}$/.test(a) ? a : undefined
}

/** The prompt cut to one line of at most `max` characters. */
export function snippet(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** When a job goes out, as `/schedule-queue` and the pane say it. */
export function describeWhen(job: Job, now: number, tz: TzOffset): string {
  if (job.kind === 'done') return 'al acabar el turno'
  if (job.dueAt === undefined) return 'al resetearse el límite'
  const when = `${formatWhen(job.dueAt, now, tz)} (en ${formatIn(job.dueAt - now)})`
  return job.kind === 'reset' ? `al resetearse el límite, ${when}` : when
}

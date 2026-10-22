// Part of the prompt-scheduler plugin. Derived from seanrobertwright/claude-mods (auto-resume) and longmaba/no-limit (MIT); see NOTICE.
// Pure rules for resuming after a usage limit: no `$`.
import type { SessionRateLimit } from 'claude-code'

import type { SchedulerPending } from '../../types'
import { systemOffset, wallToUtc } from './schedule.ts'
import type { TzOffset } from './schedule.ts'

const MINUTE = 60_000
const MAX_BACKOFF = 15 * MINUTE
/** Never resume sooner than this after a failure, whatever a window says. */
const FLOOR = 30_000
/** Longer than the native auto-continue's own wait, so ours only ever acts if the native one did not. */
export const DEFAULT_GRACE_MS = 120_000

export const DEFAULT_TEXT =
  'The usage limit has reset. Carry on with the task you were working on when the limit stopped you. If it was already finished, say so in one line.'

export type Config = {
  text: string
  graceMs: number
  retryOverloaded: boolean
  maxRetries: number
  /** Most a scheduled prompt may be overdue (app closed, laptop asleep) and still be sent. */
  catchUpMs: number
  /** Safety-net poll: the exact timers do the firing, the poll only catches what they missed (suspend, drift). */
  pollMs: number
  /** A scheduled prompt that falls due during a usage limit waits for the reset (else it is sent and meets the 429). */
  holdDuringLimit: boolean
}

/** Parses the manifest's userConfig values; a value out of range falls back to its default. */
export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const text = typeof options.schedulerResumeText === 'string' ? options.schedulerResumeText.replace(/\p{Cc}/gu, ' ').trim() : ''
  const grace = options.schedulerGraceSeconds
  const retries = options.schedulerMaxRetries
  const catchUp = options.schedulerCatchUpMinutes
  const poll = options.schedulerPollSeconds
  return {
    text: text === '' ? DEFAULT_TEXT : text,
    graceMs: typeof grace === 'number' && Number.isFinite(grace) && grace >= 0 && grace <= 900 ? grace * 1000 : DEFAULT_GRACE_MS,
    retryOverloaded: typeof options.schedulerRetryOverloaded === 'boolean' ? options.schedulerRetryOverloaded : true,
    maxRetries: typeof retries === 'number' && Number.isInteger(retries) && retries >= 1 && retries <= 20 ? retries : 5,
    catchUpMs: (typeof catchUp === 'number' && Number.isFinite(catchUp) && catchUp >= 0 && catchUp <= 1440 ? catchUp : 180) * MINUTE,
    holdDuringLimit: typeof options.schedulerHoldDuringLimit === 'boolean' ? options.schedulerHoldDuringLimit : true,
    pollMs: (typeof poll === 'number' && Number.isFinite(poll) && poll >= 5 && poll <= 60 ? poll : 5) * 1000,
  }
}

/**
 * The mod's one date helper: an ISO 8601 instant to milliseconds since the
 * epoch. A string without a zone (`Z` or an offset) is refused rather than
 * read as local time.
 */
export function instantMs(iso: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}

const WINDOW_NAMES: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  spend_limit: 'spend',
}

function windowName(kind: string): string {
  return Object.hasOwn(WINDOW_NAMES, kind) ? (WINDOW_NAMES[kind] ?? kind) : kind.replace(/_/g, ' ')
}

/**
 * The latest future reset among the windows that are full; failing that (and
 * unless `requireFull`) the five-hour window's, the one a busy session usually
 * runs out of. Undefined when there is none.
 */
export function findReset(
  rateLimits: readonly SessionRateLimit[],
  now: number,
  options: { requireFull?: boolean } = {},
): { at: number; kind: string } | undefined {
  const future: { at: number; kind: string; percentUsed: number }[] = []
  for (const window of rateLimits) {
    const at = window.resetsAt === undefined ? undefined : instantMs(window.resetsAt)
    if (at !== undefined && at > now) future.push({ at, kind: window.kind, percentUsed: window.percentUsed })
  }
  const full = future.filter(w => w.percentUsed >= 100)
  const candidates = full.length > 0 ? full : options.requireFull ? [] : future.filter(w => w.kind === 'five_hour')
  let latest: { at: number; kind: string } | undefined
  for (const w of candidates) if (latest === undefined || w.at > latest.at) latest = { at: w.at, kind: w.kind }
  return latest
}

/**
 * When to resume after a turn died on `error`: at the latest reset of an
 * exhausted rate-limit window plus the grace, or else on a backoff of one
 * minute doubling to fifteen. Undefined when the error is not worth waiting
 * out or the retries are spent.
 */
export function planResume(input: {
  error: string
  rateLimits: readonly SessionRateLimit[]
  now: number
  attempts: number
  config: Config
  /** The notice's text ("You've hit your session limit · resets 10pm (Europe/Madrid)"), read when the windows say nothing. */
  message?: string
  tz?: TzOffset
}): SchedulerPending | undefined {
  const { error, rateLimits, now, attempts, config } = input
  if (attempts >= config.maxRetries) return undefined
  const isRateLimit = error === 'rate_limit'
  const isTransient = error === 'overloaded' || error === 'server_error'
  if (!isRateLimit && !(isTransient && config.retryOverloaded)) return undefined

  if (isRateLimit) {
    const latest = findReset(rateLimits, now)
    if (latest !== undefined) {
      return {
        resumeAt: Math.max(latest.at + config.graceMs, now + FLOOR),
        reason: `${windowName(latest.kind)} limit reached`,
        isLimit: true,
        armedAt: now,
      }
    }
    const fromText = input.message === undefined ? undefined : parseResetText(input.message, now, input.tz ?? systemOffset)
    if (fromText !== undefined) {
      return { resumeAt: Math.max(fromText + config.graceMs, now + FLOOR), reason: 'usage limit reached', isLimit: true, armedAt: now }
    }
  }

  const backoff = Math.min(MINUTE * 2 ** attempts, MAX_BACKOFF)
  return {
    resumeAt: now + backoff,
    reason: isRateLimit ? 'rate limited' : error === 'overloaded' ? 'API overloaded' : 'API server error',
    armedAt: now,
    ...(isRateLimit ? { isLimit: true as const } : {}),
  }
}

/** A wait as people say it: `45 s`, `12 min`, `1 h 12 min`. */
export function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** `/schedule-resume in <minutes>`: a whole number of minutes from 1 to 1440, else undefined. */
export function parseMinutes(text: string): number | undefined {
  if (!/^\d{1,4}$/.test(text)) return undefined
  const minutes = Number.parseInt(text, 10)
  return minutes >= 1 && minutes <= 1440 ? minutes : undefined
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const RESETS = /resets?\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)(?:\s*\(([^)]+)\))?/i

/** The offset of an IANA zone (`Europe/Madrid`) at an instant, or undefined for a name the runtime does not know. */
export function zoneOffset(zone: string): TzOffset | undefined {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    return ms => {
      const p: Record<string, number> = {}
      for (const part of f.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value)
      return Math.round((Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0) - Math.floor(ms / 1000) * 1000) / MINUTE)
    }
  } catch {
    return undefined
  }
}

/**
 * The reset instant a usage-limit notice names: `resets 10pm (Europe/Madrid)`,
 * `resets 9:30am`, `resets Oct 2, 2am (Europe/Madrid)`. The zone in the text wins,
 * else `tz`. Undefined when the text names no time. Fallback only: the windows' `resetsAt` is exact.
 */
export function parseResetText(text: string, now: number, tz: TzOffset): number | undefined {
  const m = RESETS.exec(text)
  if (m === null) return undefined
  const hour12 = Number(m[3])
  if (hour12 < 1 || hour12 > 12) return undefined
  const minute = Number(m[4] ?? 0)
  if (minute > 59) return undefined
  const h = (hour12 % 12) + (m[5]?.toLowerCase() === 'pm' ? 12 : 0)
  const zone = m[6] === undefined ? undefined : zoneOffset(m[6].trim())
  const offset = zone ?? tz
  const local = new Date(now + offset(now) * MINUTE)
  const y = local.getUTCFullYear()
  const mo = local.getUTCMonth()
  const d = local.getUTCDate()
  if (m[1] !== undefined) {
    const month = MONTHS.indexOf(m[1].toLowerCase())
    if (month < 0) return undefined
    let at = wallToUtc(y, month, Number(m[2]), h, minute, offset)
    if (at <= now) at = wallToUtc(y + 1, month, Number(m[2]), h, minute, offset)
    return at
  }
  let at = wallToUtc(y, mo, d, h, minute, offset)
  if (at <= now) at = wallToUtc(y, mo, d + 1, h, minute, offset)
  return at
}

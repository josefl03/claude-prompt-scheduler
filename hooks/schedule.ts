// Part of the prompt-scheduler plugin. Derived from seanrobertwright/claude-mods (auto-resume) and longmaba/no-limit (MIT); see NOTICE.
// Pure grammar of `@when text`: no `$`, no clock of its own (now and the zone come in).

export type When =
  | { kind: 'at'; at: number; prompt: string }
  | { kind: 'done' | 'reset'; prompt: string }

/** Offset of the local zone from UTC, in minutes east, at an instant (what `-getTimezoneOffset()` gives). */
export type TzOffset = (utcMs: number) => number

const MINUTE = 60_000
const MAX_RELATIVE_MS = 31 * 24 * 60 * MINUTE
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const RELATIVE = /^(?:(\d{1,4})h)?(?:(\d{1,5})m)?(?:(\d{1,7})s)?$/i
const TOMORROW = /^(?:ma[ñn]ana|tomorrow)$/i

/** The system zone, for when nothing better is known. */
export const systemOffset: TzOffset = ms => -new Date(ms).getTimezoneOffset()

/**
 * Whether a prompt is meant as a schedule (`@17:00 ...`, `@2h ...`, `@done ...`),
 * valid or not: an invalid one is refused with a hint rather than sent to the model.
 * `@src/file.ts` and `@2fa.md` are mentions, not schedules.
 */
export function looksScheduled(text: string): boolean {
  const first = /^@(\S+)(?=\s|$)/.exec(text)?.[1]
  if (first === undefined) return false
  return /^(done|reset|ma[ñn]ana|tomorrow)$/i.test(first) || TIME.test(first) || (/^\d/.test(first) && RELATIVE.test(first))
}

/** The wall-clock time Y-M-D h:m in the zone, as a UTC instant (a gap in a DST change lands an hour on). */
export function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: TzOffset, sec = 0): number {
  const naive = Date.UTC(y, mo, d, h, mi, sec)
  const guess = naive - tz(naive) * MINUTE
  return naive - tz(guess) * MINUTE
}

/**
 * `17:00 text`, `17:00:30 text`, `9:30 text` (today, or tomorrow if past), `mañana 9:00 text`,
 * `2h30m text`, `45m text`, `30s text`, `done text`, `reset text`; a leading
 * `@` is optional. Null when it is none of those, the time is invalid, or the
 * text to send is empty.
 */
export function parseWhen(input: string, now: number, tz: TzOffset): When | null {
  const m = /^\s*@?(\S+)(?:\s+([\s\S]*))?$/.exec(input)
  if (m === null) return null
  const word = m[1] ?? ''
  let rest = m[2] ?? ''
  const finish = (build: (prompt: string) => When): When | null => {
    const prompt = rest.trim()
    return prompt === '' ? null : build(prompt)
  }

  if (/^done$/i.test(word)) return finish(prompt => ({ kind: 'done', prompt }))
  if (/^reset$/i.test(word)) return finish(prompt => ({ kind: 'reset', prompt }))

  let dayShift = 0
  let time = TIME.exec(word)
  if (TOMORROW.test(word)) {
    const t = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)
    time = TIME.exec(t?.[1] ?? '')
    rest = t?.[2] ?? ''
    dayShift = 1
  }
  if (time !== null) {
    const h = Number(time[1])
    const mi = Number(time[2])
    const sec = Number(time[3] ?? 0)
    if (h > 23 || mi > 59 || sec > 59) return null
    const local = new Date(now + tz(now) * MINUTE)
    const y = local.getUTCFullYear()
    const mo = local.getUTCMonth()
    const d = local.getUTCDate()
    let at = wallToUtc(y, mo, d + dayShift, h, mi, tz, sec)
    if (dayShift === 0 && at <= now) at = wallToUtc(y, mo, d + 1, h, mi, tz, sec)
    return finish(prompt => ({ kind: 'at', at, prompt }))
  }
  if (dayShift === 1) return null

  const rel = RELATIVE.exec(word)
  if (rel === null || (rel[1] === undefined && rel[2] === undefined && rel[3] === undefined)) return null
  const ms = (Number(rel[1] ?? 0) * 3600 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * 1000
  if (ms <= 0 || ms > MAX_RELATIVE_MS) return null
  return finish(prompt => ({ kind: 'at', at: now + ms, prompt }))
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `17:00` today, `mañana 09:00` tomorrow, `15/10 09:00` further out, in the zone. */
export function formatWhen(at: number, now: number, tz: TzOffset): string {
  const t = new Date(at + tz(at) * MINUTE)
  const n = new Date(now + tz(now) * MINUTE)
  const clock = `${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`
  const days = Math.round((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / 86_400_000)
  if (days === 0) return clock
  if (days === 1) return `mañana ${clock}`
  return `${two(t.getUTCDate())}/${two(t.getUTCMonth() + 1)} ${clock}`
}

/** A wait as people say it: `30s`, `45m`, `2h 14m`. */
export function formatIn(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`
}

const ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/

/** `AAAA-MM-DD HH:MM` (the date-time menu's default) in the zone, as a field's text; to the minute. */
export function formatField(at: number, tz: TzOffset): string {
  const t = new Date(at + tz(at) * MINUTE)
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`
}

/**
 * What the date-time menu's field accepts: `AAAA-MM-DD HH:MM[:SS]`, `HH:MM[:SS]` (today, or tomorrow if
 * past), `mañana 9:00`, `+30m`, `+2h`, `+90s` (the `+` is optional). Seconds are kept if typed, else the
 * time is on the minute. `error` says what is wrong, in words for the field.
 */
export function parseWhenInput(input: string, now: number, tz: TzOffset): { at: number } | { error: string } {
  const text = input.trim().replace(/^@/, '')
  if (text === '') return { error: 'Escribe cuándo: 17:30, +30m, mañana 9:00 o 2026-10-23 09:00.' }
  const abs = ABSOLUTE.exec(text)
  if (abs !== null) {
    const [y, mo, d, h, mi, sec] = [Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]), Number(abs[4]), Number(abs[5]), Number(abs[6] ?? 0)]
    const check = new Date(Date.UTC(y, mo, d, h, mi, sec))
    if (h > 23 || mi > 59 || sec > 59 || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return { error: 'Fecha u hora no válidas.' }
    const at = wallToUtc(y, mo, d, h, mi, tz, sec)
    return at <= now ? { error: 'Esa hora ya ha pasado.' } : { at }
  }
  const when = parseWhen(`${text.replace(/^\+/, '')} x`, now, tz)
  if (when?.kind !== 'at') return { error: 'No entiendo la hora. Prueba 17:30, +30m, +2h, mañana 9:00 o 2026-10-23 09:00.' }
  return { at: when.at }
}

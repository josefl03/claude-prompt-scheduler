import { expect, test } from 'claude-code/testing'

import { formatIn, formatWhen, looksScheduled, parseWhen } from '../hooks/schedule.ts'
import type { TzOffset } from '../hooks/schedule.ts'

/** Europe/Madrid: UTC+1, +2 from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC. */
function lastSunday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0))
  return last.getUTCDate() - last.getUTCDay()
}
const madrid: TzOffset = ms => {
  const y = new Date(ms).getUTCFullYear()
  const start = Date.UTC(y, 2, lastSunday(y, 2), 1)
  const end = Date.UTC(y, 9, lastSunday(y, 9), 1)
  return ms >= start && ms < end ? 120 : 60
}
const utc: TzOffset = () => 0
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s)

// 2026-10-14 21:45 in Madrid (CEST, +2) is 19:45 UTC
const NOW = at(2026, 10, 14, 19, 45)

test('@HH:MM today when still ahead, in the local zone', () => {
  expect(parseWhen('@23:51 hola', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 14, 21, 51), prompt: 'hola' })
  expect(parseWhen('@9:30 hola', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 15, 7, 30), prompt: 'hola' })
  expect(parseWhen('@17:00 x', NOW, utc)).toEqual({ kind: 'at', at: at(2026, 10, 15, 17), prompt: 'x' })
})

test('the same minute or a past one rolls to tomorrow; the leading @ is optional', () => {
  expect(parseWhen('21:45 x', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 15, 19, 45), prompt: 'x' })
  expect(parseWhen('21:46 x', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 14, 19, 46), prompt: 'x' })
  expect(parseWhen('00:00 x', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 14, 22), prompt: 'x' })
})

test('mañana and tomorrow add a day, even for a time still ahead today', () => {
  expect(parseWhen('@mañana 9:00 revisa', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 15, 7), prompt: 'revisa' })
  expect(parseWhen('@Tomorrow 23:59 x', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 15, 21, 59), prompt: 'x' })
  expect(parseWhen('@manana 08:15 x', NOW, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 15, 6, 15), prompt: 'x' })
  expect(parseWhen('@mañana x', NOW, madrid)).toBeNull()
  expect(parseWhen('@mañana 25:00 x', NOW, madrid)).toBeNull()
})

test('relative times: hours, minutes, seconds and their mixes', () => {
  expect(parseWhen('@2h30m texto', NOW, madrid)).toEqual({ kind: 'at', at: NOW + 150 * 60_000, prompt: 'texto' })
  expect(parseWhen('@45m texto', NOW, madrid)).toEqual({ kind: 'at', at: NOW + 45 * 60_000, prompt: 'texto' })
  expect(parseWhen('@30s texto', NOW, madrid)).toEqual({ kind: 'at', at: NOW + 30_000, prompt: 'texto' })
  expect(parseWhen('@1h texto', NOW, madrid)).toEqual({ kind: 'at', at: NOW + 3_600_000, prompt: 'texto' })
  expect(parseWhen('@1h1m1s texto', NOW, madrid)).toEqual({ kind: 'at', at: NOW + 3_661_000, prompt: 'texto' })
  expect(parseWhen('@0m texto', NOW, madrid)).toBeNull()
  expect(parseWhen('@0s texto', NOW, madrid)).toBeNull()
  expect(parseWhen('@999h texto', NOW, madrid)).toBeNull()
})

test('@done and @reset carry their text, any case', () => {
  expect(parseWhen('@done sigue', NOW, madrid)).toEqual({ kind: 'done', prompt: 'sigue' })
  expect(parseWhen('@RESET sigue', NOW, madrid)).toEqual({ kind: 'reset', prompt: 'sigue' })
  expect(parseWhen('done sigue', NOW, madrid)).toEqual({ kind: 'done', prompt: 'sigue' })
})

test('the text may span lines and keeps its inner spacing', () => {
  expect(parseWhen('@10m  uno\n\n  dos   tres  ', NOW, madrid)).toEqual({ kind: 'at', at: NOW + 600_000, prompt: 'uno\n\n  dos   tres' })
})

test('invalid hours, empty text and non-schedules are null', () => {
  for (const bad of ['@24:00 x', '@12:60 x', '@25:00 x', '@17:00', '@17:00   ', '@done', '@reset  ', '@', '', '   ', 'hola', '@hola x', '@1:5 x', '@17.00 x', '@h x', '@2x x', '@-5m x']) {
    expect(parseWhen(bad, NOW, madrid), bad).toBeNull()
  }
})

test('midnight and the end of the month roll over correctly', () => {
  const lateNight = at(2026, 12, 31, 22, 30) // 23:30 Madrid winter
  expect(parseWhen('@00:15 x', lateNight, madrid)).toEqual({ kind: 'at', at: at(2026, 12, 31, 23, 15), prompt: 'x' })
  expect(parseWhen('@mañana 0:00 x', lateNight, madrid)).toEqual({ kind: 'at', at: at(2026, 12, 31, 23), prompt: 'x' })
  const feb = at(2028, 2, 28, 12) // 2028 is a leap year
  expect(parseWhen('@mañana 12:00 x', feb, utc)).toEqual({ kind: 'at', at: at(2028, 2, 29, 12), prompt: 'x' })
})

test('DST: a wall time keeps its meaning across the change, a gap lands an hour on', () => {
  // 2026-10-24 21:00 Madrid (CEST) -> tomorrow 09:00 is after the change on the 25th (CET, +1)
  const sat = at(2026, 10, 24, 19)
  expect(parseWhen('@mañana 9:00 x', sat, madrid)).toEqual({ kind: 'at', at: at(2026, 10, 25, 8), prompt: 'x' })
  // 2026-03-28 22:00 Madrid (CET): tomorrow 09:00 is CEST (+2)
  const march = at(2026, 3, 28, 21)
  expect(parseWhen('@mañana 9:00 x', march, madrid)).toEqual({ kind: 'at', at: at(2026, 3, 29, 7), prompt: 'x' })
  // 02:30 on 2026-03-29 does not exist: it lands at 03:30 CEST = 01:30 UTC
  expect(parseWhen('@mañana 2:30 x', march, madrid)).toEqual({ kind: 'at', at: at(2026, 3, 29, 1, 30), prompt: 'x' })
  // relative times ignore the zone: 3h across the autumn change is exactly 3h
  expect(parseWhen('@3h x', at(2026, 10, 24, 23, 30), madrid)).toEqual({ kind: 'at', at: at(2026, 10, 24, 23, 30) + 3 * 3_600_000, prompt: 'x' })
})

test('looksScheduled tells a schedule from a mention', () => {
  for (const yes of ['@17:00 x', '@2h x', '@45m', '@done x', '@reset', '@mañana 9:00 x', '@tomorrow 9:00 x', '@25:00 x', '@999h x']) expect(looksScheduled(yes), yes).toBe(true)
  for (const no of ['hola', '@src/file.ts explica', '@2fa.md explica', '@reset-password.ts', '@done-list.md', ' @17:00 x', '@']) expect(looksScheduled(no), no).toBe(false)
})

test('formatWhen and formatIn read the way people say them', () => {
  expect(formatWhen(at(2026, 10, 14, 21, 51), NOW, madrid)).toBe('23:51')
  expect(formatWhen(at(2026, 10, 15, 7), NOW, madrid)).toBe('mañana 09:00')
  expect(formatWhen(at(2026, 10, 20, 7, 5), NOW, madrid)).toBe('20/10 09:05')
  expect(formatIn(30_000)).toBe('30s')
  expect(formatIn(45 * 60_000)).toBe('45m')
  expect(formatIn((2 * 60 + 14) * 60_000)).toBe('2h 14m')
  expect(formatIn(3 * 3_600_000)).toBe('3h')
})

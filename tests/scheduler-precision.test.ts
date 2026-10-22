import { expect, test } from 'claude-code/testing'

import { COMPOSER, MINUTE, NOW, engineBeneath, fiveHourFull, jobIn } from './scheduler-helpers.ts'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
// The safety-net poll is set to its slowest (60 s): anything sent earlier was sent by an exact timer.
const SLOW_POLL = { options: { schedulerPollSeconds: 60 } } as const
const submit = ($: { prompt: { submit: (a: never) => Promise<unknown> } }, text: string) => $.prompt.submit({ text, origin: COMPOSER } as never) as Promise<{ drop?: string }>
const jobKeys = (store: Map<string, unknown>) => [...store.keys()].filter(k => k.startsWith('job:'))

test('a job fires exactly at its time, not before, without waiting for the poll', SLOW_POLL, async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  await submit($, '@20s puntual')
  await clock.advance(19_999)
  expect(sent).toEqual([])
  await clock.advance(1)
  expect(sent).toEqual(['puntual'])
})

test('the log carries the real latency of each firing', SLOW_POLL, async ($, on) => {
  const { logs, clock } = engineBeneath(on)
  await $.session.start(START)
  await submit($, '@30s con latencia')
  await clock.advance(30_000)
  const line = logs.find(l => l.includes('fired job'))
  expect(line).toMatch(/\[scheduler\] fired job [0-9a-f]{4} due=\S+ at=\S+ late=0ms/)
  expect(line).toContain(`due=${new Date(NOW + 30_000).toISOString()}`)
})

test('a job stored by an earlier run is armed at session start', SLOW_POLL, async ($, on) => {
  const { store, sent, clock } = engineBeneath(on)
  jobIn(store, 'aaaa', { dueAt: NOW + 30_000 })
  await $.session.start(START)
  await clock.advance(29_999)
  expect(sent).toEqual([])
  await clock.advance(1)
  expect(sent).toEqual(['text aaaa'])
})

test('cancelling a job cancels its timer', SLOW_POLL, async ($, on) => {
  const { store, sent, clock } = engineBeneath(on)
  await $.session.start(START)
  await submit($, '@20s no')
  await submit($, '@40s si')
  const [first = ''] = jobKeys(store)
  const earlier = [...jobKeys(store)].map(k => store.get(k) as { id: string; dueAt: number }).sort((a, b) => a.dueAt - b.dueAt)[0]
  await $.command.run({ command: 'schedule-cancel', args: earlier?.id ?? first.slice(4), presentation: { isFullscreen: false, columns: 100 }, origin: COMPOSER } as never)
  await clock.advance(20_000)
  expect(sent).toEqual([])
  await clock.advance(20_000)
  expect(sent).toEqual(['si'])
})

test('a job postponed behind a limit is re-armed for the new time', SLOW_POLL, async ($, on) => {
  const { sent, store, clock } = engineBeneath(on)
  await $.session.start(START)
  await submit($, '@30s tarea')
  await $.session.measure({ context: { window: 200_000 }, rateLimits: fiveHourFull(MINUTE), changed: ['rateLimits'] } as never)
  await clock.advance(30_000)
  expect(sent).toEqual([])
  // The limit lifts at +61 min... no: at reset (+60 s) plus the 120 s grace.
  expect((store.get(jobKeys(store)[0] ?? '') as { dueAt: number }).dueAt).toBe(NOW + 3 * MINUTE)
  await clock.advance(3 * MINUTE - 30_001)
  expect(sent).toEqual([])
  await clock.advance(1)
  expect(sent).toEqual(['tarea'])
})

test('the poll still catches a job whose timer was lost (suspend)', async ($, on) => {
  const { store, sent, clock } = engineBeneath(on)
  await $.session.start(START)
  // Written straight to the store, as another process or an adoption would: no timer was armed for it.
  jobIn(store, 'late', { dueAt: NOW + 2000 })
  await clock.advance(6_000)
  expect(sent).toEqual(['text late'])
})

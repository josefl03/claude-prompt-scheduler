import { expect, test } from 'claude-code/testing'

import { ADOPT_AFTER_MS, describeWhen, isJob, newId, nextDue, parseCancel, planTick, snippet } from '../hooks/queue.ts'
import type { SchedulerJob as Job } from '../types'

const NOW = 1_800_000_000_000
const MIN = 60_000
const job = (id: string, extra: Partial<Job> = {}): Job => ({ id, text: `t${id}`, kind: 'at', dueAt: NOW - MIN, sessionId: 'A', cwd: '/w', createdAt: NOW - 10 * MIN, ...extra })
const base = { now: NOW, sessionId: 'A', cwd: '/w', alive: { A: NOW }, catchUpMs: 180 * MIN }
const ids = (jobs: Job[]) => jobs.map(j => j.id)

test('a job that is due goes out, one that is not waits', () => {
  const plan = planTick({ ...base, jobs: [job('0001'), job('0002', { dueAt: NOW + MIN })] })
  expect(ids(plan.fire)).toEqual(['0001'])
  expect(plan.expire).toEqual([])
})

test('overdue beyond the catch-up window expires, inside it is sent', () => {
  const plan = planTick({ ...base, jobs: [job('0001', { dueAt: NOW - 179 * MIN }), job('0002', { dueAt: NOW - 181 * MIN })] })
  expect(ids(plan.fire)).toEqual(['0001'])
  expect(ids(plan.expire)).toEqual(['0002'])
  expect(ids(planTick({ ...base, catchUpMs: 0, jobs: [job('0003', { dueAt: NOW - 1 })] }).expire)).toEqual(['0003'])
})

test('due jobs go out oldest first', () => {
  const plan = planTick({ ...base, jobs: [job('0002', { dueAt: NOW - MIN }), job('0001', { dueAt: NOW - 5 * MIN })] })
  expect(ids(plan.fire)).toEqual(['0001', '0002'])
})

test('during a usage limit a due job is moved to when it lifts, not sent or expired', () => {
  const plan = planTick({ ...base, limitUntil: NOW + 30 * MIN, jobs: [job('0001', { dueAt: NOW - 500 * MIN })] })
  expect(plan.fire).toEqual([])
  expect(plan.expire).toEqual([])
  expect(plan.postpone).toEqual([{ ...job('0001', { dueAt: NOW + 30 * MIN }) }])
})

test('a limit that has lifted lets the job go', () => {
  expect(ids(planTick({ ...base, limitUntil: NOW, jobs: [job('0001')] }).fire)).toEqual(['0001'])
})

test('done jobs are left to turn.complete', () => {
  const plan = planTick({ ...base, jobs: [job('0001', { kind: 'done', dueAt: undefined })] })
  expect(plan).toEqual({ adopt: [], materialize: [], postpone: [], expire: [], fire: [] })
})

test('a reset job without a time learns it from the limit, and waits without one', () => {
  const pending = job('0001', { kind: 'reset', dueAt: undefined })
  expect(planTick({ ...base, limitUntil: NOW + 5 * MIN, jobs: [pending] }).materialize).toEqual([{ ...pending, dueAt: NOW + 5 * MIN }])
  expect(planTick({ ...base, jobs: [pending] }).materialize).toEqual([])
})

test('a silent owner of the same directory loses its jobs; a live one or another directory does not', () => {
  const theirs = (id: string, extra: Partial<Job> = {}) => job(id, { sessionId: 'B', ...extra })
  const silent = planTick({ ...base, alive: { A: NOW, B: NOW - ADOPT_AFTER_MS - 1 }, jobs: [theirs('0001')] })
  expect(silent.adopt).toEqual([{ ...theirs('0001'), sessionId: 'A' }])
  expect(ids(silent.fire)).toEqual(['0001'])
  expect(ids(planTick({ ...base, alive: { A: NOW }, jobs: [theirs('0002')] }).adopt)).toEqual(['0002']) // no heartbeat at all
  const live = planTick({ ...base, alive: { A: NOW, B: NOW - ADOPT_AFTER_MS + 1000 }, jobs: [theirs('0003')] })
  expect(live).toEqual({ adopt: [], materialize: [], postpone: [], expire: [], fire: [] })
  const elsewhere = planTick({ ...base, alive: { A: NOW }, jobs: [theirs('0004', { cwd: '/other' })] })
  expect(elsewhere.adopt).toEqual([])
  expect(elsewhere.fire).toEqual([])
})

test('ids are four hex digits and never one already taken', () => {
  expect(newId([], () => 0.5)).toBe('8000')
  expect(newId(['8000'], (() => { let n = 0; return () => (n++ === 0 ? 0.5 : 0.25) })())).toBe('4000')
  expect(newId([], Math.random)).toMatch(/^[0-9a-f]{4}$/)
})

test('store values are checked before use', () => {
  expect(isJob(job('0001'))).toBe(true)
  expect(isJob({ ...job('0001'), kind: 'weekly' })).toBe(false)
  expect(isJob({ id: 'x' })).toBe(false)
  expect(isJob(null)).toBe(false)
  expect(isJob('job')).toBe(false)
})

test('cancel arguments, snippets, next time and descriptions', () => {
  expect(parseCancel('a3f9')).toBe('a3f9')
  expect(parseCancel(' ALL ')).toBe('all')
  expect(parseCancel('xyz')).toBeUndefined()
  expect(parseCancel('')).toBeUndefined()
  expect(snippet('a\n  b   c', 60)).toBe('a b c')
  expect(snippet('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
  expect(nextDue([job('0001', { dueAt: NOW + 9 * MIN }), job('0002', { dueAt: NOW + 3 * MIN }), job('0003', { kind: 'done', dueAt: undefined })])).toBe(NOW + 3 * MIN)
  expect(nextDue([])).toBeUndefined()
  const utc = () => 0
  expect(describeWhen(job('0001', { dueAt: NOW + 90 * MIN }), NOW, utc)).toMatch(/^\d\d:\d\d \(en 1h 30m\)$|^mañana \d\d:\d\d \(en 1h 30m\)$/)
  expect(describeWhen(job('0001', { kind: 'done', dueAt: undefined }), NOW, utc)).toBe('al acabar el turno')
})

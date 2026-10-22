import { expect, test } from 'claude-code/testing'

import { findReset } from '../hooks/plan.ts'
import { parseWhen, systemOffset } from '../hooks/schedule.ts'
import { BAND, COMPOSER, MINUTE, NOW, PANE, RUN, engineBeneath, fiveHourFull, jobIn } from './scheduler-helpers.ts'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const submit = ($: { prompt: { submit: (a: never) => Promise<unknown> } }, text: string) => $.prompt.submit({ text, origin: COMPOSER } as never) as Promise<{ drop?: string }>
const jobKeys = (store: Map<string, unknown>) => [...store.keys()].filter(k => k.startsWith('job:'))

test('@20s is dropped with a confirmation, stored, and sent once when due', async ($, on) => {
  const { store, sent, toasts, clock } = engineBeneath(on)
  await $.session.start(START)

  const dropped = await submit($, '@20s di hola')
  expect(dropped.drop).toMatch(/^⏰ Programado para \d\d:\d\d \(en 20s\) · id [0-9a-f]{4}$/)
  expect(toasts.some(t => t.startsWith('⏰ Programado'))).toBe(true)
  expect(sent).toEqual([])
  const [key] = jobKeys(store)
  expect(store.get(key ?? '')).toMatchObject({ text: 'di hola', kind: 'at', dueAt: NOW + 20_000, sessionId: 'sess-A', cwd: '/work' })

  await clock.advance(19_000)
  expect(sent).toEqual([])
  await clock.advance(16_000)
  expect(sent).toEqual(['di hola'])
  expect(jobKeys(store)).toEqual([])
  await clock.advance(5 * MINUTE)
  expect(sent).toEqual(['di hola'])
})

test('@HH:MM is read in the zone of the mod', async ($, on) => {
  const { store } = engineBeneath(on)
  await $.session.start(START)
  await submit($, '@23:59 tarde')
  const job = store.get(jobKeys(store)[0] ?? '') as { dueAt: number }
  expect(job.dueAt).toBe((parseWhen('@23:59 tarde', NOW, systemOffset) as { at: number }).at)
})

test('a reinjected prompt is not intercepted again, and a mention or plain prompt passes', async ($, on) => {
  const { sent, store } = engineBeneath(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '@5m me lo reenvío', origin: { kind: 'plugin', name: 'auto-resume', asUser: true } } as never)
  await $.prompt.submit({ text: '@src/a.ts explica', origin: COMPOSER } as never)
  await $.prompt.submit({ text: 'hola', origin: COMPOSER } as never)
  expect(sent).toEqual(['@5m me lo reenvío', '@src/a.ts explica', 'hola'])
  expect(jobKeys(store)).toEqual([])
})

test('a schedule that does not parse is dropped with a hint and nothing is stored', async ($, on) => {
  const { sent, store } = engineBeneath(on)
  await $.session.start(START)
  for (const bad of ['@25:00 x', '@17:00', '@999h x']) expect((await submit($, bad)).drop).toMatch(/^Hora o texto no válidos\. Uso: /)
  expect(sent).toEqual([])
  expect(jobKeys(store)).toEqual([])
})

test('the prompt box is emptied after a drop', async ($, on) => {
  const filled: unknown[] = []
  const { clock } = engineBeneath(on, { onFill: e => filled.push(e) })
  await $.session.start(START)
  await submit($, '@5m x')
  expect(filled).toEqual([])
  await clock.advance(300)
  expect(filled).toMatchObject([{ text: '', mode: 'replace' }])
})

test('/schedule-at, /schedule-queue and /schedule-cancel', async ($, on) => {
  const { store, sent, clock } = engineBeneath(on)
  await $.session.start(START)
  const at = await $.command.run({ command: 'schedule-at', args: '2h30m revisa los logs', ...RUN })
  expect(at.text).toMatch(/^⏰ Programado para .* \(en 2h 30m\) · id [0-9a-f]{4}$/)
  expect((await $.command.run({ command: 'schedule-at', args: 'nunca', ...RUN })).text).toMatch(/^Hora o texto no válidos/)
  await $.command.run({ command: 'schedule-at', args: '1h otro', ...RUN })

  const queue = (await $.command.run({ command: 'schedule-queue', args: '', ...RUN })).text
  expect(queue).toMatch(/^2 programados en esta sesión:\n[0-9a-f]{4}  .*\(en 1h\)  otro\n[0-9a-f]{4}  .*revisa los logs/)
  const [first = ''] = jobKeys(store)
  const id = first.slice(4)
  expect((await $.command.run({ command: 'schedule-cancel', args: id, ...RUN })).text).toBe('Cancelados: 1.')
  expect((await $.command.run({ command: 'schedule-cancel', args: id, ...RUN })).text).toBe(`No hay ningún programado con id ${id}.`)
  expect((await $.command.run({ command: 'schedule-cancel', args: '??', ...RUN })).text).toMatch(/^Uso: /)
  await $.command.run({ command: 'schedule-at', args: '5m uno', ...RUN })
  expect((await $.command.run({ command: 'schedule-cancel', args: 'all', ...RUN })).text).toBe('Cancelados: 2.')
  expect((await $.command.run({ command: 'schedule-queue', args: '', ...RUN })).text).toBe('Cola vacía.')
  await clock.advance(6 * MINUTE)
  expect(sent).toEqual([])
})

test('/schedule-queue and /schedule-cancel all only see this session; /schedule-queue all and /schedule-cancel <id> reach the others', async ($, on) => {
  const { store } = engineBeneath(on)
  await $.session.start(START)
  store.set('alive:sess-B', NOW)
  jobIn(store, 'b001', { sessionId: 'sess-B', dueAt: NOW + 2 * MINUTE })
  await $.command.run({ command: 'schedule-at', args: '1h mio', ...RUN })

  const mine = (await $.command.run({ command: 'schedule-queue', args: '', ...RUN })).text
  expect(mine).toMatch(/^1 programado en esta sesión:\n.*mio\n\(\+1 en otras sesiones: \/schedule-queue all\)$/)
  expect(mine).not.toMatch(/b001/)
  const all = (await $.command.run({ command: 'schedule-queue', args: 'all', ...RUN })).text
  expect(all).toMatch(/^2 programados \(todas las sesiones\):/)
  expect(all).toMatch(/b001 .*\[sesión sess-B · \/work\]/)

  expect((await $.command.run({ command: 'schedule-cancel', args: 'all', ...RUN })).text).toBe('Cancelados: 1.')
  expect(store.has('job:b001')).toBe(true)
  expect((await $.command.run({ command: 'schedule-queue', args: '', ...RUN })).text).toBe('Cola vacía. (1 en otras sesiones: /schedule-queue all)')
  expect((await $.command.run({ command: 'schedule-cancel', args: 'b001', ...RUN })).text).toBe('Cancelados: 1.')
  expect(store.has('job:b001')).toBe(false)
})

test('@done waits for the end of the main turn, not a subagent, not an abort', async ($, on) => {
  const { sent, store } = engineBeneath(on)
  await $.session.start(START)
  await $.turn.start({ text: 'trabaja', turnId: 't1' })
  const dropped = await submit($, '@done y ahora esto')
  expect(dropped.drop).toMatch(/^⏰ Se enviará al acabar el turno actual · id /)
  expect(store.get(jobKeys(store)[0] ?? '')).toMatchObject({ kind: 'done' })

  await $.turn.complete({ turnId: 's1', agentId: 'sub', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(sent).toEqual([])
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  expect(sent).toEqual([])
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(sent).toEqual(['y ahora esto'])
  expect(jobKeys(store)).toEqual([])
})

test('@done with nothing running goes out at once', async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  const dropped = await submit($, '@done ya')
  expect(dropped.drop).toMatch(/^⏰ Se enviará ahora/)
  await clock.settle()
  expect(sent).toEqual(['ya'])
})

test('@reset with no limit is like @done; with one it waits for the reset plus the grace', async ($, on) => {
  const { sent, store, clock } = engineBeneath(on)
  await $.session.start(START)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: fiveHourFull(10 * MINUTE), changed: ['rateLimits'] } as never)
  const dropped = await submit($, '@reset tras el reset')
  expect(dropped.drop).toMatch(/^⏰ Se enviará al resetearse el límite, .* \(en 12m\) · id /)
  expect(store.get(jobKeys(store)[0] ?? '')).toMatchObject({ kind: 'reset', dueAt: NOW + 12 * MINUTE })
  await clock.advance(10 * MINUTE)
  expect(sent).toEqual([])
  await clock.advance(2 * MINUTE + 5_000)
  expect(sent).toEqual(['tras el reset'])
})

test('a job that falls due during a limit is held until the reset', async ($, on) => {
  const { sent, store, clock } = engineBeneath(on)
  await $.session.start(START)
  await submit($, '@5m tarea')
  await $.session.measure({ context: { window: 200_000 }, rateLimits: fiveHourFull(60 * MINUTE), changed: ['rateLimits'] } as never)
  await clock.advance(6 * MINUTE)
  expect(sent).toEqual([])
  expect(store.get(jobKeys(store)[0] ?? '')).toMatchObject({ dueAt: NOW + 62 * MINUTE })
  await clock.advance(57 * MINUTE)
  expect(sent).toEqual(['tarea'])
})

test('with holdDuringLimit off a due job is sent into the limit', { options: { schedulerHoldDuringLimit: false } }, async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(60 * MINUTE))
  await $.session.start(START)
  await submit($, '@5m tarea')
  await clock.advance(6 * MINUTE)
  expect(sent).toEqual(['tarea'])
})

test('jobs left by an earlier run: recent ones are sent, stale ones expire with a notice', async ($, on) => {
  const { store, sent, toasts } = engineBeneath(on)
  jobIn(store, 'aaaa', { dueAt: NOW - 60 * MINUTE })
  jobIn(store, 'bbbb', { dueAt: NOW - 300 * MINUTE })
  await $.session.start(START)
  expect(sent).toEqual(['text aaaa'])
  expect(jobKeys(store)).toEqual([])
  expect(toasts.some(t => t.startsWith('⏰ Caducado bbbb'))).toBe(true)
})

test('the catch-up window is an option', { options: { schedulerCatchUpMinutes: 30 } }, async ($, on) => {
  const { store, sent } = engineBeneath(on)
  jobIn(store, 'aaaa', { dueAt: NOW - 60 * MINUTE })
  await $.session.start(START)
  expect(sent).toEqual([])
  expect(jobKeys(store)).toEqual([])
})

test('every poll leaves a heartbeat', async ($, on) => {
  const { store, clock } = engineBeneath(on)
  await $.session.start(START)
  expect(store.get('alive:sess-A')).toBe(NOW)
  await clock.advance(5_000)
  expect(store.get('alive:sess-A')).toBe(NOW) // the heartbeat is throttled: the shared store is locked per write
  await clock.advance(25_000)
  expect(store.get('alive:sess-A')).toBe(NOW + 30_000)
})

test('a job of a silent session in the same directory is adopted and sent; a live or foreign one is left', async ($, on) => {
  const { store, sent, clock } = engineBeneath(on)
  jobIn(store, 'dead', { sessionId: 'sess-B', dueAt: NOW + MINUTE })
  jobIn(store, 'live', { sessionId: 'sess-C', dueAt: NOW + MINUTE })
  jobIn(store, 'away', { sessionId: 'sess-D', dueAt: NOW + MINUTE, cwd: '/elsewhere' })
  store.set('alive:sess-B', NOW - 5 * MINUTE)
  store.set('alive:sess-C', NOW)
  store.set('alive:sess-D', NOW - 5 * MINUTE)
  await $.session.start(START)
  expect(store.get('job:dead')).toMatchObject({ sessionId: 'sess-A' })
  await clock.advance(2 * MINUTE)
  expect(sent).toEqual(['text dead'])
  expect(jobKeys(store).sort()).toEqual(['job:away', 'job:live'])
})

test('an owner that keeps its heartbeat is not robbed; one that stops is', async ($, on) => {
  const { store, sent, clock } = engineBeneath(on)
  jobIn(store, 'late', { sessionId: 'sess-B', dueAt: NOW + 10 * MINUTE })
  store.set('alive:sess-B', NOW)
  await $.session.start(START)
  for (let i = 0; i < 4; i++) {
    await clock.advance(MINUTE)
    store.set('alive:sess-B', clock.now())
  }
  expect(store.get('job:late')).toMatchObject({ sessionId: 'sess-B' })
  await clock.advance(3 * MINUTE) // 3 min with no heartbeat
  expect(store.get('job:late')).toMatchObject({ sessionId: 'sess-A' })
  await clock.advance(10 * MINUTE)
  expect(sent).toEqual(['text late'])
})

test('a job is removed before it is sent, so a second tick cannot repeat it', async ($, on) => {
  let leftAtSubmit: string[] = ['unset']
  const { store, sent, clock } = engineBeneath(on, { onSubmit: () => (leftAtSubmit = jobKeys(store)) })
  jobIn(store, 'once', { dueAt: NOW + 1000 })
  await $.session.start(START)
  await clock.advance(6_000)
  await clock.advance(6_000)
  expect(sent).toEqual(['text once'])
  expect(leftAtSubmit).toEqual([])
})

test('a rate-limited turn arms the resume from the readings that session.measure kept', async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: fiveHourFull(100 * MINUTE), changed: ['rateLimits'] } as never)
  await $.classic.StopFailure({ error: 'rate_limit' })
  expect((await $.command.run({ command: 'schedule-resume', args: 'status', ...RUN })).text).toMatch(/^5-hour limit reached: reanudo a las \d\d:\d\d \(en 1 h 42 min\)/)
  await clock.advance(100 * MINUTE)
  expect(sent).toEqual([])
  await clock.advance(2 * MINUTE + 5_000)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatch(/^The usage limit has reset\. Carry on/)
})

test('/schedule-resume test arms a simulated limit, and jobs wait behind it', async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  expect((await $.command.run({ command: 'schedule-resume', args: 'test 5', ...RUN })).text).toBe('Simulando un límite: reanudo en 5 min.')
  await submit($, '@1m tarea')
  await clock.advance(4 * MINUTE)
  expect(sent).toEqual([])
  await clock.advance(2 * MINUTE)
  // resume text first, then the job that was held behind the limit
  expect(sent[0]).toMatch(/^The usage limit has reset/)
  await clock.advance(MINUTE)
  expect(sent).toContain('tarea')
})

test('an @reset job replaces the generic resume at the reset', async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  await $.command.run({ command: 'schedule-resume', args: 'test 5', ...RUN })
  expect((await submit($, '@reset mi tarea')).drop).toMatch(/^⏰ Se enviará al resetearse el límite/)
  await clock.advance(6 * MINUTE)
  expect(sent).toEqual(['mi tarea'])
  expect((await $.command.run({ command: 'schedule-resume', args: '', ...RUN })).text).toMatch(/^Auto-resume está en reposo/)
})

test('a slash command is not a takeover; a typed prompt is', async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  await $.command.run({ command: 'schedule-resume', args: 'in 5', ...RUN })
  await $.prompt.submit({ text: '/help', command: { name: 'help', args: '' }, origin: COMPOSER } as never)
  expect((await $.command.run({ command: 'schedule-resume', args: '', ...RUN })).text).toMatch(/^scheduled by you/)
  await $.prompt.submit({ text: 'otra cosa', origin: COMPOSER } as never)
  expect((await $.command.run({ command: 'schedule-resume', args: '', ...RUN })).text).toMatch(/^Auto-resume está en reposo/)
  await clock.advance(10 * MINUTE)
  expect(sent).toEqual(['/help', 'otra cosa'])
})

test('the band, the footer label and the pane draw the queue, on terminal and desktop', async ($, on) => {
  const { store, sent } = engineBeneath(on)
  await $.session.start(START)
  await submit($, '@2h30m uno')
  await submit($, '@mañana 9:00 dos')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /2 programados/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /próximo .* \(en 2h 30m\)/ })).toBeDefined()
    expect(await band.find({ key: 'queue' })).toBeDefined()
    await band.press({ key: 'queue' })
    await band.unmount()

    const footer = await $.ui.mount({ plugin: 'prompt-scheduler', surface, component: 'SessionMode', props: { modes: ['plan'] } })
    expect(await footer.find({ type: 'Text', text: /^⏰ 2 · próximo / })).toBeDefined()
    expect(await footer.find({ type: 'Text', text: /plan/ })).toBeDefined()
    await footer.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await pane.findAll({ type: 'Button' })
  expect(rows.map(r => r.key)).toEqual([...jobKeys(store).map(k => `cancel-${k.slice(4)}`), 'cancel-all', 'close'])
  const firstKey = rows[0]?.key ?? ''
  await pane.press({ key: firstKey })
  expect(jobKeys(store)).toHaveLength(1)
  await pane.press({ key: 'close' })
  await pane.unmount()
  expect(sent).toEqual([])
})

test('the pane of an empty queue says how to schedule', async ($, on) => {
  engineBeneath(on)
  await $.session.start(START)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /Nada programado/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text' })).toBeUndefined()
  await band.unmount()
})

test('findReset prefers a full window, falls back to five_hour, and ignores the past', () => {
  const iso = (m: number) => new Date(NOW + m * MINUTE).toISOString()
  const windows = [
    { kind: 'five_hour', percentUsed: 80, resetsAt: iso(30) },
    { kind: 'seven_day', percentUsed: 100, resetsAt: iso(500) },
    { kind: 'spend_limit', percentUsed: 100, resetsAt: iso(-5) },
  ]
  expect(findReset(windows, NOW)).toEqual({ at: NOW + 500 * MINUTE, kind: 'seven_day' })
  expect(findReset(windows.slice(0, 1), NOW)).toEqual({ at: NOW + 30 * MINUTE, kind: 'five_hour' })
  expect(findReset(windows.slice(0, 1), NOW, { requireFull: true })).toBeUndefined()
  expect(findReset([{ kind: 'seven_day', percentUsed: 50, resetsAt: iso(30) }], NOW)).toBeUndefined()
  expect(findReset([], NOW)).toBeUndefined()
})

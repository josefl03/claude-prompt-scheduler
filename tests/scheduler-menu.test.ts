import { expect, test } from 'claude-code/testing'

import { formatField, parseWhenInput, systemOffset } from '../hooks/schedule.ts'
import { BAND, MINUTE, NOW, RUN, engineBeneath } from './scheduler-helpers.ts'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const SLOW_POLL = { options: { schedulerPollSeconds: 60 } } as const
const pane = (surface: 'terminal' | 'desktop' = 'terminal') =>
  ({ plugin: 'prompt-scheduler', surface, component: 'Pane', requestId: 'sched-when', viewport: { columns: 120, rows: 30 }, props: { title: 'Programar prompt', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} } }) as const
const utc = () => 0

test('the field accepts absolute, short, relative and tomorrow forms; seconds are kept', () => {
  const at = Date.UTC(2026, 9, 22, 10, 0, 0)
  expect(parseWhenInput('2026-10-23 09:05', at, utc)).toEqual({ at: Date.UTC(2026, 9, 23, 9, 5) })
  expect(parseWhenInput('2026-10-23 09:05:07', at, utc)).toEqual({ at: Date.UTC(2026, 9, 23, 9, 5, 7) })
  expect(parseWhenInput('17:30', at, utc)).toEqual({ at: Date.UTC(2026, 9, 22, 17, 30) })
  expect(parseWhenInput('09:00', at, utc)).toEqual({ at: Date.UTC(2026, 9, 23, 9, 0) })
  expect(parseWhenInput('17:30:15', at, utc)).toEqual({ at: Date.UTC(2026, 9, 22, 17, 30, 15) })
  expect(parseWhenInput('+30m', at, utc)).toEqual({ at: at + 30 * MINUTE })
  expect(parseWhenInput('+2h', at, utc)).toEqual({ at: at + 120 * MINUTE })
  expect(parseWhenInput('90s', at, utc)).toEqual({ at: at + 90_000 })
  expect(parseWhenInput('mañana 9:00', at, utc)).toEqual({ at: Date.UTC(2026, 9, 23, 9, 0) })
  expect(parseWhenInput('2026-10-22 09:00', at, utc)).toEqual({ error: 'Esa hora ya ha pasado.' })
  expect(parseWhenInput('2026-02-31 09:00', at, utc)).toEqual({ error: 'Fecha u hora no válidas.' })
  expect(parseWhenInput('25:00', at, utc)).toHaveProperty('error')
  expect(parseWhenInput('', at, utc)).toHaveProperty('error')
  expect(parseWhenInput('cuando sea', at, utc)).toHaveProperty('error')
  expect(formatField(Date.UTC(2026, 9, 22, 7, 5, 59), utc)).toBe('2026-10-22 07:05')
})

test('@HH:MM:SS is a schedule too', async ($, on) => {
  const start = Date.UTC(2026, 9, 22, 10, 0, 0)
  const { sent, clock } = engineBeneath(on, { now: start })
  await $.session.start(START)
  const wall = formatField(start, systemOffset).slice(11) // HH:MM of the start in the machine's zone
  const dropped = (await $.prompt.submit({ text: `@${wall}:30 con segundos`, origin: { kind: 'composer' } } as never)) as { drop?: string }
  expect(dropped.drop).toMatch(/^⏰ Programado para /)
  await clock.advance(29_999)
  expect(sent).toEqual([])
  await clock.advance(1)
  expect(sent).toEqual(['con segundos'])
})

test('the band always carries the shortcut button, empty queue or not', SLOW_POLL, async ($, on) => {
  engineBeneath(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'sched' })).toBeDefined()
    await band.unmount()
  }
})

test('menu: the draft leaves the box, Enter schedules it, the box stays empty', SLOW_POLL, async ($, on) => {
  const { box, panes, store, sent, toasts, clock } = engineBeneath(on)
  await $.session.start(START)
  box.text = 'revisa los logs'
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'sched' })
  expect(box.text).toBe('')
  expect(panes).toEqual(['sched-when'])

  const menu = await $.ui.mount(pane())
  expect(await menu.find({ type: 'Text', text: /revisa los logs/ })).toBeDefined()
  await menu.input({ key: 'when', text: 'cuando sea' })
  expect(await menu.find({ type: 'Text', text: /No entiendo la hora/ })).toBeDefined()
  expect(panes).toEqual(['sched-when']) // an error does not close it

  await menu.input({ key: 'when', text: '+1m' })
  expect(panes).toEqual([])
  expect(box.text).toBe('')
  expect(toasts.some(t => /^⏰ Programado para \d\d:\d\d \(en 1m\) · id [0-9a-f]{4}$/.test(t))).toBe(true)
  expect([...store.keys()].filter(k => k.startsWith('job:'))).toHaveLength(1)
  await clock.advance(MINUTE - 1)
  expect(sent).toEqual([])
  await clock.advance(1)
  expect(sent).toEqual(['revisa los logs'])
  await menu.unmount()
  await band.unmount()
})

test('menu: closing without scheduling puts the draft back; an empty box does not open it', SLOW_POLL, async ($, on) => {
  const { box, panes, toasts } = engineBeneath(on)
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'sched' })
  expect(panes).toEqual([])
  expect(toasts.some(t => /Escribe primero el prompt/.test(t))).toBe(true)

  box.text = 'no lo pierdas'
  await band.press({ key: 'sched' })
  expect(box.text).toBe('')
  const menu = await $.ui.mount(pane())
  await menu.press({ key: 'cancel' })
  await menu.unmount()
  expect(panes).toEqual([])
  expect(box.text).toBe('no lo pierdas')
  await band.unmount()
})

test('/schedule-menu <texto> opens the menu with that text; without text and with an empty box it explains', SLOW_POLL, async ($, on) => {
  const { box, panes, store } = engineBeneath(on)
  await $.session.start(START)
  expect((await $.command.run({ command: 'schedule-menu', args: '', ...RUN })).text).toMatch(/^Escribe primero el prompt/)
  expect((await $.command.run({ command: 'schedule-at', args: '', ...RUN })).text).toMatch(/^Escribe primero el prompt/)
  expect((await $.command.run({ command: 'schedule-menu', args: 'haz esto', ...RUN })).text).toMatch(/^Menú de programar abierto/)
  expect(panes).toEqual(['sched-when'])
  const menu = await $.ui.mount(pane('desktop'))
  await menu.input({ key: 'when', text: `${formatField(NOW + 5 * MINUTE, systemOffset)}` })
  expect(panes).toEqual([])
  expect([...store.values()].some(v => (v as { text?: string }).text === 'haz esto')).toBe(true)
  expect(box.text).toBe('')
  await menu.unmount()
})

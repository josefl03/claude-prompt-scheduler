import { expect, test } from 'claude-code/testing'

import { DEFAULT_TEXT, formatWait, instantMs, parseConfig, parseMinutes, parseResetText, planResume, zoneOffset } from '../hooks/plan.ts'
import { systemOffset } from '../hooks/schedule.ts'
import { BAND, MINUTE, NOW, RUN, engineBeneath, fiveHourFull } from './scheduler-helpers.ts'

const PHONE = { surface: 'mobile', clientId: 'mobile:default' } as const
const config = parseConfig({})

test('instantMs reads zoned ISO instants and refuses zone-less ones', () => {
  expect(instantMs('2027-01-15T08:00:00Z')).toBe(Date.UTC(2027, 0, 15, 8))
  expect(instantMs('2027-01-15T10:00:00+02:00')).toBe(Date.UTC(2027, 0, 15, 8))
  expect(instantMs('2027-01-15T08:00:00')).toBeUndefined()
  expect(instantMs('soon')).toBeUndefined()
})

test('a rate limit waits for the exhausted window to reset, plus the grace', () => {
  const resetsAt = '2027-01-15T08:00:00Z'
  const plan = planResume({
    error: 'rate_limit',
    rateLimits: [
      { kind: 'five_hour', percentUsed: 100, resetsAt },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2027-01-20T00:00:00Z' },
    ],
    now: Date.UTC(2027, 0, 15, 6),
    attempts: 0,
    config,
  })
  expect(plan).toEqual({ resumeAt: Date.UTC(2027, 0, 15, 8) + 2 * MINUTE, reason: '5-hour limit reached', isLimit: true, armedAt: Date.UTC(2027, 0, 15, 6) })
})

test('without a reset time it backs off, and gives up after the retries', () => {
  expect(planResume({ error: 'rate_limit', rateLimits: [], now: NOW, attempts: 0, config })).toEqual({ resumeAt: NOW + MINUTE, reason: 'rate limited', isLimit: true, armedAt: NOW })
  expect(planResume({ error: 'overloaded', rateLimits: [], now: NOW, attempts: 2, config })?.resumeAt).toBe(NOW + 4 * MINUTE)
  expect(planResume({ error: 'overloaded', rateLimits: [], now: NOW, attempts: 4, config })?.resumeAt).toBe(NOW + 15 * MINUTE)
  expect(planResume({ error: 'rate_limit', rateLimits: [], now: NOW, attempts: 5, config })).toBeUndefined()
  expect(planResume({ error: 'billing_error', rateLimits: [], now: NOW, attempts: 0, config })).toBeUndefined()
  const quiet = parseConfig({ schedulerRetryOverloaded: false })
  expect(planResume({ error: 'overloaded', rateLimits: [], now: NOW, attempts: 0, config: quiet })).toBeUndefined()
})

test('options and arguments are parsed at the boundary', () => {
  expect(parseConfig({ schedulerGraceSeconds: -1, schedulerMaxRetries: 2.5, schedulerResumeText: '  ', schedulerCatchUpMinutes: 5000, schedulerPollSeconds: 1 })).toEqual({
    text: DEFAULT_TEXT,
    graceMs: 2 * MINUTE,
    retryOverloaded: true,
    maxRetries: 5,
    catchUpMs: 180 * MINUTE,
    pollMs: 5_000,
    holdDuringLimit: true,
  })
  expect(parseConfig({ schedulerHoldDuringLimit: false }).holdDuringLimit).toBe(false)
  expect(parseConfig({ schedulerCatchUpMinutes: 0, schedulerPollSeconds: 60 })).toMatchObject({ catchUpMs: 0, pollMs: 60_000 })
  expect(parseMinutes('15')).toBe(15)
  expect(parseMinutes('0')).toBeUndefined()
  expect(parseMinutes('1e3')).toBeUndefined()
  expect(formatWait(45_000)).toBe('45 s')
  expect(formatWait(72 * MINUTE)).toBe('1 h 12 min')
})

const START = { cwd: '/work', surface: null, isInteractive: false } as const

test('a rate-limited turn arms a countdown that sends the resume text at the reset', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))

  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'now' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /en 12 min/ })).toBeDefined()

  await clock.advance(12 * MINUTE + 5_000)
  expect(sent).toEqual([DEFAULT_TEXT])
  expect(await band.find({ key: 'now' })).toBeUndefined()
  await band.unmount()
})

test('a resume pressed twice at once sends once', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))

  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await Promise.all([band.press({ key: 'now' }), band.press({ key: 'now' })])
  await clock.advance(12 * MINUTE + 5_000)
  expect(sent).toEqual([DEFAULT_TEXT])
  await band.unmount()
})

test('Cancel disarms the countdown', async ($, on) => {
  const { sent, clock } = engineBeneath(on)

  await $.classic.StopFailure({ error: 'overloaded' })
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'cancel' })
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual([])
  await band.unmount()
})

test('a headless session arms nothing after a rate limit', async ($, on) => {
  const { sent, toasts, limits, clock } = engineBeneath(on, { surfaces: [] })
  limits.push(...fiveHourFull(10 * MINUTE))

  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'now' })).toBeUndefined()
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual([])
  expect(toasts).toEqual([])
  await band.unmount()
})

test('a resume armed while shown is still sent after the last surface detaches, and the countdown stops', async ($, on) => {
  const { sent, surfaces, limits, clock } = engineBeneath(on, { surfaces: ['mobile'] })
  limits.push(...fiveHourFull(10 * MINUTE))

  await $.session.start(START)
  await $.session.attach(PHONE)
  await $.classic.StopFailure({ error: 'rate_limit' })
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'mobile', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /en 12 min/ })).toBeDefined()

  surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  await clock.advance(5 * MINUTE)
  // No redraw while nothing shows the session: the countdown still reads its old time.
  expect(await band.find({ type: 'Text', text: /en 12 min/ })).toBeDefined()

  await clock.advance(8 * MINUTE)
  expect(sent).toEqual([DEFAULT_TEXT])
  await band.unmount()
})

test('a surface attaching while a resume is armed brings the countdown up to date', async ($, on) => {
  const { surfaces, limits, clock } = engineBeneath(on, { surfaces: ['mobile'] })
  limits.push(...fiveHourFull(10 * MINUTE))

  await $.session.start(START)
  await $.session.attach(PHONE)
  await $.classic.StopFailure({ error: 'rate_limit' })
  surfaces.length = 0
  await $.session.detach({ ...PHONE, reason: 'detach' })
  await clock.advance(5 * MINUTE)

  surfaces.push('mobile')
  await $.session.attach(PHONE)
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'mobile', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /en 7 min/ })).toBeDefined()
  await clock.advance(MINUTE)
  expect(await band.find({ type: 'Text', text: /en 6 min/ })).toBeDefined()
  await band.unmount()
})

test('a prompt from the SDK host takes over from an armed resume', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on, { surfaces: ['mobile'] })
  limits.push(...fiveHourFull(10 * MINUTE))

  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.prompt.submit({ text: 'next task', origin: { kind: 'sdk' }, wait: false })
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual(['next task'])
})

test('a resume restored at start after a reload is still sent with no surface', async ($, on) => {
  const { sent, surfaces, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))

  await $.classic.StopFailure({ error: 'rate_limit' })
  // A hot reload raises session.start again; this time nothing shows the session.
  surfaces.length = 0
  await $.session.start(START)
  await clock.advance(12 * MINUTE + 5_000)
  expect(sent).toEqual([DEFAULT_TEXT])
})

test('a surface attaching while the countdown ticks shows the time now, not the last tick', async ($, on) => {
  const { surfaces, clock } = engineBeneath(on)

  await $.command.run({ command: 'schedule-resume', args: 'in 1', ...RUN })
  const band = await $.ui.mount({ plugin: 'prompt-scheduler', surface: 'mobile', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /en 1 min/ })).toBeDefined()
  // Polls come every 5 s: at 3 s the band still shows the time of the last one.
  await clock.advance(3_000)
  expect(await band.find({ type: 'Text', text: /en 1 min/ })).toBeDefined()

  surfaces.push('mobile')
  await $.session.attach(PHONE)
  expect(await band.find({ type: 'Text', text: /en 57 s/ })).toBeDefined()
  await band.unmount()
})

// ---- backup resume: the native auto-continue goes first, ours never duplicates it

const GRACE = 2 * MINUTE
const OTHER_PLUGIN = { kind: 'plugin', name: 'other', asUser: true } as const

test('backup: with nothing happening after the failure it sends at the reset plus the grace, not before', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + GRACE - 1)
  expect(sent).toEqual([])
  await clock.advance(1)
  expect(sent).toEqual([DEFAULT_TEXT])
})

test('backup: a turn that started after the failure (the native auto-continue) cancels it', async ($, on) => {
  const { sent, logs, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + 1000)
  await $.turn.start({ text: '', turnId: 'native' })
  await clock.advance(MINUTE)
  expect(sent).toEqual([])
  expect(logs.some(l => l.includes('resume skipped'))).toBe(false) // not due yet
  await clock.advance(MINUTE)
  expect(sent).toEqual([])
  expect(logs.some(l => l.includes('resume skipped'))).toBe(true)
  expect((await $.command.run({ command: 'schedule-resume', args: '', ...RUN })).text).toMatch(/^Auto-resume está en reposo/)
})

test('backup: a prompt from another plugin or the native queue also cancels it', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(5 * MINUTE)
  await $.prompt.submit({ text: 'continue', origin: OTHER_PLUGIN, wait: false } as never)
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual(['continue'])
})

test('backup: a slash command is not activity', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(5 * MINUTE)
  await $.prompt.submit({ text: '/help', command: { name: 'help', args: '' }, origin: OTHER_PLUGIN } as never)
  await clock.advance(10 * MINUTE)
  expect(sent).toEqual(['/help', DEFAULT_TEXT])
})

test('backup: pressing Reanudar ya sends even after activity', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(MINUTE)
  await $.turn.start({ text: 'x', turnId: 't9' })
  await clock.advance(MINUTE)
  expect((await $.command.run({ command: 'schedule-resume', args: 'now', ...RUN })).text).toBe('Reanudando ahora.')
  await clock.settle()
  expect(sent).toEqual([DEFAULT_TEXT])
})

test('backup: /schedule-resume in <min> is the person asking, so activity does not cancel it', async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  await $.command.run({ command: 'schedule-resume', args: 'in 5', ...RUN })
  await $.turn.start({ text: 'x', turnId: 't9' })
  await clock.advance(6 * MINUTE)
  expect(sent).toEqual([DEFAULT_TEXT])
})

test('the reset time is read from the notice when the windows say nothing', async ($, on) => {
  const { sent, clock } = engineBeneath(on)
  await $.session.start(START)
  const resetsAt = NOW + 90 * MINUTE
  // A zone-less claim of "10pm" in Europe/Madrid, built so that it lands 90 min ahead, whatever the host zone.
  const madrid = zoneOffset('Europe/Madrid') ?? systemOffset
  const local = new Date(resetsAt + madrid(resetsAt) * MINUTE)
  const hour = local.getUTCHours()
  const text = `You've hit your session limit · resets ${hour % 12 === 0 ? 12 : hour % 12}${local.getUTCMinutes() === 0 ? '' : `:${String(local.getUTCMinutes()).padStart(2, '0')}`}${hour >= 12 ? 'pm' : 'am'} (Europe/Madrid)`
  await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: text })
  await clock.advance(90 * MINUTE + GRACE - 1)
  expect(sent).toEqual([])
  await clock.advance(1_000)
  expect(sent).toEqual([DEFAULT_TEXT])
})

test('parseResetText: clock times, dates and zones', () => {
  const utc = () => 0
  const at = Date.UTC(2026, 9, 22, 20, 0) // 2026-10-22 20:00 UTC
  expect(parseResetText("You've hit your session limit · resets 10pm (UTC)", at, utc)).toBe(Date.UTC(2026, 9, 22, 22))
  expect(parseResetText('resets 9:30am', at, utc)).toBe(Date.UTC(2026, 9, 23, 9, 30)) // already past today: tomorrow
  expect(parseResetText("You've hit your weekly limit · resets Oct 2, 2am (UTC)", at, utc)).toBe(Date.UTC(2027, 9, 2, 2)) // past this year: next
  expect(parseResetText('resets Nov 1, 2am', at, utc)).toBe(Date.UTC(2026, 10, 1, 2))
  // Madrid is still on summer time (+2) on the 22nd, until the change on the 25th
  expect(parseResetText('resets 10pm (Europe/Madrid)', at - 30 * MINUTE, utc)).toBe(Date.UTC(2026, 9, 22, 20))
  expect(parseResetText('resets 13pm', at, utc)).toBeUndefined()
  expect(parseResetText('no time here', at, utc)).toBeUndefined()
  expect(zoneOffset('Europe/Madrid')?.(Date.UTC(2026, 6, 1))).toBe(120)
  expect(zoneOffset('Europe/Madrid')?.(Date.UTC(2026, 11, 1))).toBe(60)
  expect(zoneOffset('Not/AZone')).toBeUndefined()
})

// ------------------------------------------------ the 5-hour limit, end to end

const TURN_DIED = { turnId: 't-limit', answer: '', durationMs: 1, isAborted: false, reason: 'error' } as const

test('5 h: the notice alone ("session limit · resets …") is enough to arm, with the windows empty', () => {
  const at = Date.UTC(2026, 9, 22, 19, 0) // 21:00 in Madrid
  const plan = planResume({
    error: 'rate_limit',
    rateLimits: [],
    now: at,
    attempts: 0,
    config,
    message: "You've hit your session limit · resets 11:50pm (Europe/Madrid)",
  })
  expect(plan?.resumeAt).toBe(Date.UTC(2026, 9, 22, 21, 50) + 2 * MINUTE)
  expect(plan?.isLimit).toBe(true)
})

test('5 h: a turn that died on an API error with the window full arms the backup even if StopFailure never came', async ($, on) => {
  const { sent, limits, clock, logs } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't-limit' })
  await $.turn.complete(TURN_DIED)
  expect(logs.some(l => l.includes('no StopFailure'))).toBe(true)
  await clock.advance(10 * MINUTE + GRACE - 1)
  expect(sent).toEqual([])
  await clock.advance(1)
  expect(sent).toEqual([DEFAULT_TEXT])
})

test('5 h: StopFailure and the error turn together arm one resume, and it is sent once', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't-limit' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete(TURN_DIED)
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual([DEFAULT_TEXT])
})

test('5 h: an error turn with no full window is not a limit and arms nothing', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  limits.push({ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 10 * MINUTE).toISOString() })
  await $.session.start(START)
  await $.turn.complete(TURN_DIED)
  await clock.advance(30 * MINUTE)
  expect(sent).toEqual([])
})

test('5 h: the error turn does not get round the retry cap', async ($, on) => {
  const { sent, limits, clock } = engineBeneath(on)
  await $.session.start(START)
  let at = NOW
  for (let i = 0; i < config.maxRetries; i++) {
    limits.length = 0
    limits.push(...fiveHourFull(10 * MINUTE, at))
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(10 * MINUTE + GRACE)
    at += 10 * MINUTE + GRACE
  }
  expect(sent.length).toBe(config.maxRetries)
  limits.length = 0
  limits.push(...fiveHourFull(10 * MINUTE, at))
  await $.turn.complete(TURN_DIED)
  await clock.advance(30 * MINUTE)
  expect(sent.length).toBe(config.maxRetries)
})

test('5 h: a resume that no turn picks up (a dialog holds the session) tells the person after 30 s', async ($, on) => {
  const { toasts, limits, clock, logs } = engineBeneath(on)
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + GRACE) // sent; the mock engine starts no turn
  expect(toasts.some(t => t.includes('diálogo'))).toBe(false)
  await clock.advance(30_000)
  expect(toasts.some(t => t.includes('diálogo'))).toBe(true)
  expect(logs.some(l => l.includes('a dialog may hold the session'))).toBe(true)
})

test('5 h: a resume that starts a turn raises no dialog warning', async ($, on) => {
  const { toasts, limits, clock } = engineBeneath(on, { onSubmit: () => void $.turn.start({ text: '', turnId: 'resumed' }) })
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + GRACE + 60_000)
  expect(toasts.some(t => t.includes('diálogo'))).toBe(false)
})

// ------------------------------------------------ a resume held by a dialog

function terminalBeneath(on: Parameters<typeof engineBeneath>[0], env: Record<string, string>) {
  const argvs: string[][] = []
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return argvs
}

test('5 h: a resume held 30 s by a dialog gets an Escape through herdr, once', async ($, on) => {
  const { limits, clock, toasts } = engineBeneath(on)
  const argvs = terminalBeneath(on, { HERDR_PANE_ID: 'w1:p2', HERDR_BIN_PATH: '/bin/herdr', TMUX_PANE: '%3' })
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + GRACE + 29_000)
  expect(argvs).toEqual([])
  await clock.advance(2_000)
  expect(argvs).toEqual([['/bin/herdr', 'pane', 'send-keys', 'w1:p2', 'esc']])
  expect(toasts.some(t => t.includes('envío Escape'))).toBe(true)
  await clock.advance(5 * MINUTE)
  expect(argvs.length).toBe(1)
})

test('5 h: inside tmux alone the Escape goes through tmux', async ($, on) => {
  const { limits, clock } = engineBeneath(on)
  const argvs = terminalBeneath(on, { TMUX_PANE: '%3' })
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + GRACE + 31_000)
  expect(argvs).toEqual([['tmux', 'send-keys', '-t', '%3', 'Escape']])
})

test('5 h: no Escape when a turn started, when one is running, or when the person pressed Reanudar ya', async ($, on) => {
  const { limits, clock } = engineBeneath(on, { onSubmit: () => void $.turn.start({ text: '', turnId: 'resumed' }) })
  const argvs = terminalBeneath(on, { TMUX_PANE: '%3' })
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + GRACE + 60_000) // the resume started a turn: nothing to unstick
  expect(argvs).toEqual([])
})

test('5 h: with no pane to reach it only warns', async ($, on) => {
  const { limits, clock, toasts } = engineBeneath(on)
  const argvs = terminalBeneath(on, {})
  limits.push(...fiveHourFull(10 * MINUTE))
  await $.session.start(START)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(10 * MINUTE + GRACE + 31_000)
  expect(argvs).toEqual([])
  expect(toasts.some(t => t.includes('Ciérralo con Esc'))).toBe(true)
})

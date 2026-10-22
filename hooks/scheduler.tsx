// Part of the prompt-scheduler plugin. Derived from seanrobertwright/claude-mods (auto-resume) and longmaba/no-limit (MIT); see NOTICE.
//
// Prompt scheduler (`@17:00 text`, `/schedule-at`, `/schedule-queue`, `/schedule-cancel`) and a backup auto-resume
// after a usage limit.
//
// Precise firing: every job of this session that can fall due (and the armed resume) has its own
// `$.clock.after(dueAt - now)`; the periodic poll (5 s) stays as a safety net. If the session is
// busy at that time, `$.prompt.submit` waits until it is free (a plugin prompt runs "once
// idle"; PromptSubmitArgs accepts neither `turnId` nor `wait`, so there is no way to deliver it in the
// running turn). The real latency is left in the debug log: `fired job <id> due=… at=… late=…ms`.
//
// Auto-resume: Claude Code already resumes on its own (`autoContinue` setting). Here it is a BACKUP that never
// duplicates: it is armed at resetsAt + grace and, when due, sends only if no turn has started and no
// prompt has entered since the failure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { SchedulerJob as Job, SchedulerJobRequest, SchedulerPending as Pending, SchedulerResumed as Resumed } from '../../types'
import { findReset, formatWait, parseConfig, parseMinutes, planResume } from './plan.ts'
import type { Config } from './plan.ts'
import { describeWhen, isJob, newId, nextDue, parseCancel, planTick, snippet } from './queue.ts'
import { formatField, formatIn, formatWhen, looksScheduled, parseWhen, parseWhenInput, systemOffset } from './schedule.ts'
import type { TzOffset, When } from './schedule.ts'

const pending = atom({ plugin: 'prompt-scheduler', key: 'scheduler-pending' } as const, null)
const attempts = atom({ plugin: 'prompt-scheduler', key: 'scheduler-attempts' } as const, 0)
const now = atom({ plugin: 'prompt-scheduler', key: 'scheduler-now' } as const, 0)
const jobs = atom({ plugin: 'prompt-scheduler', key: 'scheduler-jobs' } as const, [])
const isQueueOpen = atom({ plugin: 'prompt-scheduler', key: 'scheduler-queue-open' } as const, false)
const menuDraft = atom({ plugin: 'prompt-scheduler', key: 'scheduler-menu-draft' } as const, '')
const menuError = atom({ plugin: 'prompt-scheduler', key: 'scheduler-menu-error' } as const, '')

const PANE = 'queue'
const MENU = 'sched-when'
/**
 * The engine action the menu's chord is bound to. Claude Code has no action of ours, so the shortcuts
 * (`alt+s`, `ctrl+enter`) are bound in the Global context of ~/.claude/keybindings.json to this rarely
 * used one, and the Button below that names it receives the chord (it does not arrive from `Chat`).
 */
const MENU_ACTION = 'app:cycleDiffBase'
const HISTORY_SIZE = 10
/** The heartbeat is written this often (adoption needs a 2 min silence): every poll would contend for the shared store lock. */
const HEARTBEAT_MS = 30_000
const DAY = 86_400_000
const CLEAR_BOX_MS = 250
/** Longest single timer; a longer wait is re-armed when it fires (the host's timers are 32-bit). */
const MAX_TIMER_MS = 60 * 60_000
const USAGE =
  'Uso: @17:00 texto · @mañana 9:00 texto · @2h30m texto · @45m texto · @30s texto · @done texto · @reset texto'

// Module state dies with the module on a reload; session.start rebuilds it from $.store and $.state.
let poll: Timer | undefined
/** One exact timer per job of this session (`job:<id>`) and one for the armed resume (`resume`). */
const timers = new Map<string, { dueAt: number; timer: Timer }>()
let rearmChain: Promise<void> = Promise.resolve()
let activeConfig: Config = parseConfig({})
let isTicking = false
let lastBeat = 0
/** The date-time menu: whether the draft was scheduled (else closing it puts the draft back in the box). */
let isMenuConfirmed = false
/** What the person last typed in the menu's field and had refused, so the redraw keeps it. */
let menuValue: string | undefined
let isTickQueued = false
let isTurnRunning = false
/** When the main loop last started a turn, to tell a resume that went out from one stuck behind a dialog. */
let lastTurnStart = 0
let sessionIdCache: string | undefined
let limits: SessionRateLimit[] = []
let tz: TzOffset = systemOffset

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`scheduler: ${error instanceof Error ? error.message : String(error)}`)
}

/** For work nobody asked for (poll, timers): a failure goes to the debug log and the next poll retries; no toast. */
function quiet($: EngineInterface): (error: unknown) => void {
  return error => dbg($, `${error instanceof Error ? error.message : String(error)} (the next poll retries)`)
}

/** The store is a file shared by every session of the user and locked per write: a busy lock is retried briefly. */
async function retried<T>($: EngineInterface, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= 4) throw error
      await $.clock.sleep(40 * attempt)
    }
  }
}

/** A line for the debug log (`--debug-file`); never throws. */
function dbg($: EngineInterface, text: string): void {
  try {
    $.ui.log(`[scheduler] ${text}`, { to: 'debug' })
  } catch {
    // the log is a convenience
  }
}

/**
 * Whether any surface shows the session right now. Asked before arming a
 * resume and before each redraw, and never kept: a reload or a missed attach
 * would leave a kept flag wrong. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

async function whoami($: EngineInterface): Promise<{ sessionId: string; cwd: string }> {
  sessionIdCache ??= await $.session.id()
  return { sessionId: sessionIdCache, cwd: await $.session.cwd() }
}

// ---------------------------------------------------------------- the store

async function loadJobs($: EngineInterface): Promise<Job[]> {
  const found: Job[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('job:')) continue
    const value = await $.store.get(key)
    if (isJob(value)) found.push(value)
  }
  return found
}

async function loadAlive($: EngineInterface): Promise<Record<string, number>> {
  const alive: Record<string, number> = {}
  for (const key of await $.store.keys()) {
    if (!key.startsWith('alive:')) continue
    const value = await $.store.get(key)
    if (typeof value === 'number') alive[key.slice(6)] = value
  }
  return alive
}

/** The jobs of this session, for the band and the pane. */
async function refreshJobs($: EngineInterface): Promise<Job[]> {
  const { sessionId } = await whoami($)
  const mine = (await loadJobs($)).filter(job => job.sessionId === sessionId).sort((a, b) => (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt))
  await update($, jobs, () => mine)
  return mine
}

// ---------------------------------------------------------------- the limit

/** When a usage limit lifts, if one is active: the armed resume's time, else the full window's reset plus the grace. */
async function limitUntil($: EngineInterface, config: Config, at: number): Promise<number | undefined> {
  const waiting = await read($, pending)
  if (waiting?.isLimit === true) return waiting.resumeAt
  const reset = findReset(limits, at, { requireFull: true })
  return reset === undefined ? undefined : reset.at + config.graceMs
}

// ---------------------------------------------------------------- auto-resume

/** Brings the clock the band and the footer read up to date (they draw from it, so they redraw). */
async function refreshNow($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
}

async function disarm($: EngineInterface): Promise<void> {
  await update($, pending, () => null)
  await rearm($)
}

/** Notes that a turn started or a prompt entered, from any origin: a backup resume armed before it must not send. */
async function markActivity($: EngineInterface): Promise<void> {
  try {
    const { sessionId } = await whoami($)
    await $.store.set(`activity:${sessionId}`, await $.clock.now())
  } catch {
    // a missed mark only risks a redundant "carry on", never a lost prompt
  }
}

async function lastActivity($: EngineInterface): Promise<number> {
  const { sessionId } = await whoami($)
  const value = await $.store.get(`activity:${sessionId}`)
  return typeof value === 'number' ? value : 0
}

/**
 * Sends the resume once: the poll, the timer and a press racing each other all get here, and only the
 * one that takes `pending` sends. A backup resume (`armedAt` set) sends only if nothing happened since the
 * failure, `force` (a press or `/schedule-resume now`) aside; otherwise the native auto-continue, the person
 * or another plugin already got the session going, and a second "carry on" would duplicate it.
 */
async function resume($: EngineInterface, config: Config, force = false): Promise<void> {
  let taken: Pending | null = null
  await update($, pending, current => {
    taken = current
    return null
  })
  if (taken === null) return
  const reason = (taken as Pending).reason
  const armedAt = (taken as Pending).armedAt
  if (!force && armedAt !== undefined) {
    const last = await lastActivity($)
    if (last > armedAt) {
      dbg($, `resume skipped: a turn or prompt started at ${new Date(last).toISOString()} after the failure at ${new Date(armedAt).toISOString()}`)
      await rearm($)
      return
    }
  }
  await update($, attempts, count => count + 1)
  const entry: Resumed = { at: await $.clock.now(), reason }
  const history = await $.store.get('history')
  await $.store.set('history', [...(Array.isArray(history) ? history : []), entry].slice(-HISTORY_SIZE))
  $.ui.toast('El límite se ha reseteado: reanudando la sesión')
  dbg($, `resuming (${reason})`)
  await rearm($)
  // Not awaited: it resolves when the turn starts, and waits for idle first.
  const sentAt = await $.clock.now()
  void $.prompt.submit({ text: config.text, asUser: true }).catch(report($))
  watchResume($, sentAt, force)
}

/** How long a resume may sit queued before the person is told something holds it. */
const STUCK_MS = 30_000

/**
 * A prompt waits for idle, and a dialog that holds the keys (the native `/rate-limit-options` one opens when
 * Claude Code's own auto-continue is not armed) is never idle: the resume would sit there unseen. No plugin API
 * closes that dialog, so after STUCK_MS with no turn started, and no turn running (an Escape would interrupt it),
 * the terminal is asked for an Escape: `herdr pane send-keys` inside herdr, `tmux send-keys` inside tmux. A
 * resume the person pressed themselves ('Reanudar ya') is theirs to unstick, so it only gets the warning.
 */
function watchResume($: EngineInterface, sentAt: number, force: boolean): void {
  $.clock.after(STUCK_MS, async () => {
    if (lastTurnStart >= sentAt) return
    dbg($, `resume queued ${STUCK_MS / 1000}s ago and no turn started: a dialog may hold the session`)
    const sent = force || isTurnRunning ? false : await escapeDialog($).catch(() => false)
    $.ui.toast(
      sent
        ? 'La reanudación estaba retenida por un diálogo: envío Escape a la terminal y sigue sola.'
        : 'La reanudación está en cola y no arranca: ¿hay un diálogo abierto (p. ej. /rate-limit-options)? Ciérralo con Esc y seguirá sola.',
    )
  })
}

/** Sends one Escape to the pane the session runs in; false when there is no pane to reach or the multiplexer refused. */
async function escapeDialog($: EngineInterface): Promise<boolean> {
  const herdrPane = await $.env.get('HERDR_PANE_ID')
  if (herdrPane !== undefined && herdrPane !== '') {
    const bin = (await $.env.get('HERDR_BIN_PATH')) ?? 'herdr'
    const out = await $.process.run([bin, 'pane', 'send-keys', herdrPane, 'esc'], { timeoutMs: 10_000 })
    dbg($, `escape via herdr pane ${herdrPane}: exit ${out.exitCode}`)
    return out.exitCode === 0
  }
  const tmuxPane = await $.env.get('TMUX_PANE')
  if (tmuxPane !== undefined && tmuxPane !== '') {
    const out = await $.process.run(['tmux', 'send-keys', '-t', tmuxPane, 'Escape'], { timeoutMs: 10_000 })
    dbg($, `escape via tmux pane ${tmuxPane}: exit ${out.exitCode}`)
    return out.exitCode === 0
  }
  return false
}

/**
 * Arms the resume from what the rate-limit windows say, for a turn that died on an API error without
 * `classic.StopFailure` having armed anything. Only a full window counts (any other error is not a limit to wait out),
 * the retry cap still applies, and an already armed resume is left alone.
 */
async function armFromFullWindow($: EngineInterface, config: Config): Promise<void> {
  if ((await read($, pending)) !== null || !(await isShown($))) return
  const at = await $.clock.now()
  const read1 = (await $.session.usage()).rateLimits
  const rateLimits = read1.length > 0 ? read1 : limits
  if (findReset(rateLimits, at, { requireFull: true }) === undefined) return
  const plan = planResume({ error: 'rate_limit', rateLimits, now: at, attempts: await read($, attempts), config, tz })
  if (plan === undefined) return
  dbg($, `turn ended in error with a full window and no StopFailure: armed ${plan.reason} for ${new Date(plan.resumeAt).toISOString()}`)
  await arm($, config, plan)
  $.ui.toast(`${plan.reason}: reanudo a las ${formatWhen(plan.resumeAt, at, tz)} (en ${formatWait(plan.resumeAt - at)}).`)
}

/** Sets the resume going at `plan.resumeAt`; the poll sends it, shown session or not. */
async function arm($: EngineInterface, config: Config, plan: Pending): Promise<void> {
  await update($, pending, () => plan)
  ensurePoll($, config)
  await rearm($)
  await refreshNow($)
}

// ---------------------------------------------------------------- the queue

/** Sends a job: removed from the store first, so no other session or tick can send it twice. */
async function fire($: EngineInterface, job: Job): Promise<void> {
  const current = await $.store.get(`job:${job.id}`)
  if (!isJob(current) || current.sessionId !== job.sessionId) return
  await retried($, () => $.store.delete(`job:${job.id}`))
  const firedAt = await $.clock.now()
  const due = job.dueAt ?? firedAt
  dbg($, `fired job ${job.id} due=${new Date(due).toISOString()} at=${new Date(firedAt).toISOString()} late=${firedAt - due}ms (${job.kind}): ${snippet(job.text, 40)}`)
  $.ui.toast(`⏰ Enviando ${job.id}: ${snippet(job.text, 40)}`)
  void $.prompt.submit({ text: job.text, asUser: true }).catch(report($))
}

/** One poll: heartbeat, adoption, catch-up, postponement past a limit, sending what is due, the countdown. */
async function tick($: EngineInterface, config: Config): Promise<void> {
  // A tick asked for while one runs (a timer waking exactly as the poll is mid-flight) runs again at its end.
  if (isTicking) {
    isTickQueued = true
    return
  }
  isTicking = true
  isTickQueued = false
  try {
    const at = await $.clock.now()
    const { sessionId, cwd } = await whoami($)

    // Sending comes first (the timer woke us for it); heartbeat and bookkeeping follow.
    const alive = await loadAlive($)
    alive[sessionId] = at
    const plan = planTick({
      jobs: await loadJobs($),
      now: at,
      sessionId,
      cwd,
      alive,
      limitUntil: await limitUntil($, config, at),
      catchUpMs: config.catchUpMs,
      holdDuringLimit: config.holdDuringLimit,
    })
    // At the reset the generic "carry on" goes first, unless a job of its own replaces it.
    const waiting = await read($, pending)
    if (waiting !== null && at >= waiting.resumeAt) {
      if (plan.fire.some(job => job.kind === 'reset')) await disarm($)
      else await resume($, config)
    }
    for (const job of plan.fire) await fire($, job)

    if (at - lastBeat >= HEARTBEAT_MS || at < lastBeat) {
      await retried($, () => $.store.set(`alive:${sessionId}`, at))
      lastBeat = at
    }
    for (const [id, seen] of Object.entries(alive)) {
      if (id !== sessionId && at - seen > DAY) {
        await $.store.delete(`alive:${id}`)
        await $.store.delete(`activity:${id}`)
      }
    }
    for (const job of [...plan.adopt, ...plan.materialize, ...plan.postpone]) {
      if (plan.fire.some(f => f.id === job.id)) continue
      await $.store.set(`job:${job.id}`, job)
    }
    for (const job of plan.adopt) dbg($, `adopted ${job.id} from a silent session`)
    for (const job of plan.expire) {
      await $.store.delete(`job:${job.id}`)
      $.ui.toast(`⏰ Caducado ${job.id}: venció hace más de ${Math.round(config.catchUpMs / 60_000)} min (${snippet(job.text, 30)})`)
    }
    await refreshJobs($)
    if (await isShown($)) await refreshNow($)
  } finally {
    isTicking = false
  }
  await rearm($)
  if (isTickQueued) await tick($, config)
}

function ensurePoll($: EngineInterface, config: Config): void {
  poll ??= $.clock.every(config.pollMs, () => void tick($, config).catch(quiet($)))
}

// ---------------------------------------------------------------- exact timers

/**
 * Brings the exact timers in line with the store: one `$.clock.after(dueAt - now)` per job of this session
 * that has a time, and one for the armed resume. A timer whose time changed (postponed, materialized,
 * adopted) is replaced; one whose job is gone is cancelled. Serialized, so two callers cannot interleave.
 */
function rearm($: EngineInterface): Promise<void> {
  rearmChain = rearmChain.then(() => applyTimers($)).catch(() => undefined)
  return rearmChain
}

async function applyTimers($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const { sessionId } = await whoami($)
  const want = new Map<string, number>()
  for (const job of await loadJobs($)) {
    if (job.sessionId === sessionId && job.kind !== 'done' && job.dueAt !== undefined) want.set(`job:${job.id}`, job.dueAt)
  }
  const waiting = await read($, pending)
  if (waiting !== null) want.set('resume', waiting.resumeAt)
  for (const [key, entry] of timers) {
    if (want.get(key) !== entry.dueAt) {
      entry.timer.cancel()
      timers.delete(key)
    }
  }
  for (const [key, dueAt] of want) {
    if (timers.has(key)) continue
    const delay = clamp(dueAt - at, 0, MAX_TIMER_MS)
    const timer = $.clock.after(delay, () => {
      timers.delete(key)
      void tick($, activeConfig).catch(quiet($))
    })
    timers.set(key, { dueAt, timer })
  }
}

/** Cancels every exact timer (a reload of the module raises session.start again and rebuilds them). */
function dropTimers(): void {
  for (const entry of timers.values()) entry.timer.cancel()
  timers.clear()
}

/** Writes a job to the store and arms its exact timer; a job already due goes out at once (timer of 0 ms). */
async function storeJob($: EngineInterface, config: Config, job: Job): Promise<void> {
  await $.store.set(`job:${job.id}`, job)
  await refreshJobs($)
  ensurePoll($, config)
  await rearm($)
}

/**
 * Extension point: schedules `text` to be sent at `dueAt` (ms since the epoch) by the session `sessionId` of
 * `cwd`, exactly like `@17:00 texto` does, and resolves the stored job (its `id` is what `/schedule-cancel` takes).
 * A time in the past goes out at once. Rejects on empty text or a non-finite time. Needs the module to have
 * been registered (session.start); the exact timer is armed before it resolves.
 */
export async function scheduleJob($: EngineInterface, request: SchedulerJobRequest): Promise<Job> {
  if (request.text.trim() === '') throw new Error('scheduleJob: empty text')
  if (!Number.isFinite(request.dueAt)) throw new Error('scheduleJob: dueAt is not a finite time')
  const at = await $.clock.now()
  const taken = (await $.store.keys()).filter(key => key.startsWith('job:')).map(key => key.slice(4))
  const job: Job = { id: newId(taken), text: request.text, kind: 'at', dueAt: request.dueAt, sessionId: request.sessionId, cwd: request.cwd, createdAt: at }
  await storeJob($, activeConfig, job)
  dbg($, `scheduled ${job.id} at dueAt=${job.dueAt} via scheduleJob`)
  return job
}

/** Stores a job and says so; `@done` and `@reset` with nothing to wait for go out at the next poll. */
async function schedule($: EngineInterface, config: Config, when: When): Promise<string> {
  const at = await $.clock.now()
  const { sessionId, cwd } = await whoami($)
  const taken = (await $.store.keys()).filter(key => key.startsWith('job:')).map(key => key.slice(4))
  const limit = when.kind === 'reset' ? await limitUntil($, config, at) : undefined
  let job: Job
  if (when.kind === 'at') {
    // The same path an outside caller takes (see scheduleJob), so it is the one the tests exercise.
    job = await scheduleJob($, { text: when.prompt, dueAt: when.at, sessionId, cwd })
  } else if (when.kind === 'reset' && limit !== undefined) {
    job = { id: newId(taken), text: when.prompt, kind: 'reset', dueAt: limit, sessionId, cwd, createdAt: at }
  } else if (!isTurnRunning) {
    job = { id: newId(taken), text: when.prompt, kind: 'at', dueAt: at, sessionId, cwd, createdAt: at }
  } else {
    job = { id: newId(taken), text: when.prompt, kind: 'done', sessionId, cwd, createdAt: at }
  }
  if (job.kind !== 'at' || when.kind !== 'at') await storeJob($, config, job)
  dbg($, `scheduled ${job.id} ${job.kind} dueAt=${job.dueAt ?? '-'} tzOffset=${tz(at)}min`)
  const text =
    job.kind === 'at' && job.dueAt === at
      ? `⏰ Se enviará ahora, en cuanto la sesión esté libre · id ${job.id}`
      : job.kind === 'at'
        ? `⏰ Programado para ${formatWhen(job.dueAt ?? at, at, tz)} (en ${formatIn((job.dueAt ?? at) - at)}) · id ${job.id}`
        : job.kind === 'done'
          ? `⏰ Se enviará al acabar el turno actual · id ${job.id}`
          : `⏰ Se enviará al resetearse el límite, ${formatWhen(job.dueAt ?? at, at, tz)} (en ${formatIn((job.dueAt ?? at) - at)}) · id ${job.id}`
  $.ui.toast(text)
  return text
}

async function cancelJobs($: EngineInterface, which: string): Promise<number> {
  const { sessionId } = await whoami($)
  let count = 0
  for (const job of await loadJobs($)) {
    if (which === 'all' ? job.sessionId !== sessionId : job.id !== which) continue
    await $.store.delete(`job:${job.id}`)
    count += 1
  }
  await refreshJobs($)
  await rearm($)
  return count
}

/** This session's queue; with `everywhere`, every session's (the way to find and `/schedule-cancel <id>` a stray one). */
async function listQueue($: EngineInterface, everywhere = false): Promise<string> {
  const at = await $.clock.now()
  const { sessionId } = await whoami($)
  const all = await loadJobs($)
  const mine = all.filter(job => everywhere || job.sessionId === sessionId).sort((a, b) => (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt))
  const elsewhere = all.length - mine.length
  if (mine.length === 0) return `Cola vacía.${elsewhere > 0 ? ` (${elsewhere} en otras sesiones: /schedule-queue all)` : ''}`
  const lines = mine.map(job => `${job.id}  ${describeWhen(job, at, tz)}  ${snippet(job.text, 50)}${job.sessionId === sessionId ? '' : `  [sesión ${job.sessionId.slice(0, 8)} · ${job.cwd}]`}`)
  return [`${mine.length} programado${mine.length === 1 ? '' : 's'}${everywhere ? ' (todas las sesiones)' : ' en esta sesión'}:`, ...lines, ...(elsewhere > 0 ? [`(+${elsewhere} en otras sesiones: /schedule-queue all)`] : [])].join('\n')
}

async function openQueue($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Cola', focus: true, closeOnEscape: true })
  await update($, isQueueOpen, () => opened.isPlaced)
  return opened.isPlaced
}

async function toggleQueue($: EngineInterface): Promise<void> {
  if (await read($, isQueueOpen)) await $.ui.close({ id: PANE })
  else await openQueue($)
}

/**
 * Empties the prompt box after a drop, which puts the typed text back once the
 * hook has returned (a fill made inside the hook is overwritten): so a moment later.
 */
function clearBox($: EngineInterface): void {
  $.clock.after(CLEAR_BOX_MS, () => {
    $.prompt.fill({ text: '', mode: 'replace' }).then(
      result => dbg($, `prompt.fill: ${JSON.stringify(result)}`),
      error => dbg($, `prompt.fill failed: ${String(error)}`),
    )
  })
}

/** Local zone: `Date` in the mod's worker, checked at start (see README). */
async function checkZone($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  dbg($, `zone: Intl=${Intl.DateTimeFormat().resolvedOptions().timeZone} offset=${tz(at)}min TZ-env-unknown`)
}

const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n))

// ---------------------------------------------------------------- the date-time menu

/**
 * Opens the menu for `draft` (else the prompt box's text): the box is emptied (a pane cannot take focus while
 * the box holds text) and the draft is put back if the menu closes without scheduling.
 */
async function openMenu($: EngineInterface, draft?: string): Promise<string | undefined> {
  const text = draft ?? (await $.prompt.read()).text
  if (text.trim() === '') return 'Escribe primero el prompt en la caja y pulsa alt+s (o /schedule-menu <texto>).'
  if ((await $.ui.panes()).some(pane => pane.id === MENU)) return undefined
  isMenuConfirmed = false
  menuValue = undefined
  await update($, menuDraft, () => text)
  await update($, menuError, () => '')
  if (draft === undefined) await $.prompt.fill({ text: '', mode: 'replace' })
  const opened = await $.ui.open({ id: MENU, title: 'Programar prompt', focus: true, closeOnEscape: true, rows: 6 })
  if (!opened.isPlaced) {
    if (draft === undefined) await $.prompt.fill({ text, mode: 'replace' })
    return 'No se pudo abrir el menú de programar.'
  }
  return undefined
}

/** The menu is over: unless it scheduled the draft, the draft goes back to the box. Idempotent. */
async function endMenu($: EngineInterface): Promise<void> {
  const draft = await read($, menuDraft)
  await update($, menuDraft, () => '')
  if (!isMenuConfirmed && draft !== '') await $.prompt.fill({ text: draft, mode: 'replace' })
}

/** Enter in the menu's field: schedules the draft or says in the pane what is wrong with the time. */
async function submitMenu($: EngineInterface, value: string): Promise<void> {
  const at = await $.clock.now()
  const parsed = parseWhenInput(value, at, tz)
  if ('error' in parsed) {
    menuValue = value
    await update($, menuError, () => parsed.error)
    return
  }
  const text = (await read($, menuDraft)).trimEnd()
  const { sessionId, cwd } = await whoami($)
  const job = await scheduleJob($, { text, dueAt: parsed.at, sessionId, cwd })
  isMenuConfirmed = true
  await update($, menuDraft, () => '')
  await $.ui.close({ id: MENU })
  $.ui.toast(`⏰ Programado para ${formatWhen(parsed.at, at, tz)} (en ${formatIn(parsed.at - at)}) · id ${job.id}`)
}

// ---------------------------------------------------------------- the mod

export const register: Register = (on, options) => {
  const config = parseConfig(options)
  activeConfig = config

  on('session.start', async ($, e, next) => {
    sessionIdCache = undefined
    activeConfig = config
    await $.command.register({
      name: 'schedule-resume',
      description: "Auto-resume tras un límite de uso: '/schedule-resume' estado, 'now', 'cancel', 'in <min>', 'test [min]'",
      immediate: true,
    })
    await $.command.register({ name: 'schedule-at', description: 'Programa un prompt: /schedule-at 17:00 texto · /schedule-at 2h30m texto · /schedule-at done texto · /schedule-at reset texto', argumentHint: '<cuándo> <texto>', immediate: true })
    await $.command.register({ name: 'schedule-queue', description: "Lista (y abre) los prompts programados de esta sesión; '/schedule-queue all' los de todas", argumentHint: '[all]', immediate: true })
    await $.command.register({ name: 'schedule-menu', description: 'Abre el menú de fecha y hora para programar el prompt (también alt+s con el prompt escrito): /schedule-menu [texto]', argumentHint: '[texto]', immediate: true })
    await $.command.register({ name: 'schedule-cancel', description: 'Cancela un prompt programado: /schedule-cancel <id> o /schedule-cancel all (los de esta sesión)', argumentHint: '<id|all>', immediate: true })
    // An earlier version pinned a status line; the band and the footer label say it now.
    $.ui.status(undefined)
    await checkZone($)
    try {
      limits = (await $.session.usage()).rateLimits.map(w => ({ ...w }))
    } catch {
      // no reading yet: session.measure brings it
    }
    poll?.cancel()
    dropTimers()
    poll = $.clock.every(config.pollMs, () => void tick($, config).catch(quiet($)))
    // Jobs left by an earlier run are caught up, adopted or expired at once; the tick arms the exact timers.
    await tick($, config).catch(quiet($))
    await rearm($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) limits = e.rateLimits.map(w => ({ ...w }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // A surface joining brings the countdown up to date.
  on('session.attach', async ($, e, next) => {
    const done = await next(e)
    await refreshNow($)
    return done
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isTurnRunning = true
      lastTurnStart = await $.clock.now()
      await markActivity($)
    }
    return done
  }).catch(($, e, next) => next(e))

  // ponytail: the prompt box is read as typed; a pasted or multi-line prompt starting with a schedule word is a schedule too.
  on('prompt.submit', async ($, e, next) => {
    // Our own reinjected prompt: never intercept it again. (The engine skips a plugin's own hooks for its
    // own submits as re-entry, so this is a guard only; turn.start is what marks activity for those.)
    if (e.origin?.kind === 'plugin') {
      if (e.command === undefined) await markActivity($)
      return next(e)
    }
    const text = e.text.trimStart()
    if (e.command === undefined && looksScheduled(text)) {
      const when = parseWhen(text, await $.clock.now(), tz)
      if (when === null) return { drop: `Hora o texto no válidos. ${USAGE}` }
      const confirmation = await schedule($, config, when)
      clearBox($)
      return { drop: confirmation }
    }
    // Any prompt that enters, of any origin, tells a backup resume that someone got the session going.
    if (e.command === undefined) await markActivity($)
    // The person, or the SDK host driving the session, sent a prompt of its own: it has taken over.
    const kind = e.origin?.kind
    const isTakeOver = e.command === undefined && (kind === 'composer' || kind === 'bridge' || kind === 'sdk')
    if (isTakeOver && (await read($, pending)) !== null) {
      await disarm($)
      $.ui.toast('Auto-resume cancelado: has retomado el control.')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    isTurnRunning = false
    if (e.reason === 'answer') {
      await update($, attempts, () => 0)
      const { sessionId } = await whoami($)
      for (const job of await loadJobs($)) {
        if (job.kind === 'done' && job.sessionId === sessionId) await fire($, job)
      }
      await refreshJobs($)
    }
    // Second signal for the same failure: if StopFailure never reached us, a turn dead on an API error while a window is full still arms.
    if (e.reason === 'error') await armFromFullWindow($, config).catch(quiet($))
    return done
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    const done = await next(e)
    // Nobody is waiting on a headless session: arm nothing, say nothing.
    if (!(await isShown($))) return done
    const at = await $.clock.now()
    const read1 = (await $.session.usage()).rateLimits
    const rateLimits = read1.length > 0 ? read1 : limits
    dbg($, `StopFailure error=${e.error} rateLimits=${JSON.stringify(rateLimits)}`)
    const message = [e.last_assistant_message, e.error_details].filter((t): t is string => typeof t === 'string').join(' ')
    const plan = planResume({ error: e.error, rateLimits, now: at, attempts: await read($, attempts), config, message, tz })
    if (plan === undefined) {
      if (e.error === 'rate_limit') $.ui.toast('Auto-resume se rinde: demasiados reintentos seguidos.')
      return done
    }
    await arm($, config, plan)
    $.ui.toast(`${plan.reason}: reanudo a las ${formatWhen(plan.resumeAt, at, tz)} (en ${formatWait(plan.resumeAt - at)}).`)
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'schedule-resume' }, async ($, e) => {
    const [verb = '', amount = ''] = e.args.trim().split(/\s+/)
    if (verb === 'now') {
      if ((await read($, pending)) === null) return { text: 'No hay ninguna reanudación en espera.' }
      void resume($, config, true).catch(report($))
      return { text: 'Reanudando ahora.' }
    }
    if (verb === 'cancel') {
      await disarm($)
      return { text: 'Auto-resume cancelado.' }
    }
    if (verb === 'in') {
      const minutes = parseMinutes(amount)
      if (minutes === undefined) return { text: 'Uso: /schedule-resume in <minutos>, de 1 a 1440.' }
      await arm($, config, { resumeAt: (await $.clock.now()) + minutes * 60_000, reason: 'scheduled by you' })
      return { text: `Reanudaré en ${formatWait(minutes * 60_000)}.` }
    }
    if (verb === 'test') {
      const minutes = amount === '' ? 1 : parseMinutes(amount)
      if (minutes === undefined) return { text: 'Uso: /schedule-resume test [minutos], de 1 a 1440.' }
      await arm($, config, { resumeAt: (await $.clock.now()) + minutes * 60_000, reason: 'test limit', isLimit: true })
      return { text: `Simulando un límite: reanudo en ${formatWait(minutes * 60_000)}.` }
    }
    if (verb !== '' && verb !== 'status') return { text: 'Uso: /schedule-resume [status | now | cancel | in <minutos> | test [minutos]]' }
    const waiting = await read($, pending)
    if (waiting === null) return { text: 'Auto-resume está en reposo; se arma solo cuando un turno choca con un límite de uso.' }
    const at = await $.clock.now()
    return { text: `${waiting.reason}: reanudo a las ${formatWhen(waiting.resumeAt, at, tz)} (en ${formatWait(waiting.resumeAt - at)}).` }
  }).catch(() => ({ text: 'scheduler: error interno (mira el log de depuración)' }))

  on('command.run', { command: 'schedule-menu' }, async ($, e) => {
    const failure = await openMenu($, e.args.trim() === '' ? undefined : e.args.trim())
    return { text: failure ?? 'Menú de programar abierto: escribe la hora y pulsa Enter (Esc cancela).' }
  }).catch(() => ({ text: 'scheduler: error interno (mira el log de depuración)' }))

  on('command.run', { command: 'schedule-at' }, async ($, e) => {
    if (e.args.trim() === '') return { text: (await openMenu($)) ?? 'Menú de programar abierto: escribe la hora y pulsa Enter (Esc cancela).' }
    const when = parseWhen(e.args, await $.clock.now(), tz)
    if (when === null) return { text: `Hora o texto no válidos. ${USAGE.replaceAll('@', '/schedule-at ')}` }
    return { text: await schedule($, config, when) }
  }).catch(() => ({ text: 'scheduler: error interno (mira el log de depuración)' }))

  on('command.run', { command: 'schedule-queue' }, async ($, e) => {
    const list = await listQueue($, /^(all|todo|todos)$/i.test(e.args.trim()))
    await openQueue($)
    return { text: list }
  }).catch(() => ({ text: 'scheduler: error interno (mira el log de depuración)' }))

  on('command.run', { command: 'schedule-cancel' }, async ($, e) => {
    const which = parseCancel(e.args)
    if (which === undefined) return { text: 'Uso: /schedule-cancel <id> o /schedule-cancel all (ids en /schedule-queue).' }
    const count = await cancelJobs($, which)
    return { text: count === 0 ? (which === 'all' ? 'No hay prompts programados en esta sesión.' : `No hay ningún programado con id ${which}.`) : `Cancelados: ${count}.` }
  }).catch(() => ({ text: 'scheduler: error interno (mira el log de depuración)' }))

  // Esc or a click outside (the person closing it): a plugin's own $.ui.close does not pass through its own hooks.
  on('ui.close', { id: MENU }, async ($, e, next) => {
    await endMenu($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isQueueOpen, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const waiting = await read($, pending)
    const queued = await read($, jobs)
    const at = await read($, now)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // Always mounted: the Button that names MENU_ACTION is what receives the shortcut's chord.
    const menu = (
      <Button
        key="sched"
        plain
        dimColor
        label="⏰ alt+s programar"
        action={MENU_ACTION}
        onPress={() => void openMenu($).then(failure => failure !== undefined && $.ui.toast(failure)).catch(report($))}
      />
    )
    if (waiting === null && queued.length === 0) return <Box flexDirection="row">{menu}</Box>

    if (waiting !== null) {
      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={e.props.bodyColumns}>
          <Text color="yellow">{'⏳'} {waiting.reason}:</Text>
          <Text>
            reanuda {formatWhen(waiting.resumeAt, at, tz)} (en {formatWait(waiting.resumeAt - at)})
          </Text>
          <Button key="now" variant="primary" label="Reanudar ya" onPress={() => void resume($, config, true).catch(report($))} />
          <Button key="cancel" label="Cancelar" onPress={() => void disarm($).catch(report($))} />
          {menu}
        </Box>
      )
    }
    const next1 = nextDue(queued)
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={e.props.bodyColumns}>
        <Text color="cyan">{'⏰'} {queued.length} programado{queued.length === 1 ? '' : 's'}</Text>
        {next1 !== undefined && (
          <Text>
            · próximo {formatWhen(next1, at, tz)} (en {formatIn(next1 - at)})
          </Text>
        )}
        <Button key="queue" label="Cola" onPress={() => void toggleQueue($).catch(report($))} />
        {menu}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // The dim labels at the right of the prompt footer, after the engine's own modes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const waiting = await read($, pending)
    const queued = await read($, jobs)
    const at = await read($, now)
    if (waiting === null && queued.length === 0) return next(e)
    const next1 = nextDue(queued)
    const label =
      waiting !== null
        ? `⏳ reanuda ${formatWhen(waiting.resumeAt, at, tz)}`
        : `⏰ ${queued.length}${next1 === undefined ? '' : ` · próximo ${formatWhen(next1, at, tz)}`}`
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')} · </Text>}
        <Text color={waiting !== null ? 'yellow' : 'cyan'}>{label}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: MENU }, async ($, e) => {
    const draft = await read($, menuDraft)
    const error = await read($, menuError)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // A surface without text fields (the phone) offers /schedule-at instead.
    if (!('Input' in elements)) return <Text>Este menú necesita un campo de texto: usa /schedule-at 17:30 texto.</Text>
    const { Input } = elements
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Prompt: {snippet(draft, Math.max(20, e.props.bodyColumns - 12))}</Text>
        <Input
          key="when"
          label="Cuándo"
          value={menuValue ?? formatField(await $.clock.now(), tz)}
          placeholder="17:30 · +30m · mañana 9:00 · 2026-10-23 09:00"
          autoFocus
          submitLabel="programar"
          onSubmit={(value: string) => void submitMenu($, value).catch(report($))}
        />
        {error !== '' && <Text color="red">{error}</Text>}
        <Box flexDirection="row" columnGap={1}>
          <Button key="cancel" label="Cancelar" onPress={() => void endMenu($).then(() => $.ui.close({ id: MENU })).catch(report($))} />
          <Text dimColor>Enter programa · Esc cancela y devuelve el prompt a la caja</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const queued = await read($, jobs)
    const at = await read($, now)
    const width = clamp(e.props.bodyColumns - 36, 12, 80)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{'⏰'} Prompts programados</Text>
        {queued.length === 0 && <Text dimColor>Nada programado. Escribe @17:00 texto, @2h30m texto, @done texto o @reset texto.</Text>}
        {queued.map((job, i) => (
          <Box key={`row-${job.id}`} flexDirection="row" columnGap={1}>
            <Text bold>{job.id}</Text>
            <Text color="cyan">{describeWhen(job, at, tz)}</Text>
            <Text>{snippet(job.text, width)}</Text>
            <Button
              key={`cancel-${job.id}`}
              label="Cancelar"
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              onPress={() => void cancelJobs($, job.id).catch(report($))}
            />
          </Box>
        ))}
        <Box flexDirection="row" columnGap={1}>
          {queued.length > 1 && <Button key="cancel-all" label="Cancelar todo" hotkey="x" onPress={() => void cancelJobs($, 'all').catch(report($))} />}
          <Button key="close" label="Cerrar" hotkey="q" onPress={() => void $.ui.close({ id: PANE }).catch(report($))} />
        </Box>
      </Box>
    )
  })
}

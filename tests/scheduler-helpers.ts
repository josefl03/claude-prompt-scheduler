import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const MINUTE = 60_000
export const NOW = 1_800_000_000_000

export const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

export const PANE = {
  plugin: 'prompt-scheduler',
  component: 'Pane',
  requestId: 'queue',
  viewport: { columns: 120, rows: 30 },
  props: { title: 'Cola', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

export type Beneath = {
  store: Map<string, unknown>
  toasts: string[]
  /** Lines written with `$.ui.log` (the debug log). */
  logs: string[]
  /** The prompt box: what `$.prompt.read()` answers and `$.prompt.fill` sets. */
  box: { text: string }
  /** Ids of the panes open. */
  panes: string[]
  sent: string[]
  surfaces: string[]
  /** What `$.session.usage()` reports as rate limits; the test edits it. */
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  clock: ReturnType<typeof mock.clock>
}

/**
 * Stand-ins for what the engine does beneath the plugin: store, session
 * identity, an empty band, toasts, the prompts that really go out (`sent`),
 * and the surfaces showing the session (a list the test edits).
 */
export function engineBeneath(
  on: On,
  init: { sessionId?: string; cwd?: string; surfaces?: string[]; now?: number; onSubmit?: (text: string) => void; onFill?: (e: unknown) => void } = {},
): Beneath {
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const logs: string[] = []
  const box = { text: '' }
  const panes: string[] = []
  const sent: string[] = []
  const surfaces = init.surfaces ?? ['terminal']
  const limits: Beneath['limits'] = []
  const clock = mock.clock(on, { now: init.now ?? NOW })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: init.sessionId ?? 'sess-A' }))
  on('session.cwd', () => ({ value: init.cwd ?? '/work' }))
  on('session.surfaces', () => ({ value: [...surfaces] as never }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [...limits] } }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.render', { component: 'SessionMode' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    const i = panes.indexOf(e.id)
    if (i >= 0) panes.splice(i, 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes.map(id => ({ id })) as never }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.StopFailure', () => ({}))
  on('prompt.fill', (_$, e) => {
    box.text = e.text
    init.onFill?.(e)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    init.onSubmit?.(e.text)
    sent.push(e.text)
    return { text: e.text }
  })
  return { store, toasts, logs, box, panes, sent, surfaces, limits, clock }
}

export const COMPOSER = { kind: 'composer' } as const
export const RUN = { origin: COMPOSER, presentation: { isFullscreen: false, columns: 100 } } as const

/** A reading of the usage windows as `session.measure` brings it. */
export function fiveHourFull(resetsInMs: number, at: number = NOW) {
  return [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(at + resetsInMs).toISOString() }]
}

export function jobIn(store: Map<string, unknown>, id: string, extra: Record<string, unknown> = {}): void {
  store.set(`job:${id}`, { id, text: `text ${id}`, kind: 'at', dueAt: NOW + MINUTE, sessionId: 'sess-A', cwd: '/work', createdAt: NOW, ...extra })
}

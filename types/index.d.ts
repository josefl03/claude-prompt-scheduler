// Contract of the `$.state` of the prompt-scheduler plugin's scheduler (hooks/scheduler/). The exported names
// carry the `Scheduler` prefix because the contract belongs to the whole plugin, not to a single module.

/** A resume waiting on the clock. */
export type SchedulerPending = {
  /** Milliseconds since the epoch at which the resume prompt is sent. */
  resumeAt: number
  /** Why it waits, as the band and status line say it. */
  reason: string
  /** True when a usage/rate limit caused it: scheduled jobs wait for it too. */
  isLimit?: true
  /**
   * When the failure that armed it happened. Present = a backup resume: at `resumeAt` it is sent only
   * if no turn has started and no prompt has entered since (the native auto-continue may have acted).
   * Absent (`/schedule-resume in`, `test`) = sent unconditionally.
   */
  armedAt?: number
}

/** A scheduled prompt, kept in `$.store` under `job:<id>`. */
export type SchedulerJob = {
  /** Four hex digits. */
  id: string
  /** What is sent. */
  text: string
  /** `at`: a clock time; `done`: when the current turn ends; `reset`: when the usage limit resets. */
  kind: 'at' | 'done' | 'reset'
  /** Milliseconds since the epoch; absent for `done` (and a `reset` not yet known). */
  dueAt?: number
  /** The session that fires it (another session of the same cwd adopts it if this one goes silent). */
  sessionId: string
  cwd: string
  createdAt: number
}

/** What `scheduleJob` takes: a prompt for a given instant. */
export type SchedulerJobRequest = {
  text: string
  /** Milliseconds since the epoch. */
  dueAt: number
  sessionId: string
  cwd: string
}

/** One automatic resume sent, kept in `$.store` under `history` (last 10). */
export type SchedulerResumed = { at: number; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-scheduler': {
      'scheduler-pending': SchedulerPending | null
      /** Resumes sent since the last successful answer. */
      'scheduler-attempts': number
      /** The clock as of the last tick, so the countdown redraws. */
      'scheduler-now': number
      /** The queued jobs of this session, for the band and the pane. */
      'scheduler-jobs': SchedulerJob[]
      /** Whether the queue pane is open. */
      'scheduler-queue-open': boolean
      /** The prompt being scheduled from the date-time menu (taken from the prompt box). */
      'scheduler-menu-draft': string
      /** What is wrong with the menu's field, shown in the pane; empty when nothing. */
      'scheduler-menu-error': string
    }
  }
}

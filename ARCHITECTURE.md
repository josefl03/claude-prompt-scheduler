# Architecture

`prompt-scheduler` is one Claude Code mod: `hooks/hooks.json` names a single module, `hooks/scheduler.tsx`, which exports `register`.

## Files

| File | Role |
|---|---|
| `hooks/schedule.ts` | Pure grammar of `@when text`, time zones, time formatting. No engine, no clock. |
| `hooks/queue.ts` | Pure queue rules: who fires what and when, adoption by heartbeat (2 min of silence), catch-up, waiting during a limit. |
| `hooks/plan.ts` | Pure resume rules (`planResume`, `findReset`, reading the reset time from the notice) and `parseConfig`. |
| `hooks/scheduler.tsx` | `register`: store, timers, commands, band, footer label, queue panel and date-time menu. Exports `scheduleJob`. |
| `types/index.d.ts` | The `$.state` contract under the name `prompt-scheduler` and the job types; named in `plugin.json` as `types`. |
| `tests/` | Six files, 80 tests, run with `claude plugin test .` against a mocked engine. |

## State

- **`$.store`** (shared by every session of this plugin): `job:<id>` (a queued prompt with its `sessionId` and `cwd`), `alive:<session>` (heartbeat, written every 30 s), `activity:<session>`, `history`.
- **`$.state`** (per session, drives redraws): pending resume, attempts, the session's jobs, panel and menu state.

## Rules that matter

- **Per-session view.** `refreshJobs`, `/schedule-queue`, `/schedule-cancel all`, the band, the footer and the panel filter by `job.sessionId`. `/schedule-queue all` and `/schedule-cancel <id>` reach the others.
- **Adoption.** A job of a session silent for 2 minutes is adopted by a live session of the same `cwd` and becomes its own.
- **Exact firing.** Every job of this session has a `$.clock.after(dueAt - now)` (at most 1 h per timer, re-armed on expiry). Timers are re-armed on create, cancel, adopt, postpone and `session.start`. The 5 s poll catches what a suspended laptop missed.
- **A job is deleted from the store before it is sent**, so no tick or other session can send it twice.
- **Backup resume.** After a `rate_limit` `StopFailure` the resume is armed at `resetsAt` (or the time read from the notice) plus the grace; at expiry it sends only if no turn or prompt started since the failure.
- **Why the backup exists (measured on Claude Code 2.1.308/2.1.309 with a mock API, 5 h and weekly alike).** The native auto-continue (`autoContinueAtUsageLimit`, on by default) arms on both limits and fires at reset plus 30-90 s, but if the process is suspended across the reset for more than 30 min it turns "stale" (`Usage limit has reset · press enter to continue`) and sends nothing; a 5 h wait is long enough for a sleeping laptop to hit that. The backup then sends at wake-up. When the native resume is not armed Claude Code opens its `/rate-limit-options` dialog, which holds the keys: the resume is queued behind it and no plugin API closes it. After 30 s with no turn started (`watchResume`) and no turn running, the backup sends one Escape to the pane (`herdr pane send-keys $HERDR_PANE_ID esc`, else `tmux send-keys -t $TMUX_PANE Escape`) and the queued resume goes out; with no pane to reach, or after 'Reanudar ya', it only warns. The native gate (`tengu_marble_heron` plus the auto-continue setting, `Rlt`) cannot be forced locally: the cached flags in `~/.claude.json` are ignored.
- **Second arming signal.** `turn.complete` with `reason: 'error'` arms the resume too (`armFromFullWindow`) when `StopFailure` armed nothing, a window is full, a surface shows the session and the retry cap allows it.
- **Extension point.** `scheduleJob($, { text, dueAt, sessionId, cwd })` stores a job and arms its timer; its `id` is what `/schedule-cancel` takes.
- **Command names** allow letters, digits, `_` and `-` only, so the `schedule-` prefix stands in for a namespace.

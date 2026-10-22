# CHANGELOG_AI

## 2026-10-23 — 5 h limit: measured against a mock API, backup hardened

- Reproduced the usage limit with a mock Anthropic API (headers `anthropic-ratelimit-unified-*`, 429): Claude Code 2.1.309 prints the exact `You've hit your session limit · resets …` / `weekly limit` notice, arms its native auto-continue for both, fires it at reset plus 30-90 s, and this backup defers (one request reaches the API). Native fails when the process sleeps through the reset ("stale", press enter) or when its auto-continue is off (dialog); the backup covers the first (sent 2 s after wake) and is held by the second.
- Dialog case: after 30 s queued with no turn started or running, `watchResume` sends one Escape via herdr or tmux (`$.process.run`), proven in tmux with the native resume off: one request reaches the API after the reset (5 h and weekly).
- Added `armFromFullWindow` (second arming signal on `turn.complete` error) and a 30 s watchdog (`watchResume`) that tells the person when a queued resume is stuck behind a dialog.
- 7 tests for the 5 h case in `tests/scheduler-auto-resume.test.ts` plus 4 for the Escape. Verified: `claude plugin test .` 91 pass, `claude plugin validate .` passes.

## 2026-10-22 — Extracted from the personal `jose` plugin

- Moved `hooks/scheduler/*` and its tests into this repository as the plugin `prompt-scheduler` 0.1.0; state atoms renamed from `jose` to `prompt-scheduler`; `hooks.json` points straight at `scheduler.tsx` (a module that only re-exports `register` is refused).
- Commands renamed to the `schedule-` prefix (`at`, `menu`, `queue`, `cancel`, `resume`); command names cannot contain `:`.
- Queue, band, footer and panel scoped to the session; `/schedule-queue all` added; `/schedule-cancel all` on an empty session no longer says "id all".
- Verified: `claude plugin test .` 80 pass, `claude plugin validate .` passes.

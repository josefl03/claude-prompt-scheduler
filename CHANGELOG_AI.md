# CHANGELOG_AI

## 2026-10-22 — Extracted from the personal `jose` plugin

- Moved `hooks/scheduler/*` and its tests into this repository as the plugin `prompt-scheduler` 0.1.0; state atoms renamed from `jose` to `prompt-scheduler`; `hooks.json` points straight at `scheduler.tsx` (a module that only re-exports `register` is refused).
- Commands renamed to the `schedule-` prefix (`at`, `menu`, `queue`, `cancel`, `resume`); command names cannot contain `:`.
- Queue, band, footer and panel scoped to the session; `/schedule-queue all` added; `/schedule-cancel all` on an empty session no longer says "id all".
- Verified: `claude plugin test .` 80 pass, `claude plugin validate .` passes.

# prompt-scheduler

[![CI](https://github.com/josefl03/claude-prompt-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/josefl03/claude-prompt-scheduler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Write `@17:00 run the nightly report` in Claude Code and the prompt goes out at 17:00. Each session sees and cancels only its own queue. If you hit a usage limit, it also resumes your work once the limit resets.

It is a [Claude Code mod](https://code.claude.com/docs): a plugin with a hooks module. Needs Claude Code 2.1.300 or later.

> Early release. Command output and menus are in Spanish for now; the prompt grammar accepts English and Spanish words (`tomorrow`, `mañana`).

## Install

```sh
claude plugin marketplace add josefl03/claude-prompt-scheduler
claude plugin install prompt-scheduler@prompt-scheduler --scope user
```

Start a new session afterwards. Update with `claude plugin update prompt-scheduler@prompt-scheduler`.

## Schedule a prompt

Put a prefix at the start of the prompt and press Enter. It is held back and a toast confirms it.

| Prefix | Sent |
|---|---|
| `@17:00 text` · `@17:00:30 text` | at that time today, or tomorrow if it has passed |
| `@tomorrow 9:00 text` | tomorrow at 09:00 |
| `@2h30m text` · `@45m text` · `@30s text` | after that long |
| `@done text` | when the current turn ends |
| `@reset text` | when the usage limit resets |

Times use your system time zone. A prompt found overdue (laptop asleep) is still sent if it is under 3 hours late.

## Commands

All start with `/schedule-`, so typing that lists them.

| Command | What it does |
|---|---|
| `/schedule-at <when> <text>` | same as the prefix, without the `@` (use this on mobile) |
| `/schedule-menu [text]` | date-time menu, also on **alt+s** if you bind it |
| `/schedule-queue` | prompts queued in this session, plus a panel with a Cancel button each |
| `/schedule-queue all` | prompts of every session, with session and folder |
| `/schedule-cancel <id>` | cancel one prompt by its 4-character id, from any session |
| `/schedule-cancel all` | cancel everything queued in this session |
| `/schedule-resume [status\|now\|cancel\|in <min>\|test [min]]` | control the usage-limit resume |

If a session closes, another one in the same folder adopts its prompts after two minutes, so nothing is lost.

To open the menu with a key, bind a chord to `app:cycleDiffBase` in `~/.claude/keybindings.json`:

```json
{ "bindings": [ { "context": "Global", "bindings": { "alt+s": "app:cycleDiffBase" } } ] }
```

## Resume after a usage limit

Claude Code already resumes by itself; this is the backup. After a rate-limit failure it waits for the reset plus 120 s and sends a resume prompt, but only if no turn or prompt has started in the meantime. If the native resume is stuck behind the `/rate-limit-options` dialog, it sends Escape to the herdr or tmux pane. `/schedule-resume now` forces it.

Options (resume text, grace period, retries, catch-up window, poll interval) are in `/config` → plugins, or under `pluginConfigs` in `settings.json`.

## How it works

Every queued prompt gets its own timer for the exact due time; a 5 s poll only covers a suspended machine. The queue lives in the plugin's store, so any session can read it, and each prompt belongs to the session that made it. Details in [ARCHITECTURE.md](ARCHITECTURE.md). To see what fired, run `claude --debug-file <file>` and look for `[scheduler] fired job`.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Parts derive from other mods, credited in [NOTICE.md](NOTICE.md).

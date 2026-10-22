<div align="center">

# prompt-scheduler

*Schedule Claude Code prompts for any time, see and cancel what is queued in each session, and resume by itself after a usage limit.*

[![CI](https://github.com/josefl03/claude-prompt-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/josefl03/claude-prompt-scheduler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

`prompt-scheduler` is a [Claude Code mod](https://code.claude.com/docs) (a plugin with a hooks module). Type `@17:00 run the nightly report` in the prompt box and the prompt is held back and sent at 17:00 sharp. Each session sees only its own queue; a backup resume sends your work on after a usage limit if Claude Code's own resume did not.

> Status: early release. The command output and menus are in Spanish for now; the prompt grammar accepts English and Spanish words (`tomorrow`, `mañana`).

## What you need

- Claude Code 2.1.300 or later, on any surface (terminal, desktop, VS Code, mobile show the queue; the date-time menu needs a text field, so on mobile use `/schedule-at`).

## Install

```sh
claude plugin marketplace add josefl03/claude-prompt-scheduler
claude plugin install prompt-scheduler@prompt-scheduler --scope user
```

Then start a new session. Update with `claude plugin update prompt-scheduler@prompt-scheduler`; remove with `claude plugin uninstall prompt-scheduler@prompt-scheduler`.

## Use

Write a prefix at the start of the prompt and press Enter. The prompt is stored and confirmed with a toast.

| Prefix | Sent |
|---|---|
| `@17:00 text`, `@17:00:30 text` | at that time today, or tomorrow if already past |
| `@tomorrow 9:00 text` | tomorrow at 09:00 |
| `@2h30m text`, `@45m text`, `@30s text` | after that long |
| `@done text` | when the current turn ends |
| `@reset text` | when the usage limit resets |

Times use your system time zone.

### Commands

All commands start with `/schedule-` so one keystroke lists them.

| Command | What it does |
|---|---|
| `/schedule-at <when> <text>` | same as the prefix, without the `@` |
| `/schedule-menu [text]` | date-time menu (also **alt+s** with the prompt typed) |
| `/schedule-queue` | list the prompts scheduled **in this session** and open the queue panel |
| `/schedule-queue all` | list the prompts of **every session**, with its session and folder |
| `/schedule-cancel <id>` | cancel one prompt by its four-character id, from any session |
| `/schedule-cancel all` | cancel every prompt of this session |
| `/schedule-resume [status\|now\|cancel\|in <min>\|test [min]]` | the usage-limit backup resume |

The band above the prompt and the footer show the count and the next time, again for this session only. The panel has a Cancel button per prompt.

A prompt of a session that has closed is adopted by another session in the same folder after two minutes of silence, so it is not lost; it then shows in that session.

### Keyboard shortcut for the menu

Bind a chord to `app:cycleDiffBase`, the action the menu button listens to, in `~/.claude/keybindings.json`:

```json
{ "bindings": [ { "context": "Global", "bindings": { "alt+s": "app:cycleDiffBase" } } ] }
```

`ctrl+enter` works too on terminals that tell it apart from Enter (CSI-u). That binding replaces `chat:sendNow`.

## Usage-limit backup resume

Claude Code already resumes by itself (`autoContinue`). This plugin is only a backup: after a rate-limit failure it waits for the reset plus a grace period (120 s) and sends the resume prompt only if no turn and no prompt has started since. `/schedule-resume now` or the **Resume now** button forces it.

## Options

Set in `/config` → plugins, or under `pluginConfigs` in `settings.json`: resume text, grace seconds, retry on overloaded errors, most retries in a row, catch-up window (a prompt found overdue is still sent if it is at most this many minutes late, 180 by default), safety poll interval, and whether prompts wait for the end of a usage limit.

## How it works

Each queued prompt has its own timer set for the exact due time; a 5 s poll is only a safety net for a suspended laptop. Prompts live in the plugin's store, so any session can see them; each is owned by the session that created it. See [ARCHITECTURE.md](ARCHITECTURE.md).

`claude --debug-file <file>` records `[scheduler] fired job <id> due=… at=… late=…ms` for each prompt sent.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and license

MIT, see [LICENSE](LICENSE). Derived in part from other mods, listed with their licenses in [NOTICE.md](NOTICE.md).

# Security policy

## Supported versions

Only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability** (https://github.com/josefl03/claude-prompt-scheduler/security/advisories/new).

Include what you found, how to reproduce it, the plugin version and your Claude Code version. Do not paste real credentials or private prompts.

This is a volunteer project: expect an acknowledgement within a few days and no fixed fix timeline.

## What the plugin does and does not touch

- It stores scheduled prompts in the plugin's own store (`$.store`) on your machine. Nothing leaves your machine except the prompts it sends to Claude Code itself, at the time you chose.
- It sends a prompt as if you typed it, so a scheduled prompt runs with the permissions your session has at that moment. Schedule only what you would type.
- It reads your usage windows from Claude Code to time the resume. It makes no network calls of its own and holds no credentials.

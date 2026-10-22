# Contributing

Thanks for helping.

## Before you start

- Read [ARCHITECTURE.md](ARCHITECTURE.md): the pure rules (`schedule.ts`, `queue.ts`, `plan.ts`) are kept apart from the engine glue (`scheduler.tsx`) on purpose.
- For anything bigger than a small fix, open an issue first so we agree on the approach.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Vulnerabilities go through [SECURITY.md](SECURITY.md), not public issues.

## Workflow

1. Fork, then branch from `main`.
2. Make the change in the style of the file you edit. Avoid style-only churn.
3. Run the checks (Claude Code 2.1.300 or later on your PATH):
   ```sh
   claude plugin validate .
   claude plugin test .
   ```
4. Add or update tests in `tests/`. They run against a mocked engine: no real session, clock or credentials.
5. User-visible change: add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md); changed modules or flows: update `ARCHITECTURE.md`.
6. Open a pull request using the template. One concern per PR.

## Commit messages

Short imperative subject with a prefix: `feat:`, `fix:`, `docs:`, `test:`, `ci:`.

## Licensing

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

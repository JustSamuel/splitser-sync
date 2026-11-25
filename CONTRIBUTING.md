# Contributing

Thanks for looking. This is a small project, so the process is short.

## Setup

```sh
pnpm install   # also installs the git hooks
pnpm check     # typecheck, lint, formatting, tests
```

Tests use fake backends and need no credentials. You can run `pnpm dev` to start the server and `pnpm reconcile` for a live dry run if you have a `.env`.

## What `pnpm check` runs

- `tsc` in strict mode
- the boundary lint (`scripts/check-boundaries.ts`), which keeps risky things like `fetch`, Actual writes and secrets in the one module that owns them. Allowlist entries live in `scripts/boundaries.json`, each with a reason, and a stale entry fails
- the env docs check, which fails when the code reads a variable that `.env.example` doesn't list, or the other way round
- prettier
- the tests, including seeded property tests for the reconcile invariants

CI runs the same things, plus commitlint, a Docker build and a dependency audit. `main` requires these to pass.

## Fixing a mistake

If you fix something that could have been caught by a check, add the check in the same PR. A sentence in a doc is easy to miss and a red build is not. When you add one, break the rule on purpose once and make sure it goes red. [HARDEN-AUDIT.md](HARDEN-AUDIT.md) lists what is enforced today and what isn't.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:` and so on). A git hook and CI both enforce this, and releases are cut from the commit messages, so the type matters.

Pull requests are rebase-merged, so every commit lands on `main` as you wrote it and history stays linear. Keep commits small and each one buildable.

## Where things live

[AGENTS.md](AGENTS.md) has the module layout.

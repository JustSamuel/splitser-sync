# Hardening audit

Checked against HARDEN.md after the SimpleFIN link landed. Each gap names the layer it belongs to.

## Layer 1: architecture and APIs

Present:

- One module per risky boundary, enforced by `scripts/boundaries.json`: `client.ts` (Splitser network, cookies, `fetch`), `http.ts` (inbound auth, constant-time compare), `reconcile.ts` (every Actual write, the adjustment's imported id), `config.ts` (`.env`), `simplefin.ts` and `splitser.ts` (pure, no I/O).
- Illegal inputs are rejected at the edge: EUR only, exactly one member per list, SimpleFIN amounts always two decimals.

Missing:

- Secrets and untrusted text are plain strings; there is no `Secret` type.
- Splitser responses are read through casts, not a runtime schema. The effects-sum-to-balance check in `splitserEffects` is the only cross-check, and it only warns.

## Layer 2: deterministic checks

Present: strict `tsc`, prettier check, boundary lint with a reason per allowlist line and stale-entry detection, env-variable docs check (`.env.example` vs `src/`), commitlint over every PR commit, unit and contract tests with fake backends, required checks on `main` (`lint-and-build / pnpm-steps`, `commitlint`, `dockerize / dockerize (.)`), rebase-only linear history, `pnpm audit` in CI.

Missing: license check (the only runtime dependency is `@actual-app/api`); golden tests; generated docs other than the env-variable check.

## Layer 3: runtime and invariants

Present: reconcile refuses tracker drift beyond rows Actual imported itself, changed bank balances and invalid bank-sync results, and verifies account and tracker after writing. A seeded property test covers 300 random histories (account = balance, tracker = minus balance, bank untouched, replay is a no-op) with a coverage guard. Per-transaction effects have a seeded property test against the balance formula.

Missing: fuzzing of the HTTP routes, performance budgets, a test for retries and concurrent sign-in in `client.ts`.

## Layer 4: prose

`AGENTS.md` holds the module map and commit rules. Everything enforceable lives in checks.

## Boundary inventory

- Splitser credentials: `.env` -> `config.ts` -> login JSON; cookies in memory and an atomic cookie file.
- Untrusted Splitser JSON: `fetch` -> pagination and cache -> balances and transactions -> reconcile, `/simplefin/accounts` and the public API.
- Actual credentials: `.env` -> Actual API init; Actual SQLite cache under the data directory.
- Actual writes: `addTransactions`, `updateTransaction`, `setBudgetAmount`, `sync`, plus `runBankSync` (which also pulls Splitser rows through SimpleFIN), all in `reconcile.ts`.
- Public HTTP: bearer tokens for the API and reconcile; a separate access secret (Basic auth) for `/simplefin/accounts`; a claim route that exists only while `SIMPLEFIN_CLAIM_TOKEN` is set.
- Docker and Coolify inject configuration as environment variables; the persistent volume holds credentials, session and budget data.

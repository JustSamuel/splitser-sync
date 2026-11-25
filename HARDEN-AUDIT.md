# Hardening audit

## Existing checks and automation

- Runtime: Node.js ES modules, pinned `@actual-app/api` 26.11.0.
- Manual checks: `node --check` per module, `npm audit --omit=dev`, Docker build, live dry run.
- No tests, test runner command, lint, formatter, typecheck, CI workflow, coverage, schema generation, or generated docs.
- No required checks or branch protection on `main`; direct pushes are currently possible.
- README contains setup and security guidance, but no repository-specific AGENTS.md.

## Layer 1: architecture and APIs

Present:
- `client.js` owns Splitser network calls, login, cookies, and caching.
- `server.js` owns inbound HTTP and bearer-token checks.
- `actual.js` owns Actual initialization and writes.
- `config.js` owns `.env` parsing.

Missing:
- No schema/runtime validation for external Splitser responses or configuration.
- Secrets and external data are plain strings/objects throughout.
- External request targets are partly derived from API data (`list.id`) without a common allowlist/schema.
- Reconciliation, Actual I/O, console reporting, environment access, and CLI/server composition are coupled in `actual.js`.
- Publicly served error messages originate at internal boundaries.

## Layer 2: deterministic checks

Present: dependency pinning; `npm audit` currently reports zero vulnerabilities.

Missing: all automated checks and CI jobs listed above. No contract tests, fake backends, mutation tests, golden tests, or stale allowlist detection. A syntax error was previously introduced during refactoring and caught only manually.

## Layer 3: runtime and invariants

Present:
- Explicit off-budget account, tracker carryover, duplicate adjustment, and post-write checks.
- Bank sync before apply; stops for imported transactions or changed transaction-derived balances.
- Stable `splitser:balance:current` imported ID; sequential reconciliation requests.

Missing or defective:
- A zero Splitser/account delta skips the tracker-drift check, so an already broken tracker can be reported as healthy.
- `getAccountBalance` is transaction-derived; it does not prove the bank-reported balance is unchanged. Account metadata timestamps must also be checked.
- No validation that bank sync returned the expected structure.
- No tests for changed/deleted source data, stale cache, pagination, retries, or concurrent sign-in.
- No seeded property/fuzz tests, coverage thresholds, or performance budgets.

## Layer 4: prose

README documents the balance invariant and deployment behavior. It also says no adjustment is needed when balances match, which must be qualified once zero-delta tracker drift is fixed. Keep operational judgment in prose; move security and accounting rules to executable checks.

## Boundary inventory

- Splitser credentials: `.env` -> `config.js` -> login JSON; cookies -> in-memory header and atomic cookie file.
- Untrusted Splitser JSON: `fetch` -> pagination/cache -> normalized balances/transactions -> reconciliation and public API responses.
- Actual credentials: `.env` -> Actual API initialization; Actual SQLite cache under the data directory.
- Bank network writes: `api.runBankSync()`; Actual writes: `addTransactions`, `updateTransaction`, `setBudgetAmount`, `sync`.
- Public HTTP: bearer tokens and query parameters -> route handlers -> Splitser/Actual; internal errors -> JSON and logs.
- Docker/Coolify inject all configuration as environment variables; persistent volume contains credentials/session/budget data.

# Splitser sync

Dependency-light TypeScript service (Node.js, pnpm) that reconciles the user's Splitser net balance to an off-budget Actual account. Keep deployment names, account names, credentials, and infrastructure details out of this public repository.

## Checks

`pnpm check` is the local CI gate: strict typechecking, boundary lint, formatting, and tests. `pnpm test` uses fake backends and no credentials. `pnpm reconcile` is a live dry run; only `pnpm reconcile --apply` may write.

Commits must be Conventional Commits (enforced by commitlint locally and in CI). Pull requests are rebase-merged into a linear history.

## Architecture

All source is in `src/`, written as erasable TypeScript (no enums or parameter properties) so Node runs it directly in development; `pnpm build` compiles to `dist/` for production.

- `client.ts`: Splitser authentication, cookie persistence, HTTP, caching.
- `http.ts`: inbound HTTP authentication and response redaction.
- `splitser.ts`: balance resolution and the member's per-transaction effects (pure).
- `simplefin.ts`: SimpleFIN response shapes, setup token and access URL (pure). `simplefin-setup.ts` is its CLI.
- `reconcile.ts`: reconciliation invariants and the only Actual mutations.
- `actual.ts`: real API adapter and CLI.
- `config.ts`: `.env` loading and settings.
- `server.ts`: composition and scheduling.

Keep private cookie and Actual state in `/data` in containers. Reconciliation refuses unbooked bank imports, changed bank-reported balances, and tracker drift. Rows Actual imported into the Splitser account itself (SimpleFIN) are expected: they are marked reconciled and the adjustment row absorbs any difference.

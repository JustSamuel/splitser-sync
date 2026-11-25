# splitser-sync

<p align="center"><img src="assets/banner.svg" alt="Actual Budget × WieBetaaltWat" width="720"></p>

[![Lint and build](https://github.com/JustSamuel/splitser-sync/actions/workflows/lint-and-build.yml/badge.svg?branch=main)](https://github.com/JustSamuel/splitser-sync/actions/workflows/lint-and-build.yml)
![License](https://img.shields.io/github/license/JustSamuel/splitser-sync)

Keep your [Splitser](https://splitser.com) balance visible in [Actual Budget](https://actualbudget.org/).

Splitser tracks who owes whom in shared expense lists. Actual doesn't know about it, so money you've fronted for friends (or owe them) never shows up in your budget. This tool reads your net balance across all active Splitser lists and mirrors it into Actual:

- an **off-budget account** (for example `Splitser`) holds the balance, positive when others owe you
- a **tracker category** (for example `Advances`) holds the opposite amount, so your _To Budget_ number doesn't move

```text
tracker category balance = -Splitser account balance
```

It never writes to Splitser. It writes to Actual only when you ask it to.

> **Heads up:** this uses Splitser's private web API, which has no stability guarantee and may change without notice. It is a hobby tool, not an official integration.

## How it works

1. Logs in to Splitser (session cookie is cached and refreshed automatically) and fetches your balance for every active list.
2. Opens your Actual budget through the official `@actual-app/api`.
3. Compares the two and prints the correction it would make (a dry run).
4. With `--apply`, adds or updates a single adjustment transaction in the off-budget account (`imported_id` `splitser:balance:current`) and shifts the tracker category's budget by the opposite amount.

Safety checks before and after every write:

- refuses to run if the tracker doesn't already equal minus the account (drift)
- syncs your bank accounts first and stops if that imports new transactions, so you book those before reconciling
- verifies both balances after writing
- aborts if any bank account balance changed

## Prerequisites

- Node.js 22.18 or newer (24 recommended; see `.nvmrc`) and [pnpm](https://pnpm.io/) (`corepack enable` is enough)
- A Splitser account (email and password login)
- An Actual Budget server you can reach, with its budget's **Sync ID** (Settings → Advanced settings → Sync ID)
- Actual server version matching the pinned API package, currently **26.11.0** (`@actual-app/api` in `package.json`). If your server is on a different version, change that dependency to match and run `pnpm install`.

## Getting started

### 1. Prepare Actual

Create these once in Actual:

1. **An off-budget account** named `Splitser`. Starting balance 0.
2. **A category** named `Advances` (in any group) with **carryover enabled** (category menu → _Enable carryover_). The tracker must carry over, otherwise its balance resets each month.
3. Know the names of your **on-budget bank accounts**. They are used as a tripwire: the tool refuses to write if their balances move.

You can use other names; set them in `.env` below.

### 2. Configure

```sh
git clone https://github.com/JustSamuel/splitser-sync.git
cd splitser-sync
cp .env.example .env
pnpm install
```

Edit `.env`. The settings you must fill in:

| Variable                                    | What it is                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SPLITSER_EMAIL`, `SPLITSER_PASSWORD`       | Your Splitser login                                                                            |
| `SPLITSER_MEMBER_NAME`                      | Your name exactly as it appears in your Splitser lists. Must match exactly one member per list |
| `ACTUAL_SERVER_URL`                         | URL of your Actual server                                                                      |
| `ACTUAL_PASSWORD`                           | Actual server password                                                                         |
| `ACTUAL_SYNC_ID`                            | The budget's Sync ID                                                                           |
| `ACTUAL_ENCRYPTION_PASSWORD`                | Only if the budget uses end-to-end encryption                                                  |
| `ACTUAL_ACCOUNT`, `ACTUAL_TRACKER_CATEGORY` | Names from step 1 (defaults `Splitser`, `Advances`)                                            |
| `ACTUAL_BANK_ACCOUNTS`                      | Comma-separated on-budget accounts, e.g. `Checking,Savings`. Required for `--apply`            |
| `ACTUAL_TIMEZONE`                           | Used to date the adjustment (default `Europe/Amsterdam`)                                       |

Everything else in `.env.example` is optional tuning (cache lifetimes, timeouts, API tokens, scheduling).

Only EUR lists are supported; the tool stops with an error on any other currency.

### 3. Dry run

```sh
pnpm reconcile
```

Example output:

```text
Splitser (Your Name): €42.50 across 3 active lists
  Ski trip: €30.00
  Flat: €12.50
  Dinner: €0.00
Actual Splitser: €0.00; proposed correction: €42.50
Advances 2026-11: €0.00 -> €-42.50
DRY RUN: no Actual changes. Re-run with --apply to write.
```

If it can't find your member name, account or category, the error says which one.

### 4. Apply once

```sh
pnpm reconcile --apply
```

Check Actual: the `Splitser` account should now equal your Splitser balance, `Advances` its negative, and your bank accounts and _To Budget_ unchanged. Re-running is safe; it updates the same adjustment rather than adding new ones.

When a Splitser settlement lands in your bank account, book it in Actual as a transfer to the `Splitser` account as usual. The next run reconciles the remainder.

To get every Splitser expense as its own transaction, and a real linked account in Actual, see [Linking the account in Actual](#linking-the-account-in-actual-simplefin).

Add `--json` to either command for machine-readable output. After a successful apply, `reconciliation.json` (git-ignored) holds the last report.

## Running it automatically

### As a service (Docker / Coolify)

```sh
docker compose up -d --build
```

Each release publishes a ready-made image, so you can skip the build: `ghcr.io/justsamuel/splitser-sync:latest` (or pin a version such as `:1.2.3`). Use it in `compose.yaml` by replacing `build: .` with `image: ghcr.io/justsamuel/splitser-sync:latest`. Releases and version tags (`v1.2.3`) are created automatically from conventional commits: `feat:` bumps the minor version, `fix:` and dependency updates bump the patch version.

The container serves a small HTTP API and can reconcile on a timer. Put the settings from `.env` into your platform's secret store rather than committing them. The `splitser-data` volume keeps the refreshed Splitser session and Actual's local cache. The published port is bound to localhost; adjust it if you front the service with a reverse proxy.

To reconcile on a schedule, set:

```text
ALLOW_ACTUAL_WRITES=true
RECONCILE_INTERVAL_MINUTES=60
```

It then reconciles at startup and at that interval. Only turn this on after a dry run and a reviewed one-time `--apply` have both worked.

### HTTP API

```sh
pnpm build
pnpm start
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/lists
curl http://127.0.0.1:8787/balances
curl 'http://127.0.0.1:8787/transactions?list_id=LIST_UUID'
```

- `/transactions` returns expenses, income and settlements, deduplicated by `type:id`.
- List metadata is cached for 60 s, balances and transactions for 5 min. `?refresh=1` bypasses the cache.
- Set `API_TOKEN` to require `Authorization: Bearer <token>` on everything except `/health`. Without it, bind only to localhost or a private network.

Trigger a reconcile over HTTP with a separate `RECONCILE_TOKEN`:

```sh
curl -X POST -H "Authorization: Bearer $RECONCILE_TOKEN" http://127.0.0.1:8787/reconcile
```

That is a dry run unless you add `?apply=true` _and_ have set `ALLOW_ACTUAL_WRITES=true`. Overlapping runs get HTTP 409.

### Linking the account in Actual (SimpleFIN)

splitser-sync can act as a [SimpleFIN](https://www.simplefin.org/) bank, so Actual treats `Splitser` as a linked account: your share of every Splitser expense arrives as a transaction through Actual's normal bank sync. It needs a service reachable by your Actual server over HTTPS on a public address.

1. Deploy splitser-sync and run `pnpm simplefin:setup https://your-host`. Set the three variables it prints on the service, then redeploy.
2. In Actual: Settings → Bank Sync → SimpleFIN, and paste the setup token. Actual allows one SimpleFIN connection per server.
3. On the `Splitser` account choose _Link account_ and pick `Splitser`.
4. Remove `SIMPLEFIN_CLAIM_TOKEN` and redeploy so the token cannot be claimed again.
5. Run `pnpm reconcile` (dry run first). Reconcile now absorbs rows that Actual imported itself: it marks them reconciled, trims the adjustment row so the balance still equals Splitser's, and keeps the tracker at minus the balance.

Notes:

- Only expenses and income appear as transactions. Settlements are not included because they don't change the balance Splitser reports.
- Actual never rewrites the amount of a row it already imported. If you later edit or delete a Splitser expense, the next reconcile corrects the difference through the adjustment row.
- Actual may merge two Splitser rows of the same amount within a week into one. The adjustment row absorbs this too.
- Don't use Actual's own _Reconcile_ on this account; reconcile.ts uses that flag to tell new rows from handled ones.
- To undo, unlink the account in Actual and run `pnpm reconcile`.

## Security notes

- `.env`, the cookie file, the Actual cache and `reconciliation.json` are git-ignored and excluded from the Docker build context. Never commit them.
- Use long random values for `API_TOKEN` and `RECONCILE_TOKEN`, and don't expose the API publicly without a token.
- `/simplefin/accounts` accepts only the separate `SIMPLEFIN_ACCESS_SECRET`; the bearer tokens don't work there and the secret doesn't work elsewhere.
- Credentials never appear in logs; `pnpm lint` fails on code that logs them.

## Troubleshooting

| Message                                                | Fix                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `Actual needs an off-budget account named ...`         | Create it, or set `ACTUAL_ACCOUNT`. It must be marked off-budget                     |
| `... must have carryover enabled`                      | Enable carryover on the tracker category                                             |
| `... does not equal minus ...; fix the existing drift` | The account and tracker disagree beyond new linked imports. Correct that in Actual   |
| `Bank sync imported N transaction(s); book them ...`   | Categorize the newly imported _bank_ transactions in Actual, then run again          |
| `expected one member named ...`                        | Fix `SPLITSER_MEMBER_NAME` to match your name in that list exactly                   |
| Login or API errors from Splitser                      | Check credentials; the private API may have changed (`SPLITSER_API_VERSION`)         |
| Errors opening the budget                              | Check the Sync ID, and that the server version matches the `@actual-app/api` version |

## Contributing

```sh
pnpm install   # also installs the git hooks
pnpm check     # typecheck, boundary lint, formatting, tests
```

Tests use fake backends and need no credentials. See [AGENTS.md](AGENTS.md) for the module layout.

Every commit must follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:` ...). A git hook and CI both enforce this. Pull requests are rebase-merged, so each commit lands on `main` exactly as written and history stays linear.

## License

[MIT](LICENSE)

Actual Budget and WieBetaaltWat (Splitser) names and logos belong to their respective owners and appear here only to say which services this tool connects. This project is not affiliated with or endorsed by either. The logo files in `assets/` are their owners' (Actual: [actualbudget/actual](https://github.com/actualbudget/actual), WieBetaaltWat: [wiebetaaltwat.nl](https://wiebetaaltwat.nl)) and are not covered by the MIT license.

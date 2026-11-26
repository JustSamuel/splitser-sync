# splitser-sync

<p align="center"><img src="assets/banner.svg" alt="Actual Budget × WieBetaaltWat" width="720"></p>

[![Lint and build](https://github.com/JustSamuel/splitser-sync/actions/workflows/lint-and-build.yml/badge.svg?branch=main)](https://github.com/JustSamuel/splitser-sync/actions/workflows/lint-and-build.yml)
[![Release](https://img.shields.io/github/v/release/JustSamuel/splitser-sync)](https://github.com/JustSamuel/splitser-sync/releases)
![License](https://img.shields.io/github/license/JustSamuel/splitser-sync)

Splitser knows what your friends owe you. Actual Budget doesn't. So when you pay for the ski trip, your budget thinks the money is gone, and when they pay you back it thinks you got a raise.

splitser-sync reads your balance from [Splitser](https://splitser.com) (also known as WieBetaaltWat) and keeps it in [Actual](https://actualbudget.org/):

- an off-budget account, say `Splitser`, holds what others owe you (negative if you owe them)
- a category, say `Advances`, holds the opposite amount, so _To Budget_ never moves

```text
Splitser lists  ──►  splitser-sync  ──►  Actual
                     (reads only)        Splitser account:  +€131.34
                                         Advances category: −€131.34
```

It never writes to Splitser, and it only writes to Actual when you say so.

> Splitser has no public API. This uses the private one its web app talks to, which can change without notice. Treat this as a hobby tool. It isn't affiliated with Actual or Splitser.

## Two ways to use it

**Plain.** One command reconciles the account to your current balance with a single adjustment transaction. Quick to set up, and the account has no history.

**Linked.** splitser-sync also pretends to be a [SimpleFIN](https://www.simplefin.org/) bank, so Actual treats `Splitser` like a real bank account. Your share of each expense arrives as its own transaction, through Actual's normal bank sync. It takes a few more minutes and needs the service reachable from your Actual server.

Start with plain. You can switch to linked later without losing anything.

## Quick start

You need Node.js 22.18 or newer (24 is what CI uses), [pnpm](https://pnpm.io/) (`corepack enable` is enough), a Splitser account with an email and password, and an Actual server. Your Actual server version has to match the pinned `@actual-app/api` in `package.json`, currently 26.11.0. If yours differs, change that version and run `pnpm install`.

### 1. Prepare Actual

Create two things, once:

1. An off-budget account called `Splitser`, starting balance 0.
2. A category called `Advances` with carryover turned on (category menu, _Enable carryover_). Without carryover its balance resets every month and the numbers drift.

You'll also need the names of your on-budget bank accounts. The tool refuses to write if any of their balances move, which catches a lot of mistakes.

### 2. Configure

```sh
git clone https://github.com/JustSamuel/splitser-sync.git
cd splitser-sync
cp .env.example .env
pnpm install
```

Fill in `.env`:

| Variable                              | What to put there                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `SPLITSER_EMAIL`, `SPLITSER_PASSWORD` | Your Splitser login                                                              |
| `SPLITSER_MEMBER_NAME`                | Your name exactly as Splitser shows it. It has to match one member in every list |
| `ACTUAL_SERVER_URL`                   | Where your Actual server lives                                                   |
| `ACTUAL_PASSWORD`                     | The Actual server password                                                       |
| `ACTUAL_SYNC_ID`                      | Settings → Advanced settings → Sync ID                                           |
| `ACTUAL_ENCRYPTION_PASSWORD`          | Only if the budget uses end-to-end encryption                                    |
| `ACTUAL_BANK_ACCOUNTS`                | On-budget accounts to guard, comma separated, e.g. `Checking,Savings`            |
| `ACTUAL_ACCOUNT`                      | Name of the off-budget account if it isn't `Splitser`                            |
| `ACTUAL_TRACKER_CATEGORY`             | Name of the category if it isn't `Advances`                                      |
| `ACTUAL_TIMEZONE`                     | Used to date the adjustment. Defaults to `Europe/Amsterdam`                      |

Only EUR lists work. Anything else stops the run with an error. The rest of `.env.example` is optional tuning.

### 3. Dry run

```sh
pnpm reconcile
```

You should see something like this, and nothing in Actual changes:

```text
Splitser (Your Name): €42.50 across 3 active lists
  Ski trip: €30.00
  Flat: €12.50
  Dinner: €0.00
Actual Splitser: €0.00; proposed correction: €42.50
Advances 2026-11: €0.00 -> €-42.50
DRY RUN: no Actual changes. Re-run with --apply to write.
```

If it can't find your member name, the account or the category, the error says which.

### 4. Apply

```sh
pnpm reconcile --apply
```

Open Actual. The `Splitser` account should equal your Splitser balance, `Advances` its negative, and your bank accounts and _To Budget_ should look the same as before. Running it again is safe: it updates the same adjustment instead of adding another.

When someone pays you back through your bank, book that payment in Actual as a transfer into the `Splitser` account, like any other transfer. The next run sorts out the remainder.

Add `--json` for machine-readable output. After a successful apply, `reconciliation.json` (git-ignored) holds the last report.

### What it checks

Before and after each write, reconcile:

- stops if the tracker doesn't match the account(s), apart from rows Actual imported itself
- runs bank sync first and stops if that pulled in bank transactions you haven't booked yet
- verifies both balances after writing
- aborts if any bank account balance changed

## Link it in Actual (SimpleFIN)

This is the better setup if you want to see what the balance is made of. Actual's sync server accepts any SimpleFIN-compatible host, and splitser-sync can be one.

Your Actual server has to reach splitser-sync over HTTPS on a public address. Actual refuses private addresses on purpose.

1. Deploy splitser-sync (see [Running it](#running-it)) and generate the settings:

   ```sh
   pnpm simplefin:setup https://splitser-sync.example.com
   ```

   It prints `SIMPLEFIN_PUBLIC_URL`, `SIMPLEFIN_ACCESS_SECRET`, `SIMPLEFIN_CLAIM_TOKEN` and a setup token. Set the three variables on the service and redeploy.

2. In Actual, go to Settings → Bank Sync → SimpleFIN and paste the setup token.
3. On the `Splitser` account choose _Link account_ and pick `Splitser`.
4. Remove `SIMPLEFIN_CLAIM_TOKEN` and redeploy. The token can be claimed for as long as the variable is set, so don't leave it.
5. Run `pnpm reconcile`, dry run first.

From then on, Actual's bank sync imports your share of each expense. Reconcile marks those rows reconciled, shrinks the adjustment row so the balance still matches Splitser, and moves `Advances` to minus the balance.

A few things worth knowing:

- Actual allows one SimpleFIN credential per budget. If you already use the official SimpleFIN Bridge in the same budget, this will replace it.
- Between reconcile runs the account moves as soon as Actual syncs, and `Advances` catches up on the next run. Schedule reconcile (below) so the gap stays small.
- Actual only fetches about three months of history when you first link, so older history stays folded into the adjustment row.
- Only expenses and income show up as transactions. Settlements don't change the balance Splitser reports, so they aren't included.
- Actual never rewrites a row it already imported. If someone edits or deletes an old expense in Splitser, the difference goes into the adjustment row at the next reconcile.
- Don't use Actual's own _Reconcile_ button on this account. Reconcile here uses that flag to tell new rows from handled ones.
- To go back, unlink the account in Actual and run `pnpm reconcile`.

## More than one Splitser account

If you and a partner each have a Splitser account, both can feed the same budget. Each Splitser account gets its own off-budget account, and the one `Advances` category holds minus their total. Whatever one of you owes the other cancels out there, so `Advances` shows what the household is owed.

1. In Actual, create a second off-budget account, say `Splitser Partner`, starting balance 0.
2. Add the partner's settings to `.env` with a `_2` suffix:

   ```text
   SPLITSER_EMAIL_2=partner@example.com
   SPLITSER_PASSWORD_2=...
   SPLITSER_MEMBER_NAME_2=Partner's name as Splitser shows it
   ACTUAL_ACCOUNT_2=Splitser Partner
   ```

   A third account uses `_3`, and so on. Each account keeps its own Splitser session in `cookies-2.txt` next to `COOKIE_FILE`; set `COOKIE_FILE_2` to put it elsewhere.

3. Run `pnpm reconcile`. It lists every account with its own correction, and one change to `Advances`.

When linked, the one SimpleFIN credential serves every account. No new setup token is needed: choose _Link account_ on `Splitser Partner` and pick the SimpleFIN account with the same name. Each account must be a different person; reconcile and the SimpleFIN feed stop if two of them resolve to the same member of a list. After linking, run `pnpm reconcile` again, dry run first. It absorbs the starting balance Actual adds to a newly linked account.

To remove an account again:

1. Delete its `_2` variables and redeploy.
2. Add that account's balance to this month's `Advances` budget (a negative balance lowers it), so `Advances` equals minus the remaining accounts.
3. Delete the account in Actual, then run `pnpm reconcile`.

## Running it

### Docker or Coolify

```sh
docker compose up -d --build
```

Every release publishes an image, so you can skip the build. Use `ghcr.io/justsamuel/splitser-sync:latest` (or a version like `:1.2.3`) and replace `build: .` in `compose.yaml` with `image: ghcr.io/justsamuel/splitser-sync:latest`. Releases and `v1.2.3` tags are cut automatically from [conventional commits](https://www.conventionalcommits.org/): `feat:` bumps the minor version, `fix:` and dependency updates bump the patch.

Put the settings from `.env` in your platform's secret store instead of committing them. The `splitser-data` volume keeps the refreshed Splitser session and Actual's local cache. The port is bound to localhost, so change that if a reverse proxy sits in front.

To reconcile on a timer, set:

```text
ALLOW_ACTUAL_WRITES=true
RECONCILE_INTERVAL_MINUTES=60
```

It then reconciles at startup and every hour. Turn this on only after a dry run and one reviewed `--apply` have both gone well.

### HTTP API

```sh
pnpm build
pnpm start
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/lists
curl http://127.0.0.1:8787/balances
curl 'http://127.0.0.1:8787/transactions?list_id=LIST_UUID'
```

`/transactions` returns expenses, income and settlements. Lists are cached for 60 seconds and balances and transactions for 5 minutes, and `?refresh=1` skips the cache. With [more than one Splitser account](#more-than-one-splitser-account), `?account=splitser-2` (or `-3`, ...) selects another account; the default is the first. Set `API_TOKEN` to require `Authorization: Bearer <token>` on everything except `/health`. Without it, keep the service on localhost or a private network.

You can also trigger a reconcile over HTTP with a separate `RECONCILE_TOKEN`:

```sh
curl -X POST -H "Authorization: Bearer $RECONCILE_TOKEN" http://127.0.0.1:8787/reconcile
```

That is a dry run unless you add `?apply=true` and have set `ALLOW_ACTUAL_WRITES=true`. A second request while one is running gets a 409.

## Security

- `.env`, the cookie file, Actual's cache and `reconciliation.json` are git-ignored and kept out of the Docker build. Don't commit them.
- Use long random values for `API_TOKEN` and `RECONCILE_TOKEN`, and don't expose the API without a token.
- `/simplefin/accounts` accepts only `SIMPLEFIN_ACCESS_SECRET`. The bearer tokens don't open it, and the secret doesn't open anything else.
- Credentials never appear in logs, and the lint fails on code that would print them.

## Troubleshooting

| Message                                                | What to do                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `Actual needs an off-budget account named ...`         | Create it, or set `ACTUAL_ACCOUNT`. It must be marked off-budget            |
| `... must have carryover enabled`                      | Turn on carryover for the tracker category                                  |
| `... does not equal minus ...; fix the existing drift` | The account and tracker disagree by more than the new linked rows explain   |
| `Bank sync imported N transaction(s); book them ...`   | Categorize the new bank transactions in Actual, then run again              |
| `expected one member named ...`                        | Fix `SPLITSER_MEMBER_NAME` so it matches your name in that list exactly     |
| `... is counted by both ...`                           | Two Splitser accounts resolve to the same person. Check the member names    |
| Login or API errors from Splitser                      | Check your credentials. The private API may also have changed               |
| Errors opening the budget                              | Check the Sync ID, and that the server and `@actual-app/api` versions match |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

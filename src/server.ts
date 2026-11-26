import http from 'node:http';
import { SplitserClient } from './client.ts';
import { loadEnv, projectRoot, splitserAccounts } from './config.ts';
import { reconcile } from './actual.ts';
import { createHandler } from './http.ts';
import { simplefinAccounts } from './simplefin.ts';
import { simplefinSources } from './splitser.ts';

await loadEnv(projectRoot);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const accounts = splitserAccounts(projectRoot).map((account) => ({
  ...account,
  client: new SplitserClient(account.splitser),
}));
const handler = createHandler({
  clients: new Map(accounts.map((account) => [account.id, account.client])),
  reconcile,
  async simplefin(query) {
    return simplefinAccounts({
      accounts: await simplefinSources(
        accounts.map((account) => ({
          id: account.id,
          name: account.actualAccount,
          memberName: account.memberName,
          client: account.client,
        })),
        query.accounts,
      ),
      query,
      now: Math.floor(Date.now() / 1000),
    });
  },
  env: process.env,
});
const server = http.createServer(handler);
server.listen(port, host, () => {
  console.log(`Splitser API listening on http://${host}:${port}`);
  const interval = Number(process.env.RECONCILE_INTERVAL_MINUTES || 0);
  if (interval > 0) {
    if (process.env.ALLOW_ACTUAL_WRITES !== 'true') {
      throw new Error(
        'Scheduled reconciliation requires ALLOW_ACTUAL_WRITES=true',
      );
    }
    const schedule = () =>
      reconcile({ apply: true }).catch((error: Error) => {
        console.error(`Scheduled reconciliation failed: ${error.message}`);
      });
    schedule();
    setInterval(schedule, interval * 60000).unref();
  }
});

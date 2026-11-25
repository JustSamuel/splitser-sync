import http from 'node:http';
import { SplitserClient } from './client.ts';
import { loadEnv, projectRoot, splitserConfig } from './config.ts';
import { reconcile } from './actual.ts';
import { createHandler } from './http.ts';
import { simplefinAccounts } from './simplefin.ts';
import { splitserEffects } from './splitser.ts';

await loadEnv(projectRoot);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const client = new SplitserClient(splitserConfig(projectRoot));
const handler = createHandler({
  client,
  reconcile,
  async simplefin(query) {
    const { source, effects } = await splitserEffects(
      client,
      process.env.SPLITSER_MEMBER_NAME,
    );
    return simplefinAccounts({
      balance: source.amount,
      effects,
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

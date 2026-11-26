#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as actualApi from '@actual-app/api';
import { SplitserClient } from './client.ts';
import { loadEnv, projectRoot, splitserAccounts } from './config.ts';
import { reconcileWithActual } from './reconcile.ts';
import { splitserBalance } from './splitser.ts';
import type { ActualApi, ReconcilePlan } from './reconcile.ts';

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const fail = (message: string): never => {
  throw new Error(message);
};

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

function localDate(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts();
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('Actual write did not become visible within 10 seconds');
}

export async function reconcile({
  apply = false,
  json = false,
} = {}): Promise<ReconcilePlan> {
  await loadEnv(projectRoot);
  const mirrors = await Promise.all(
    splitserAccounts(projectRoot).map(async (account) => ({
      accountName: account.actualAccount,
      source: await splitserBalance(
        new SplitserClient(account.splitser),
        account.memberName,
      ),
    })),
  );
  const trackerName = process.env.ACTUAL_TRACKER_CATEGORY || 'Advances';
  const today = localDate(process.env.ACTUAL_TIMEZONE || 'Europe/Amsterdam');
  const month = today.slice(0, 7);
  const dataDir = resolve(
    projectRoot,
    process.env.ACTUAL_DATA_DIR || './.actual-data',
  );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const serverURL = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const syncId = process.env.ACTUAL_SYNC_ID;
  if (!serverURL || !password || !syncId) {
    return fail('Set ACTUAL_SERVER_URL, ACTUAL_PASSWORD, and ACTUAL_SYNC_ID');
  }
  await quiet(() =>
    actualApi.init({
      serverURL,
      password,
      dataDir,
    }),
  );
  try {
    await quiet(() =>
      actualApi.downloadBudget(syncId, {
        password: process.env.ACTUAL_ENCRYPTION_PASSWORD || '',
      }),
    );
    const plan = await reconcileWithActual({
      mirrors,
      apply,
      // The real API is a superset of the slice reconciliation uses.
      api: {
        ...actualApi,
        sync: () => quiet(() => actualApi.sync()),
        eventually,
      } as unknown as ActualApi,
      config: {
        trackerName,
        today,
        month,
        bankNames: (process.env.ACTUAL_BANK_ACCOUNTS || '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
        id: randomUUID,
      },
    });
    plan.date = today;
    if (json) console.log(JSON.stringify(plan, null, 2));
    else {
      for (const { name, source, before, adjustment } of plan.accounts) {
        console.log(
          `Splitser (${source.memberName}): ${eur(source.amount)} across ${source.lists.length} active lists`,
        );
        for (const list of source.lists)
          console.log(`  ${list.name}: ${eur(list.amount)}`);
        console.log(
          `Actual ${name}: ${eur(before)}; proposed correction: ${eur(adjustment?.amount || 0)}`,
        );
      }
      console.log(
        `${trackerName} ${month}: ${eur(plan.tracker.before)} -> ${eur(plan.tracker.after)}`,
      );
      console.log(
        apply
          ? 'Applying one idempotent balance adjustment per account and the matching tracker budget correction.'
          : 'DRY RUN: no Actual changes. Re-run with --apply to write.',
      );
    }
    if (plan.applied) {
      await writeFile(
        resolve(projectRoot, 'reconciliation.json'),
        JSON.stringify(plan, null, 2) + '\n',
        { mode: 0o600 },
      );
      if (!json)
        console.log(
          `Verified: ${plan.accounts.map((account) => `${account.name} = ${eur(account.after)}`).join(', ')}, ${trackerName} = ${eur(plan.tracker.after)}; bank balances unchanged.`,
        );
    }
    return plan;
  } finally {
    await quiet(() => actualApi.shutdown());
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  reconcile({
    apply: args.includes('--apply'),
    json: args.includes('--json'),
  }).catch((error: Error) => {
    console.error(`FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}

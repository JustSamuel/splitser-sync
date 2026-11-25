#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as actualApi from '@actual-app/api';
import { SplitserClient } from './client.js';
import { loadEnv, splitserConfig } from './config.js';
import { reconcileWithActual } from './reconcile.js';

const directory = dirname(fileURLToPath(import.meta.url));
const eur = (cents) => `€${(cents / 100).toFixed(2)}`;
const fail = (message) => { throw new Error(message); };

async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

function localDate(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts();
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function splitserBalance(client, memberName) {
  if (!memberName) fail('Set SPLITSER_MEMBER_NAME to your exact Splitser name');
  const response = await client.balances();
  const lists = response.data.map((entry) => {
    const members = entry.data.filter((member) => member.member.full_name === memberName);
    if (members.length !== 1) {
      fail(`${entry.list.name}: expected one member named ${JSON.stringify(memberName)}, found ${members.length}`);
    }
    const member = members[0];
    if (member.balance_total.currency !== 'EUR') fail(`${entry.list.name}: expected EUR`);
    return {
      id: entry.list.id,
      name: entry.list.name,
      amount: member.balance_total.fractional,
      sourceUpdatedAt: new Date(Math.max(entry.list.modified_at || 0, entry.list.updated_at || 0) * 1000).toISOString(),
    };
  });
  return { memberName, amount: lists.reduce((sum, list) => sum + list.amount, 0), lists };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('Actual write did not become visible within 10 seconds');
}

export async function reconcile({ apply = false, json = false } = {}) {
  await loadEnv(directory);
  const source = await splitserBalance(
    new SplitserClient(splitserConfig(directory)), process.env.SPLITSER_MEMBER_NAME,
  );
  const accountName = process.env.ACTUAL_ACCOUNT || 'Splitser';
  const trackerName = process.env.ACTUAL_TRACKER_CATEGORY || 'Advances';
  const today = localDate(process.env.ACTUAL_TIMEZONE || 'Europe/Amsterdam');
  const month = today.slice(0, 7);
  const dataDir = resolve(directory, process.env.ACTUAL_DATA_DIR || './.actual-data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await quiet(() => actualApi.init({
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
    dataDir,
  }));
  try {
    await quiet(() => actualApi.downloadBudget(process.env.ACTUAL_SYNC_ID, {
      password: process.env.ACTUAL_ENCRYPTION_PASSWORD || undefined,
    }));
    const plan = await reconcileWithActual({
      source,
      apply,
      api: { ...actualApi, sync: () => quiet(() => actualApi.sync()), eventually },
      config: {
        accountName,
        trackerName,
        today,
        month,
        bankNames: (process.env.ACTUAL_BANK_ACCOUNTS || '').split(',').map((name) => name.trim()).filter(Boolean),
        id: randomUUID,
      },
    });
    plan.date = today;
    if (json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`Splitser (${source.memberName}): ${eur(source.amount)} across ${source.lists.length} active lists`);
      for (const list of source.lists) console.log(`  ${list.name}: ${eur(list.amount)}`);
      console.log(`Actual ${accountName}: ${eur(plan.account.before)}; proposed correction: ${eur(plan.adjustment?.amount || 0)}`);
      console.log(`${trackerName} ${month}: ${eur(plan.tracker.before)} -> ${eur(plan.tracker.after)}`);
      console.log(apply ? 'Applying one idempotent balance adjustment and the matching tracker budget correction.' : 'DRY RUN: no Actual changes. Re-run with --apply to write.');
    }
    if (plan.applied) {
      await writeFile(resolve(directory, 'reconciliation.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
      if (!json) console.log(`Verified: ${accountName} = ${eur(source.amount)}, ${trackerName} = ${eur(-source.amount)}; bank balances unchanged.`);
    }
    return plan;
  } finally {
    await quiet(() => actualApi.shutdown());
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  reconcile({ apply: args.includes('--apply'), json: args.includes('--json') })
    .catch((error) => { console.error(`FAILED: ${error.message}`); process.exitCode = 1; });
}

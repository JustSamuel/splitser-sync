import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileWithActual } from '../reconcile.js';

const source = { memberName: 'Member', amount: 100, lists: [{ name: 'List', amount: 100 }] };
const config = {
  accountName: 'Mirror', trackerName: 'Tracker', bankNames: ['Bank'], today: '2026-01-02', month: '2026-01', id: () => 'new-id',
};

function fake({ tracker = 0, mirror = 100, reported = 500, bankResult } = {}) {
  const calls = [];
  const state = { mirror, tracker, budgeted: 0, reported, lastSync: 'before' };
  const api = {
    async getAccounts() {
      return [
        { id: 'mirror', name: 'Mirror', offbudget: true },
        { id: 'bank', name: 'Bank', offbudget: false, balance_current: state.reported, balance_available: state.reported, last_sync: state.lastSync, bank_sync_status: 'success' },
      ];
    },
    async runBankSync() { calls.push('bank-sync'); return bankResult || { newTransactions: [], matchedTransactions: [], updatedAccounts: [] }; },
    async getBudgetMonth() { return { categoryGroups: [{ categories: [{ id: 'tracker', name: 'Tracker', carryover: true, balance: state.tracker, budgeted: state.budgeted }] }] }; },
    async getTransactions() { return []; },
    async getAccountBalance() { return state.mirror; },
    async getBudgetMonths() { return ['2026-01']; },
    async addTransactions(account, rows) { calls.push(['add', account, rows]); state.mirror += rows[0].amount; },
    async updateTransaction() { calls.push('update'); },
    async setBudgetAmount(month, id, amount) { calls.push(['budget', month, id, amount]); state.budgeted = amount; state.tracker = -state.mirror; },
    async sync() { calls.push('sync'); },
    async eventually(check) { assert.equal(await check(), true); },
  };
  return { api, calls, state };
}

const run = (backend, apply = true) => reconcileWithActual({ source, apply, api: backend.api, config });

test('dry run performs no bank sync or Actual writes', async () => {
  const backend = fake();
  const result = await run(backend, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(backend.calls, []);
});

test('zero delta still rejects tracker drift before writing', async () => {
  const backend = fake({ tracker: -99 });
  await assert.rejects(run(backend), /does not equal minus/);
  assert.deepEqual(backend.calls, ['bank-sync']);
});

test('bank sync must return new transaction metadata', async () => {
  const backend = fake({ bankResult: {} });
  await assert.rejects(run(backend), /invalid result/);
  assert.deepEqual(backend.calls, ['bank-sync']);
});

test('bank sync stops on unbooked imported transactions', async () => {
  const backend = fake({ bankResult: { newTransactions: ['imported'] } });
  await assert.rejects(run(backend), /book them with book.mjs/);
  assert.deepEqual(backend.calls, ['bank-sync']);
});

test('one adjustment updates account and tracker and syncs after both writes', async () => {
  const backend = fake({ mirror: 90, tracker: -90 });
  const result = await run(backend);
  assert.equal(result.adjustment.amount, 10);
  assert.equal(result.trackerBudgetChange.to, -10);
  assert.deepEqual(backend.calls.map((call) => Array.isArray(call) ? call[0] : call), ['bank-sync', 'add', 'budget', 'sync']);
  assert.equal(result.verified, true);
});

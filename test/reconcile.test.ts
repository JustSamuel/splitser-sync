import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActualApi } from '../src/reconcile.ts';
import { reconcileWithActual } from '../src/reconcile.ts';

type Row = {
  id: string;
  imported_id?: string;
  amount: number;
  reconciled?: boolean;
  transfer_id?: string | null;
};

const source = {
  memberName: 'Member',
  amount: 100,
  lists: [{ name: 'List', amount: 100 }],
};
const config = {
  accountName: 'Mirror',
  trackerName: 'Tracker',
  bankNames: ['Bank'],
  today: '2026-01-02',
  month: '2026-01',
  id: () => 'new-id',
};

function fake({
  tracker = 0,
  mirror = 100,
  reported = 500,
  bankResult,
  rows = [],
}: {
  rows?: Row[];
  tracker?: number;
  mirror?: number;
  reported?: number;
  bankResult?: { newTransactions?: unknown[] };
} = {}) {
  const calls: unknown[] = [];
  const state = {
    mirror,
    tracker,
    budgeted: 0,
    reported,
    lastSync: 'before',
    rows,
  };
  const api: ActualApi = {
    async getAccounts() {
      return [
        { id: 'mirror', name: 'Mirror', offbudget: true },
        {
          id: 'bank',
          name: 'Bank',
          offbudget: false,
          balance_current: state.reported,
          balance_available: state.reported,
          last_sync: state.lastSync,
          bank_sync_status: 'success',
        },
      ];
    },
    async runBankSync() {
      calls.push('bank-sync');
      return (
        bankResult || {
          newTransactions: [],
          matchedTransactions: [],
          updatedAccounts: [],
        }
      );
    },
    async getBudgetMonth() {
      return {
        categoryGroups: [
          {
            categories: [
              {
                id: 'tracker',
                name: 'Tracker',
                carryover: true,
                balance: state.tracker,
                budgeted: state.budgeted,
              },
            ],
          },
        ],
      };
    },
    async getTransactions() {
      return state.rows;
    },
    async getAccountBalance() {
      return state.mirror;
    },
    async getBudgetMonths() {
      return ['2026-01'];
    },
    async addTransactions(account, rows) {
      calls.push(['add', account, rows]);
      state.mirror += rows[0]!.amount as number;
    },
    async updateTransaction(id, fields) {
      calls.push(['update', id, fields]);
      const row = state.rows.find((entry) => entry.id === id);
      if (row && typeof fields.amount === 'number') {
        state.mirror += fields.amount - row.amount;
        row.amount = fields.amount;
      }
      if (row && fields.reconciled) row.reconciled = true;
    },
    async setBudgetAmount(month, id, amount) {
      calls.push(['budget', month, id, amount]);
      state.budgeted = amount;
      state.tracker = -state.mirror;
    },
    async sync() {
      calls.push('sync');
    },
    async eventually(check) {
      assert.equal(await check(), true);
    },
  };
  return { api, calls, state };
}

const run = (
  backend: ReturnType<typeof fake>,
  apply = true,
  balance = source,
) => reconcileWithActual({ source: balance, apply, api: backend.api, config });

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
  await assert.rejects(run(backend), /book them in Actual/);
  assert.deepEqual(backend.calls, ['bank-sync']);
});

test('one adjustment updates account and tracker and syncs after both writes', async () => {
  const backend = fake({ mirror: 90, tracker: -90 });
  const result = await run(backend);
  assert.equal(result.adjustment!.amount, 10);
  assert.equal(result.trackerBudgetChange!.to, -10);
  assert.deepEqual(
    backend.calls.map((call) => (Array.isArray(call) ? call[0] : call)),
    ['bank-sync', 'add', 'budget', 'sync'],
  );
  assert.equal(result.verified, true);
});

const adjustment = (amount: number): Row => ({
  id: 'adjustment',
  imported_id: 'splitser:balance:current',
  amount,
});
const imported = (
  id: string,
  amount: number,
  extra: Partial<Row> = {},
): Row => ({
  id,
  imported_id: `splitser:list:expense:${id}`,
  amount,
  ...extra,
});
const updates = (backend: ReturnType<typeof fake>) =>
  backend.calls.filter((call) => Array.isArray(call) && call[0] === 'update');

test('an existing adjustment is moved by the difference, not set to it', async () => {
  const backend = fake({ mirror: 90, tracker: -90, rows: [adjustment(90)] });
  await run(backend);
  assert.deepEqual(updates(backend), [
    [
      'update',
      'adjustment',
      {
        date: '2026-01-02',
        amount: 100,
        notes: 'Splitser balance sync: 1 active lists, 2026-01-02',
      },
    ],
  ]);
});

test('rows imported by Actual are absorbed: only the adjustment shrinks', async () => {
  const backend = fake({
    mirror: 13634,
    tracker: -13134,
    rows: [adjustment(13134), imported('a', 300), imported('b', 200)],
  });
  const result = await run(backend, true, {
    ...source,
    amount: 13134,
  });
  assert.deepEqual(result.imports, { count: 2, amount: 500 });
  assert.equal(result.adjustment!.amount, -500);
  assert.equal(result.trackerBudgetChange, null);
  assert.equal(backend.state.rows[0]!.amount, 12634);
  assert.deepEqual(
    backend.state.rows.map((row) => row.reconciled ?? false),
    [false, true, true],
  );
  assert.equal(
    backend.calls.some((call) => Array.isArray(call) && call[0] === 'budget'),
    false,
  );
  assert.equal(result.verified, true);
});

test('new balance after imports also moves the tracker', async () => {
  const backend = fake({
    mirror: 13434,
    tracker: -13134,
    rows: [adjustment(13134), imported('a', 300)],
  });
  const result = await run(backend, true, { ...source, amount: 13534 });
  assert.equal(result.trackerBudgetChange!.to, -400);
  assert.equal(backend.state.mirror, 13534);
  assert.equal(result.verified, true);
});

test('drift that the imports do not explain is refused', async () => {
  const backend = fake({
    mirror: 13634,
    tracker: -13000,
    rows: [adjustment(13134), imported('a', 500)],
  });
  await assert.rejects(
    run(backend, true, { ...source, amount: 13134 }),
    /does not equal minus/,
  );
  assert.deepEqual(updates(backend), []);
});

test('reconciled rows and transfers are not counted as new imports', async () => {
  const backend = fake({
    mirror: 13134,
    tracker: -13134,
    rows: [
      adjustment(12134),
      imported('old', 500, { reconciled: true }),
      imported('moved', 500, { transfer_id: 'transfer' }),
    ],
  });
  const result = await run(backend, true, { ...source, amount: 13134 });
  assert.deepEqual(result.imports, { count: 0, amount: 0 });
  assert.equal(result.adjustment, null);
  assert.deepEqual(updates(backend), []);
});

test('bank sync imports into the Splitser account are allowed, others are not', async () => {
  const own = fake({
    mirror: 100,
    tracker: -100 + 0,
    rows: [adjustment(100)],
    bankResult: { newTransactions: ['x'] },
  });
  own.state.rows.push(imported('x', 0));
  assert.equal((await run(own)).verified, true);
  const foreign = fake({ bankResult: { newTransactions: ['elsewhere'] } });
  await assert.rejects(run(foreign), /book them in Actual/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActualApi, Mirror, SplitserSource } from '../src/reconcile.ts';
import { reconcileWithActual } from '../src/reconcile.ts';

type Row = {
  id: string;
  imported_id?: string;
  amount: number;
  reconciled?: boolean;
  transfer_id?: string | null;
};
type Account = { name: string; balance: number; rows: Row[] };

const source = (
  amount: number,
  list = 'list',
  member = 'member',
): SplitserSource => ({
  memberName: 'Member',
  amount,
  lists: [{ id: list, memberId: member, name: 'List', amount }],
});
let ids = 0;
const config = {
  trackerName: 'Tracker',
  bankNames: ['Bank'],
  today: '2026-01-02',
  month: '2026-01',
  id: () => `new-id-${++ids}`,
};

function fake({
  tracker = 0,
  mirror = 100,
  reported = 500,
  bankResult,
  rows = [],
  others = [],
}: {
  rows?: Row[];
  tracker?: number;
  mirror?: number;
  reported?: number;
  bankResult?: { newTransactions?: unknown[] };
  /** Mirror accounts besides `Mirror`. */
  others?: Account[];
} = {}) {
  const calls: unknown[] = [];
  const mirrors: Account[] = [{ name: 'Mirror', balance: mirror, rows }];
  mirrors.push(...others);
  const state = {
    mirrors,
    tracker,
    budgeted: 0,
    reported,
    lastSync: 'before',
  };
  // Ids differ from names so code that confuses the two fails.
  const byId = (id: string) =>
    mirrors.find((account) => `id-${account.name}` === id)!;
  const api: ActualApi = {
    async getAccounts() {
      return [
        ...mirrors.map((account) => ({
          id: `id-${account.name}`,
          name: account.name,
          offbudget: true,
        })),
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
    async getTransactions(id) {
      return byId(id).rows;
    },
    async getAccountBalance(id) {
      return byId(id).balance;
    },
    async getBudgetMonths() {
      return ['2026-01'];
    },
    async addTransactions(id, rows) {
      calls.push(['add', id, rows]);
      const account = byId(id);
      account.balance += rows[0]!.amount as number;
      account.rows.push({
        id: rows[0]!.id as string,
        imported_id: rows[0]!.imported_id as string,
        amount: rows[0]!.amount as number,
      });
    },
    async updateTransaction(id, fields) {
      calls.push(['update', id, fields]);
      const account = mirrors.find((entry) =>
        entry.rows.some((row) => row.id === id),
      );
      const row = account?.rows.find((entry) => entry.id === id);
      if (account && row && typeof fields.amount === 'number') {
        account.balance += fields.amount - row.amount;
        row.amount = fields.amount;
      }
      if (row && fields.reconciled) row.reconciled = true;
    },
    async setBudgetAmount(month, id, amount) {
      calls.push(['budget', month, id, amount]);
      state.tracker += amount - state.budgeted;
      state.budgeted = amount;
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

const runAll = (
  backend: ReturnType<typeof fake>,
  mirrors: Mirror[],
  apply = true,
) => reconcileWithActual({ mirrors, apply, api: backend.api, config });
const run = (backend: ReturnType<typeof fake>, apply = true, amount = 100) =>
  runAll(backend, [{ accountName: 'Mirror', source: source(amount) }], apply);
const mirrorOf = (backend: ReturnType<typeof fake>) =>
  backend.state.mirrors[0]!;

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
  assert.equal(result.accounts[0]!.adjustment!.amount, 10);
  assert.equal(result.trackerBudgetChange!.to, -10);
  assert.deepEqual(
    backend.calls.map((call) => (Array.isArray(call) ? call[0] : call)),
    ['bank-sync', 'add', 'budget', 'sync'],
  );
  assert.equal(result.verified, true);
});

const adjustment = (amount: number, id = 'adjustment'): Row => ({
  id,
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
  const result = await run(backend, true, 13134);
  assert.deepEqual(result.accounts[0]!.imports, { count: 2, amount: 500 });
  assert.equal(result.accounts[0]!.adjustment!.amount, -500);
  assert.equal(result.trackerBudgetChange, null);
  assert.equal(mirrorOf(backend).rows[0]!.amount, 12634);
  assert.deepEqual(
    mirrorOf(backend).rows.map((row) => row.reconciled ?? false),
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
  const result = await run(backend, true, 13534);
  assert.equal(result.trackerBudgetChange!.to, -400);
  assert.equal(mirrorOf(backend).balance, 13534);
  assert.equal(result.verified, true);
});

test('drift that the imports do not explain is refused', async () => {
  const backend = fake({
    mirror: 13634,
    tracker: -13000,
    rows: [adjustment(13134), imported('a', 500)],
  });
  await assert.rejects(run(backend, true, 13134), /does not equal minus/);
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
  const result = await run(backend, true, 13134);
  assert.deepEqual(result.accounts[0]!.imports, { count: 0, amount: 0 });
  assert.equal(result.accounts[0]!.adjustment, null);
  assert.deepEqual(updates(backend), []);
});

test('bank sync imports into the Splitser account are allowed, others are not', async () => {
  const own = fake({
    mirror: 100,
    tracker: -100 + 0,
    rows: [adjustment(100)],
    bankResult: { newTransactions: ['x'] },
  });
  mirrorOf(own).rows.push(imported('x', 0));
  assert.equal((await run(own)).verified, true);
  const foreign = fake({ bankResult: { newTransactions: ['elsewhere'] } });
  await assert.rejects(run(foreign), /book them in Actual/);
});

const partner = (balance: number, rows: Row[] = []): Account => ({
  name: 'Partner',
  balance,
  rows,
});
const both = (mine: number, theirs: number): Mirror[] => [
  { accountName: 'Mirror', source: source(mine) },
  { accountName: 'Partner', source: source(theirs, 'list', 'partner') },
];

test('each account gets its own adjustment and one tracker offsets their sum', async () => {
  const backend = fake({
    mirror: 90,
    tracker: -70,
    others: [partner(-20, [adjustment(-20, 'partner-adjustment')])],
  });
  const result = await runAll(backend, both(100, -50));
  assert.deepEqual(
    result.accounts.map((account) => [
      account.name,
      account.adjustment?.amount,
    ]),
    [
      ['Mirror', 10],
      ['Partner', -30],
    ],
  );
  assert.deepEqual(
    backend.state.mirrors.map((account) => account.balance),
    [100, -50],
  );
  assert.equal(backend.state.tracker, -50);
  assert.deepEqual(
    backend.calls.map((call) => (Array.isArray(call) ? call[0] : call)),
    ['bank-sync', 'add', 'update', 'budget', 'sync'],
  );
  assert.equal(result.verified, true);
});

test('drift is checked against all accounts together', async () => {
  const backend = fake({ mirror: 100, tracker: -100, others: [partner(-40)] });
  await assert.rejects(
    runAll(backend, both(100, -40)),
    /Tracker does not equal minus Mirror \+ Partner/,
  );
  assert.deepEqual(updates(backend), []);
});

test('bank sync imports into any Splitser account are allowed', async () => {
  const backend = fake({
    tracker: -100,
    others: [partner(-40, [imported('p', -40)])],
    bankResult: { newTransactions: ['p'] },
  });
  const result = await runAll(backend, both(100, -40));
  assert.equal(result.verified, true);
  assert.equal(backend.state.mirrors[1]!.rows[0]!.reconciled, true);
});

test('one person counted by two accounts is refused before touching Actual', async () => {
  const backend = fake({ tracker: -200, others: [partner(100)] });
  await assert.rejects(
    runAll(backend, [
      { accountName: 'Mirror', source: source(100) },
      { accountName: 'Partner', source: source(100) },
    ]),
    /Member is counted by both "Mirror" and "Partner"/,
  );
  assert.deepEqual(backend.calls, []);
});

test('every Splitser account needs its own off-budget account', async () => {
  const backend = fake({ tracker: -100 });
  await assert.rejects(
    runAll(backend, both(100, 0)),
    /off-budget account named "Partner"/,
  );
  await assert.rejects(
    runAll(backend, [
      { accountName: 'Mirror', source: source(100) },
      { accountName: 'Mirror', source: source(0, 'list', 'partner') },
    ]),
    /Two Splitser accounts mirror into "Mirror"/,
  );
  assert.deepEqual(backend.calls, []);
});

test('random histories end with each account = its balance, tracker = -total and replay as a no-op', async () => {
  let seed = 42;
  const random = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.floor(seed / 65536) % max;
  };
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const seen = {
    imports: 0,
    noImports: 0,
    trackerMoved: 0,
    unchanged: 0,
    existingAdjustment: 0,
    severalAccounts: 0,
  };
  for (let round = 0; round < 300; round++) {
    // A settled round is already reconciled: the replay path from the start.
    const settled = random(3) === 0;
    const accounts = Array.from({ length: 1 + random(3) }, (_, index) => {
      const start = random(50000) - 10000;
      const hasAdjustment = random(2) === 1;
      const imports = Array.from(
        { length: settled ? 0 : random(4) },
        (_, row) => imported(`r${round}-${index}-${row}`, random(4000) - 2000),
      );
      const balance =
        (hasAdjustment ? start : 0) + sum(imports.map((row) => row.amount));
      return {
        name: index === 0 ? 'Mirror' : `Partner ${index}`,
        tracked: hasAdjustment ? start : 0,
        rows: [
          ...(hasAdjustment ? [adjustment(start, `adjustment-${index}`)] : []),
          ...imports,
        ],
        imports,
        balance,
        wanted: settled || random(3) === 0 ? balance : random(60000) - 20000,
      };
    });
    const [first, ...others] = accounts;
    const backend = fake({
      mirror: first!.balance,
      rows: first!.rows,
      others: others.map(({ name, balance, rows }) => ({
        name,
        balance,
        rows,
      })),
      tracker: 0 - sum(accounts.map((account) => account.tracked)),
      bankResult: {
        newTransactions: accounts.flatMap((account) =>
          account.imports.map((row) => row.id),
        ),
      },
    });
    const mirrors = accounts.map((account, index) => ({
      accountName: account.name,
      source: source(account.wanted, `list-${index}`),
    }));
    const total = sum(accounts.map((account) => account.wanted));
    const bankBefore = backend.state.reported;
    const result = await runAll(backend, mirrors);
    assert.deepEqual(
      backend.state.mirrors.map((account) => account.balance),
      accounts.map((account) => account.wanted),
      'each account equals its balance',
    );
    assert.equal(
      backend.state.tracker,
      0 - total,
      'tracker equals minus total',
    );
    assert.equal(backend.state.reported, bankBefore, 'bank balance untouched');
    assert.ok(
      backend.state.mirrors.every((account) =>
        account.rows
          .filter((row) => row.imported_id !== 'splitser:balance:current')
          .every((row) => row.reconciled),
      ),
    );
    const replay = await runAll(backend, mirrors);
    assert.ok(
      replay.accounts.every((account) => account.adjustment === null),
      'replay writes no adjustment',
    );
    assert.equal(replay.trackerBudgetChange, null, 'replay moves no budget');
    assert.ok(
      replay.accounts.every((account) => account.imports.count === 0),
      'replay finds no new imports',
    );
    const imports = accounts.some((account) => account.imports.length > 0);
    seen[imports ? 'imports' : 'noImports']++;
    if (result.trackerBudgetChange) seen.trackerMoved++;
    if (
      !result.trackerBudgetChange &&
      result.accounts.every((account) => !account.adjustment)
    )
      seen.unchanged++;
    if (
      result.accounts.some(
        (account) => account.adjustment?.existingTransactionId,
      )
    )
      seen.existingAdjustment++;
    if (accounts.length > 1) seen.severalAccounts++;
  }
  for (const [name, count] of Object.entries(seen))
    assert.ok(count >= 20, `generator stopped covering ${name} (${count})`);
});

import { assertDistinctMembers } from './splitser.ts';

const fail = (message: string): never => {
  throw new Error(message);
};

export interface SplitserSource {
  memberName: string;
  amount: number;
  lists: { id: string; memberId: string; name: string; amount: number }[];
}

/** One Splitser account and the off-budget Actual account that mirrors it. */
export interface Mirror {
  accountName: string;
  source: SplitserSource;
}

export interface ReconcileConfig {
  trackerName: string;
  bankNames: string[];
  today: string;
  month: string;
  id: () => string;
}

interface ActualAccount {
  id: string;
  name: string;
  offbudget?: boolean;
  balance_current?: number;
  balance_available?: number;
  last_sync?: string;
  bank_sync_status?: string;
}

interface ActualCategory {
  id: string;
  name: string;
  carryover?: boolean;
  balance: number;
  budgeted: number;
}

interface ActualRow {
  id: string;
  imported_id?: string;
  amount?: number;
  reconciled?: boolean;
  transfer_id?: string | null;
  starting_balance_flag?: boolean;
}

const ADJUSTMENT_ID = 'splitser:balance:current';

/** The slice of the Actual API that reconciliation uses. */
export interface ActualApi {
  getAccounts(): Promise<ActualAccount[]>;
  runBankSync(): Promise<{ newTransactions?: unknown[] } | undefined>;
  getBudgetMonth(
    month: string,
  ): Promise<{ categoryGroups: { categories: ActualCategory[] }[] }>;
  getBudgetMonths(): Promise<string[]>;
  getTransactions(
    accountId: string,
    start: string,
    end: string,
  ): Promise<ActualRow[]>;
  getAccountBalance(accountId: string): Promise<number>;
  addTransactions(
    accountId: string,
    rows: Record<string, unknown>[],
  ): Promise<unknown>;
  updateTransaction(
    id: string,
    fields: Record<string, unknown>,
  ): Promise<unknown>;
  setBudgetAmount(
    month: string,
    categoryId: string,
    amount: number,
  ): Promise<unknown>;
  sync(): Promise<unknown>;
  eventually(check: () => Promise<boolean>): Promise<void>;
}

export interface AccountPlan {
  name: string;
  source: SplitserSource;
  before: number;
  after: number;
  /** Splitser rows that Actual's own bank sync added since the last run. */
  imports: { count: number; amount: number };
  adjustment: {
    importedId: string;
    existingTransactionId: string | null;
    amount: number;
  } | null;
  actualAfter?: number;
}

export interface ReconcilePlan {
  dryRun: boolean;
  /** One entry per Splitser account, each mirrored by its own Actual account. */
  accounts: AccountPlan[];
  /** The one tracker category that offsets all accounts together. */
  tracker: {
    name: string;
    before: number;
    after: number;
    budgetedBefore: number;
  };
  trackerBudgetChange: { month: string; from: number; to: number } | null;
  bankAccounts: string[];
  bankSync: { newTransactions?: unknown[] } | null;
  date?: string;
  applied?: boolean;
  verified?: boolean;
}

export async function reconcileWithActual({
  mirrors,
  apply,
  api,
  config,
}: {
  mirrors: Mirror[];
  apply: boolean;
  api: ActualApi;
  config: ReconcileConfig;
}): Promise<ReconcilePlan> {
  assertDistinctMembers(
    mirrors.map(({ accountName, source }) => ({ name: accountName, source })),
  );

  const accounts = await api.getAccounts();
  const targets = mirrors.map((mirror, index) => {
    if (
      mirrors.findIndex((other) => other.accountName === mirror.accountName) !==
      index
    )
      fail(
        `Two Splitser accounts mirror into ${JSON.stringify(mirror.accountName)}`,
      );
    const account = accounts.find((entry) => entry.name === mirror.accountName);
    if (!account?.offbudget)
      fail(
        `Actual needs an off-budget account named ${JSON.stringify(mirror.accountName)}`,
      );
    return { ...mirror, account: account as ActualAccount };
  });
  const bankAccounts = config.bankNames.map(
    (name) =>
      accounts.find((entry) => entry.name === name && !entry.offbudget) ||
      fail(`Actual on-budget bank account not found: ${JSON.stringify(name)}`),
  );
  if (apply && bankAccounts.length === 0)
    fail('Set ACTUAL_BANK_ACCOUNTS before enabling writes');

  const snapshotBanks = async () =>
    Object.fromEntries(
      (await api.getAccounts())
        .filter((entry) => bankAccounts.some((bank) => bank.id === entry.id))
        .map((entry) => [
          entry.name,
          {
            transactions: entry.balance_current,
            available: entry.balance_available,
            lastSync: entry.last_sync,
            status: entry.bank_sync_status,
          },
        ]),
    );
  const banksBefore = await snapshotBanks();
  let bankSync: ReconcilePlan['bankSync'] = null;
  if (apply) {
    bankSync = (await api.runBankSync()) ?? null;
    if (!Array.isArray(bankSync?.newTransactions))
      fail('Actual bank sync returned an invalid result');
    const imported = bankSync?.newTransactions ?? [];
    if (imported.length > 0) {
      const own = new Set<string>();
      for (const { account } of targets)
        for (const row of await api.getTransactions(
          account.id,
          '0000-01-01',
          '9999-12-31',
        ))
          own.add(row.id);
      const foreign = imported.filter((id) => !own.has(String(id)));
      if (foreign.length > 0) {
        fail(
          `Bank sync imported ${foreign.length} transaction(s); book them in Actual before reconciling`,
        );
      }
    }
    if (JSON.stringify(banksBefore) !== JSON.stringify(await snapshotBanks())) {
      fail(
        'Bank balances changed during sync; book the changes before reconciling',
      );
    }
  }

  const findTracker = async () =>
    (await api.getBudgetMonth(config.month)).categoryGroups
      .flatMap((group) => group.categories)
      .find((entry) => entry.name === config.trackerName);
  const trackerFound = await findTracker();
  if (!trackerFound)
    fail(`Actual needs a category named ${JSON.stringify(config.trackerName)}`);
  const tracker = trackerFound as ActualCategory;
  if (!tracker.carryover)
    fail(`${config.trackerName} must have carryover enabled`);

  const states = [];
  for (const target of targets) {
    const rows = await api.getTransactions(
      target.account.id,
      '0000-01-01',
      '9999-12-31',
    );
    const adjustments = rows.filter((row) =>
      row.imported_id?.startsWith('splitser:balance:'),
    );
    if (adjustments.length > 1)
      fail(
        `Multiple automatic Splitser adjustments found in ${JSON.stringify(target.accountName)}; inspect them before continuing`,
      );
    const newImports = rows.filter(
      (row) =>
        row.imported_id?.startsWith('splitser:') &&
        row.imported_id !== ADJUSTMENT_ID &&
        !row.reconciled &&
        !row.transfer_id,
    );
    const before = await api.getAccountBalance(target.account.id);
    states.push({
      ...target,
      startingRows: rows.filter(
        (row) =>
          row.starting_balance_flag && !row.reconciled && !row.transfer_id,
      ),
      existing: adjustments[0],
      newImports,
      importedAmount: newImports.reduce(
        (sum, row) => sum + (row.amount ?? 0),
        0,
      ),
      before,
      delta: target.source.amount - before,
    });
  }
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0);
  const total = sum(states.map((state) => state.source.amount));
  const trackerBefore = tracker.balance;
  const trackerChange = -total - trackerBefore;
  // Actual's first sync of an empty linked account also adds a starting balance
  // row without an imported id. Count such rows only when they explain the gap
  // exactly, so a starting balance the tracker already covers is left alone.
  const gap =
    sum(states.map((state) => state.before - state.importedAmount)) +
    trackerBefore;
  let subsets: { state: (typeof states)[number]; row: ActualRow }[][] = [[]];
  for (const state of states)
    for (const row of state.startingRows)
      subsets = subsets.concat(
        subsets.map((subset) => [...subset, { state, row }]),
      );
  const explaining =
    gap === 0
      ? undefined
      : subsets.find(
          (subset) => sum(subset.map(({ row }) => row.amount ?? 0)) === gap,
        );
  for (const { state, row } of explaining ?? []) {
    state.newImports.push(row);
    state.importedAmount += row.amount ?? 0;
  }
  const newImports = states.flatMap((state) => state.newImports);
  if (
    apply &&
    sum(states.map((state) => state.before)) + trackerBefore !==
      sum(states.map((state) => state.importedAmount))
  ) {
    fail(
      `${config.trackerName} does not equal minus ${states.map((state) => state.accountName).join(' + ')} (allowing for ${newImports.length} new imported row(s)); fix the existing drift before reconciling`,
    );
  }
  if (apply && !(await api.getBudgetMonths()).includes(config.month)) {
    fail(`Actual budget month ${config.month} does not exist`);
  }

  const plan: ReconcilePlan = {
    dryRun: !apply,
    accounts: states.map((state) => ({
      name: state.accountName,
      source: state.source,
      before: state.before,
      after: state.source.amount,
      imports: { count: state.newImports.length, amount: state.importedAmount },
      adjustment:
        state.delta === 0
          ? null
          : {
              importedId: ADJUSTMENT_ID,
              existingTransactionId: state.existing?.id || null,
              amount: state.delta,
            },
    })),
    tracker: {
      name: config.trackerName,
      before: trackerBefore,
      after: -total,
      budgetedBefore: tracker.budgeted,
    },
    trackerBudgetChange:
      trackerChange === 0
        ? null
        : {
            month: config.month,
            from: tracker.budgeted,
            to: tracker.budgeted + trackerChange,
          },
    bankAccounts: Object.keys(banksBefore),
    bankSync,
  };

  if (
    apply &&
    (states.some((state) => state.delta !== 0) ||
      trackerChange !== 0 ||
      newImports.length > 0)
  ) {
    for (const { account, source, existing, delta } of states) {
      if (delta === 0) continue;
      const notes = `Splitser balance sync: ${source.lists.length} active lists, ${config.today}`;
      if (existing)
        await api.updateTransaction(existing.id, {
          date: config.today,
          amount: (existing.amount ?? 0) + delta,
          notes,
        });
      else
        await api.addTransactions(account.id, [
          {
            id: config.id(),
            date: config.today,
            amount: delta,
            notes,
            imported_id: ADJUSTMENT_ID,
            cleared: true,
          },
        ]);
    }
    if (trackerChange !== 0)
      await api.setBudgetAmount(
        config.month,
        tracker.id,
        tracker.budgeted + trackerChange,
      );
    for (const row of newImports)
      await api.updateTransaction(row.id, { reconciled: true });
    await api.sync();
    for (const { account, source } of states)
      await api.eventually(
        async () => (await api.getAccountBalance(account.id)) === source.amount,
      );
    await api.eventually(async () => {
      const current = (await api.getBudgetMonth(config.month)).categoryGroups
        .flatMap((group) => group.categories)
        .find((entry) => entry.id === tracker.id);
      return (
        current?.balance === -total &&
        current?.budgeted === tracker.budgeted + trackerChange
      );
    });
    if (JSON.stringify(banksBefore) !== JSON.stringify(await snapshotBanks())) {
      fail(
        'Bank balances changed. Inspect Actual immediately; do not run reconciliation again.',
      );
    }
    for (const [index, { account }] of states.entries())
      (plan.accounts[index] as AccountPlan).actualAfter =
        await api.getAccountBalance(account.id);
    Object.assign(plan, { applied: true, verified: true });
  }
  return plan;
}

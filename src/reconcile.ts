const fail = (message: string): never => {
  throw new Error(message);
};

export interface SplitserSource {
  memberName: string;
  amount: number;
  lists: { name: string; amount: number }[];
}

export interface ReconcileConfig {
  accountName: string;
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

export interface ReconcilePlan {
  dryRun: boolean;
  source: SplitserSource;
  account: { name: string; before: number; after: number };
  tracker: {
    name: string;
    before: number;
    after: number;
    budgetedBefore: number;
  };
  /** Splitser rows that Actual's own bank sync added since the last run. */
  imports: { count: number; amount: number };
  adjustment: {
    importedId: string;
    existingTransactionId: string | null;
    amount: number;
  } | null;
  trackerBudgetChange: { month: string; from: number; to: number } | null;
  bankAccounts: string[];
  bankSync: { newTransactions?: unknown[] } | null;
  date?: string;
  applied?: boolean;
  verified?: boolean;
  actualAfter?: number;
}

export async function reconcileWithActual({
  source,
  apply,
  api,
  config,
}: {
  source: SplitserSource;
  apply: boolean;
  api: ActualApi;
  config: ReconcileConfig;
}): Promise<ReconcilePlan> {
  const accounts = await api.getAccounts();
  const account = accounts.find((entry) => entry.name === config.accountName);
  if (!account?.offbudget)
    fail(
      `Actual needs an off-budget account named ${JSON.stringify(config.accountName)}`,
    );
  const mirror = account as ActualAccount;
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
      const own = new Set(
        (await api.getTransactions(mirror.id, '0000-01-01', '9999-12-31')).map(
          (row) => row.id,
        ),
      );
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

  const rows = await api.getTransactions(mirror.id, '0000-01-01', '9999-12-31');
  const adjustments = rows.filter((row) =>
    row.imported_id?.startsWith('splitser:balance:'),
  );
  if (adjustments.length > 1)
    fail(
      'Multiple automatic Splitser adjustments found; inspect them before continuing',
    );
  const existing = adjustments[0];
  const newImports = rows.filter(
    (row) =>
      row.imported_id?.startsWith('splitser:') &&
      row.imported_id !== ADJUSTMENT_ID &&
      !row.reconciled &&
      !row.transfer_id,
  );
  const importedAmount = newImports.reduce(
    (sum, row) => sum + (row.amount ?? 0),
    0,
  );
  const actualBefore = await api.getAccountBalance(mirror.id);
  const delta = source.amount - actualBefore;
  const trackerBefore = tracker.balance;
  const trackerChange = -source.amount - trackerBefore;
  if (apply && actualBefore + trackerBefore !== importedAmount) {
    fail(
      `${config.trackerName} does not equal minus ${config.accountName} (allowing for ${newImports.length} new imported row(s)); fix the existing drift before reconciling`,
    );
  }
  if (apply && !(await api.getBudgetMonths()).includes(config.month)) {
    fail(`Actual budget month ${config.month} does not exist`);
  }

  const plan: ReconcilePlan = {
    dryRun: !apply,
    source,
    account: {
      name: config.accountName,
      before: actualBefore,
      after: source.amount,
    },
    tracker: {
      name: config.trackerName,
      before: trackerBefore,
      after: -source.amount,
      budgetedBefore: tracker.budgeted,
    },
    imports: { count: newImports.length, amount: importedAmount },
    adjustment:
      delta === 0
        ? null
        : {
            importedId: 'splitser:balance:current',
            existingTransactionId: existing?.id || null,
            amount: delta,
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

  if (apply && (delta !== 0 || trackerChange !== 0 || newImports.length > 0)) {
    if (delta !== 0) {
      const notes = `Splitser balance sync: ${source.lists.length} active lists, ${config.today}`;
      const id = existing?.id || config.id();
      if (existing)
        await api.updateTransaction(id, {
          date: config.today,
          amount: (existing.amount ?? 0) + delta,
          notes,
        });
      else
        await api.addTransactions(mirror.id, [
          {
            id,
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
    await api.eventually(
      async () => (await api.getAccountBalance(mirror.id)) === source.amount,
    );
    await api.eventually(async () => {
      const current = (await api.getBudgetMonth(config.month)).categoryGroups
        .flatMap((group) => group.categories)
        .find((entry) => entry.id === tracker.id);
      return (
        current?.balance === -source.amount &&
        current?.budgeted === tracker.budgeted + trackerChange
      );
    });
    if (JSON.stringify(banksBefore) !== JSON.stringify(await snapshotBanks())) {
      fail(
        'Bank balances changed. Inspect Actual immediately; do not run reconciliation again.',
      );
    }
    Object.assign(plan, {
      applied: true,
      verified: true,
      actualAfter: await api.getAccountBalance(mirror.id),
    });
  }
  return plan;
}

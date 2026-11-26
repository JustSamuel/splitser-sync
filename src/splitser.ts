import type {
  MemberTotal,
  SplitserClient,
  SplitserList,
  Transaction,
} from './client.ts';
import type { SplitserSource } from './reconcile.ts';

const fail = (message: string): never => {
  throw new Error(message);
};

export async function splitserBalance(
  client: Pick<SplitserClient, 'balances'>,
  memberName: string | undefined,
): Promise<SplitserSource> {
  if (!memberName) fail('Set SPLITSER_MEMBER_NAME to your exact Splitser name');
  const response = await client.balances();
  const lists = response.data.map(
    (entry: { list: SplitserList; data: MemberTotal[] }) => {
      const members = entry.data.filter(
        (member) => member.member.full_name === memberName,
      );
      if (members.length !== 1) {
        fail(
          `${entry.list.name}: expected one member named ${JSON.stringify(memberName)}, found ${members.length}`,
        );
      }
      const member = members[0] as MemberTotal;
      if (member.balance_total.currency !== 'EUR')
        fail(`${entry.list.name}: expected EUR`);
      return {
        id: entry.list.id,
        memberId: member.member.id,
        name: entry.list.name,
        amount: member.balance_total.fractional,
        sourceUpdatedAt: new Date(
          Math.max(entry.list.modified_at || 0, entry.list.updated_at || 0) *
            1000,
        ).toISOString(),
      };
    },
  );
  return {
    memberName: memberName as string,
    amount: lists.reduce((sum, list) => sum + list.amount, 0),
    lists,
  };
}

/** Two accounts resolving to one person would count their balance twice. */
export function assertDistinctMembers(
  accounts: { name: string; source: SplitserSource }[],
): void {
  const counted = new Map<string, string>();
  for (const { name, source } of accounts) {
    for (const list of source.lists) {
      const key = `${list.id}:${list.memberId}`;
      const other = counted.get(key);
      if (other !== undefined)
        fail(
          `${list.name}: ${source.memberName} is counted by both ${JSON.stringify(other)} and ${JSON.stringify(name)}; each Splitser account must be a different person`,
        );
      counted.set(key, name);
    }
  }
}

/** One expense or income, as it changes the member's balance. */
export interface Effect {
  /** Stable and unique across lists: `splitser:<list>:<type>:<id>`. */
  id: string;
  listId: string;
  listName: string;
  title: string;
  /** Cents; positive when others owe the member more. */
  amount: number;
  /** Epoch seconds when it was entered. */
  postedAt: number;
  /** Epoch seconds of the date on the expense. */
  transactedAt: number;
}

interface Money {
  fractional?: number;
}
interface Share {
  share?: { member_id?: string; amount?: Money };
}
interface Entry extends Transaction {
  name?: string;
  status?: string;
  amount?: Money;
  shares?: Share[];
  payed_by_id?: string;
  received_by_id?: string;
  payed_on?: string;
  received_on?: string;
  created_at?: number;
}

const seconds = (date: string | undefined, fallback: number) => {
  const parsed = date ? Date.parse(date) : NaN;
  return Number.isNaN(parsed) ? fallback : Math.floor(parsed / 1000);
};

/**
 * The member's effect per transaction. Deleted entries and settlements are
 * skipped: the per-list balance Splitser reports equals the sum of the
 * remaining effects.
 */
export function memberEffects(
  list: { id: string; name: string },
  memberId: string,
  transactions: Transaction[],
): Effect[] {
  const effects: Effect[] = [];
  for (const entry of transactions as Entry[]) {
    if (entry.type !== 'expense' && entry.type !== 'income') continue;
    if (entry.status === 'deleted') continue;
    const total = entry.amount?.fractional ?? 0;
    const share = (entry.shares ?? [])
      .filter((item) => item.share?.member_id === memberId)
      .reduce((sum, item) => sum + (item.share?.amount?.fractional ?? 0), 0);
    const amount =
      entry.type === 'expense'
        ? (entry.payed_by_id === memberId ? total : 0) - share
        : share - (entry.received_by_id === memberId ? total : 0);
    if (amount === 0) continue;
    const postedAt = entry.created_at ?? 0;
    effects.push({
      id: `splitser:${list.id}:${entry.type}:${entry.id}`,
      listId: list.id,
      listName: list.name,
      title: entry.name ?? entry.type,
      amount,
      postedAt,
      transactedAt: seconds(entry.payed_on ?? entry.received_on, postedAt),
    });
  }
  return effects;
}

/** Balance and the transaction effects that add up to it. */
export async function splitserEffects(
  client: Pick<SplitserClient, 'balances' | 'transactions'>,
  memberName: string | undefined,
  logger: { warn: (...args: unknown[]) => void } = console,
): Promise<{ source: SplitserSource; effects: Effect[] }> {
  const source = await splitserBalance(client, memberName);
  const { data } = await client.transactions();
  const effects: Effect[] = [];
  for (const list of source.lists) {
    const entry = data.find((item) => item.list.id === list.id);
    const listEffects = memberEffects(
      { id: list.id, name: list.name },
      list.memberId,
      entry?.data ?? [],
    );
    const sum = listEffects.reduce((total, item) => total + item.amount, 0);
    if (sum !== list.amount)
      logger.warn(
        `${list.name}: transactions add up to ${sum} cents but the balance is ${list.amount}`,
      );
    effects.push(...listEffects);
  }
  return { source, effects };
}

/**
 * The accounts SimpleFIN asked for. A login that fails only drops its own
 * account, unless nothing is left to answer with.
 */
export async function simplefinSources(
  accounts: {
    id: string;
    name: string;
    memberName: string | undefined;
    client: Pick<SplitserClient, 'balances' | 'transactions'>;
  }[],
  requested: string[],
  logger: { warn: (...args: unknown[]) => void } = console,
) {
  const wanted = (id: string) =>
    requested.length === 0 || requested.includes(id);
  // Balances of the others are still needed for the duplicate-member check.
  const settled = await Promise.allSettled(
    accounts.map(async ({ id, name, memberName, client }) => ({
      id,
      name,
      ...(wanted(id)
        ? await splitserEffects(client, memberName, logger)
        : {
            source: await splitserBalance(client, memberName),
            effects: [],
          }),
    })),
  );
  const loaded = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  assertDistinctMembers(loaded);
  const failures = settled.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ account: accounts[index]!, reason: result.reason as unknown }]
      : [],
  );
  for (const { account, reason } of failures)
    logger.warn(`${account.name}: could not load from Splitser`, reason);
  const answer = loaded.filter((account) => wanted(account.id));
  const failed = failures.find(({ account }) => wanted(account.id));
  if (answer.length === 0 && failed) throw failed.reason;
  return answer.map(({ id, name, source, effects }) => ({
    id,
    name,
    balance: source.amount,
    effects,
  }));
}

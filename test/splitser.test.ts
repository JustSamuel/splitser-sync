import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberEffects, splitserEffects } from '../src/splitser.ts';

const list = { id: 'list-1', name: 'Flat' };
const me = 'me';
const money = (fractional: number) => ({ currency: 'EUR', fractional });
const shares = (entries: Record<string, number>) =>
  Object.entries(entries).map(([member_id, amount]) => ({
    share: { member_id, amount: money(amount) },
  }));
const expense = (
  id: number,
  paidBy: string,
  amounts: Record<string, number>,
  extra: Record<string, unknown> = {},
) => ({
  type: 'expense',
  id,
  name: `Expense ${id}`,
  status: 'active',
  payed_by_id: paidBy,
  amount: money(Object.values(amounts).reduce((a, b) => a + b, 0)),
  shares: shares(amounts),
  created_at: 1000 + id,
  payed_on: '2026-01-02',
  ...extra,
});

test('expense effect is what I paid minus my share', () => {
  const [paid, owed, uninvolved] = [
    expense(1, me, { me: 400, you: 600 }),
    expense(2, 'you', { me: 250, you: 750 }),
    expense(3, 'you', { you: 500, other: 500 }),
  ].map((entry) => memberEffects(list, me, [entry]));
  assert.equal(paid![0]!.amount, 600);
  assert.equal(owed![0]!.amount, -250);
  assert.deepEqual(uninvolved, []);
});

test('income is shared out and received money is owed back', () => {
  const income = {
    type: 'income',
    id: 7,
    status: 'active',
    received_by_id: me,
    amount: money(1000),
    shares: shares({ me: 500, you: 500 }),
    created_at: 5,
  };
  assert.equal(memberEffects(list, me, [income])[0]!.amount, -500);
  assert.equal(
    memberEffects(list, me, [{ ...income, received_by_id: 'you' }])[0]!.amount,
    500,
  );
});

test('deleted entries and settlements are ignored', () => {
  const effects = memberEffects(list, me, [
    expense(1, me, { me: 1, you: 1 }, { status: 'deleted' }),
    { type: 'settle', id: 9, created_at: 1 },
    expense(2, me, { me: 1, you: 1 }),
  ]);
  assert.deepEqual(
    effects.map((effect) => effect.id),
    ['splitser:list-1:expense:2'],
  );
});

test('ids are unique across lists and stable between calls', () => {
  const entry = expense(1, me, { me: 1, you: 1 });
  const first = memberEffects(list, me, [entry])[0]!.id;
  assert.equal(memberEffects(list, me, [entry])[0]!.id, first);
  assert.notEqual(
    memberEffects({ id: 'list-2', name: 'Trip' }, me, [entry])[0]!.id,
    first,
  );
});

test('dates come from the entry and fall back to when it was created', () => {
  const [dated] = memberEffects(list, me, [expense(1, me, { me: 1, you: 1 })]);
  assert.equal(dated!.transactedAt, Date.parse('2026-01-02') / 1000);
  assert.equal(dated!.postedAt, 1001);
  const [undated] = memberEffects(list, me, [
    expense(2, me, { me: 1, you: 1 }, { payed_on: undefined }),
  ]);
  assert.equal(undated!.transactedAt, 1002);
});

test('per-list effects add up to the balance for random lists', () => {
  let seed = 7;
  const random = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.floor(seed / 65536) % max;
  };
  const members = [me, 'a', 'b'];
  const entries = Array.from({ length: 200 }, (_, index) => {
    const amounts = Object.fromEntries(
      members.map((member) => [member, random(2000)]),
    );
    return expense(index, members[random(3)]!, amounts);
  });
  const effectSum = memberEffects(list, me, entries).reduce(
    (total, effect) => total + effect.amount,
    0,
  );
  const expected = entries.reduce((total, entry) => {
    const own = entry.shares.find((item) => item.share.member_id === me)!.share
      .amount.fractional;
    return (
      total + (entry.payed_by_id === me ? entry.amount.fractional : 0) - own
    );
  }, 0);
  assert.equal(effectSum, expected);
});

test('mismatching totals are reported but do not fail', async () => {
  const warnings: unknown[][] = [];
  const result = await splitserEffects(
    {
      async balances() {
        return {
          data: [
            {
              list: { id: 'list-1', name: 'Flat' },
              data: [
                {
                  member: { id: me, full_name: 'Member' },
                  balance_total: money(999),
                },
              ],
              cached: false,
            },
          ],
          meta: { lists: 1, cachedLists: 0 },
        };
      },
      async transactions() {
        return {
          data: [
            {
              list: { id: 'list-1', name: 'Flat' },
              data: [expense(1, me, { me: 400, you: 600 })],
              fetchedAt: '',
              cached: false,
            },
          ],
          meta: { lists: 1, transactions: 1, cachedLists: 0 },
        };
      },
    },
    'Member',
    { warn: (...args) => warnings.push(args) },
  );
  assert.equal(result.source.amount, 999);
  assert.equal(result.effects.length, 1);
  assert.equal(warnings.length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accessUrl,
  formatAmount,
  parseQuery,
  setupToken,
  simplefinAccounts,
} from '../src/simplefin.ts';
import type { Effect } from '../src/splitser.ts';

const effect = (id: string, amount: number, postedAt: number): Effect => ({
  id,
  listId: 'l',
  listName: 'Flat',
  title: 'Groceries',
  amount,
  postedAt,
  transactedAt: postedAt - 10,
});
const effects = [effect('a', -5, 100), effect('b', 123456, 200)];
const query = (
  extra: Partial<Parameters<typeof simplefinAccounts>[0]['query']> = {},
) => ({
  accounts: [],
  balancesOnly: false,
  ...extra,
});

test('amounts always have two decimals and keep their sign', () => {
  assert.equal(formatAmount(-5), '-0.05');
  assert.equal(formatAmount(5), '0.05');
  assert.equal(formatAmount(100000), '1000.00');
  assert.equal(formatAmount(-13134), '-131.34');
  assert.equal(formatAmount(0), '0.00');
});

test('account carries balance, EUR and transactions newest first', () => {
  const { accounts } = simplefinAccounts({
    balance: 13134,
    effects,
    query: query(),
    now: 300,
  });
  const account = accounts[0] as any;
  assert.equal(account.id, 'splitser');
  assert.equal(account.currency, 'EUR');
  assert.equal(account.balance, '131.34');
  assert.equal(account['balance-date'], 300);
  assert.deepEqual(
    account.transactions.map((row: any) => [row.id, row.amount, row.posted]),
    [
      ['b', '1234.56', 200],
      ['a', '-0.05', 100],
    ],
  );
  assert.equal(account.transactions[0].payee, 'Flat');
  assert.equal(account.transactions[0].description, 'Groceries');
});

test('balances-only omits transactions', () => {
  const { accounts } = simplefinAccounts({
    balance: 1,
    effects,
    query: query({ balancesOnly: true }),
    now: 1,
  });
  assert.equal('transactions' in (accounts[0] as object), false);
});

test('date window is inclusive at the start and exclusive at the end', () => {
  const ids = (start: number, end: number) =>
    (
      (
        simplefinAccounts({
          balance: 0,
          effects,
          query: query({ start, end }),
          now: 1,
        }).accounts[0] as any
      ).transactions as any[]
    ).map((row) => row.id);
  assert.deepEqual(ids(100, 200), ['a']);
  assert.deepEqual(ids(101, 201), ['b']);
  assert.deepEqual(ids(0, 100), []);
});

test('unknown account ids return no accounts', () => {
  const result = simplefinAccounts({
    balance: 0,
    effects,
    query: query({ accounts: ['other'] }),
    now: 1,
  });
  assert.deepEqual(result.accounts, []);
});

test('query parameters follow the SimpleFIN names', () => {
  assert.deepEqual(
    parseQuery(
      new URLSearchParams(
        'start-date=10&end-date=20&pending=1&account=a&account=b',
      ),
    ),
    { start: 10, end: 20, accounts: ['a', 'b'], balancesOnly: false },
  );
  assert.equal(
    parseQuery(new URLSearchParams('balances-only=1')).balancesOnly,
    true,
  );
});

test('setup token decodes to the claim URL and the access URL parses', () => {
  const token = setupToken('https://splitser.example.com', 'claim123');
  assert.equal(
    Buffer.from(token, 'base64').toString(),
    'https://splitser.example.com/simplefin/claim/claim123',
  );
  const access = accessUrl('https://splitser.example.com', 'S3cret_-x');
  assert.match(access, /^.*\/\/.*:.*@.*$/);
  const url = new URL(access);
  assert.equal(url.username, 'splitser');
  assert.equal(url.password, 'S3cret_-x');
  assert.equal(
    `${url.origin}${url.pathname}`,
    'https://splitser.example.com/simplefin',
  );
});

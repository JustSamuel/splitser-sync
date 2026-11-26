import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitserAccounts } from '../src/config.ts';

const base = {
  SPLITSER_EMAIL: 'me@example.com',
  SPLITSER_MEMBER_NAME: 'Me',
  COOKIE_FILE: '/data/cookies.txt',
};
const partner = {
  SPLITSER_EMAIL_2: 'partner@example.com',
  SPLITSER_PASSWORD_2: 'secret',
  SPLITSER_MEMBER_NAME_2: 'Partner',
  ACTUAL_ACCOUNT_2: 'Splitser Partner',
};

test('the unsuffixed variables configure the one account as before', () => {
  const accounts = splitserAccounts('/app', { ...base, SPLITSER_EMAIL_2: '' });
  assert.deepEqual(
    accounts.map((account) => [
      account.id,
      account.memberName,
      account.actualAccount,
      account.splitser.cookieFile,
      account.splitser.email,
    ]),
    [['splitser', 'Me', 'Splitser', '/data/cookies.txt', 'me@example.com']],
  );
});

test('numbered variables add accounts in order with their own cookie file', () => {
  const accounts = splitserAccounts('/app', {
    ...base,
    SPLITSER_BASE_URL: 'https://splitser.example.com',
    SPLITSER_MEMBER_NAME_10: 'Third',
    ACTUAL_ACCOUNT_10: 'Splitser Third',
    COOKIE_FILE_10: './third.txt',
    ...partner,
  });
  assert.deepEqual(
    accounts.map((account) => [
      account.id,
      account.memberName,
      account.actualAccount,
      account.splitser.cookieFile,
      account.splitser.email,
      account.splitser.baseUrl,
    ]),
    [
      [
        'splitser',
        'Me',
        'Splitser',
        '/data/cookies.txt',
        'me@example.com',
        'https://splitser.example.com',
      ],
      [
        'splitser-2',
        'Partner',
        'Splitser Partner',
        '/data/cookies-2.txt',
        'partner@example.com',
        'https://splitser.example.com',
      ],
      [
        'splitser-10',
        'Third',
        'Splitser Third',
        '/app/third.txt',
        undefined,
        'https://splitser.example.com',
      ],
    ],
  );
  assert.equal(accounts[1]!.splitser.password, 'secret');
});

test('an extra account must name its member and Actual account', () => {
  assert.throws(
    () =>
      splitserAccounts('/app', {
        ...base,
        SPLITSER_EMAIL_2: 'partner@example.com',
        SPLITSER_MEMBER_NAME_2: 'Partner',
      }),
    /account 2 needs SPLITSER_MEMBER_NAME_2 and ACTUAL_ACCOUNT_2/,
  );
});

test('extra accounts are numbered from 2 without leading zeros', () => {
  for (const key of ['SPLITSER_EMAIL_1', 'ACTUAL_ACCOUNT_02'])
    assert.throws(
      () => splitserAccounts('/app', { ...base, [key]: 'x' }),
      new RegExp(`${key}: number additional Splitser accounts`),
    );
});

test('accounts cannot share an Actual account or a cookie file', () => {
  assert.throws(
    () =>
      splitserAccounts('/app', {
        ...base,
        ...partner,
        ACTUAL_ACCOUNT_2: 'Splitser',
      }),
    /same Actual account: "Splitser"/,
  );
  assert.throws(
    () =>
      splitserAccounts('/app', {
        ...base,
        ...partner,
        COOKIE_FILE_2: '/data/cookies.txt',
      }),
    /same cookie file/,
  );
});

import type { Effect } from './splitser.ts';

export const ACCESS_USER = 'splitser';

/** Cents as a SimpleFIN decimal string with exactly two decimals. */
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export interface AccountQuery {
  /** Epoch seconds, inclusive. */
  start?: number | undefined;
  /** Epoch seconds, exclusive. */
  end?: number | undefined;
  accounts: string[];
  balancesOnly: boolean;
}

export function parseQuery(params: URLSearchParams): AccountQuery {
  const number = (name: string) => {
    const value = Number(params.get(name));
    return params.get(name) && Number.isFinite(value) ? value : undefined;
  };
  return {
    start: number('start-date'),
    end: number('end-date'),
    accounts: params.getAll('account'),
    balancesOnly: params.get('balances-only') === '1',
  };
}

export interface SimplefinAccount {
  /** Stable SimpleFIN id; Actual links by it. */
  id: string;
  name: string;
  balance: number;
  effects: Effect[];
}

/** The SimpleFIN `/accounts` response, one account per Splitser account. */
export function simplefinAccounts({
  accounts,
  query,
  now,
}: {
  accounts: SimplefinAccount[];
  query: AccountQuery;
  now: number;
}) {
  return {
    errors: [],
    accounts: accounts
      .filter(
        ({ id }) => query.accounts.length === 0 || query.accounts.includes(id),
      )
      .map(({ id, name, balance, effects }) => {
        const account = {
          org: {
            id: 'splitser',
            name: 'Splitser',
            domain: 'splitser.com',
            'sfin-url': 'https://splitser.com',
          },
          id,
          name,
          currency: 'EUR',
          balance: formatAmount(balance),
          'available-balance': formatAmount(balance),
          'balance-date': now,
        };
        if (query.balancesOnly) return account;
        const transactions = effects
          .filter(
            (effect) =>
              (query.start === undefined || effect.postedAt >= query.start) &&
              (query.end === undefined || effect.postedAt < query.end),
          )
          .sort((a, b) => b.postedAt - a.postedAt || a.id.localeCompare(b.id))
          .map((effect) => ({
            id: effect.id,
            posted: effect.postedAt,
            amount: formatAmount(effect.amount),
            description: effect.title,
            payee: effect.listName,
            transacted_at: effect.transactedAt,
          }));
        return { ...account, transactions };
      }),
  };
}

/** The URL Actual stores after claiming; its credentials never leave the server. */
export function accessUrl(publicUrl: string, secret: string): string {
  const url = new URL('/simplefin', publicUrl);
  return `${url.protocol}//${ACCESS_USER}:${secret}@${url.host}${url.pathname}`;
}

/** What the user pastes into Actual: the base64 claim URL. */
export function setupToken(publicUrl: string, claimToken: string): string {
  const claim = new URL(`/simplefin/claim/${claimToken}`, publicUrl);
  return Buffer.from(claim.toString()).toString('base64');
}

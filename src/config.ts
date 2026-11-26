import { readFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root; works from both `src/` and the compiled `dist/`. */
export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export interface SplitserConfig {
  cookieFile: string;
  baseUrl: string;
  apiVersion: string;
  timeoutMs: number;
  listTtlMs: number;
  transactionTtlMs: number;
  email: string | undefined;
  password: string | undefined;
}

export async function loadEnv(directory: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(resolve(directory, '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*)?\s*$/);
    const key = match?.[1];
    if (!key || process.env[key] !== undefined) continue;
    let value = match[2] || '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const fail = (message: string): never => {
  throw new Error(message);
};

/** Per-account settings. Account N (from 2) reads them with an `_N` suffix. */
export const ACCOUNT_VARIABLES = [
  'SPLITSER_EMAIL',
  'SPLITSER_PASSWORD',
  'SPLITSER_MEMBER_NAME',
  'COOKIE_FILE',
  'ACTUAL_ACCOUNT',
];

export interface SplitserAccount {
  /** Stable SimpleFIN account id: `splitser`, then `splitser-2`, ... */
  id: string;
  memberName: string | undefined;
  /** The off-budget Actual account that mirrors this Splitser account. */
  actualAccount: string;
  splitser: SplitserConfig;
}

/**
 * The unsuffixed variables configure the first Splitser account. Setting any
 * per-account variable with a suffix `_2`, `_3`, ... adds another account.
 */
export function splitserAccounts(
  directory: string,
  env: Record<string, string | undefined> = process.env,
): SplitserAccount[] {
  const integer = (name: string, fallback: number) =>
    Number(env[name] || fallback);
  const shared = {
    baseUrl: env.SPLITSER_BASE_URL || 'https://app.splitser.com',
    apiVersion: env.SPLITSER_API_VERSION || '11',
    timeoutMs: integer('REQUEST_TIMEOUT_MS', 30000),
    listTtlMs: integer('LIST_CACHE_TTL_MS', 60000),
    transactionTtlMs: integer('TRANSACTION_CACHE_TTL_MS', 300000),
  };
  const cookieFile = resolve(directory, env.COOKIE_FILE || './cookies.txt');
  const accounts: SplitserAccount[] = [
    {
      id: 'splitser',
      memberName: env.SPLITSER_MEMBER_NAME,
      actualAccount: env.ACTUAL_ACCOUNT || 'Splitser',
      splitser: {
        ...shared,
        cookieFile,
        email: env.SPLITSER_EMAIL,
        password: env.SPLITSER_PASSWORD,
      },
    },
  ];

  const numbers = new Set<number>();
  for (const [key, value] of Object.entries(env)) {
    const match = /^([A-Z_]+)_(\d+)$/.exec(key);
    if (!value || !match || !ACCOUNT_VARIABLES.includes(match[1] as string))
      continue;
    const number = Number(match[2]);
    if (number < 2 || String(number) !== match[2])
      fail(`${key}: number additional Splitser accounts 2, 3, ...`);
    numbers.add(number);
  }
  const cookie = parse(cookieFile);
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const get = (name: string) => env[`${name}_${number}`] || undefined;
    const memberName = get('SPLITSER_MEMBER_NAME');
    const actualAccount = get('ACTUAL_ACCOUNT');
    if (!memberName || !actualAccount)
      fail(
        `Splitser account ${number} needs SPLITSER_MEMBER_NAME_${number} and ACTUAL_ACCOUNT_${number}`,
      );
    const ownCookieFile = get('COOKIE_FILE');
    accounts.push({
      id: `splitser-${number}`,
      memberName,
      actualAccount: actualAccount as string,
      splitser: {
        ...shared,
        cookieFile: ownCookieFile
          ? resolve(directory, ownCookieFile)
          : join(cookie.dir, `${cookie.name}-${number}${cookie.ext}`),
        email: get('SPLITSER_EMAIL'),
        password: get('SPLITSER_PASSWORD'),
      },
    });
  }

  for (const [label, values] of [
    ['Actual account', accounts.map((account) => account.actualAccount)],
    ['cookie file', accounts.map((account) => account.splitser.cookieFile)],
  ] as const) {
    const duplicate = values.find(
      (value, index) => values.indexOf(value) !== index,
    );
    if (duplicate !== undefined)
      fail(
        `Two Splitser accounts use the same ${label}: ${JSON.stringify(duplicate)}`,
      );
  }
  return accounts;
}

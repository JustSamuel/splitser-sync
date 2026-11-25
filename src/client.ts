import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SplitserConfig } from './config.ts';

export class SplitserError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface SplitserList {
  id: string;
  name: string;
  modified_at?: number;
  updated_at?: number;
}

export interface MemberTotal {
  member: { id: string; full_name: string };
  balance_total: { currency: string; fractional: number };
}

export interface Collection<T> {
  data: T[];
  pagination?: { total_pages?: number };
}

export interface ListEntry {
  list: SplitserList;
}

export interface ListBalance {
  list: SplitserList;
  data: MemberTotal[];
  cached: boolean;
}

export interface Transaction {
  type: string;
  id: string | number;
  [key: string]: unknown;
}

export interface ListTransactions {
  list: SplitserList;
  data: Transaction[];
  fetchedAt: string;
  cached: boolean;
}

interface Cached<T> {
  value: T;
  version: number;
  expires: number;
}

type RequestOptions = {
  method?: string;
  authenticated?: boolean;
  body?: string | undefined;
  retried?: boolean;
};

const unwrap = (entry: Record<string, unknown>): Transaction | null => {
  const key = ['expense', 'income', 'payment', 'settle'].find(
    (name) => entry?.[name],
  );
  return key ? ({ type: key, ...(entry[key] as object) } as Transaction) : null;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validPath =
  /^\/api\/(?:users\/sign_in|lists(?:\/[0-9a-f-]+\/(?:balance|list_items|settles))?)$/i;
const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const listVersion = (list: SplitserList) =>
  Math.max(finite(list.modified_at), finite(list.updated_at));

export type SplitserClientConfig = SplitserConfig & { fetch?: typeof fetch };

export class SplitserClient {
  config: SplitserConfig;
  fetch: typeof fetch;
  cookie: string | null = null;
  loginPromise: Promise<void> | null = null;
  listCache: { value: Collection<ListEntry>; expires: number } | null = null;
  listPromise: Promise<Collection<ListEntry>> | null = null;
  transactionCache = new Map<string, Cached<ListTransactions>>();
  transactionPromises = new Map<string, Promise<ListTransactions>>();
  balanceCache = new Map<string, Cached<ListBalance>>();
  balancePromises = new Map<string, Promise<ListBalance>>();

  constructor(config: Partial<SplitserClientConfig> & { baseUrl: string }) {
    const base = new URL(config.baseUrl);
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    ) {
      throw new SplitserError(
        'SPLITSER_BASE_URL must be an HTTPS origin without credentials',
        500,
      );
    }
    this.config = config as SplitserConfig;
    this.fetch = config.fetch || fetch;
  }

  async cookieFromDisk(): Promise<string | null> {
    let contents: string;
    try {
      contents = await readFile(this.config.cookieFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    for (const line of contents.split(/\r?\n/)) {
      if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_')))
        continue;
      const fields = line.replace(/^#HttpOnly_/, '').split('\t');
      if (
        fields.length === 7 &&
        fields[5] === '_wbw_rails_session' &&
        Number(fields[4]) * 1000 > Date.now()
      ) {
        return `${fields[5]}=${fields[6]}`;
      }
    }
    return null;
  }

  async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const { email, password } = this.config;
      if (!email || !password) {
        throw new SplitserError(
          'Splitser session expired. Set SPLITSER_EMAIL and SPLITSER_PASSWORD for automatic sign-in.',
          401,
        );
      }

      const response = await this.request('/api/users/sign_in', {
        method: 'POST',
        authenticated: false,
        body: JSON.stringify({ user: { email, password } }),
      });
      const values = response.headers.getSetCookie();
      const session = values.find((value) =>
        value.startsWith('_wbw_rails_session='),
      );
      if (!session)
        throw new SplitserError(
          'Splitser sign-in returned no session cookie',
          401,
        );

      this.cookie = session.split(';', 1)[0] ?? null;
      await this.saveCookies(values);
      this.listCache = null;
      this.transactionCache.clear();
      this.balanceCache.clear();
      console.log('Splitser session refreshed');
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async saveCookies(values: string[]): Promise<void> {
    const lines = [
      '# Netscape HTTP Cookie File',
      '# Generated by splitser-sync. Contains secrets; do not commit.',
    ];
    for (const value of values) {
      const [pair = '', ...attributes] = value
        .split(';')
        .map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const content = pair.slice(separator + 1);
      const options: Record<string, string | true> = Object.fromEntries(
        attributes.map((attribute): [string, string | true] => {
          const index = attribute.indexOf('=');
          return index < 0
            ? [attribute.toLowerCase(), true]
            : [
                attribute.slice(0, index).toLowerCase(),
                attribute.slice(index + 1),
              ];
        }),
      );
      if (name.startsWith('__Host-') && !options.secure) continue;
      const expires = options['max-age']
        ? Math.floor(Date.now() / 1000) + Number(options['max-age'])
        : Math.floor(
            new Date(
              (options.expires as string | undefined) ?? Date.now() + 86400000,
            ).getTime() / 1000,
          );
      const domain = new URL(this.config.baseUrl).hostname;
      const httpOnly = options.httponly ? '#HttpOnly_' : '';
      lines.push(
        [
          httpOnly + domain,
          'FALSE',
          options.path || '/',
          options.secure ? 'TRUE' : 'FALSE',
          expires,
          name,
          content,
        ].join('\t'),
      );
    }
    await mkdir(dirname(this.config.cookieFile), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.config.cookieFile}.${process.pid}.tmp`;
    await writeFile(temporary, lines.join('\n') + '\n', { mode: 0o600 });
    await rename(temporary, this.config.cookieFile);
  }

  async request(
    path: string,
    {
      method = 'GET',
      authenticated = true,
      body,
      retried = false,
    }: RequestOptions = {},
  ): Promise<Response> {
    const target = new URL(path, this.config.baseUrl);
    if (
      target.origin !== new URL(this.config.baseUrl).origin ||
      !validPath.test(target.pathname)
    ) {
      throw new SplitserError(
        'Refusing an unapproved Splitser API request',
        500,
      );
    }
    if (authenticated && !this.cookie)
      this.cookie = await this.cookieFromDisk();
    if (authenticated && !this.cookie) await this.login();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': 'en',
      'Accept-Version': this.config.apiVersion,
      'X-App-React': 'true',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (authenticated && this.cookie) headers.Cookie = this.cookie;

    let response: Response;
    try {
      response = await this.fetch(target, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new SplitserError(
        `Could not reach Splitser: ${(error as Error).message}`,
      );
    }

    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.arrayBuffer();
      if (!authenticated)
        throw new SplitserError('Splitser rejected the email or password', 401);
      if (retried)
        throw new SplitserError('Splitser rejected the refreshed session', 401);
      this.cookie = null;
      await this.login();
      return this.request(path, { method, authenticated, body, retried: true });
    }
    if (!response.ok) {
      await response.arrayBuffer();
      throw new SplitserError(`Splitser returned HTTP ${response.status}`);
    }
    return response;
  }

  async json(path: string, options: RequestOptions = {}): Promise<any> {
    const response = await this.request(path, options);
    try {
      return await response.json();
    } catch {
      throw new SplitserError('Splitser returned invalid JSON');
    }
  }

  async lists({ refresh = false } = {}): Promise<Collection<ListEntry>> {
    if (!refresh && this.listCache && this.listCache.expires > Date.now()) {
      return this.listCache.value;
    }
    if (this.listPromise) return this.listPromise;
    this.listPromise = (async () => {
      const body = await this.page<ListEntry>('/api/lists', {
        'filter[archived]': 'false',
      });
      this.listCache = {
        value: body,
        expires: Date.now() + this.config.listTtlMs,
      };
      return body;
    })().finally(() => {
      this.listPromise = null;
    });
    return this.listPromise;
  }

  async page<T>(
    path: string,
    filters: Record<string, string> = {},
  ): Promise<Collection<T>> {
    const data: T[] = [];
    let page = 1;
    let metadata: Collection<T>;
    do {
      const url = new URL(path, this.config.baseUrl);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '100');
      for (const [key, value] of Object.entries(filters))
        url.searchParams.set(key, value);
      const body = await this.json(url.pathname + url.search);
      if (!Array.isArray(body.data))
        throw new SplitserError(`Invalid collection from ${path}`);
      data.push(...body.data);
      metadata = body;
      page += 1;
      if (page > 1000)
        throw new SplitserError(`Pagination limit exceeded for ${path}`);
    } while (
      metadata.pagination &&
      Number.isInteger(metadata.pagination.total_pages) &&
      page <= (metadata.pagination.total_pages as number)
    );
    return { ...metadata, data };
  }

  private async selectLists(
    listId: string | undefined,
    refresh: boolean,
  ): Promise<SplitserList[]> {
    const lists = await this.lists({ refresh });
    const selected = listId
      ? lists.data.filter((entry) => entry.list?.id === listId)
      : lists.data;
    if (listId && selected.length === 0)
      throw new SplitserError('Active Splitser list not found', 404);
    return selected.map((entry) => entry.list);
  }

  // Net balances are one request per list; no transaction export is needed for reconciliation.
  async balances({
    listId,
    refresh = false,
  }: { listId?: string; refresh?: boolean } = {}): Promise<{
    data: ListBalance[];
    meta: { lists: number; cachedLists: number };
  }> {
    const selected = await this.selectLists(listId, refresh);

    const result = await Promise.all(
      selected.map(async (list): Promise<ListBalance> => {
        const cached = this.balanceCache.get(list.id);
        if (!uuid.test(list.id))
          throw new SplitserError('Invalid Splitser list ID');
        const version = listVersion(list);
        if (
          !refresh &&
          cached &&
          cached.version === version &&
          cached.expires > Date.now()
        ) {
          return { ...cached.value, cached: true };
        }
        const pending = this.balancePromises.get(list.id);
        if (pending) return pending;

        const promise = (async (): Promise<ListBalance> => {
          const body = await this.json(`/api/lists/${list.id}/balance`);
          if (!Array.isArray(body.balance?.member_totals)) {
            throw new SplitserError(
              `Invalid balance for Splitser list ${list.id}`,
            );
          }
          const value: ListBalance = {
            list,
            data: body.balance.member_totals.map(
              (entry: { member_total: MemberTotal }) => entry.member_total,
            ),
            cached: false,
          };
          this.balanceCache.set(list.id, {
            value,
            version,
            expires: Date.now() + this.config.transactionTtlMs,
          });
          return value;
        })().finally(() => this.balancePromises.delete(list.id));
        this.balancePromises.set(list.id, promise);
        return promise;
      }),
    );

    return {
      data: result,
      meta: {
        lists: result.length,
        cachedLists: result.filter((entry) => entry.cached).length,
      },
    };
  }

  async transactions({
    listId,
    refresh = false,
  }: { listId?: string; refresh?: boolean } = {}): Promise<{
    data: ListTransactions[];
    meta: { lists: number; transactions: number; cachedLists: number };
  }> {
    const selected = await this.selectLists(listId, refresh);

    const result = await Promise.all(
      selected.map(async (list): Promise<ListTransactions> => {
        const cached = this.transactionCache.get(list.id);
        if (!uuid.test(list.id))
          throw new SplitserError('Invalid Splitser list ID');
        const version = listVersion(list);
        if (
          !refresh &&
          cached &&
          cached.version === version &&
          cached.expires > Date.now()
        ) {
          return { ...cached.value, cached: true };
        }
        const pending = this.transactionPromises.get(list.id);
        if (pending) return pending;

        const promise = (async (): Promise<ListTransactions> => {
          const [items, settlements] = await Promise.all([
            this.page<Record<string, unknown>>(
              `/api/lists/${list.id}/list_items`,
            ),
            this.page<Record<string, unknown>>(`/api/lists/${list.id}/settles`),
          ]);
          const seen = new Set<string>();
          const transactions = [...items.data, ...settlements.data]
            .map(unwrap)
            .filter((item): item is Transaction => {
              if (!item || seen.has(`${item.type}:${item.id}`)) return false;
              seen.add(`${item.type}:${item.id}`);
              return true;
            });
          const value: ListTransactions = {
            list,
            data: transactions,
            fetchedAt: new Date().toISOString(),
            cached: false,
          };
          this.transactionCache.set(list.id, {
            value,
            version,
            expires: Date.now() + this.config.transactionTtlMs,
          });
          return value;
        })().finally(() => {
          this.transactionPromises.delete(list.id);
        });
        this.transactionPromises.set(list.id, promise);
        return promise;
      }),
    );

    return {
      data: result,
      meta: {
        lists: result.length,
        transactions: result.reduce(
          (total, entry) => total + entry.data.length,
          0,
        ),
        cachedLists: result.filter((entry) => entry.cached).length,
      },
    };
  }
}

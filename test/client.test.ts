import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SplitserClient, SplitserError } from '../src/client.ts';

const id = '123e4567-e89b-42d3-a456-426614174000';
type Call = { url: string; options?: RequestInit | undefined };
function setup(
  handler: (
    url: URL,
    options: RequestInit | undefined,
    count: number,
  ) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const client = new SplitserClient({
    baseUrl: 'https://app.splitser.com',
    apiVersion: '11',
    timeoutMs: 1000,
    cookieFile: '/not-read',
    email: 'email',
    password: 'password',
    listTtlMs: 60000,
    transactionTtlMs: 60000,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return handler(url as URL, options, calls.length);
    },
  });
  client.cookieFromDisk = async () => '_wbw_rails_session=existing';
  client.saveCookies = async () => {};
  return { client, calls };
}
const collection = (data: unknown[], totalPages = 1) =>
  new Response(
    JSON.stringify({ data, pagination: { total_pages: totalPages } }),
    { status: 200 },
  );

test('request allowlist rejects non-HTTPS origins and unexpected paths', async () => {
  assert.throws(
    () => new SplitserClient({ baseUrl: 'http://app.splitser.com' }),
    SplitserError,
  );
  const { client, calls } = setup(() => collection([]));
  await assert.rejects(client.json('/api/users'), /unapproved/);
  assert.equal(calls.length, 0);
});

test('lists are paginated at 100 entries and cached', async () => {
  const { client, calls } = setup((url) =>
    collection(
      [{ list: { id, modified_at: url.searchParams.get('page') } }],
      2,
    ),
  );
  const result = await client.lists();
  await client.lists();
  assert.equal(result.data.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]!.url).searchParams.get('per_page'), '100');
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get('page')),
    ['1', '2'],
  );
});

test('expired session refreshes once and retries without recursion', async () => {
  let signIns = 0;
  const { client, calls } = setup((url) => {
    if (url.pathname === '/api/users/sign_in') {
      signIns += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'Set-Cookie': '_wbw_rails_session=fresh; Secure; HttpOnly' },
      });
    }
    return signIns ? collection([]) : new Response('{}', { status: 401 });
  });
  await client.lists();
  assert.equal(signIns, 1);
  assert.equal(calls.length, 3);
});

test('invalid pagination and list identifiers are rejected', async () => {
  const { client, calls } = setup((url) =>
    url.pathname === '/api/lists'
      ? collection([{ list: { id: '../../users' } }])
      : collection([]),
  );
  await assert.rejects(client.balances(), /Invalid Splitser list ID/);
  assert.equal(calls.length, 1);
});

test('concurrent balance requests share one upstream call', async () => {
  const { client, calls } = setup(async (url) => {
    if (url.pathname === '/api/lists')
      return collection([{ list: { id, modified_at: 1 } }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ balance: { member_totals: [] } }));
  });
  const [a, b] = await Promise.all([client.balances(), client.balances()]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 2);
});

test('cookie file is private and session is not logged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'splitser-client-'));
  const cookieFile = join(directory, 'cookies.txt');
  t.after(() =>
    import('node:fs/promises').then(({ rm }) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  const client = new SplitserClient({
    baseUrl: 'https://app.splitser.com',
    cookieFile,
  });
  await client.saveCookies([
    '_wbw_rails_session=very-secret; Path=/; Secure; HttpOnly; Max-Age=3600',
  ]);
  const contents = await readFile(cookieFile, 'utf8');
  assert.match(
    contents,
    /^#HttpOnly_app\.splitser\.com\tFALSE\t\/\tTRUE\t\d+\t_wbw_rails_session\tvery-secret$/m,
  );
  client.cookie = null;
  assert.equal(await client.cookieFromDisk(), '_wbw_rails_session=very-secret');
});

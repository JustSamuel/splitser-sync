import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/http.ts';

const env: Record<string, string | undefined> = {
  API_TOKEN: 'read-secret',
  RECONCILE_TOKEN: 'write-secret',
  SIMPLEFIN_ACCESS_SECRET: 'sfin-secret',
  SIMPLEFIN_PUBLIC_URL: 'https://splitser.example.com',
};
const client = (account: string, calls: unknown[][]) => ({
  async lists(options?: { refresh?: boolean }) {
    calls.push(['lists', options, account]);
    return { data: [] };
  },
  async transactions(): Promise<never> {
    throw new Error('unused');
  },
  async balances(): Promise<never> {
    throw Object.assign(new Error('Secret backend detail'), {
      status: 502,
    });
  },
});
function setup() {
  const calls: unknown[][] = [];
  const handler = createHandler({
    env,
    logger: { error() {} },
    clients: new Map([
      ['splitser', client('splitser', calls)],
      ['splitser-2', client('splitser-2', calls)],
    ]),
    async simplefin(query: unknown) {
      calls.push(['simplefin', query]);
      return { errors: [], accounts: [] };
    },
    async reconcile(options: { apply: boolean }) {
      calls.push(['reconcile', options]);
      return { dryRun: !options.apply } as never;
    },
  });
  return { handler, calls };
}

async function request(
  handler: ReturnType<typeof createHandler>,
  path: string,
  token: string | null = 'read-secret',
  method = 'GET',
  authorization?: string,
) {
  const response = {
    status: 0,
    headers: {} as unknown,
    body: '',
    writeHead(status: number, headers: unknown) {
      this.status = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
  };
  await handler(
    {
      url: path,
      method,
      headers: authorization
        ? { authorization }
        : token
          ? { authorization: `Bearer ${token}` }
          : {},
    },
    response as never,
  );
  return {
    ...response,
    json: response.body.startsWith('{') ? JSON.parse(response.body) : null,
  };
}

test('health is public but every other route requires its own token', async () => {
  const { handler } = setup();
  assert.equal((await request(handler, '/health', null)).status, 200);
  for (const [path, token] of [
    ['/lists', null],
    ['/lists', 'write-secret'],
    ['/transactions', null],
    ['/reconcile', 'read-secret'],
  ] as [string, string | null][]) {
    assert.equal((await request(handler, path, token, 'POST')).status, 401);
  }
});

test('refresh accepts only the exact value 1', async () => {
  const { handler, calls } = setup();
  assert.equal((await request(handler, '/lists?refresh=1')).status, 200);
  assert.equal((await request(handler, '/lists?refresh=false')).status, 200);
  assert.deepEqual(
    calls.map((call) => (call[1] as { refresh: boolean }).refresh),
    [true, false],
  );
});

test('account selects the Splitser account and defaults to the first', async () => {
  const { handler, calls } = setup();
  assert.equal((await request(handler, '/lists')).status, 200);
  assert.equal(
    (await request(handler, '/lists?account=splitser-2')).status,
    200,
  );
  assert.equal((await request(handler, '/lists?account=other')).status, 404);
  assert.deepEqual(
    calls.map((call) => call[2]),
    ['splitser', 'splitser-2'],
  );
});

test('apply requires explicit opt-in and the write token', async () => {
  const { handler, calls } = setup();
  assert.equal(
    (await request(handler, '/reconcile?apply=true', 'write-secret', 'POST'))
      .status,
    403,
  );
  assert.deepEqual(calls, []);
  env.ALLOW_ACTUAL_WRITES = 'true';
  assert.equal(
    (await request(handler, '/reconcile?apply=true', 'write-secret', 'POST'))
      .status,
    200,
  );
  assert.deepEqual(calls, [['reconcile', { apply: true }]]);
  delete env.ALLOW_ACTUAL_WRITES;
});

test('backend details are not exposed in HTTP responses', async () => {
  const { handler } = setup();
  const response = await request(handler, '/balances');
  assert.equal(response.status, 502);
  assert.deepEqual(response.json, { error: 'Request failed' });
});

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

test('simplefin accounts accept only the access secret as basic auth', async () => {
  const { handler, calls } = setup();
  const get = (authorization?: string) =>
    request(
      handler,
      '/simplefin/accounts?balances-only=1',
      null,
      'GET',
      authorization,
    );
  assert.equal((await get()).status, 403);
  assert.equal((await get(basic('splitser', 'wrong'))).status, 403);
  assert.equal((await get(basic('someone', 'sfin-secret'))).status, 403);
  assert.equal((await get('Bearer read-secret')).status, 403);
  assert.deepEqual(calls, []);
  const ok = await get(basic('splitser', 'sfin-secret'));
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, [
    [
      'simplefin',
      { start: undefined, end: undefined, accounts: [], balancesOnly: true },
    ],
  ]);
});

test('the access secret does not open the other routes', async () => {
  const { handler } = setup();
  assert.equal((await request(handler, '/lists', 'sfin-secret')).status, 401);
});

test('claim is disabled unless a claim token is set and then checks it', async () => {
  const { handler } = setup();
  const claim = (token: string) =>
    request(handler, `/simplefin/claim/${token}`, null, 'POST');
  assert.equal((await claim('claim-1')).status, 404);
  env.SIMPLEFIN_CLAIM_TOKEN = 'claim-1';
  assert.equal((await claim('wrong')).status, 403);
  const ok = await claim('claim-1');
  assert.equal(ok.status, 200);
  assert.equal(
    ok.body,
    'https://splitser:sfin-secret@splitser.example.com/simplefin',
  );
  delete env.SIMPLEFIN_CLAIM_TOKEN;
});

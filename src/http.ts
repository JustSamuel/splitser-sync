import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SplitserClient } from './client.ts';
import type { ReconcilePlan } from './reconcile.ts';
import { ACCESS_USER, accessUrl, parseQuery } from './simplefin.ts';
import type { AccountQuery } from './simplefin.ts';

export function safeEqual(supplied: string, secret: string): boolean {
  return (
    supplied.length === secret.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
  );
}

export function authorized(
  request: Pick<IncomingMessage, 'headers'>,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || '');
  const supplied = match?.[1];
  return Boolean(supplied) && safeEqual(supplied as string, secret);
}

function basicAuthorized(
  request: Pick<IncomingMessage, 'headers'>,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(
    request.headers.authorization || '',
  );
  const decoded = Buffer.from(match?.[1] ?? '', 'base64').toString();
  const separator = decoded.indexOf(':');
  return (
    separator > 0 &&
    decoded.slice(0, separator) === ACCESS_USER &&
    safeEqual(decoded.slice(separator + 1), secret)
  );
}

export function sendJson(
  response: Pick<ServerResponse, 'writeHead' | 'end'>,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  response.end(data);
}

export interface HandlerOptions {
  /** Splitser clients by account id; the first one is the default. */
  clients: Map<
    string,
    Pick<SplitserClient, 'lists' | 'balances' | 'transactions'>
  >;
  reconcile: (options: { apply: boolean }) => Promise<ReconcilePlan>;
  simplefin?: (query: AccountQuery) => Promise<unknown>;
  env: Record<string, string | undefined>;
  logger?: { error: (...args: unknown[]) => void };
}

export function createHandler({
  clients,
  reconcile,
  simplefin,
  env,
  logger = console,
}: HandlerOptions) {
  let reconciliation: Promise<ReconcilePlan> | null = null;
  async function runReconciliation(apply: boolean) {
    if (reconciliation)
      throw Object.assign(new Error('A reconciliation is already running'), {
        status: 409,
      });
    reconciliation = reconcile({ apply }).finally(() => {
      reconciliation = null;
    });
    return reconciliation;
  }

  return async (
    request: Pick<IncomingMessage, 'url' | 'method' | 'headers'>,
    response: Pick<ServerResponse, 'writeHead' | 'end'>,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        reconciling: Boolean(reconciliation),
      });
      return;
    }
    try {
      if (url.pathname.startsWith('/simplefin/')) {
        const secret = env.SIMPLEFIN_ACCESS_SECRET;
        const claimToken = env.SIMPLEFIN_CLAIM_TOKEN;
        const claim = /^\/simplefin\/claim\/([^/]+)$/.exec(url.pathname);
        if (request.method === 'POST' && claim) {
          const publicUrl = env.SIMPLEFIN_PUBLIC_URL;
          if (!secret || !claimToken || !publicUrl) {
            sendJson(response, 404, { error: 'Not found' });
            return;
          }
          if (!safeEqual(decodeURIComponent(claim[1] as string), claimToken)) {
            sendJson(response, 403, { error: 'Forbidden' });
            return;
          }
          const body = accessUrl(publicUrl, secret);
          response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store',
          });
          response.end(body);
          return;
        }
        if (
          request.method === 'GET' &&
          url.pathname === '/simplefin/accounts' &&
          simplefin
        ) {
          if (!basicAuthorized(request, secret)) {
            sendJson(response, 403, { error: 'Forbidden' });
            return;
          }
          sendJson(
            response,
            200,
            await simplefin(parseQuery(url.searchParams)),
          );
          return;
        }
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const writeRoute = url.pathname === '/reconcile';
      if (
        !authorized(request, env[writeRoute ? 'RECONCILE_TOKEN' : 'API_TOKEN'])
      ) {
        sendJson(response, 401, {
          error: 'Valid bearer authentication is required',
        });
        return;
      }
      if (request.method === 'POST' && writeRoute) {
        const apply = url.searchParams.get('apply') === 'true';
        if (apply && env.ALLOW_ACTUAL_WRITES !== 'true') {
          sendJson(response, 403, { error: 'Actual writes are disabled' });
          return;
        }
        sendJson(response, 200, await runReconciliation(apply));
        return;
      }
      const refresh = url.searchParams.get('refresh') === '1';
      const listId = url.searchParams.get('list_id') || undefined;
      const accountId = url.searchParams.get('account');
      const client =
        accountId === null
          ? clients.values().next().value
          : clients.get(accountId);
      if (!client) {
        sendJson(response, 404, { error: 'Splitser account not found' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/lists') {
        sendJson(response, 200, await client.lists({ refresh }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/balances') {
        sendJson(
          response,
          200,
          await client.balances(
            listId === undefined ? { refresh } : { listId, refresh },
          ),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/transactions') {
        sendJson(
          response,
          200,
          await client.transactions(
            listId === undefined ? { refresh } : { listId, refresh },
          ),
        );
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      logger.error(error);
      const status = (error as { status?: unknown }).status;
      sendJson(response, Number.isInteger(status) ? (status as number) : 500, {
        error: 'Request failed',
      });
    }
  };
}

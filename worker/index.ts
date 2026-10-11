import { z } from 'zod';
import { authorize, isLocal, secureEqual, verifyMutation } from './auth';
import type { Env } from './env';
import { GroupService } from './group';
import { PostgresDatabase } from './database';
import { runScheduledWork } from './scheduler';
import { HttpError, json, readJson, databaseQuotaResponse } from './http';
import { updateSchema } from './telegram';
import { GroupDirectory, groupEnv, type Directory } from './directory';

function group(env: Env, db?: PostgresDatabase) {
  if (!/^-100\d+$/.test(env.TELEGRAM_CHAT_ID))
    throw new HttpError(503, 'Configure the numeric Telegram supergroup ID.');
  return new GroupService(db || new PostgresDatabase(env), env);
}
function securityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cache-Control', 'no-store');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
async function dispatchGroupWork(env: Env, chatId: string, cleanup: boolean) {
  if (!env.WORKER_URL || !env.TELEGRAM_WEBHOOK_SECRET)
    throw new HttpError(503, 'Configure WORKER_URL for multi-group scheduling.');
  const endpoint = new URL('/internal/work', env.WORKER_URL);
  if (endpoint.protocol !== 'https:') throw new HttpError(503, 'WORKER_URL must use HTTPS.');
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'X-Watchtower-Work-Secret': env.TELEGRAM_WEBHOOK_SECRET,
    },
    // Omit dispatch so a child can never recursively dispatch itself.
    body: JSON.stringify({ chatId, cleanup }),
    signal: AbortSignal.timeout(55_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new HttpError(503, 'Group work will resume on the next scheduled tick.');
}
export function createWorker(
  resolveGroup: (
    env: Env,
    db?: PostgresDatabase,
  ) => { fetch(request: Request): Promise<Response> } = group,
  resolveDirectory: (env: Env) => Directory = (env) =>
    new GroupDirectory(new PostgresDatabase(env), env),
) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.pathname === '/health' && request.method === 'GET')
          return json({ ok: true, service: 'watchtower' });
        if (url.pathname === '/internal/work') {
          if (
            request.method !== 'POST' ||
            !env.TELEGRAM_WEBHOOK_SECRET ||
            !(await secureEqual(
              request.headers.get('X-Watchtower-Work-Secret') || '',
              env.TELEGRAM_WEBHOOK_SECRET,
            ))
          )
            throw new HttpError(401, 'Invalid work request.');
          const { chatId, cleanup, dispatch } = z
            .object({
              chatId: z.string().regex(/^-100\d+$/),
              cleanup: z.boolean().default(false),
              dispatch: z.boolean().default(false),
            })
            .parse(await readJson(request));
          const directory = resolveDirectory(env);
          // Trusted recovery callers use the cron dispatch path. The outbound body
          // cannot dispatch again, and the child rechecks active membership.
          if (dispatch) {
            const active = await directory.session(
              async () => (await directory.get(chatId))?.status === 'active',
            );
            if (!active) return json({ skipped: true });
            await dispatchGroupWork(env, chatId, cleanup);
            return json({ ok: true });
          }
          return await directory.session(async () => {
            if ((await directory.get(chatId))?.status !== 'active') return json({ skipped: true });
            const selected = groupEnv(env, chatId),
              db = directory.db?.forGroup(chatId);
            if (cleanup) {
              const response = await resolveGroup(selected, db).fetch(
                new Request('https://group.internal/cleanup', { method: 'POST' }),
              );
              if (!response.ok) throw new HttpError(503, 'Retention cleanup will retry.');
            } else await runScheduledWork(selected, 45_000, db);
            return json({ ok: true });
          });
        }
        if (url.pathname === '/telegram/webhook') {
          if (request.method !== 'POST') throw new HttpError(405, 'POST only.');
          if (!env.TELEGRAM_WEBHOOK_SECRET)
            throw new HttpError(503, 'Webhook secret is not configured.');
          if (
            !(await secureEqual(
              request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '',
              env.TELEGRAM_WEBHOOK_SECRET,
            ))
          )
            throw new HttpError(401, 'Invalid webhook secret.');
          const update = updateSchema.parse(await readJson(request, 256_000));
          const directory = resolveDirectory(env);
          return await directory.session(async () => {
            const chatId = await directory.discover(update);
            if (!chatId) return json({ ok: true });
            // Acknowledge only after registration and the pending message commit.
            const response = await resolveGroup(
              groupEnv(env, chatId),
              directory.db?.forGroup(chatId),
            ).fetch(
              new Request('https://group.internal/ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(update),
              }),
            );
            if (!response.ok)
              throw new HttpError(503, 'Could not persist update. Telegram should retry.');
            return json({ ok: true });
          });
        }
        const owner = await authorize(request, env);
        verifyMutation(request);
        if (url.pathname === '/api/groups' || url.pathname.startsWith('/api/groups/'))
          return securityHeaders(await resolveDirectory(env).fetch(request));
        if (url.pathname.startsWith('/api/')) {
          const chatId = request.headers.get('X-Watchtower-Group') || env.TELEGRAM_CHAT_ID;
          if (!/^-100\d+$/.test(chatId)) throw new HttpError(400, 'Invalid group selection.');
          const directory = resolveDirectory(env);
          return await directory.session(async () => {
            // Default read paths retain their small CPU footprint. Every other group,
            // and every live write, is checked against the owner-managed registry.
            const liveWrite =
              !['GET', 'HEAD'].includes(request.method) &&
              !/^\/api\/(datasets|evaluations)(?:\/|$)/.test(url.pathname);
            if (chatId !== env.TELEGRAM_CHAT_ID || liveWrite) {
              const selected = await directory.get(chatId);
              if (!selected?.provisioned)
                throw new HttpError(404, 'Activate this group in Watchtower first.');
              if (liveWrite && selected.status !== 'active')
                throw new HttpError(409, 'Reconnect this group before changing live moderation.');
            }
            const headers = new Headers(request.headers);
            headers.delete('X-Local-Demo');
            if (isLocal(request, env)) headers.set('X-Local-Demo', '1');
            const response = await resolveGroup(
              groupEnv(env, chatId),
              directory.db?.forGroup(chatId),
            ).fetch(new Request(request, { headers }));
            if (url.pathname === '/api/overview' && response.ok) {
              const data = (await response.json()) as Record<string, unknown>;
              return securityHeaders(json({ ...data, dev: isLocal(request, env), owner }));
            }
            return securityHeaders(response);
          });
        }
        if (!['GET', 'HEAD'].includes(request.method))
          throw new HttpError(405, 'Method not allowed.');
        return securityHeaders(await env.ASSETS.fetch(request));
      } catch (e) {
        const quota = databaseQuotaResponse(e);
        if (quota) return securityHeaders(quota);
        if (e instanceof HttpError) return securityHeaders(json({ error: e.message }, e.status));
        if (e instanceof z.ZodError) return json({ error: 'Malformed Telegram update.' }, 400);
        return securityHeaders(
          json({ error: 'Request failed. Check worker configuration and logs.' }, 500),
        );
      }
    },
    async scheduled(controller: ScheduledController, env: Env) {
      if (!env.TELEGRAM_CHAT_ID) return;
      const directory = resolveDirectory(env);
      const cleanup = controller.cron === '17 3 * * *';
      const groups = await directory.session(async () => {
        const groups = await directory.active();
        if (groups.length === 1 && groups[0].chat_id === env.TELEGRAM_CHAT_ID) {
          if (cleanup) {
            const response = await resolveGroup(env, directory.db).fetch(
              new Request('https://group.internal/cleanup', { method: 'POST' }),
            );
            if (!response.ok)
              throw new HttpError(503, 'Retention cleanup failed; saved data is retained.');
          } else await runScheduledWork(env, 45_000, directory.db);
          return [];
        }
        return groups;
      });
      if (!groups.length) return;
      // Separate HTTP invocations give each group its own free Worker CPU allowance.
      // Persisted leases exclude overlaps and cron retries recover interrupted work.
      const outcomes = await Promise.allSettled(
        groups.map((g) => dispatchGroupWork(env, g.chat_id, cleanup)),
      );
      if (outcomes.some((result) => result.status === 'rejected'))
        throw new HttpError(503, 'Some groups could not finish this tick; saved work is retained.');
    },
  } satisfies ExportedHandler<Env>;
}
export default createWorker();

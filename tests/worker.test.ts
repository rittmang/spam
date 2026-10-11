import { env } from 'cloudflare:workers';
import {
  runInDurableObject,
  runDurableObjectAlarm,
  reset,
  abortAllDurableObjects,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Overview, type Settings } from '../shared/types';
import { reviewedExamples } from '../shared/review';
import { metrics } from '../shared/metrics';
import { GroupModerator } from '../worker/local-group';
import worker from '../worker/local';
import { authorize } from '../worker/auth';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { Env } from '../worker/env';
import type { TelegramUpdate } from '../worker/telegram';

let calls: { method: string; body: Record<string, any> }[];
let nextScore = 0.99,
  admins: number[] = [],
  memberStatus = 'member',
  deleteFailures = 0;
let modelReply: ((body: Record<string, any>) => Promise<Response> | Response) | null;
beforeEach(() => {
  calls = [];
  nextScore = 0.99;
  admins = [];
  memberStatus = 'member';
  deleteFailures = 0;
  modelReply = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        body = JSON.parse(String(init?.body || '{}'));
      if (url.startsWith('https://api.telegram.org/')) {
        const method = url.split('/').at(-1)!;
        calls.push({ method, body });
        if (method === 'getChatAdministrators')
          return Response.json({ ok: true, result: admins.map((id) => ({ user: { id } })) });
        if (method === 'getChatMember')
          return Response.json({ ok: true, result: { status: memberStatus } });
        if (method === 'deleteMessages' && deleteFailures-- > 0)
          return Response.json({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 1 },
          });
        return Response.json({ ok: true, result: true });
      }
      if (url.startsWith('https://openrouter.ai/')) {
        calls.push({ method: 'classify', body });
        if (modelReply) return modelReply(body);
        const messages = JSON.parse(body.messages[1].content).messages;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: messages
                    .map((m: { id: string }) => ({
                      id: m.id,
                      score: nextScore,
                      category: 'spam',
                      reason: 'Unsolicited promotion',
                    }))
                    .reverse(),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.00001 },
        });
      }
      throw new Error(`Unexpected external request: ${url}`);
    }),
  );
});
afterEach(async () => {
  await reset();
  vi.unstubAllGlobals();
});
function stub() {
  return env.GROUPS.get(env.GROUPS.idFromName(crypto.randomUUID()));
}
function update(id: number, user = 42, text = 'Buy fake signals', edited = false): TelegramUpdate {
  return {
    update_id: id,
    [edited ? 'edited_message' : 'message']: {
      message_id: edited ? 1 : id,
      date: Math.floor(Date.now() / 1000),
      ...(edited ? { edit_date: Math.floor(Date.now() / 1000) + 1 } : {}),
      chat: { id: Number(env.TELEGRAM_CHAT_ID), type: 'supergroup' },
      from: { id: user, first_name: 'Test User' },
      text,
    },
  };
}
async function send(s: DurableObjectStub, body: unknown) {
  return s.fetch('https://group.internal/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function overview(s: DurableObjectStub) {
  return (await (await s.fetch('https://group.internal/api/overview')).json()) as Overview;
}
async function configure(s: DurableObjectStub, value: Partial<Settings>) {
  return s.fetch('https://group.internal/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...defaultSettings, ...value }),
  });
}
async function tick(s: DurableObjectStub) {
  await runDurableObjectAlarm(s);
}

describe('durable moderation', () => {
  it('reuses overview reads until storage changes or the cache expires', async () => {
    const s = stub();
    await send(s, update(1));
    await overview(s);
    await runInDurableObject(s, async (instance: GroupModerator) => {
      const rows = vi.spyOn(instance as any, 'rows');
      await instance.fetch(new Request('https://group.internal/api/overview'));
      expect(rows).not.toHaveBeenCalled();
      (instance as any).overviewCache.at = Date.now() - 60_001;
      await instance.fetch(new Request('https://group.internal/api/overview'));
      expect(rows).toHaveBeenCalled();
      rows.mockRestore();
    });
    await send(s, update(2));
    expect((await overview(s)).stats.total).toBe(2);
    await tick(s);
    expect((await overview(s)).stats.pending).toBe(0);
    await configure(s, { mode: 'paused' });
    expect((await overview(s)).settings.mode).toBe('paused');
  });
  it('returns a recoverable service error and retry delay for exhausted database quotas', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance: GroupModerator) => {
      const overview = vi.spyOn(instance as any, 'overview').mockImplementation(() => {
        throw new Error('Exceeded allowed rows read in Durable Objects free tier.');
      });
      try {
        const response = await instance.fetch(new Request('https://group.internal/api/overview'));
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('300');
        expect(await response.json()).toMatchObject({ code: 'DATABASE_DAILY_QUOTA' });
      } finally {
        overview.mockRestore();
      }
    });
  });
  it('keeps an alarm for quota recovery without querying or logging through exhausted storage', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance: GroupModerator, state) => {
      const process = vi.spyOn(instance as any, 'processMessages').mockImplementation(() => {
        throw new Error('Exceeded allowed rows read in Durable Objects free tier.');
      });
      const log = vi.spyOn(instance as any, 'log');
      const schedule = vi.spyOn(instance as any, 'scheduleRemaining');
      try {
        await instance.alarm();
        expect(log).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
        expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 290_000);
      } finally {
        process.mockRestore();
        log.mockRestore();
        schedule.mockRestore();
      }
    });
  });
  it('provides only recent same-sender messages as repetition context', async () => {
    const s = stub();
    nextScore = 0.05;
    const old = update(1, 42, 'Yesterday greeting');
    old.message!.date -= 86400;
    await send(s, old);
    await send(s, update(2, 42, 'Recent greeting'));
    await send(s, update(3, 42, 'New greeting'));
    await tick(s);
    const payload = calls.find((c) => c.method === 'classify')!.body;
    const messages = JSON.parse(payload.messages[1].content).messages;
    expect(messages.find((m: any) => m.text === 'Recent greeting').recent_same_sender).toEqual([]);
    expect(messages.find((m: any) => m.text === 'New greeting').recent_same_sender).toEqual([
      'Recent greeting',
    ]);
  });
  it('persists before acknowledging and deduplicates concurrent webhook delivery', async () => {
    const s = stub();
    const replies = await Promise.all([send(s, update(1)), send(s, update(1)), send(s, update(1))]);
    expect(replies.every((r) => r.ok)).toBe(true);
    expect((await overview(s)).stats.total).toBe(1);
    expect(
      await runInDurableObject(s, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();
    await tick(s);
    expect((await overview(s)).messages[0].status).toBe('observed_spam');
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'deleteMessages')).toBe(false);
  });
  it('deletes at strike one, purges at two, and bans at three, exactly once per message', async () => {
    const s = stub();
    await configure(s, { mode: 'enforce' });
    // A legitimate tracked message is included in the second-strike purge.
    nextScore = 0.05;
    await send(s, update(10, 42, 'Legitimate question'));
    await tick(s);
    nextScore = 0.99;
    await send(s, update(11));
    await tick(s);
    expect((await overview(s)).users[0].strikes).toBe(1);
    expect(
      calls.some(
        (c) => c.method === 'deleteMessages' && (c.body.message_ids as number[]).includes(11),
      ),
    ).toBe(true);
    await send(s, update(12));
    await tick(s);
    expect((await overview(s)).users[0].strikes).toBe(2);
    expect(
      calls.some(
        (c) => c.method === 'deleteMessages' && (c.body.message_ids as number[]).includes(10),
      ),
    ).toBe(true);
    await send(s, update(13));
    await send(s, update(13));
    await tick(s);
    const data = await overview(s);
    expect(data.users[0]).toMatchObject({ strikes: 3, banned: 1 });
    expect(calls.filter((c) => c.method === 'banChatMember')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'banChatMember')!.body).toMatchObject({
      revoke_messages: true,
      user_id: 42,
    });
  });
  it('awards strikes in message chronology even if a model returns reversed results', async () => {
    const s = stub();
    await configure(s, { mode: 'enforce' });
    await send(s, update(1));
    await send(s, update(2));
    await send(s, update(3));
    await tick(s);
    const spam = (await overview(s)).audit.filter((a) => a.kind === 'spam').reverse();
    expect(spam.map((a) => a.message_id)).toEqual([1, 2, 3]);
    expect(spam.map((a) => JSON.parse(a.detail).strike)).toEqual([1, 2, 3]);
  });
  it('protects owner, administrators, anonymous senders, bots, and exempt users', async () => {
    const s = stub();
    await configure(s, { mode: 'enforce', exemptUserIds: ['77'] });
    admins = [88];
    await send(s, update(1, 999));
    await send(s, update(2, 77));
    await send(s, update(3, 88));
    const anonymous = update(4);
    anonymous.message!.sender_chat = { id: -10012 };
    await send(s, anonymous);
    await tick(s);
    const data = await overview(s);
    expect(data.stats.spam).toBe(0);
    expect(data.users).toHaveLength(0);
    expect(data.messages.every((m) => m.status === 'protected')).toBe(true);
    expect(calls.some((c) => c.method === 'classify')).toBe(false);
  });
  it('never counts an edited message twice and disregards stale model output', async () => {
    const s = stub();
    await configure(s, { mode: 'enforce' });
    await send(s, update(1));
    // Inject the edit at the upstream await boundary inside the actor context.
    // This avoids moving an unresolved Promise between workerd request contexts.
    await runInDurableObject<GroupModerator, void>(s, async (instance, state) => {
      modelReply = async () => {
        await instance.ingest(update(2, 42, 'Edited legitimate content', true));
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [{ id: 'm0', score: 0.99, reason: 'old content', category: 'spam' }],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
      };
      await state.storage.deleteAlarm();
      await instance.alarm();
    });
    expect((await overview(s)).users).toHaveLength(0);
    modelReply = null;
    nextScore = 0.99;
    await tick(s);
    expect((await overview(s)).users[0].strikes).toBe(1);
    await send(s, update(3, 42, 'Another edit', true));
    await tick(s);
    expect((await overview(s)).users[0].strikes).toBe(1);
  });
  it('keeps provider failures non-destructive and does not trust partial results', async () => {
    const s = stub();
    await configure(s, { mode: 'enforce' });
    await send(s, update(1));
    await send(s, update(2));
    modelReply = () => Response.json({ choices: [{ message: { content: '{"results":[]}' } }] });
    await tick(s);
    const data = await overview(s);
    expect(data.stats.pending).toBe(2);
    expect(data.users).toHaveLength(0);
    expect(calls.some((c) => c.method === 'deleteMessages')).toBe(false);
    expect(data.audit.some((a) => a.kind === 'classification_error')).toBe(true);
  });
  it('holds live messages until the budget resets without spending their failure retries', async () => {
    const s = stub();
    await configure(s, { mode: 'enforce', dailyTokenBudget: 1000 });
    await send(s, update(1));
    await tick(s);
    const held = await runInDurableObject(s, (_instance, state) =>
      state.storage.sql.exec('SELECT status,attempts,next_at FROM messages WHERE id=1').one(),
    );
    expect(held.status).toBe('pending');
    expect(held.attempts).toBe(0);
    expect(held.next_at).toBeGreaterThan(Date.now());
    expect(calls.some((c) => c.method === 'classify')).toBe(false);
    await configure(s, { mode: 'enforce', dailyTokenBudget: 100000 });
    await tick(s);
    expect((await overview(s)).users[0].strikes).toBe(1);
  });
  it('retries Telegram rate limits without awarding another strike', async () => {
    const s = stub();
    await configure(s, { mode: 'enforce' });
    deleteFailures = 1;
    await send(s, update(1));
    await tick(s);
    expect((await overview(s)).users[0].strikes).toBe(1);
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec("UPDATE actions SET next_at=0 WHERE status='pending'");
    });
    await tick(s);
    expect((await overview(s)).users[0].strikes).toBe(1);
    expect((await overview(s)).stats.deleted).toBe(1);
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(1);
  });
  it('persists user state across actor restarts and preserves it across retention cleanup', async () => {
    let s = stub();
    await configure(s, { mode: 'enforce', retentionDays: 3 });
    await send(s, update(1));
    await tick(s);
    await abortAllDurableObjects();
    s = env.GROUPS.get(s.id);
    expect((await overview(s)).users[0].strikes).toBe(1);
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec('UPDATE messages SET sent_at=0');
    });
    await s.fetch('https://group.internal/cleanup', { method: 'POST' });
    expect((await overview(s)).stats.total).toBe(0);
    expect((await overview(s)).users[0].strikes).toBe(1);
  });
  it('keeps uncaptioned media for review and ignores other groups', async () => {
    const s = stub();
    const m = update(1);
    delete m.message!.text;
    m.message!.photo = [{ file_id: 'image' }];
    await send(s, m);
    const other = update(2);
    other.message!.chat.id = -100999999;
    await send(s, other);
    expect((await overview(s)).messages[0].status).toBe('unsupported');
    expect((await overview(s)).stats.total).toBe(1);
  });
  it('pauses classification while retaining messages', async () => {
    const s = stub();
    await configure(s, { mode: 'paused' });
    await send(s, update(1));
    expect((await overview(s)).messages[0].status).toBe('paused');
    expect(calls).toHaveLength(0);
  });
});

describe('worker authorization', () => {
  it('rejects forged webhook requests and acknowledges authenticated ones', async () => {
    const body = JSON.stringify(update(1));
    const unauthorized = await worker.fetch(
      new Request('https://bot.example/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      env,
    );
    expect(unauthorized.status).toBe(401);
    const authorized = await worker.fetch(
      new Request('https://bot.example/telegram/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret',
        },
        body,
      }),
      env,
    );
    expect(authorized.status).toBe(200);
  });
  it('fails closed without Access configuration and restricts development bypass to loopback', async () => {
    expect((await worker.fetch(new Request('https://bot.example/api/overview'), env)).status).toBe(
      503,
    );
    expect((await worker.fetch(new Request('http://127.0.0.1/api/overview'), env)).status).toBe(
      200,
    );
    expect(
      (
        await worker.fetch(new Request('http://127.0.0.1/api/overview'), {
          ...env,
          DEV_MODE: 'false',
        })
      ).status,
    ).toBe(503);
    expect((await worker.fetch(new Request('https://bot.example/health'), env)).status).toBe(200);
  });
  it('blocks cross-origin writes and missing mutation headers', async () => {
    const request = (headers: Record<string, string>) =>
      new Request('http://127.0.0.1/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(defaultSettings),
      });
    expect((await worker.fetch(request({}), env)).status).toBe(403);
    expect(
      (
        await worker.fetch(
          request({ Origin: 'https://evil.invalid', 'X-Watchtower-Request': '1' }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          request({ Origin: 'http://127.0.0.1', 'X-Watchtower-Request': '1' }),
          env,
        )
      ).status,
    ).toBe(200);
  });
  it('verifies Access signatures, issuer, audience, and the sole owner email', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const key = await exportJWK(publicKey);
    key.kid = 'test';
    key.alg = 'RS256';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ keys: [key] })),
    );
    const secureEnv = {
      ...env,
      DEV_MODE: 'false',
      ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
      ACCESS_AUD: 'expected-audience',
      ADMIN_EMAIL: 'owner@example.com',
    } as Env;
    const jwt = (email: string, audience = 'expected-audience') =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(secureEnv.ACCESS_TEAM_DOMAIN)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    const req = (token: string) =>
      new Request('https://bot.example/api/overview', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      });
    expect(await authorize(req(await jwt('owner@example.com')), secureEnv)).toBe(
      'owner@example.com',
    );
    await expect(authorize(req(await jwt('intruder@example.com')), secureEnv)).rejects.toThrow(
      'restricted',
    );
    await expect(
      authorize(req(await jwt('owner@example.com', 'wrong-audience')), secureEnv),
    ).rejects.toThrow('restricted');
    await expect(authorize(req('forged-token'), secureEnv)).rejects.toThrow('restricted');
  });
});

describe('model evaluation jobs', () => {
  it('reads a small evaluation batch using its position index instead of scanning the sample', async () => {
    const s = stub();
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql
        .exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<999)
        INSERT INTO run_examples (run_id,id,position,text,label,user_id,context,media)
        SELECT 'sample',CAST(i AS TEXT),i,'Example',NULL,NULL,'[]','' FROM n`);
      const query =
        'SELECT * FROM run_examples WHERE run_id=? AND position>=? ORDER BY position LIMIT ?';
      const indexed = state.storage.sql.exec(query, 'sample', 800, 20);
      expect(indexed.toArray()).toHaveLength(20);
      expect(indexed.rowsRead).toBeLessThanOrEqual(60);
      state.storage.sql.exec('DROP INDEX run_examples_position');
      const scan = state.storage.sql.exec(query, 'sample', 800, 20);
      expect(scan.toArray()).toHaveLength(20);
      expect(scan.rowsRead).toBeGreaterThan(indexed.rowsRead * 10);
      state.storage.sql.exec('CREATE INDEX run_examples_position ON run_examples(run_id,position)');
    });
  });
  const request = (s: DurableObjectStub, path: string, body: unknown, method = 'POST') =>
    s.fetch(`https://group.internal/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  async function dataset(s: DurableObjectStub) {
    const response = await request(s, '/datasets', {
      name: 'Test corpus',
      data: {
        examples: [
          { id: 'a', text: 'Free scam', label: 'spam' },
          { id: 'b', text: 'Hello world', label: 'ham' },
          { id: 'c', text: 'Question', label: null },
        ],
      },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  it('reports evaluation progress without reloading samples or predictions', async () => {
    const s = stub();
    const id = await dataset(s);
    await request(s, '/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'model' }],
    });
    let status = (await (
      await s.fetch('https://group.internal/api/evaluations/status')
    ).json()) as any[];
    expect(status[0]).toMatchObject({ status: 'queued', cursor: 0, total: 3 });
    expect(status[0]).not.toHaveProperty('examples');
    expect(status[0]).not.toHaveProperty('predictions');
    expect(status[0]).not.toHaveProperty('reviewLabels');
    await tick(s);
    status = (await (
      await s.fetch('https://group.internal/api/evaluations/status')
    ).json()) as any[];
    expect(status[0]).toMatchObject({ status: 'complete', cursor: 3 });
    const index = (await (
      await s.fetch('https://group.internal/api/evaluations/status?snapshots=1')
    ).json()) as any[];
    expect(index[0].snapshot_key).toBe(status[0].id);
    const full = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    const first = (await (
      await s.fetch(`https://group.internal/api/evaluations/${status[0].id}/examples?limit=1`)
    ).json()) as any;
    expect(first).toEqual({ examples: [full[0].examples[0]], nextOffset: 1 });
    const rest = (await (
      await s.fetch(`https://group.internal/api/evaluations/${status[0].id}/examples?offset=1`)
    ).json()) as any;
    expect(rest).toEqual({ examples: full[0].examples.slice(1), nextOffset: null });
    const scores = (await (
      await s.fetch(`https://group.internal/api/evaluations/${status[0].id}/results`)
    ).json()) as any;
    expect(scores.predictions).toEqual(expect.arrayContaining(full[0].predictions));
    expect(scores.reviewLabels).toEqual([]);
    expect(scores.nextOffset).toBeNull();
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(1);
  });
  it('imports more than 10,000 messages idempotently, paginates, and samples the whole corpus', async () => {
    const s = stub(),
      id = crypto.randomUUID(),
      count = 10250;
    expect((await request(s, '/datasets/imports', { id, name: 'Large corpus' })).status).toBe(201);
    expect((await request(s, '/datasets/imports', { id, name: 'Large corpus' })).status).toBe(200);
    const first = {
      sequence: 0,
      examples: Array.from({ length: 250 }, (_, i) => ({
        id: String(i),
        text: 'Message ' + i,
        label: i === 0 ? 'spam' : null,
      })),
    };
    expect((await request(s, `/datasets/${id}/chunks`, first)).status).toBe(200);
    expect((await request(s, `/datasets/${id}/chunks`, first)).status).toBe(200);
    expect(
      (
        await request(s, `/datasets/${id}/chunks`, {
          ...first,
          examples: [{ id: '0', text: 'Different' }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(s, `/datasets/${id}/chunks`, {
          sequence: 2,
          examples: [{ id: 'skip', text: 'Hello' }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(s, `/datasets/${id}/chunks`, {
          sequence: 1,
          examples: [
            { id: 'new', text: 'Hello' },
            { id: '0', text: 'Duplicate' },
          ],
        })
      ).status,
    ).toBe(409);
    expect(await (await s.fetch('https://group.internal/api/datasets')).json()).toEqual([]);
    expect((await s.fetch(`https://group.internal/api/datasets/${id}`)).status).toBe(404);
    expect(
      (
        await request(s, '/evaluations', {
          datasetId: id,
          models: [{ provider: 'openrouter', model: 'model' }],
        })
      ).status,
    ).toBe(404);
    expect((await request(s, `/datasets/${id}/complete`, { count, chunks: 41 })).status).toBe(409);
    for (let offset = 250; offset < count; offset += 250) {
      const examples = Array.from({ length: 250 }, (_, i) => ({
        id: String(offset + i),
        text: 'Message ' + (offset + i),
        label: null,
      }));
      expect(
        (await request(s, `/datasets/${id}/chunks`, { sequence: offset / 250, examples })).status,
      ).toBe(200);
    }
    expect((await request(s, `/datasets/${id}/complete`, { count, chunks: 41 })).status).toBe(200);
    expect((await request(s, `/datasets/${id}/complete`, { count, chunks: 41 })).status).toBe(200);
    const page = (await (
      await s.fetch(`https://group.internal/api/datasets/${id}?offset=10000&limit=25`)
    ).json()) as any;
    expect(page.dataset).toMatchObject({ count, labelled: 1 });
    expect(page.examples).toHaveLength(25);
    expect(page.examples[0].id).toBe('10000');
    expect(page.nextOffset).toBe(10025);
    await request(s, `/datasets/${id}/labels`, [
      { id: '10000', label: 'ham' },
      { id: '10000', label: 'ham' },
    ]);
    const labelled = (await (
      await s.fetch(`https://group.internal/api/datasets/${id}`)
    ).json()) as any;
    expect(labelled.dataset.labelled).toBe(2);
    expect(
      (
        await request(s, '/evaluations', {
          datasetId: id,
          limit: 1000,
          models: [{ provider: 'openrouter', model: 'model' }],
        })
      ).status,
    ).toBe(202);
    const runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs[0].examples).toHaveLength(1000);
    expect(runs[0].examples[999].id).toBe(String(Math.floor((999 * count) / 1000)));
    expect(calls).toHaveLength(0);
  });
  it('cleans up cancelled and abandoned uploads without exposing partial datasets', async () => {
    const s = stub(),
      id = crypto.randomUUID();
    await request(s, '/datasets/imports', { id, name: 'Abandoned' });
    await request(s, `/datasets/${id}/chunks`, {
      sequence: 0,
      examples: [{ id: 'a', text: 'Hi' }],
    });
    await runInDurableObject(s, async (instance: GroupModerator, ctx) => {
      ctx.storage.sql.exec(
        'UPDATE dataset_imports SET updated_at=? WHERE id=?',
        Date.now() - 2 * 86400_000,
        id,
      );
      await instance.cleanup();
      for (const table of [
        'datasets',
        'dataset_stats',
        'dataset_imports',
        'examples',
        'dataset_import_chunks',
      ])
        expect(ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n).toBe(0);
    });
    const other = crypto.randomUUID();
    await request(s, '/datasets/imports', { id: other, name: 'Cancelled' });
    await request(s, `/datasets/${other}/chunks`, {
      sequence: 0,
      examples: [{ id: 'a', text: 'Hi' }],
    });
    expect((await request(s, `/datasets/${other}`, {}, 'DELETE')).status).toBe(200);
    expect((await s.fetch(`https://group.internal/api/datasets/${other}`)).status).toBe(404);
  });
  it('marks unknown token usage as estimated and incomplete cost as unavailable', async () => {
    const s = stub(),
      id = await dataset(s);
    await configure(s, { batchSize: 1 });
    let chunk = 0;
    modelReply = (body) => {
      const messages = JSON.parse(body.messages[1].content).messages;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: messages.map((m: { id: string }) => ({
                  id: m.id,
                  score: 0.2,
                  category: 'ham',
                  reason: 'Valid',
                })),
              }),
            },
          },
        ],
        ...(chunk++ === 0
          ? { usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 } }
          : {}),
      });
    };
    await request(s, '/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'model-a' }],
      limit: 2,
    });
    await tick(s);
    await tick(s);
    const run = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    )[0];
    expect(run.status).toBe('complete');
    expect(run.usage_estimated).toBe(1);
    expect(run.input_tokens).toBeGreaterThan(100);
    expect(run.cost).toBeNull();
  });
  it('evaluates models in durable batches without affecting live strikes', async () => {
    let s = stub();
    await configure(s, { mode: 'enforce', batchSize: 1 });
    const id = await dataset(s);
    const response = await request(s, '/evaluations', {
      datasetId: id,
      models: [
        { provider: 'openrouter', model: 'model-a' },
        { provider: 'openrouter', model: 'model-b' },
      ],
      limit: 3,
    });
    expect(response.status).toBe(202);
    await tick(s);
    const first = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(first.some((r) => r.cursor === 1 && r.status === 'running')).toBe(true);
    await abortAllDurableObjects();
    s = env.GROUPS.get(s.id);
    for (let i = 0; i < 5; i++) await tick(s);
    const runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'complete' && r.predictions.length === 3)).toBe(true);
    expect(runs[0].input_tokens).toBe(300);
    expect(runs[0].output_tokens).toBe(150);
    expect(runs[0].cost).toBeCloseTo(0.00003);
    expect((await overview(s)).users).toHaveLength(0);
    expect(calls.some((c) => c.method === 'deleteMessages' || c.method === 'banChatMember')).toBe(
      false,
    );
  });
  it('snapshots labels and policy so later edits cannot change saved evaluations', async () => {
    const s = stub(),
      id = await dataset(s),
      policy = 'Only fake crypto investment promotions should be flagged as spam.';
    await request(s, '/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'model-a' }],
      policy,
    });
    await request(s, `/datasets/${id}/labels`, [{ id: 'a', label: 'ham' }]);
    await configure(s, { policy: 'A different custom moderation policy for subsequent runs.' });
    await tick(s);
    const run = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    )[0];
    expect(run.examples[0].label).toBe('spam');
    expect(run.policy).toBe(policy);
    expect(calls.find((c) => c.method === 'classify')!.body.messages[0].content).toContain(policy);
    const current = (await (
      await s.fetch(`https://group.internal/api/datasets/${id}`)
    ).json()) as any;
    expect(current.examples[0].label).toBe('ham');
  });
  it('reviews saved scores across models without new calls, preserves snapshots, and updates source labels', async () => {
    const s = stub(),
      id = await dataset(s);
    const { ids } = (await (
      await request(s, '/evaluations', {
        datasetId: id,
        models: [
          { provider: 'openrouter', model: 'gemini' },
          { provider: 'openrouter', model: 'jev' },
        ],
      })
    ).json()) as { ids: string[] };
    await tick(s);
    await tick(s);
    const before = await overview(s),
      callCount = calls.length;
    expect(
      (
        await request(s, `/evaluations/${ids[0]}/reviews`, [
          { id: 'a', label: 'ham' },
          { id: 'c', label: 'spam' },
        ])
      ).status,
    ).toBe(200);
    let runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    for (const r of runs) {
      expect(r.examples.find((e: any) => e.id === 'a').label).toBe('spam');
      expect(r.examples.find((e: any) => e.id === 'c').label).toBeNull();
      expect(r.reviewLabels).toHaveLength(2);
      expect(metrics(reviewedExamples(r), r.predictions, 0.9)).toMatchObject({
        count: 3,
        fp: 2,
        tp: 1,
        precision: 1 / 3,
        recall: 1,
      });
    }
    expect((await (await s.fetch('https://group.internal/api/datasets')).json()) as any).toEqual([
      expect.objectContaining({ labelled: 3 }),
    ]);
    expect(calls).toHaveLength(callCount);
    expect((await overview(s)).stats).toEqual(before.stats);
    await request(s, `/datasets/${id}/labels`, [{ id: 'a', label: 'spam' }]);
    runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs.every((r) => reviewedExamples(r).find((e) => e.id === 'a')!.label === 'spam')).toBe(
      true,
    );
    await request(s, `/evaluations/${ids[0]}/reviews`, [{ id: 'c', label: null }]);
    runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs.every((r) => reviewedExamples(r).find((e) => e.id === 'c')!.label === null)).toBe(
      true,
    );
    expect((await (await s.fetch('https://group.internal/api/datasets')).json()) as any).toEqual([
      expect.objectContaining({ labelled: 2 }),
    ]);
    expect(calls).toHaveLength(callCount);
  });
  it('rejects unknown or duplicate review IDs atomically and does not apply labels to changed snapshot content', async () => {
    const s = stub(),
      id = await dataset(s);
    const { ids } = (await (
      await request(s, '/evaluations', {
        datasetId: id,
        models: [
          { provider: 'openrouter', model: 'a' },
          { provider: 'openrouter', model: 'b' },
        ],
      })
    ).json()) as { ids: string[] };
    await tick(s);
    await tick(s);
    expect(
      (
        await request(s, `/evaluations/${ids[0]}/reviews`, [
          { id: 'a', label: 'ham' },
          { id: 'unknown', label: 'spam' },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await request(s, `/evaluations/${ids[0]}/reviews`, [
          { id: 'a', label: 'ham' },
          { id: 'a', label: 'spam' },
        ])
      ).status,
    ).toBe(400);
    expect(
      (await request(s, '/evaluations/missing/reviews', [{ id: 'a', label: 'ham' }])).status,
    ).toBe(404);
    let runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs.every((r) => r.reviewLabels.length === 0)).toBe(true);
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_examples SET context='[\"changed context\"]' WHERE run_id=? AND id='a'",
        ids[1],
      );
    });
    await request(s, `/evaluations/${ids[0]}/reviews`, [{ id: 'a', label: 'ham' }]);
    runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs.find((r) => r.id === ids[0]).reviewLabels).toHaveLength(1);
    expect(runs.find((r) => r.id === ids[1]).reviewLabels).toHaveLength(0);
  });
  it('retains review labels across restarts and permits review after deleting the source dataset', async () => {
    let s = stub();
    const id = await dataset(s);
    const { ids } = (await (
      await request(s, '/evaluations', {
        datasetId: id,
        models: [{ provider: 'openrouter', model: 'model' }],
      })
    ).json()) as { ids: string[] };
    await tick(s);
    await request(s, `/evaluations/${ids[0]}/reviews`, [{ id: 'b', label: 'spam' }]);
    await request(s, `/datasets/${id}`, undefined, 'DELETE');
    await abortAllDurableObjects();
    s = env.GROUPS.get(s.id);
    let runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs[0].reviewLabels).toEqual([expect.objectContaining({ id: 'b', label: 'spam' })]);
    expect(
      (await request(s, `/evaluations/${ids[0]}/reviews`, [{ id: 'b', label: 'ham' }])).status,
    ).toBe(200);
    runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs[0].examples.find((e: any) => e.id === 'b').label).toBe('ham');
    expect(runs[0].reviewLabels).toEqual([expect.objectContaining({ id: 'b', label: 'ham' })]);
  });
  it('runs Model lab independently of the moderation token budget', async () => {
    const s = stub(),
      id = await dataset(s);
    await configure(s, { dailyTokenBudget: 1000 });
    await request(s, '/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'model-a' }],
    });
    await tick(s);
    const run = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    )[0];
    expect(run.status).toBe('complete');
    expect(run.predictions).toHaveLength(3);
    expect((await overview(s)).stats).toMatchObject({ tokens: 0, labTokens: 150 });
    expect(calls.some((c) => c.method === 'classify')).toBe(true);
  });
  it('accounts for invalid paid output, shrinks the batch, and resumes without accepting partial decisions', async () => {
    const s = stub(),
      id = await dataset(s);
    await request(s, '/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'model-a' }],
    });
    modelReply = () =>
      Response.json({
        id: 'gen-invalid',
        choices: [{ message: { content: '{"results":[]}' } }],
        usage: { prompt_tokens: 321, completion_tokens: 12, cost: 0.002 },
      });
    await tick(s);
    let run = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    )[0];
    expect(run).toMatchObject({
      status: 'running',
      cursor: 0,
      batch_size: 1,
      input_tokens: 321,
      output_tokens: 12,
      provider_request_id: 'gen-invalid',
    });
    expect(run.predictions).toHaveLength(0);
    expect((await overview(s)).stats).toMatchObject({ tokens: 0, labTokens: 333 });
    modelReply = null;
    for (let i = 0; i < 3; i++) await tick(s);
    run = ((await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[])[0];
    expect(run).toMatchObject({
      status: 'complete',
      cursor: 3,
      error: '',
      input_tokens: 621,
      output_tokens: 162,
    });
    expect(run.cost).toBeCloseTo(0.00203);
    expect(run.predictions).toHaveLength(3);
    expect((await overview(s)).stats).toMatchObject({ tokens: 0, labTokens: 783 });
  });
  it('continues comparisons after actor restarts even when the moderation budget is exhausted', async () => {
    let s = stub();
    const id = await dataset(s);
    await configure(s, { batchSize: 1, dailyTokenBudget: 1000 });
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO usage(day,tokens) VALUES (?,1000)',
        new Date().toISOString().slice(0, 10),
      );
    });
    await request(s, '/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'model-a' }],
    });
    await tick(s);
    await tick(s);
    let run = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    )[0];
    expect(run).toMatchObject({
      status: 'running',
      cursor: 2,
      input_tokens: 200,
      output_tokens: 100,
    });
    expect(run.predictions).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(2);
    await abortAllDurableObjects();
    s = env.GROUPS.get(s.id);
    await tick(s);
    run = ((await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[])[0];
    expect(run).toMatchObject({
      status: 'complete',
      cursor: 3,
      input_tokens: 300,
      output_tokens: 150,
    });
    expect(run.predictions).toHaveLength(3);
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(3);
    expect((await overview(s)).stats).toMatchObject({ tokens: 1000, labTokens: 450 });
  });
  it('allows a failed run to resume from its existing cursor and retains unknown-usage reservations', async () => {
    const s = stub(),
      id = await dataset(s);
    await configure(s, { batchSize: 1 });
    const response = await request(s, '/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'model-a' }],
    });
    const { ids } = (await response.json()) as { ids: string[] };
    await tick(s);
    modelReply = () => new Response('provider unavailable', { status: 503 });
    await tick(s);
    let run = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    )[0];
    expect(run).toMatchObject({ status: 'failed', cursor: 1, usage_estimated: 1, cost: null });
    const tokens = run.input_tokens + run.output_tokens;
    expect((await overview(s)).stats).toMatchObject({ tokens: 0, labTokens: tokens });
    expect(tokens).toBeGreaterThan(150);
    modelReply = null;
    expect((await request(s, `/evaluations/${ids[0]}/resume`, {})).status).toBe(202);
    for (let i = 0; i < 2; i++) await tick(s);
    run = ((await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[])[0];
    expect(run.status).toBe('complete');
    expect(run.predictions.map((p: any) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(run.cost).toBeNull();
    expect((await request(s, `/evaluations/${ids[0]}/resume`, {})).status).toBe(409);
  });
  it.each([false, true])(
    'migrates prior shared usage conservatively when live history exists: %s',
    async (hasLiveHistory) => {
      let s = stub();
      await overview(s);
      if (hasLiveHistory) await send(s, update(1));
      await runInDurableObject(s, (_instance, state) => {
        state.storage.sql.exec('ALTER TABLE usage DROP COLUMN lab_tokens');
        state.storage.sql.exec(
          'INSERT INTO usage(day,tokens) VALUES (?,1234)',
          new Date().toISOString().slice(0, 10),
        );
      });
      await abortAllDurableObjects();
      s = env.GROUPS.get(s.id);
      expect((await overview(s)).stats).toMatchObject({
        tokens: hasLiveHistory ? 1234 : 0,
        labTokens: hasLiveHistory ? 0 : 1234,
      });
    },
  );
  it('keeps unknown historical billed usage visible after upgrading legacy failures', async () => {
    let s = stub();
    const id = await dataset(s);
    const { ids } = (await (
      await request(s, '/evaluations', {
        datasetId: id,
        models: [
          { provider: 'openrouter', model: 'legacy-invalid' },
          { provider: 'openrouter', model: 'legacy-budget' },
        ],
      })
    ).json()) as { ids: string[] };
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec('ALTER TABLE evaluations DROP COLUMN usage_incomplete');
      state.storage.sql.exec(
        "UPDATE evaluations SET status='failed',error='Model response must contain exactly one result for each requested message ID.' WHERE id=?",
        ids[0],
      );
      state.storage.sql.exec(
        "UPDATE evaluations SET status='failed',error='Daily token budget reached.' WHERE id=?",
        ids[1],
      );
    });
    await abortAllDurableObjects();
    s = env.GROUPS.get(s.id);
    const runs = (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[];
    expect(runs.find((r) => r.id === ids[0])).toMatchObject({
      usage_incomplete: 1,
      cost_complete: 0,
      cost: null,
    });
    expect(runs.find((r) => r.id === ids[1])).toMatchObject({
      usage_incomplete: 0,
      cost_complete: 1,
    });
    await request(s, `/evaluations/${ids[0]}/resume`, {});
    await tick(s);
    const resumed = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    ).find((r) => r.id === ids[0]);
    expect(resumed).toMatchObject({ status: 'complete', usage_incomplete: 1, cost: null });
  });
  it('supports cancellation and protects owner-only demo data', async () => {
    const s = stub(),
      id = await dataset(s);
    const result = (await (
      await request(s, '/evaluations', {
        datasetId: id,
        models: [{ provider: 'openrouter', model: 'model-a' }],
      })
    ).json()) as { ids: string[] };
    await request(s, `/evaluations/${result.ids[0]}/cancel`, {});
    await tick(s);
    const run = (
      (await (await s.fetch('https://group.internal/api/evaluations')).json()) as any[]
    )[0];
    expect(run.status).toBe('cancelled');
    expect(calls).toHaveLength(0);
    expect((await request(s, '/demo', {})).status).toBe(404);
  });
});

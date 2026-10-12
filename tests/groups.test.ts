import { env } from 'cloudflare:workers';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresDatabase, STORAGE_TABLES } from '../worker/database';
import { initializePostgres } from '../worker/storage';
import { initializeDirectory, GroupDirectory, groupEnv } from '../worker/directory';
import { GroupService } from '../worker/group';
import worker from '../worker/index';
import { runScheduledWork } from '../worker/scheduler';
import { defaultSettings, type Overview } from '../shared/types';
import type { TelegramUpdate } from '../worker/telegram';

describe.skipIf(!env.TEST_POSTGRES_URL)('group onboarding and isolation in Postgres', () => {
  let db: PostgresDatabase, directory: GroupDirectory;
  let botRights: boolean, ownerAdmin: boolean;
  let effects: { method: string; chat: string; file?: string }[];
  const second = '-1009876543210',
    third = '-1009876543211',
    botId = 123;
  beforeEach(async () => {
    expect(new URL(String(env.TEST_POSTGRES_URL)).hostname).toBe('127.0.0.1');
    await initializePostgres(env);
    db = new PostgresDatabase(env);
    await initializeDirectory(db, env);
    await db.transaction(async () => {
      await db.exec(`TRUNCATE ${[...STORAGE_TABLES, 'storage_state', 'work_state'].join(',')}`);
      // Use the test namespace only; all data below is disposable loopback storage.
      await db.exec(`DELETE FROM ${db.table('watchtower_groups')}`);
      for (const id of [second, third])
        for (const table of [...STORAGE_TABLES, 'storage_state', 'work_state'])
          await db.exec(`DROP TABLE IF EXISTS ${db.forGroup(id).table(table)} CASCADE`);
    });
    await initializePostgres(env);
    await initializeDirectory(db, env);
    directory = new GroupDirectory(db, env);
    botRights = true;
    ownerAdmin = true;
    effects = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          body = JSON.parse(String(init?.body || '{}'));
        if (url.startsWith('https://api.telegram.org/')) {
          if (url.includes('/file/'))
            return new Response(new Uint8Array([255, 216, 255, 224, 0, 16]));
          const method = url.split('/').at(-1)!;
          effects.push({
            method,
            chat: String(body.chat_id || ''),
            ...(method === 'getFile' ? { file: body.file_id } : {}),
          });
          if (method === 'getFile')
            return Response.json({
              ok: true,
              result: { file_path: 'photos/test.jpg', file_size: 6 },
            });
          if (method === 'getMe')
            return Response.json({ ok: true, result: { id: botId, username: 'test_bot' } });
          if (method === 'getChat')
            return Response.json({
              ok: true,
              result: { id: Number(body.chat_id), type: 'supergroup', title: 'Second group' },
            });
          if (method === 'getChatAdministrators')
            return Response.json({
              ok: true,
              result: [{ user: { id: Number(env.OWNER_TELEGRAM_ID) } }],
            });
          if (method === 'getChatMember') {
            const result =
              body.user_id === botId
                ? {
                    status: 'administrator',
                    can_delete_messages: botRights,
                    can_restrict_members: botRights,
                  }
                : body.user_id === Number(env.OWNER_TELEGRAM_ID)
                  ? { status: ownerAdmin ? 'administrator' : 'member' }
                  : { status: 'member' };
            return Response.json({ ok: true, result });
          }
          return Response.json({ ok: true, result: true });
        }
        if (url.startsWith('https://openrouter.ai/')) {
          const messages = JSON.parse(body.messages[1].content).messages;
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: messages.map((m: { id: string }) => ({
                      id: m.id,
                      score: 0.99,
                      category: 'promotion',
                      reason: 'Spam',
                    })),
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          });
        }
        throw new Error('Unexpected external request');
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const membership = (
    chatId = second,
    update_id = 1,
    status = 'administrator',
    date = 100,
  ): TelegramUpdate => ({
    update_id,
    my_chat_member: {
      chat: { id: Number(chatId), type: 'supergroup', title: 'Second group' },
      from: { id: Number(env.OWNER_TELEGRAM_ID), first_name: 'Owner' },
      date,
      old_chat_member: { user: { id: botId, first_name: 'Bot', is_bot: true }, status: 'member' },
      new_chat_member: {
        user: { id: botId, first_name: 'Bot', is_bot: true },
        status,
        can_delete_messages: status === 'administrator',
        can_restrict_members: status === 'administrator',
      },
    },
  });
  const message = (chatId: string, id = 1, text = 'Spam'): TelegramUpdate => ({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'supergroup', title: 'Second group' },
      from: { id: 42, first_name: 'Member' },
      text,
    },
  });
  const post = (path: string, body: unknown, chatId?: string) =>
    worker.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Watchtower-Request': '1',
          ...(chatId ? { 'X-Watchtower-Group': chatId } : {}),
          ...(path === '/telegram/webhook'
            ? { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }
            : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
    );
  async function activate(chatId = second, copyFrom?: string) {
    const response = await post(`/api/groups/${chatId}/activate`, copyFrom ? { copyFrom } : {});
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  }
  async function overview(chatId: string) {
    const response = await worker.fetch(
      new Request('http://127.0.0.1/api/overview', { headers: { 'X-Watchtower-Group': chatId } }),
      env,
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as Overview;
  }
  it('detects a group without storing its messages or granting activation to an outsider', async () => {
    expect((await post('/telegram/webhook', membership())).status).toBe(200);
    expect(await directory.get(second)).toMatchObject({
      status: 'pending',
      provisioned: 0,
      can_delete: 1,
      can_ban: 1,
    });
    expect((await post('/telegram/webhook', message(second))).status).toBe(200);
    expect(await db.exec('SELECT * FROM messages')).toEqual([]);
    expect(
      (
        await worker.fetch(
          new Request('http://127.0.0.1/api/overview', {
            headers: { 'X-Watchtower-Group': second },
          }),
          env,
        )
      ).status,
    ).toBe(404);
    ownerAdmin = false;
    expect((await post(`/api/groups/${second}/activate`, {})).status).toBe(403);
    expect((await directory.get(second))?.provisioned).toBe(0);
    expect(
      (
        await worker.fetch(
          new Request(`https://bot.example/api/groups/${second}/activate`, { method: 'POST' }),
          {
            ...env,
            ACCESS_TEAM_DOMAIN: 'https://owner.cloudflareaccess.com',
            ACCESS_AUD: 'owner-audience',
          },
        )
      ).status,
    ).toBe(401);
    const outsider = membership(third);
    outsider.my_chat_member!.from.id = 777;
    expect(await directory.discover(outsider)).toBeNull();
    expect(await directory.get(third)).toBeUndefined();
  });
  it('requires both bot permissions and copies settings into Observe without copying strikes or labels', async () => {
    await directory.discover(membership());
    botRights = false;
    expect((await post(`/api/groups/${second}/activate`, {})).status).toBe(409);
    botRights = true;
    const source = {
      ...defaultSettings,
      mode: 'enforce' as const,
      policy: 'A custom community policy with no copied examples.',
      threshold: 0.95,
      exemptUserIds: ['55'],
    };
    await db.exec('UPDATE config SET value=? WHERE id=1', JSON.stringify(source));
    await db.exec("INSERT INTO users (user_id,name,last_seen,strikes) VALUES ('42','Member',0,2)");
    await activate(second, env.TELEGRAM_CHAT_ID);
    const target = await overview(second);
    expect(target.settings).toEqual({ ...source, mode: 'observe', exemptUserIds: [] });
    expect(target.users).toEqual([]);
    expect(target.stats.total).toBe(0);
    expect((await overview(env.TELEGRAM_CHAT_ID)).settings.mode).toBe('enforce');
    await db
      .forGroup(second)
      .exec('UPDATE config SET value=? WHERE id=1', JSON.stringify({ ...source, mode: 'enforce' }));
    await activate();
    expect((await overview(second)).settings.mode).toBe('enforce');
  });
  it('isolates overlapping Telegram message IDs, users, strikes, effects and lab data', async () => {
    await directory.discover(membership());
    await activate();
    for (const id of [env.TELEGRAM_CHAT_ID, second]) {
      const selected = groupEnv(env, id),
        store = db.forGroup(id);
      await store.exec(
        'UPDATE config SET value=? WHERE id=1',
        JSON.stringify({ ...defaultSettings, mode: 'enforce' }),
      );
      expect((await post('/telegram/webhook', message(id, 1))).status).toBe(200);
      await store.exec('UPDATE messages SET next_at=0');
      await runScheduledWork(selected, 0, store);
    }
    expect((await overview(second)).users[0].strikes).toBe(1);
    expect((await overview(env.TELEGRAM_CHAT_ID)).users[0].strikes).toBe(1);
    expect(effects.filter((e) => e.method === 'deleteMessages').map((e) => e.chat)).toEqual([
      env.TELEGRAM_CHAT_ID,
      second,
    ]);
    const data = [{ id: '1', text: 'Labelled sample', label: 'spam' }];
    const a = await post('/api/datasets', { name: 'Only main', data }, env.TELEGRAM_CHAT_ID);
    const { id } = (await a.json()) as { id: string };
    expect(
      (
        await worker.fetch(
          new Request(`http://127.0.0.1/api/datasets/${id}`, {
            headers: { 'X-Watchtower-Group': second },
          }),
          env,
        )
      ).status,
    ).toBe(404);
    const b = await post('/api/datasets', { name: 'Only second', data }, second);
    expect(b.status).toBe(201);
    const dataset = (await b.json()) as { id: string };
    const created = await post(
      '/api/evaluations',
      {
        datasetId: dataset.id,
        models: [{ provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' }],
        limit: 1,
      },
      second,
    );
    const runs = (await created.json()) as { ids: string[] };
    expect(created.status, JSON.stringify(runs)).toBe(202);
    await runScheduledWork(groupEnv(env, second), 0, db.forGroup(second));
    const target = new GroupService(db.forGroup(second), groupEnv(env, second));
    const index = await target.fetch(
      new Request('https://group.internal/api/evaluations/status?snapshots=1'),
    );
    expect(await index.json()).toMatchObject([{ id: runs.ids[0], status: 'complete', cursor: 1 }]);
    const page = await target.fetch(
      new Request(`https://group.internal/api/evaluations/${runs.ids[0]}/results`),
    );
    expect(await page.json()).toMatchObject({
      predictions: [{ id: '1', score: 0.99 }],
      nextOffset: null,
    });
    expect((await overview(second)).stats.labTokens).toBe(150);
    expect((await overview(env.TELEGRAM_CHAT_ID)).stats.labTokens).toBe(0);
    expect(await db.exec('SELECT * FROM evaluations')).toEqual([]);
    expect(await db.forGroup(second).exec('SELECT * FROM evaluation_labels')).toEqual([]);
    // Retention uses a correlated message/user lookup and must also resolve prefixed tables.
    expect(
      (await target.fetch(new Request('https://group.internal/cleanup', { method: 'POST' })))
        .status,
    ).toBe(200);
  });
  it('pauses removed groups, rejects stale membership events and requires explicit reconnection', async () => {
    await directory.discover(membership());
    await activate();
    await directory.discover(membership(second, 10, 'left', 200));
    expect((await directory.get(second))?.status).toBe('removed');
    expect((await overview(second)).settings.mode).toBe('paused');
    await directory.discover(membership(second, 2, 'administrator', 100));
    expect((await directory.get(second))?.status).toBe('removed');
    expect(
      (await post('/api/settings', { ...defaultSettings, mode: 'enforce' }, second)).status,
    ).toBe(409);
    expect((await post('/telegram/webhook', message(second))).status).toBe(200);
    expect((await overview(second)).stats.total).toBe(0);
    await directory.discover(membership(second, 11, 'administrator', 201));
    expect((await directory.get(second))?.status).toBe('pending');
    await activate();
    expect((await overview(second)).settings.mode).toBe('observe');
  });
  it('supports the owner command fallback and refuses basic groups until upgraded', async () => {
    const command = message(second, 1, '/watchtower');
    command.message!.from!.id = Number(env.OWNER_TELEGRAM_ID);
    expect(await directory.discover(command)).toBeNull();
    expect((await directory.get(second))?.status).toBe('pending');
    const basic = membership('-123456789');
    basic.my_chat_member!.chat.type = 'group';
    await directory.discover(basic);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        if (String(input).endsWith('/getMe'))
          return Response.json({ ok: true, result: { id: botId } });
        if (String(input).endsWith('/getChat'))
          return Response.json({
            ok: true,
            result: { id: Number(body.chat_id), type: 'group', title: 'Basic group' },
          });
        return Response.json({
          ok: true,
          result: {
            status: 'administrator',
            can_delete_messages: true,
            can_restrict_members: true,
          },
        });
      }),
    );
    expect((await post('/api/groups/-123456789/activate', {})).status).toBe(409);
  });
  it('keeps image previews isolated when message IDs overlap across groups', async () => {
    await directory.discover(membership());
    await activate();
    for (const [chatId, file] of [
      [env.TELEGRAM_CHAT_ID, 'primary-image'],
      [second, 'secondary-image'],
    ])
      await db
        .forGroup(chatId)
        .exec(
          "INSERT INTO messages (id,user_id,user_name,text,sent_at,status,telegram_revision,image_file_id) VALUES (1,'42','Member','',1,'unsupported',1,?)",
          file,
        );
    for (const chatId of [second, env.TELEGRAM_CHAT_ID]) {
      const r = await worker.fetch(
        new Request(`http://127.0.0.1/api/messages/1/image?group=${chatId}`),
        env,
      );
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    expect(effects.filter((e) => e.method === 'getFile').map((e) => e.file)).toEqual([
      'secondary-image',
      'primary-image',
    ]);
    const unknown = await worker.fetch(
      new Request('http://127.0.0.1/api/messages/1/image?group=-1005555555555'),
      env,
    );
    expect(unknown.status).toBe(404);
    expect(effects.filter((e) => e.method === 'getFile')).toHaveLength(2);
  });
  it('authenticates internal work and dispatches each active group separately while excluding pending groups', async () => {
    await directory.discover(membership());
    await activate();
    await directory.discover(membership(third));
    expect((await post('/internal/work', { chatId: second })).status).toBe(401);
    const authorized = await worker.fetch(
      new Request('https://worker.example/internal/work', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Watchtower-Work-Secret': 'test-webhook-secret',
        },
        body: JSON.stringify({ chatId: second }),
      }),
      env,
    );
    expect(authorized.status, await authorized.text()).toBe(200);
    const dispatched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://worker.example/internal/work');
        expect(init?.redirect).toBe('manual');
        expect((init?.headers as Record<string, string>)['X-Watchtower-Work-Secret']).toBe(
          'test-webhook-secret',
        );
        dispatched.push(JSON.parse(String(init?.body)).chatId);
        expect(JSON.parse(String(init?.body)).dispatch).toBeUndefined();
        return Response.json({ ok: true });
      }),
    );
    const retried = await worker.fetch(
      new Request('https://worker.example/internal/work', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Watchtower-Work-Secret': 'test-webhook-secret',
        },
        body: JSON.stringify({ chatId: second, dispatch: true }),
      }),
      { ...env, WORKER_URL: 'https://worker.example' },
    );
    expect(retried.status, await retried.text()).toBe(200);
    expect(dispatched).toEqual([second]);
    dispatched.length = 0;
    await worker.scheduled({ cron: '* * * * *' } as ScheduledController, {
      ...env,
      WORKER_URL: 'https://worker.example',
    });
    expect(new Set(dispatched)).toEqual(new Set([env.TELEGRAM_CHAT_ID, second]));
  });
});

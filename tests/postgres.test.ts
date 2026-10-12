import { env } from 'cloudflare:workers';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  type Evaluation,
  type EvaluationIndex,
  type EvaluationPage,
  type Overview,
} from '../shared/types';
import { PostgresDatabase, STORAGE_TABLES } from '../worker/database';
import {
  initializePostgres,
  initialMigration,
  discardLegacyHistory,
  migrationState,
  writeMigration,
} from '../worker/storage';
import { GroupService } from '../worker/group';
import { LostWorkLeaseError } from '../worker/database';
import { runScheduledWork } from '../worker/scheduler';
import productionWorker from '../worker/index';
import type { TelegramUpdate } from '../worker/telegram';
import { initializeDirectory } from '../worker/directory';

// Explicitly opt in to a disposable local Postgres database, never the production secret.
describe.skipIf(!env.TEST_POSTGRES_URL)('Postgres backend in Workers runtime', () => {
  let db: PostgresDatabase;
  let calls: { method: string; body: any }[];
  let admins: number[];
  beforeEach(async () => {
    expect(new URL(String(env.TEST_POSTGRES_URL)).hostname).toBe('127.0.0.1');
    await initializePostgres(env, true);
    db = new PostgresDatabase(env);
    await initializeDirectory(db, env);
    await db.transaction(async () => {
      await db.exec(
        `TRUNCATE ${[...STORAGE_TABLES, 'storage_state', 'work_state'].join(',')} RESTART IDENTITY`,
      );
      await db.exec('INSERT INTO work_state (id) VALUES (1)');
      await db.exec('INSERT INTO config (id,value) VALUES (1,?)', JSON.stringify(defaultSettings));
      await db.exec(
        'INSERT INTO storage_state (id,value) VALUES (1,?)',
        JSON.stringify({ ...initialMigration(), ready: true, status: 'complete' }),
      );
    });
    await db.exec(`DELETE FROM ${db.table('watchtower_groups')}`);
    await initializeDirectory(db, env);
    calls = [];
    admins = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          body = JSON.parse(String(init?.body || '{}'));
        if (url.startsWith('https://api.telegram.org/')) {
          if (url.includes('/file/'))
            return new Response(new Uint8Array([255, 216, 255, 224, 0, 16]));
          const method = url.split('/').at(-1)!;
          calls.push({ method, body });
          if (method === 'getFile')
            return Response.json({
              ok: true,
              result: { file_path: 'photos/test.jpg', file_size: 6 },
            });
          if (method === 'getChatAdministrators')
            return Response.json({ ok: true, result: admins.map((id) => ({ user: { id } })) });
          if (method === 'getChatMember')
            return Response.json({ ok: true, result: { status: 'member' } });
          return Response.json({ ok: true, result: true });
        }
        if (url.startsWith('https://openrouter.ai/')) {
          if (url.endsWith('/endpoints'))
            return Response.json({ data: { architecture: { input_modalities: ['image'] } } });
          calls.push({ method: 'classify', body });
          const content = body.messages[1].content;
          const messages = JSON.parse(Array.isArray(content) ? content[0].text : content).messages;
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: messages.map((m: { id: string }) => ({
                      id: m.id,
                      score: 0.99,
                      category: 'spam',
                      reason: 'Promotion',
                    })),
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.00001 },
          });
        }
        throw new Error('Unexpected external request');
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
  });
  const stub = () => new GroupService(new PostgresDatabase(env), env);
  function update(id: number, user = 42): TelegramUpdate {
    return {
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(env.TELEGRAM_CHAT_ID), type: 'supergroup' },
        from: { id: user, first_name: 'Test' },
        text: 'Buy fake signals',
      },
    };
  }
  async function request(s: GroupService, path: string, body?: unknown, method = 'POST') {
    return s.fetch(
      new Request(`https://group.internal${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function get<T>(s: GroupService, path: string) {
    const response = await request(s, path, undefined, 'GET');
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as T;
  }
  async function tick() {
    await db.exec("UPDATE messages SET next_at=0 WHERE status='pending' AND reason=''");
    await runScheduledWork(env, 0);
  }
  async function enforce(s: GroupService) {
    const response = await request(
      s,
      '/api/settings',
      { ...defaultSettings, mode: 'enforce', batchSeconds: 1 },
      'PUT',
    );
    expect(response.status, await response.text()).toBe(200);
  }
  it('persists three strikes, outbox actions, duplicate protection and numeric stats', async () => {
    const s = stub();
    await enforce(s);
    const response = await request(s, '/ingest', update(1));
    expect(response.status, await response.text()).toBe(200);
    await request(s, '/ingest', update(1));
    await tick();
    await request(s, '/ingest', update(2));
    await tick();
    await request(s, '/ingest', update(3));
    await tick();
    const overview = await get<Overview>(s, '/api/overview');
    expect(overview.users[0]).toMatchObject({ user_id: '42', strikes: 3, banned: 1 });
    expect(overview.stats).toMatchObject({ total: 3, spam: 3, deleted: 3, tokens: 450, banned: 1 });
    expect(overview.storage).toMatchObject({ backend: 'planetscale', ready: true });
    expect(calls.filter((c) => c.method === 'banChatMember')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(3);
    const feed = await get<{ total: number }>(s, '/api/messages?search=signals');
    expect(feed.total).toBe(3);
  });
  it('preserves image metadata, classifications, settings and strikes when schema setup is rerun', async () => {
    const s = stub();
    await enforce(s);
    const photo = update(1);
    delete photo.message!.text;
    photo.message!.photo = [{ file_id: 'postgres-image', width: 640, height: 640 }];
    await request(s, '/ingest', photo);
    await request(s, '/ingest', photo);
    await tick();
    const before = await get<Overview>(s, '/api/overview');
    expect(before.messages[0]).toMatchObject({
      status: 'spam',
      image_file_id: 'postgres-image',
      strike_awarded: 1,
      model: 'openrouter:google/gemini-2.5-flash-lite',
    });
    expect(before.users[0].strikes).toBe(1);
    await initializePostgres(env, true);
    const after = await get<Overview>(stub(), '/api/overview');
    expect(after.settings).toEqual(before.settings);
    expect(after.messages).toEqual(before.messages);
    expect(after.users).toEqual(before.users);
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(1);
    await db.exec(
      "INSERT INTO messages (id,user_id,user_name,text,sent_at,status,telegram_revision,image_file_id) VALUES (2,'42','Member','',1,'unsupported',1,'unavailable-image')",
    );
    const review = await get<{ total: number; messages: { id: number; status: string }[] }>(
      s,
      '/api/messages?status=review',
    );
    expect(review.total).toBe(1);
    expect(review.messages[0]).toMatchObject({ id: 2, status: 'unsupported' });
  });
  it('does not send owner or administrator messages to models', async () => {
    const s = stub();
    await enforce(s);
    admins = [42];
    await request(s, '/ingest', update(1));
    await request(s, '/ingest', update(2, Number(env.OWNER_TELEGRAM_ID)));
    await tick();
    expect(calls.some((c) => c.method === 'classify')).toBe(false);
    expect((await get<Overview>(s, '/api/overview')).stats.spam).toBe(0);
  });
  it('rolls back failed transactions and isolates overlapping request sessions', async () => {
    await expect(
      db.transaction(async () => {
        await db.exec('INSERT INTO updates (id,received_at) VALUES (1,0)');
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await db.exec('SELECT * FROM updates')).toEqual([]);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        db.transaction(async () => {
          const row = (await db.exec<{ value: string }>('SELECT value FROM config WHERE id=1'))[0];
          const value = JSON.parse(row.value);
          value.dailyTokenBudget++;
          await db.exec('UPDATE config SET value=? WHERE id=1', JSON.stringify(value));
        }),
      ),
    );
    expect(
      JSON.parse((await db.exec<{ value: string }>('SELECT value FROM config WHERE id=1'))[0].value)
        .dailyTokenBudget,
    ).toBe(defaultSettings.dailyTokenBudget + 12);
  });
  it('returns retryable errors without leaking database credentials or touching Cloudflare SQL', async () => {
    const disconnected = new GroupService(
      new PostgresDatabase({
        ...env,
        PLANETSCALE_DATABASE_URL:
          'postgresql://private-user:private-password@127.0.0.1:1/unavailable',
      }),
      env,
    );
    const response = await disconnected.fetch(new Request('https://group.internal/api/overview'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    const body = await response.text();
    expect(body).toContain('PlanetScale is temporarily unavailable');
    expect(body).not.toMatch(/private-user|private-password|127\.0\.0\.1/);
  });
  it('imports idempotent chunks, scores lab runs and updates review metrics without a new model call', async () => {
    const s = stub(),
      id = crypto.randomUUID();
    expect((await request(s, '/api/datasets/imports', { id, name: 'Lab' })).status).toBe(201);
    const examples = [
      { id: 'a', text: 'Buy signals', label: null },
      { id: 'b', text: 'Hi', label: null },
    ];
    const batch = { sequence: 0, examples };
    expect((await request(s, `/api/datasets/${id}/chunks`, batch)).status).toBe(200);
    expect((await request(s, `/api/datasets/${id}/chunks`, batch)).status).toBe(200);
    expect((await request(s, `/api/datasets/${id}/complete`, { count: 2, chunks: 1 })).status).toBe(
      200,
    );
    const response = await request(s, '/api/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' }],
      limit: 2,
    });
    const body = (await response.json()) as { ids: string[] };
    expect(response.status, JSON.stringify(body)).toBe(202);
    await tick();
    const runs = await get<Evaluation[]>(s, '/api/evaluations');
    expect(runs[0]).toMatchObject({
      status: 'complete',
      cursor: 2,
      input_tokens: 100,
      output_tokens: 50,
      cost: 0.00001,
    });
    const reviewed = await request(s, `/api/evaluations/${body.ids[0]}/reviews`, [
      { id: 'a', label: 'spam' },
      { id: 'b', label: 'ham' },
    ]);
    expect(reviewed.status, await reviewed.text()).toBe(200);
    expect((await get<Overview>(s, '/api/overview')).stats).toMatchObject({
      tokens: 0,
      labTokens: 150,
    });
    expect((await get<Evaluation[]>(s, '/api/evaluations'))[0].reviewLabels).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(1);
  });
  it('assembles saved-run JSON in Postgres while preserving order, snapshots and matching review labels', async () => {
    const s = stub();
    expect(await get(s, '/api/evaluations')).toEqual([]);
    const text = 'हैलो 👋 "quoted"\nA reply',
      context = JSON.stringify(['Earlier message']);
    await db.transaction(async () => {
      for (const [id, at] of [
        ['old', 100],
        ['new', 200],
      ] as const) {
        await db.exec(
          'INSERT INTO evaluations (id,dataset_id,dataset_name,provider,model,policy,status,total,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          id,
          'dataset',
          'Corpus',
          'openrouter',
          'model',
          'Policy',
          'complete',
          2,
          at,
        );
        await db.exec(
          'INSERT INTO run_examples (run_id,id,position,text,label,user_id,context,media) VALUES (?,?,?,?,?,?,?,?)',
          id,
          'z',
          0,
          text,
          'spam',
          null,
          id === 'old' ? context : '[]',
          'photo',
        );
        await db.exec(
          'INSERT INTO run_examples (run_id,id,position,text,label,user_id,context,media) VALUES (?,?,?,?,?,?,?,?)',
          id,
          'a',
          1,
          'Hello',
          null,
          '42',
          '[]',
          '',
        );
        await db.exec(
          'INSERT INTO predictions (run_id,id,score,category,reason) VALUES (?,?,?,?,?)',
          id,
          'z',
          0.93,
          'promotion',
          'Saved reason',
        );
      }
      await db.exec(
        'INSERT INTO evaluation_labels (dataset_id,id,text,context,media,label,updated_at) VALUES (?,?,?,?,?,?,?)',
        'dataset',
        'z',
        text,
        context,
        'photo',
        null,
        300,
      );
    });
    const response = await s.fetch(new Request('https://group.internal/api/evaluations'));
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const runs = (await response.json()) as Evaluation[];
    expect(runs.map((r) => r.id)).toEqual(['new', 'old']);
    expect(runs[1].examples).toEqual([
      {
        id: 'z',
        text,
        label: 'spam',
        userId: null,
        context: ['Earlier message'],
        media: 'photo',
        family: '',
      },
      { id: 'a', text: 'Hello', label: null, userId: '42', context: [], media: '', family: '' },
    ]);
    expect(runs[1].predictions).toEqual([
      { id: 'z', score: 0.93, category: 'promotion', reason: 'Saved reason', needs_review: false },
    ]);
    expect(runs[1].reviewLabels).toEqual([{ id: 'z', label: null, updated_at: 300 }]);
    expect(runs[0].reviewLabels).toEqual([]);
    expect(runs[1].total).toBe(2);
    const index = await get<EvaluationIndex[]>(s, '/api/evaluations/status?snapshots=1');
    expect(index.map((r) => r.id)).toEqual(['new', 'old']);
    expect(index[0]).not.toHaveProperty('examples');
    expect(index[0].snapshot_key).not.toBe(index[1].snapshot_key);
    const examplePage = await get<EvaluationPage>(s, '/api/evaluations/old/examples?limit=1');
    expect(examplePage).toEqual({ examples: [runs[1].examples[0]], nextOffset: 1 });
    expect(await get(s, '/api/evaluations/old/examples?offset=1')).toEqual({
      examples: [runs[1].examples[1]],
      nextOffset: null,
    });
    expect(await get(s, '/api/evaluations/old/results?limit=1')).toEqual({
      predictions: runs[1].predictions,
      reviewLabels: runs[1].reviewLabels,
      nextOffset: 1,
    });
    expect(await get(s, '/api/evaluations/old/results?offset=1')).toEqual({
      predictions: [],
      reviewLabels: [],
      nextOffset: null,
    });
    expect(await get(s, '/api/evaluations/new/results')).toEqual({
      predictions: runs[0].predictions,
      reviewLabels: [],
      nextOffset: null,
    });
    await db.exec('UPDATE run_examples SET context=? WHERE run_id=? AND id=?', context, 'new', 'z');
    const identical = await get<EvaluationIndex[]>(s, '/api/evaluations/status?snapshots=1');
    expect(identical[0].snapshot_key).toBe(identical[1].snapshot_key);
    expect((await request(s, '/api/evaluations/absent/examples', undefined, 'GET')).status).toBe(
      404,
    );
    expect(await get(s, '/api/evaluations/old/examples?offset=99')).toEqual({
      examples: [],
      nextOffset: null,
    });
    await writeMigration(db, { ...initialMigration(), sourceRunIds: ['old'] });
    expect((await get<Evaluation[]>(s, '/api/evaluations')).map((r) => r.id)).toEqual(['new']);
    expect(
      (await get<EvaluationIndex[]>(s, '/api/evaluations/status?snapshots=1')).map((r) => r.id),
    ).toEqual(['new']);
    expect((await request(s, '/api/evaluations/old/examples', undefined, 'GET')).status).toBe(409);
    expect(calls).toEqual([]);
  });
  it('bounds pages by UTF-8 bytes without truncating or losing oversized messages', async () => {
    const s = stub();
    const texts = ['👋'.repeat(4000), 'ह'.repeat(9000), 'Last message'];
    await db.transaction(async () => {
      await db.exec(`INSERT INTO evaluations (id,dataset_id,dataset_name,provider,model,policy,status,total,created_at)
        VALUES ('large','dataset','Corpus','openrouter','model','Policy','complete',3,1)`);
      for (const [position, text] of texts.entries())
        await db.exec(
          `INSERT INTO run_examples (run_id,id,position,text,context,media)
          VALUES ('large',?,?,?,'[]','')`,
          String(position),
          position,
          text,
        );
    });
    const pages: EvaluationPage[] = [];
    let offset = 0;
    do {
      const page = await get<EvaluationPage>(
        s,
        `/api/evaluations/large/examples?offset=${offset}&limit=100`,
      );
      pages.push(page);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    } while (pages.length < 4);
    expect(pages).toHaveLength(3);
    expect(pages.flatMap((p) => p.examples || []).map((e) => e.text)).toEqual(texts);
    expect(pages.map((p) => p.nextOffset)).toEqual([1, 2, null]);
    expect(
      (await request(s, '/api/evaluations/large/examples?limit=101', undefined, 'GET')).status,
    ).toBe(400);
  });
  it('keeps cancellation authoritative when a stateless provider request is in flight', async () => {
    const s = stub();
    const imported = await request(s, '/api/datasets', {
      name: 'Cancellation',
      data: [{ id: 'a', text: 'Sample message' }],
    });
    const { id } = (await imported.json()) as { id: string };
    const created = await request(s, '/api/evaluations', {
      datasetId: id,
      models: [{ provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' }],
    });
    const { ids } = (await created.json()) as { ids: string[] };
    const original = globalThis.fetch;
    let release!: () => void, started!: () => void;
    const began = new Promise<void>((r) => (started = r)),
      waiting = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith('https://openrouter.ai/')) {
          started();
          await waiting;
        }
        return original(input, init);
      }),
    );
    const pending = runScheduledWork(env, 0);
    await began;
    try {
      expect((await request(stub(), `/api/evaluations/${ids[0]}/cancel`)).status).toBe(200);
    } finally {
      release();
      await pending;
    }
    const run = (await get<Evaluation[]>(stub(), '/api/evaluations'))[0];
    expect(run).toMatchObject({
      status: 'cancelled',
      cursor: 0,
      predictions: [],
      input_tokens: 100,
      output_tokens: 50,
    });
  });
  it('stores dataset imports larger than one Postgres insert batch in the original order', async () => {
    const s = stub();
    const examples = Array.from({ length: 501 }, (_, i) => ({
      id: String(i),
      text: `Sample ${i}`,
      label: i % 2 ? 'ham' : 'spam',
    }));
    const response = await request(s, '/api/datasets', { name: 'Bulk', data: examples });
    const dataset = (await response.json()) as { id: string };
    expect(response.status, JSON.stringify(dataset)).toBe(201);
    const last = await get<{
      examples: { id: string }[];
      dataset: { count: number; labelled: number };
    }>(s, `/api/datasets/${dataset.id}?offset=499&limit=10`);
    expect(last.examples.map((e) => e.id)).toEqual(['499', '500']);
    expect(last.dataset).toMatchObject({ count: 501, labelled: 501 });
    expect(calls.some((c) => c.method === 'classify')).toBe(false);
  });
  it('abandons an untouched source copy without resetting Postgres settings, labels, runs or usage', async () => {
    const s = stub();
    await enforce(s);
    const response = await request(s, '/api/datasets', {
      name: 'Keep this',
      data: [{ id: 'a', text: 'Existing labelled sample', label: 'spam' }],
    });
    const dataset = (await response.json()) as { id: string };
    const created = await request(s, '/api/evaluations', {
      datasetId: dataset.id,
      models: [{ provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' }],
      limit: 1,
    });
    expect(created.status).toBe(202);
    await tick();
    await writeMigration(db, initialMigration());
    expect((await request(stub(), '/ingest', update(1))).status).toBe(503);
    const preserved = await Promise.all(
      ['config', 'examples', 'evaluations', 'predictions', 'usage'].map((t) =>
        db.exec(`SELECT * FROM ${t}`),
      ),
    );
    const state = await discardLegacyHistory(db);
    expect(state).toMatchObject({ ready: true, status: 'cancelled', tables: [], error: '' });
    expect(state.nextAttemptAt).toBeUndefined();
    expect(
      await Promise.all(
        ['config', 'examples', 'evaluations', 'predictions', 'usage'].map((t) =>
          db.exec(`SELECT * FROM ${t}`),
        ),
      ),
    ).toEqual(preserved);
    expect(await discardLegacyHistory(db)).toEqual(state);
    expect(
      (await request(stub(), '/api/settings', { ...defaultSettings, mode: 'observe' }, 'PUT'))
        .status,
    ).toBe(200);
    expect((await request(stub(), '/ingest', update(2))).status).toBe(200);
    expect((await request(stub(), '/api/storage/migrate')).status).toBe(404);
  });
  it('refuses to discard a partially copied ledger', async () => {
    const state = {
      ...initialMigration(),
      status: 'copying' as const,
      tables: [{ table: 'users', count: 2, copied: 1 }],
    };
    await writeMigration(db, state);
    await expect(discardLegacyHistory(db)).rejects.toThrow('Some legacy rows');
    expect(await migrationState(db)).toEqual(state);
  });
  it('excludes overlapping cron ticks while HTTP ingestion and labels remain independent', async () => {
    const s = stub();
    await enforce(s);
    await request(s, '/ingest', update(1));
    await db.exec('UPDATE messages SET next_at=0');
    const original = globalThis.fetch;
    let release!: () => void, started!: () => void;
    const providerStarted = new Promise<void>((r) => (started = r)),
      wait = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith('https://openrouter.ai/')) {
          started();
          await wait;
        }
        return original(input, init);
      }),
    );
    const first = runScheduledWork(env, 0);
    await providerStarted;
    try {
      expect(await runScheduledWork(env, 0)).toBe(false);
      expect((await request(stub(), '/ingest', update(2))).status).toBe(200);
    } finally {
      release();
      await first;
    }
    await tick();
    expect((await get<Overview>(stub(), '/api/overview')).users[0].strikes).toBe(2);
    expect(calls.filter((c) => c.method === 'classify')).toHaveLength(2);
  });
  it('fences an expired worker, recovers its work and cannot release a replacement lease', async () => {
    const first = new PostgresDatabase(env),
      second = new PostgresDatabase(env);
    const owner = await first.withWorkLease(async () => {
      await db.exec('UPDATE work_state SET expires_at=0 WHERE id=1');
      const replaced = await second.withWorkLease(async () => {
        await expect(
          first.exec('INSERT INTO updates (id,received_at) VALUES (88,0)'),
        ).rejects.toBeInstanceOf(LostWorkLeaseError);
        await expect(first.assertWorkLease()).rejects.toBeInstanceOf(LostWorkLeaseError);
        await second.exec('INSERT INTO updates (id,received_at) VALUES (89,0)');
      });
      expect(replaced).toBe(true);
    });
    expect(owner).toBe(true);
    expect(await db.exec('SELECT id FROM updates')).toEqual([{ id: 89 }]);
    // Release from an old owner does not clear another owner.
    await first.withWorkLease(async () => {
      await db.exec("UPDATE work_state SET owner='replacement' WHERE id=1");
    });
    expect((await db.exec<{ owner: string }>('SELECT owner FROM work_state'))[0].owner).toBe(
      'replacement',
    );
  });
  it('honors collection delays and processes persisted work from the stateless scheduled handler', async () => {
    const s = stub();
    await request(s, '/ingest', update(1));
    await productionWorker.scheduled({ cron: '* * * * *' } as ScheduledController, env);
    expect(calls.some((c) => c.method === 'classify')).toBe(false);
    await db.exec('UPDATE messages SET next_at=0');
    await productionWorker.scheduled({ cron: '* * * * *' } as ScheduledController, env);
    expect((await get<Overview>(stub(), '/api/overview')).messages[0].status).toBe('observed_spam');
    expect(
      (await db.exec<{ last_run_at: number }>('SELECT last_run_at FROM work_state'))[0].last_run_at,
    ).toBeGreaterThan(0);
    expect(
      (await productionWorker.fetch(new Request('http://127.0.0.1/api/overview'), env)).status,
    ).toBe(200);
  });
});

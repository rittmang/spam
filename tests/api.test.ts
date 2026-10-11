import { afterEach, expect, it, vi } from 'vitest';
import { api, apiForGroup, ApiError, retryApi, setApiGroup } from '../src/api';
import { databaseQuotaResponse } from '../worker/http';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setApiGroup('');
});

it('keeps retries routed to the original group after a workspace switch', async () => {
  vi.useFakeTimers();
  setApiGroup('-100111');
  const fetch = vi
    .fn()
    .mockImplementationOnce(async () => {
      setApiGroup('-100222');
      return new Response('Unavailable', { status: 503 });
    })
    .mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  const check = expect(api('/messages')).resolves.toEqual({ ok: true });
  await vi.runAllTimersAsync();
  await check;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    fetch.mock.calls.map(([, init]) => new Headers(init.headers).get('X-Watchtower-Group')),
  ).toEqual(['-100111', '-100111']);
  await api('/messages');
  expect(new Headers(fetch.mock.lastCall?.[1].headers).get('X-Watchtower-Group')).toBe('-100222');
});

it('keeps group management requests global rather than attaching the selected workspace', async () => {
  setApiGroup('-100111');
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ groups: [] }),
  );
  vi.stubGlobal('fetch', fetch);
  await api('/groups');
  await api('/groups/-100222/activate', { method: 'POST', body: '{}' });
  expect(
    fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has('X-Watchtower-Group')),
  ).toBe(true);
});

it('keeps successive pages and mutations scoped to a workspace after it is unmounted', async () => {
  const oldWorkspace = apiForGroup('-100111');
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  vi.stubGlobal('fetch', fetch);
  await oldWorkspace('/export');
  setApiGroup('-100222');
  await oldWorkspace('/export?before=20');
  await oldWorkspace.retry('/datasets/id/append', { method: 'POST', body: '{}' });
  expect(
    fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-Watchtower-Group')),
  ).toEqual(['-100111', '-100111', '-100111']);
});

it('recovers a transient read failure without making the caller discard loaded data', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('<h1>Error 1102: Worker exceeded resource limits</h1>', { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json([{ id: 'saved-run' }]));
  vi.stubGlobal('fetch', fetch);
  const check = expect(api('/evaluations')).resolves.toEqual([{ id: 'saved-run' }]);
  await vi.runAllTimersAsync();
  await check;
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not replay a mutation when its response is lost to a Worker CPU error', async () => {
  const fetch = vi.fn(
    async () => new Response('Error 1102: Worker exceeded CPU time limit.', { status: 503 }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(api('/evaluations', { method: 'POST', body: '{}' })).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining('CPU limit'),
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('stops read retries after cancellation', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    controller.abort();
    return new Response('Unavailable', { status: 503 });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(api('/datasets', { signal: controller.signal })).rejects.toBeInstanceOf(ApiError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('recognizes legacy quota errors and avoids immediate upload retries', async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      { error: 'Exceeded allowed rows read in Durable Objects free tier.' },
      { status: 400 },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(retryApi('/datasets', { method: 'POST' })).rejects.toMatchObject({
    retryAfterMs: 300_000,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves quota retry delays and returns the reason to the dashboard', async () => {
  const response = databaseQuotaResponse(
    new Error('Exceeded allowed rows written in Durable Objects free tier.'),
  )!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  try {
    await api('/overview');
    throw new Error('Expected quota failure');
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 503, retryAfterMs: 300_000 });
    expect((e as Error).message).toContain('moderation are unavailable');
  }
  expect(databaseQuotaResponse(new Error('Different database error'))).toBeNull();
});

import { afterEach, expect, it, vi } from 'vitest';
import { EvaluationReader } from '../src/evaluation-load';
import type { EvaluationIndex, Example } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());
const index = (id: string, snapshot_key = 'shared'): EvaluationIndex => ({
  id,
  snapshot_key,
  dataset_id: 'corpus',
  dataset_name: 'Corpus',
  provider: 'openrouter',
  model: id,
  status: 'complete',
  cursor: 2,
  batch_size: 10,
  provider_request_id: null,
  total: 2,
  input_tokens: 20,
  output_tokens: 10,
  usage_estimated: 0,
  usage_incomplete: 0,
  latency_ms: 100,
  cost: 0.01,
  error: '',
  created_at: id === 'new' ? 2 : 1,
  policy: 'Policy',
});
const example = (id: string): Example => ({ id, text: id, label: null, context: [], media: '' });

it('shares immutable paged snapshots but refreshes model scores and human labels', async () => {
  let label: 'spam' | 'ham' = 'spam';
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      paths.push(input);
      const url = new URL(input, 'https://test');
      if (url.pathname.endsWith('/status')) return Response.json([index('new'), index('old')]);
      if (url.pathname.endsWith('/examples'))
        return Response.json({
          examples: [example(url.searchParams.get('offset') === '0' ? 'a' : 'b')],
          nextOffset: url.searchParams.get('offset') === '0' ? 1 : null,
        });
      return Response.json({
        predictions: [
          { id: 'a', score: label === 'spam' ? 0.9 : 0.1, category: 'promotion', reason: 'Reason' },
        ],
        reviewLabels: [{ id: 'a', label, updated_at: 2 }],
        nextOffset: null,
      });
    }),
  );
  const reader = new EvaluationReader();
  const loaded: string[] = [];
  const first = await reader.load((run) => loaded.push(run.id));
  expect(first.map((run) => run.id)).toEqual(['new', 'old']);
  expect(new Set(loaded)).toEqual(new Set(['new', 'old']));
  expect(first[0].examples).toEqual([example('a'), example('b')]);
  expect(first[1].examples).toBe(first[0].examples);
  expect(paths.filter((path) => path.includes('/examples'))).toHaveLength(2);
  label = 'ham';
  const second = await reader.load();
  expect(paths.filter((path) => path.includes('/examples'))).toHaveLength(2);
  expect(paths.filter((path) => path.includes('/results'))).toHaveLength(4);
  expect(second[0].reviewLabels?.[0].label).toBe('ham');
  expect(second[0].predictions[0].score).toBe(0.1);
  expect(second[0].examples[0].label).toBeNull();
});

it('does not reuse snapshots when their original content changes', async () => {
  let revision = 'one';
  const fetch = vi.fn(async (input: string) => {
    if (input.includes('/status')) return Response.json([index('new', revision)]);
    if (input.includes('/examples'))
      return Response.json({ examples: [example(revision)], nextOffset: null });
    return Response.json({ predictions: [], reviewLabels: [], nextOffset: null });
  });
  vi.stubGlobal('fetch', fetch);
  const reader = new EvaluationReader();
  expect((await reader.load())[0].examples[0].id).toBe('one');
  revision = 'two';
  expect((await reader.load())[0].examples[0].id).toBe('two');
  expect(fetch.mock.calls.filter(([path]) => path.includes('/examples'))).toHaveLength(2);
});

it('rejects a stalled cursor and permits a fresh snapshot request after failure', async () => {
  let stalled = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.includes('/status')) return Response.json([index('new')]);
      if (input.includes('/examples'))
        return Response.json({ examples: [example('a')], nextOffset: stalled ? 0 : null });
      return Response.json({ predictions: [], nextOffset: null });
    }),
  );
  const reader = new EvaluationReader();
  await expect(reader.load()).rejects.toThrow('could not advance');
  stalled = false;
  expect((await reader.load())[0].examples).toEqual([example('a')]);
});

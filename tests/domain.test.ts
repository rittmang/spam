import { describe, expect, it, vi, afterEach } from 'vitest';
import { metrics } from '../shared/metrics';
import { defaultSettings, settingsSchema } from '../shared/types';
import { importExamples } from '../worker/import';
import {
  classify,
  requestPayload,
  validatePredictions,
  providers,
  publicProviders,
  fitExamples,
  estimateTokens,
  ClassificationError,
  modelProvider,
} from '../worker/classifier';
import { messageText, updateSchema } from '../worker/telegram';
import type { Env } from '../worker/env';
const examples = [
  { id: 'a', text: 'Scam', label: 'spam' as const },
  { id: 'b', text: 'Hello', label: 'ham' as const },
];
const fakeEnv = { OPENROUTER_API_KEY: 'secret' } as Env;
afterEach(() => vi.unstubAllGlobals());

describe('classification adapters', () => {
  it('rejects provider redirects without forwarding credentials or accepting decisions', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://unexpected.example/collect' },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(
      classify(fakeEnv, 'openrouter', 'model', defaultSettings.policy, examples),
    ).rejects.toThrow('HTTP 307');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('shrinks large batches while preserving complete message text', () => {
    const large = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      text: 'x'.repeat(8000),
      label: null,
      context: ['y'.repeat(2000), 'z'.repeat(2000)],
    }));
    const fitted = fitExamples(fakeEnv, 'jev', 'typesafe/jev-1.13', defaultSettings.policy, large);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(large.length);
    expect(fitted[0].text.length).toBe(8000);
    expect(
      estimateTokens(fakeEnv, 'jev', 'typesafe/jev-1.13', defaultSettings.policy, fitted),
    ).toBeLessThanOrEqual(28000);
  });
  it('rejects missing, duplicate, unknown, and out-of-range results', () => {
    const result = (id: string, score = 0.9) => ({ id, score, category: 'spam', reason: 'reason' });
    expect(() => validatePredictions({ results: [result('a')] }, examples)).toThrow();
    expect(() => validatePredictions({ results: [result('a'), result('a')] }, examples)).toThrow();
    expect(() => validatePredictions({ results: [result('a'), result('c')] }, examples)).toThrow();
    expect(() =>
      validatePredictions({ results: [result('a', 2), result('b')] }, examples),
    ).toThrow();
  });
  it('uses the OpenRouter Decisions endpoint and Jev noul probabilities', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
      const payload = JSON.parse(String(init.body));
      expect(payload.questions.m0.type).toBe('noul');
      expect(payload.state.messages.m1.text).toBe('Hello');
      expect(payload.state.messages.m0.label).toBeUndefined();
      expect(payload.model).toBe('typesafe/jev-1.13');
      return Response.json({
        answers: { m0: { type: 'noul', noul: 0.98 }, m1: { type: 'noul', noul: 0.04 } },
        usage: { input_tokens: 200, output_tokens: 0, cost: 0.00003 },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await classify(
      fakeEnv,
      'jev',
      'typesafe/jev-1.13',
      defaultSettings.policy,
      examples,
    );
    expect(result.results.map((r) => r.score)).toEqual([0.98, 0.04]);
    expect(result.input).toBe(200);
    expect(result.cost).toBe(0.00003);
  });
  it('uses Gemini through OpenRouter with strict structured output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        const payload = JSON.parse(String(init.body));
        expect(payload.model).toBe('google/gemini-2.5-flash-lite');
        expect(payload.response_format.json_schema.strict).toBe(true);
        expect(payload.messages[0].content).toContain('untrusted');
        expect(payload.messages[1].content).not.toContain('"label"');
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: examples.map((_, i) => ({
                    id: `m${i}`,
                    score: 0.1,
                    category: 'ham',
                    reason: 'valid',
                  })),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 30 },
        });
      }),
    );
    const result = await classify(
      fakeEnv,
      'openrouter',
      'google/gemini-2.5-flash-lite',
      defaultSettings.policy,
      examples,
    );
    expect(result.results.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('preserves provider usage and request IDs when validation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          id: 'gen-failed',
          choices: [{ message: { content: '{"results":[]}' } }],
          usage: { prompt_tokens: 321, completion_tokens: 12, cost: 0.002 },
        }),
      ),
    );
    const error = await classify(
      fakeEnv,
      'openrouter',
      'model',
      defaultSettings.policy,
      examples,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ClassificationError);
    expect(error.invalidOutput).toBe(true);
    expect(error.usage).toMatchObject({
      input: 321,
      output: 12,
      cost: 0.002,
      requestId: 'gen-failed',
    });
  });
  it('routes Clef through Decisions even on the general OpenRouter connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
        expect(JSON.parse(String(init.body)).model).toBe('cloudflare/clef-omni');
        return Response.json({
          answers: { m0: { type: 'noul', noul: 0.03 }, m1: { type: 'noul', noul: 0.95 } },
          usage: { input_tokens: 100, output_tokens: 0 },
        });
      }),
    );
    const result = await classify(
      fakeEnv,
      'openrouter',
      'cloudflare/clef-omni',
      defaultSettings.policy,
      examples,
    );
    expect(result.results.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.results.map((p) => p.score)).toEqual([0.03, 0.95]);
  });
  it('bounds decision batches and fits the remaining budget without truncating messages', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...examples[0], id: String(i) }));
    expect(
      fitExamples(fakeEnv, 'openrouter', 'cloudflare/clef-omni', defaultSettings.policy, many),
    ).toHaveLength(5);
    const one = estimateTokens(
      fakeEnv,
      'openrouter',
      'model',
      defaultSettings.policy,
      many.slice(0, 1),
    );
    expect(
      fitExamples(fakeEnv, 'openrouter', 'model', defaultSettings.policy, many, one),
    ).toHaveLength(1);
    expect(
      fitExamples(fakeEnv, 'openrouter', 'model', defaultSettings.policy, many, one - 1),
    ).toHaveLength(0);
  });
  it('supports custom providers without exposing their API keys', () => {
    const env = {
      ...fakeEnv,
      CUSTOM_API_KEY: 'private-secret',
      MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: 'custom',
          name: 'Custom',
          baseUrl: 'https://example.com/v1',
          apiKeyEnv: 'CUSTOM_API_KEY',
          format: 'plain',
        },
      ]),
    } as Env;
    expect(publicProviders(env).find((p) => p.id === 'custom')?.configured).toBe(true);
    expect(JSON.stringify(publicProviders(env))).not.toContain('private-secret');
    expect(
      requestPayload(
        providers(env).find((p) => p.id === 'custom')!,
        'model',
        'policy',
        examples,
      ),
    ).not.toHaveProperty('response_format');
    const override = {
      ...env,
      MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: 'openrouter',
          name: 'Custom override',
          baseUrl: 'https://example.com/v1',
          apiKeyEnv: 'CUSTOM_API_KEY',
          format: 'plain',
        },
      ]),
    };
    expect(modelProvider(override, 'openrouter', 'cloudflare/clef-omni')).toMatchObject({
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
      format: 'plain',
    });
    expect(() =>
      providers({
        ...env,
        MODEL_PROVIDERS_JSON:
          '[{"id":"x","name":"x","baseUrl":"http://example.com","apiKeyEnv":"CUSTOM_API_KEY"}]',
      }),
    ).toThrow();
  });
});
describe('metrics and imports', () => {
  it('recomputes metrics across thresholds and excludes unlabelled or unscored examples', () => {
    const predictions = [
      { id: 'a', score: 0.95, category: '', reason: '' },
      { id: 'b', score: 0.8, category: '', reason: '' },
    ];
    expect(metrics(examples, predictions, 0.7)).toMatchObject({
      tp: 1,
      fp: 1,
      precision: 0.5,
      recall: 1,
    });
    expect(metrics(examples, predictions, 0.9)).toMatchObject({
      tp: 1,
      tn: 1,
      precision: 1,
      recall: 1,
    });
    expect(
      metrics([...examples, { id: 'c', text: 'Unlabelled', label: null }], predictions, 0.9).count,
    ).toBe(2);
    expect(metrics(examples, [], 0.9).precision).toBeNull();
  });
  it('flattens Telegram rich text, ignores service/media-only messages, and retains sender context', () => {
    const result = importExamples({
      messages: [
        { id: 1, type: 'service', text: 'joined' },
        {
          id: 2,
          type: 'message',
          from_id: 'user42',
          date_unixtime: '1700000000',
          text: ['Hello ', { type: 'bold', text: 'world' }],
        },
        { id: 3, type: 'message', from_id: 'user42', date_unixtime: '1700000010', text: 'Again' },
        { id: 4, type: 'message', text: '' },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Hello world');
    expect(result[1].context).toEqual(['Hello world']);
    expect(result[0].label).toBeNull();
  });
  it('does not infer repetition from greetings on different days or missing timestamps', () => {
    const message = (id: number, date?: string) => ({
      id,
      type: 'message',
      from_id: 'user42',
      text: 'Hello',
      date,
    });
    const result = importExamples({
      messages: [
        message(1, '2026-10-09T12:00:00Z'),
        message(2, '2026-10-10T12:00:00Z'),
        message(3, '2026-10-10T12:00:05Z'),
        message(4),
      ],
    });
    expect(result[1].context).toEqual([]);
    expect(result[2].context).toEqual(['Hello']);
    expect(result[3].context).toEqual([]);
  });
  it('requires explicit chat selection for multi-chat exports and unique IDs', () => {
    const value = {
      chats: { list: [{ id: 123, messages: [{ id: 1, type: 'message', text: 'Hello' }] }] },
    };
    expect(() => importExamples(value)).toThrow('select the chat ID');
    expect(importExamples(value, '123')).toHaveLength(1);
    expect(() => importExamples([examples[0], examples[0]])).toThrow('unique');
  });
  it('includes hidden links in the text sent to classifiers', () => {
    const message = updateSchema.parse({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -1001, type: 'supergroup' },
        text: 'Claim',
        entities: [{ type: 'text_link', url: 'https://scam.invalid' }],
      },
    }).message!;
    expect(messageText(message)).toContain('https://scam.invalid');
  });
  it('validates thresholds and batch limits', () => {
    expect(() => settingsSchema.parse({ threshold: 0.7, reviewThreshold: 0.8 })).toThrow();
    expect(() => settingsSchema.parse({ batchSeconds: 61 })).toThrow();
  });
});

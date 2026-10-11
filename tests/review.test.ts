import { describe, expect, it } from 'vitest';
import { comparableRuns, reviewedExamples } from '../shared/review';
import { metrics } from '../shared/metrics';
import type { Evaluation, Example } from '../shared/types';

const examples: Example[] = [
  { id: '1', text: 'Hello', label: null },
  { id: '2', text: 'Fake investment returns', label: null, context: ['Buy now'] },
];
function run(id: string): Evaluation {
  return {
    id,
    model: id,
    provider: 'openrouter',
    dataset_id: 'dataset',
    dataset_name: 'Corpus',
    policy: 'Reject scams, allow greetings.',
    status: 'complete',
    cursor: 2,
    total: 2,
    batch_size: 20,
    provider_request_id: null,
    input_tokens: 0,
    output_tokens: 0,
    usage_estimated: 0,
    usage_incomplete: 0,
    latency_ms: 0,
    cost: null,
    error: '',
    created_at: 0,
    examples: structuredClone(examples),
    predictions: examples.map((e) => ({
      id: e.id,
      score: 0.95,
      category: 'spam',
      reason: 'example',
    })),
    reviewLabels: [],
  };
}
describe('reviewing saved model scores', () => {
  it('computes quality from later human labels without changing the original snapshot or predictions', () => {
    const original = run('gemini');
    const predictions = structuredClone(original.predictions);
    original.reviewLabels = [
      { id: '1', label: 'ham', updated_at: 1 },
      { id: '2', label: 'spam', updated_at: 1 },
    ];
    expect(metrics(reviewedExamples(original), original.predictions, 0.9)).toMatchObject({
      count: 2,
      precision: 0.5,
      recall: 1,
      fp: 1,
      tp: 1,
    });
    expect(original.examples.every((e) => e.label === null)).toBe(true);
    expect(original.predictions).toEqual(predictions);
  });
  it('supports clearing a label even when an original snapshot contained a label', () => {
    const original = run('gemini');
    original.examples[0].label = 'ham';
    original.reviewLabels = [
      { id: '1', label: null, updated_at: 2 },
      { id: 'unknown', label: 'spam', updated_at: 2 },
    ];
    expect(reviewedExamples(original)[0].label).toBeNull();
    expect(original.examples[0].label).toBe('ham');
    expect(metrics(reviewedExamples(original), original.predictions, 0.9).count).toBe(0);
  });
  it('compares only matching message text, context, media, dataset, and policy; ignores label differences', () => {
    const anchor = run('gemini'),
      jeV = run('jev'),
      differentText = run('text'),
      differentContext = run('context'),
      differentMedia = run('media'),
      differentPolicy = run('policy'),
      differentDataset = run('dataset'),
      differentSample = run('sample');
    jeV.examples[0].label = 'ham';
    differentText.examples[0].text = 'Another message';
    differentContext.examples[1].context = ['Different evidence'];
    differentMedia.examples[0].media = 'photo';
    differentPolicy.policy = 'Disallow every greeting.';
    differentDataset.dataset_id = 'another-dataset';
    differentSample.examples.pop();
    expect(
      comparableRuns(anchor, [
        differentText,
        differentContext,
        differentMedia,
        differentPolicy,
        differentDataset,
        differentSample,
        jeV,
        run('jev'),
      ]).map((r) => r.model),
    ).toEqual(['gemini', 'jev']);
  });
});

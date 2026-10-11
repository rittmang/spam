import { describe, expect, it } from 'vitest';
import { applyReviewLabel, labelKey, LabelEdits, type LabelEdit } from '../src/label-edits';
import { reviewedExamples } from '../shared/review';
import type { Dataset, Evaluation, Example } from '../shared/types';

const examples: Example[] = [
  { id: '1', text: 'Hello', label: null },
  { id: '2', text: 'Fake promotion', label: null },
];
const dataset: Dataset = { id: 'd1', name: 'Dataset', count: 2, labelled: 0, created_at: 1 };
const run = (id: string, datasetId = 'd1'): Evaluation =>
  ({
    id,
    dataset_id: datasetId,
    examples,
    reviewLabels: [],
  }) as unknown as Evaluation;
const edit = (index: number, label: Example['label']): LabelEdit => ({
  datasetId: 'd1',
  example: examples[index],
  label,
  updatedAt: index + 1,
});

describe('independent label saves', () => {
  it('guards only the same dataset and message and releases one save at a time', () => {
    const edits = new LabelEdits();
    expect(edits.begin('d1', '1')).toBe(true);
    expect(edits.begin('d1', '1')).toBe(false);
    expect(edits.begin('d1', '2')).toBe(true);
    expect(edits.begin('d2', '1')).toBe(true);
    edits.end('d1', '1');
    expect(edits.pending.has(labelKey('d1', '1'))).toBe(false);
    expect(edits.pending.has(labelKey('d1', '2'))).toBe(true);
    expect(edits.begin('d1', '1')).toBe(true);
  });
  it('merges out-of-order successful saves across matching models without changing snapshots', () => {
    const edits = new LabelEdits(),
      original = [run('gemini'), run('jev'), run('other', 'd2')];
    const before = edits.snapshot();
    edits.commit(edit(1, 'spam'));
    edits.commit(edit(0, 'ham'));
    const merged = edits.runs(original, before);
    for (const r of merged.slice(0, 2))
      expect(reviewedExamples(r).map((e) => e.label)).toEqual(['ham', 'spam']);
    expect(reviewedExamples(merged[2]).map((e) => e.label)).toEqual([null, null]);
    expect(
      original.every((r) => r.examples.every((e) => e.label === null) && !r.reviewLabels?.length),
    ).toBe(true);
    expect(edits.examples('d1', examples, before).map((e) => e.label)).toEqual(['ham', 'spam']);
  });
  it('keeps current counts and labels when a refresh overlaps saves, but trusts a later refresh', () => {
    const edits = new LabelEdits();
    const before = edits.snapshot();
    edits.begin('d1', '1');
    // A GET may already see the server commit before the POST response arrives.
    expect(edits.datasets([{ ...dataset, labelled: 1 }], [dataset], before)[0].labelled).toBe(0);
    edits.commit(edit(0, 'ham'));
    edits.end('d1', '1');
    expect(edits.datasets([dataset], [{ ...dataset, labelled: 1 }], before)[0].labelled).toBe(1);
    expect(edits.examples('d1', examples, before)[0].label).toBe('ham');
    const after = edits.snapshot();
    const otherTab = [{ ...examples[0], label: 'spam' as const }, examples[1]];
    expect(edits.examples('d1', otherTab, after)[0].label).toBe('spam');
    expect(
      edits.datasets([{ ...dataset, labelled: 2 }], [{ ...dataset, labelled: 1 }], after)[0]
        .labelled,
    ).toBe(2);
  });
  it('leaves a failed row unchanged and does not clear another pending or successful label', () => {
    const edits = new LabelEdits();
    edits.begin('d1', '1');
    edits.begin('d1', '2');
    edits.commit(edit(1, 'spam'));
    edits.end('d1', '2');
    edits.end('d1', '1');
    expect(edits.examples('d1', examples, 0).map((e) => e.label)).toEqual([null, 'spam']);
    expect(edits.pending.size).toBe(0);
  });
  it('clears labels and replaces obsolete reviews only for the matching dataset and contents', () => {
    const labelled = applyReviewLabel([run('gemini'), run('jev')], edit(0, 'ham'));
    const clear = { ...edit(0, null), updatedAt: 3 };
    expect(reviewedExamples(applyReviewLabel(labelled, clear)[0])[0].label).toBeNull();
    const changed = { ...edit(0, 'spam'), example: { ...examples[0], text: 'Edited message' } };
    const stale = applyReviewLabel(labelled, changed);
    expect(stale.every((r) => r.reviewLabels?.length === 0)).toBe(true);
    expect(stale[0].examples[0].text).toBe('Hello');
  });
});

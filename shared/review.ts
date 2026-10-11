import type { Evaluation, Example } from './types';

export function reviewedExamples(run: Pick<Evaluation, 'examples' | 'reviewLabels'>): Example[] {
  const labels = new Map((run.reviewLabels || []).map((r) => [r.id, r.label]));
  return run.examples.map((e) => (labels.has(e.id) ? { ...e, label: labels.get(e.id)! } : e));
}

export function sameExample(a: Example, b: Example) {
  return (
    a.id === b.id &&
    a.text === b.text &&
    (a.media || '') === (b.media || '') &&
    JSON.stringify(a.context || []) === JSON.stringify(b.context || [])
  );
}

export function comparableRuns(anchor: Evaluation, candidates: Evaluation[]) {
  const matched: Evaluation[] = [anchor];
  const models = new Set([`${anchor.provider}:${anchor.model}`]);
  for (const run of candidates) {
    const key = `${run.provider}:${run.model}`;
    if (
      models.has(key) ||
      !run.predictions.length ||
      run.dataset_id !== anchor.dataset_id ||
      run.policy !== anchor.policy ||
      run.examples.length !== anchor.examples.length
    )
      continue;
    const examples = new Map(run.examples.map((e) => [e.id, e]));
    if (!anchor.examples.every((e) => examples.has(e.id) && sameExample(e, examples.get(e.id)!)))
      continue;
    matched.push(run);
    models.add(key);
    if (matched.length === 5) break;
  }
  return matched;
}

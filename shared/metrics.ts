import type { Example, Prediction } from './types';

export function metrics(examples: Example[], predictions: Prediction[], threshold: number) {
  const byId = new Map(predictions.map((p) => [p.id, p]));
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const example of examples) {
    const p = byId.get(example.id);
    if (example.label === null || !p) continue;
    const positive = p.score >= threshold;
    if (positive && example.label === 'spam') tp++;
    else if (positive) fp++;
    else if (example.label === 'ham') tn++;
    else fn++;
  }
  const count = tp + fp + tn + fn;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return {
    tp,
    fp,
    tn,
    fn,
    count,
    precision,
    recall,
    f1:
      precision !== null && recall !== null
        ? precision + recall
          ? (2 * precision * recall) / (precision + recall)
          : 0
        : null,
    accuracy: count ? (tp + tn) / count : null,
    fpr: fp + tn ? fp / (fp + tn) : null,
  };
}

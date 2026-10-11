import { api } from './api';
import type { Evaluation, EvaluationIndex, EvaluationPage, Example } from '../shared/types';

export class EvaluationReader {
  constructor(private request: typeof api = api) {}
  private snapshots = new Map<string, Promise<Example[]>>();
  async load(onRun?: (run: Evaluation) => void): Promise<Evaluation[]> {
    const index = await this.request<EvaluationIndex[]>('/evaluations/status?snapshots=1');
    const keys = new Set(index.map((r) => r.snapshot_key));
    for (const key of this.snapshots.keys()) if (!keys.has(key)) this.snapshots.delete(key);
    const result: Evaluation[] = new Array(index.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, index.length) }, async () => {
        while (next < index.length) {
          const position = next++,
            row = index[position];
          const [examples, pages] = await Promise.all([
            this.snapshot(row),
            this.pages(row.id, 'results'),
          ]);
          const run: Evaluation = {
            ...row,
            examples,
            predictions: pages.flatMap((p) => p.predictions || []),
            reviewLabels: pages.flatMap((p) => p.reviewLabels || []),
          };
          result[position] = run;
          onRun?.(run);
        }
      }),
    );
    return result;
  }
  private snapshot(row: EvaluationIndex) {
    let pending = this.snapshots.get(row.snapshot_key);
    if (!pending) {
      pending = this.pages(row.id, 'examples').then((pages) =>
        pages.flatMap((p) => p.examples || []),
      );
      this.snapshots.set(row.snapshot_key, pending);
      const current = pending;
      void pending.catch(() => {
        if (this.snapshots.get(row.snapshot_key) === current)
          this.snapshots.delete(row.snapshot_key);
      });
    }
    return pending;
  }
  private async pages(id: string, section: 'examples' | 'results') {
    const pages: EvaluationPage[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.request<EvaluationPage>(
        `/evaluations/${encodeURIComponent(id)}/${section}?offset=${offset}&limit=100`,
      );
      pages.push(page);
      if (page.nextOffset === null) return pages;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
        throw new Error('Saved-run pagination could not advance. Please refresh results.');
      offset = page.nextOffset;
    }
  }
}

import type { Dataset, Evaluation, Example, Label } from '../shared/types';
import { sameExample } from '../shared/review';

export const labelKey = (datasetId: string, id: string) => JSON.stringify([datasetId, id]);
export interface LabelEdit {
  datasetId: string;
  example: Example;
  label: Label;
  updatedAt: number;
}

export function applyReviewLabel(runs: Evaluation[], edit: LabelEdit): Evaluation[] {
  return runs.map((run) => {
    if (run.dataset_id !== edit.datasetId || !run.examples.some((e) => e.id === edit.example.id))
      return run;
    const matching = run.examples.some((e) => sameExample(e, edit.example));
    return {
      ...run,
      reviewLabels: [
        ...(run.reviewLabels || []).filter((l) => l.id !== edit.example.id),
        ...(matching
          ? [{ id: edit.example.id, label: edit.label, updated_at: edit.updatedAt }]
          : []),
      ],
    };
  });
}

// Protect saved labels from GET responses that started before the save finished.
// Requests begun after a save use the server's current labels, including other tabs' edits.
export class LabelEdits {
  readonly pending = new Set<string>();
  private version = 0;
  private saved = new Map<string, LabelEdit & { version: number }>();
  snapshot() {
    return this.version;
  }
  begin(datasetId: string, id: string) {
    const key = labelKey(datasetId, id);
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    return true;
  }
  end(datasetId: string, id: string) {
    this.pending.delete(labelKey(datasetId, id));
  }
  commit(edit: LabelEdit) {
    this.saved.set(labelKey(edit.datasetId, edit.example.id), { ...edit, version: ++this.version });
  }
  examples(datasetId: string, examples: Example[], since: number) {
    return examples.map((example) => {
      const edit = this.saved.get(labelKey(datasetId, example.id));
      return edit && edit.version > since && sameExample(example, edit.example)
        ? { ...example, label: edit.label }
        : example;
    });
  }
  runs(runs: Evaluation[], since: number) {
    for (const edit of this.saved.values())
      if (edit.version > since) runs = applyReviewLabel(runs, edit);
    return runs;
  }
  datasets(datasets: Dataset[], current: Dataset[], since: number) {
    const touched = new Set(
      [...this.saved.values()].filter((edit) => edit.version > since).map((edit) => edit.datasetId),
    );
    for (const key of this.pending) touched.add((JSON.parse(key) as string[])[0]);
    const counts = new Map(current.map((d) => [d.id, d.labelled]));
    return datasets.map((dataset) =>
      touched.has(dataset.id) && counts.has(dataset.id)
        ? { ...dataset, labelled: counts.get(dataset.id)! }
        : dataset,
    );
  }
}

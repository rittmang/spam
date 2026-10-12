import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, LoaderCircle, Search, Shield } from 'lucide-react';
import type { Evaluation, Label } from '../shared/types';
import { comparableRuns, reviewedExamples } from '../shared/review';
import { labelKey } from './label-edits';
import { FeedbackEditor } from './FeedbackEditor';

type Filter =
  'all' | 'flagged' | 'disagreements' | 'unlabelled' | 'false-positive' | 'false-negative';
export function RunReview({
  run,
  runs,
  threshold,
  onLabel,
  savingLabels,
  chatId,
  onFeedbackSaved,
}: {
  run: Evaluation;
  runs: Evaluation[];
  threshold: number;
  onLabel: (runId: string, id: string, label: Label) => Promise<void>;
  savingLabels: ReadonlySet<string>;
  chatId: string;
  onFeedbackSaved: (id: string, label: Label) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [hideScores, setHideScores] = useState(false);
  const [sort, setSort] = useState<'score' | 'order'>('score');
  useEffect(() => {
    setPage(0);
    setExcluded([]);
    setFilter('all');
    setSearch('');
  }, [run.id]);
  useEffect(() => setPage(0), [filter, search, sort]);
  const candidates = comparableRuns(run, runs);
  const compared = candidates.filter((r) => !excluded.includes(r.id));
  const byRun = compared.map((r) => new Map(r.predictions.map((p) => [p.id, p])));
  const examples = reviewedExamples(run);
  const labelled = examples.filter((e) => e.label !== null).length;
  const rows = examples
    .map((example, index) => {
      const predictions = byRun.map((m) => m.get(example.id));
      const scores = predictions.flatMap((p) => (p ? [p.score] : []));
      const flagged = predictions.some((p) => p && !p.needs_review && p.score >= threshold);
      const disagreement =
        flagged && predictions.some((p) => p && (p.needs_review || p.score < threshold));
      return { example, index, predictions, scores, flagged, disagreement };
    })
    .filter((row) => {
      if (!row.scores.length) return false;
      if (
        search &&
        !`${row.example.id} ${row.example.text}`.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      if (filter === 'flagged') return row.flagged;
      if (filter === 'disagreements') return row.disagreement;
      if (filter === 'unlabelled') return row.example.label === null;
      if (filter === 'false-positive') return row.example.label === 'ham' && row.flagged;
      if (filter === 'false-negative')
        return (
          row.example.label === 'spam' &&
          row.predictions.some((p) => p && (p.needs_review || p.score < threshold))
        );
      return true;
    })
    .sort((a, b) =>
      sort === 'order'
        ? a.index - b.index
        : Math.max(...b.scores) - Math.max(...a.scores) || a.index - b.index,
    );
  const pages = Math.max(1, Math.ceil(rows.length / 10));
  const activePage = Math.min(page, pages - 1);
  const visible = rows.slice(activePage * 10, activePage * 10 + 10);
  return (
    <section className="panel run-review" id="run-review">
      <div className="panel-heading">
        <div>
          <h2>Review the scored sample</h2>
          <p>
            Read the messages, compare decisions, then mark what is actually spam. Labels update
            metrics without new model calls.
          </p>
        </div>
        <span className="tag">
          {labelled}/{examples.length} labelled
        </span>
      </div>
      <div className="review-models">
        {candidates.map((r) => {
          const active = !excluded.includes(r.id);
          const flagged = r.predictions.filter(
            (p) => !p.needs_review && p.score >= threshold,
          ).length;
          return (
            <button
              key={r.id}
              type="button"
              aria-pressed={active}
              className={`review-model-chip ${active ? 'active' : ''}`}
              title={r.model}
              onClick={() => {
                if (active && compared.length === 1) return;
                setExcluded((ids) => (active ? [...ids, r.id] : ids.filter((id) => id !== r.id)));
                setPage(0);
              }}
            >
              <strong>{r.model.split('/').at(-1)}</strong>
              <span>
                {hideScores
                  ? 'Scores hidden'
                  : `${flagged}/${r.predictions.length} flagged at ${threshold.toFixed(2)}`}
              </span>
            </button>
          );
        })}
      </div>
      <div className="review-controls">
        <label className="search-field">
          <Search size={14} />
          <input
            aria-label="Search scored messages"
            placeholder="Search the scored sample…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter scored messages"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="all">All scored messages</option>
          <option value="flagged">Flagged as spam</option>
          <option value="disagreements">Models disagree</option>
          <option value="unlabelled">Needs a label</option>
          <option value="false-positive">False positives</option>
          <option value="false-negative">Missed spam</option>
        </select>
        <select
          aria-label="Sort scored messages"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
        >
          <option value="score">Highest spam score first</option>
          <option value="order">Conversation order</option>
        </select>
        <label className="review-blind">
          <input
            type="checkbox"
            checked={hideScores}
            onChange={(e) => {
              setHideScores(e.target.checked);
              if (e.target.checked) setSort('order');
              if (e.target.checked) setFilter('all');
            }}
          />
          Hide scores while labelling
        </label>
      </div>
      {!visible.length ? (
        <div className="review-empty">
          {run.predictions.length
            ? 'No messages match this filter.'
            : 'Choose a run with saved scores from the results above.'}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="review-table">
            <thead>
              <tr>
                <th>Message</th>
                {compared.map((r) => (
                  <th key={r.id} title={r.model}>
                    {r.model.split('/').at(-1)}
                    <small>
                      {r.predictions.length}/{r.total} scored
                    </small>
                  </th>
                ))}
                <th>Your label</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.example.id}
                  className={!hideScores && row.disagreement ? 'review-disagreement' : ''}
                >
                  <td className="review-message">
                    <span className="review-message-id">
                      #{row.example.id}
                      {!hideScores && row.disagreement && (
                        <span className="tag">Models disagree</span>
                      )}
                    </span>
                    <p>{row.example.text}</p>
                    <details>
                      <summary>
                        Full message{row.example.context?.length ? ' & recent context' : ''}
                      </summary>
                      <pre>{row.example.text}</pre>
                      {row.example.context?.length ? (
                        <div className="review-context">
                          <strong>Recent messages from the same sender</strong>
                          {row.example.context.map((text, i) => (
                            <p key={i}>{text}</p>
                          ))}
                        </div>
                      ) : null}
                    </details>
                  </td>
                  {row.predictions.map((p, i) => (
                    <td key={compared[i].id} className="review-prediction">
                      {hideScores ? (
                        <span className="muted">Hidden for review</span>
                      ) : p ? (
                        <>
                          <strong className={p.score >= threshold ? 'red' : 'review-low-score'}>
                            {(p.score * 100).toFixed(1)}%
                          </strong>
                          <span
                            className={`tag ${!p.needs_review && p.score >= threshold ? 'review-spam-tag' : ''}`}
                          >
                            {p.needs_review ? 'Review' : p.score >= threshold ? 'Spam' : 'Allowed'}
                          </span>
                          <p title={p.reason}>
                            {/^(Jev|Decision model) policy probability/.test(p.reason)
                              ? 'Probability only; no generated explanation.'
                              : p.reason}
                          </p>
                        </>
                      ) : (
                        <span className="muted">Not scored yet</span>
                      )}
                    </td>
                  ))}
                  <td className="review-label">
                    <div className="label-buttons">
                      <button
                        aria-label={`Review message ${row.example.id} legitimate`}
                        aria-pressed={row.example.label === 'ham'}
                        className={row.example.label === 'ham' ? 'selected ham' : ''}
                        disabled={savingLabels.has(labelKey(run.dataset_id, row.example.id))}
                        onClick={() => void onLabel(run.id, row.example.id, 'ham')}
                      >
                        <Check size={13} />
                        Legitimate
                      </button>
                      <button
                        aria-label={`Review message ${row.example.id} spam`}
                        aria-pressed={row.example.label === 'spam'}
                        className={row.example.label === 'spam' ? 'selected spam' : ''}
                        disabled={savingLabels.has(labelKey(run.dataset_id, row.example.id))}
                        onClick={() => void onLabel(run.id, row.example.id, 'spam')}
                      >
                        <Shield size={13} />
                        Spam
                      </button>
                      <button
                        aria-label={`Review message ${row.example.id} needs context`}
                        aria-pressed={row.example.label === 'review'}
                        className={row.example.label === 'review' ? 'selected' : ''}
                        disabled={savingLabels.has(labelKey(run.dataset_id, row.example.id))}
                        onClick={() => void onLabel(run.id, row.example.id, 'review')}
                      >
                        Needs context
                      </button>
                    </div>
                    {savingLabels.has(labelKey(run.dataset_id, row.example.id)) ? (
                      <LoaderCircle
                        size={13}
                        className="spin"
                        aria-label={`Saving label for message ${row.example.id}`}
                      />
                    ) : row.example.label !== null ? (
                      <button
                        className="text-button"
                        aria-label={`Clear review label ${row.example.id}`}
                        disabled={savingLabels.has(labelKey(run.dataset_id, row.example.id))}
                        onClick={() => void onLabel(run.id, row.example.id, null)}
                      >
                        Clear label
                      </button>
                    ) : (
                      <small>Not labelled</small>
                    )}
                    <FeedbackEditor
                      key={`${run.id}:${row.example.id}:feedback`}
                      chatId={chatId}
                      endpoint={`/evaluations/${run.id}/reviews`}
                      id={row.example.id}
                      label={row.example.label}
                      disabled={savingLabels.has(labelKey(run.dataset_id, row.example.id))}
                      onSaved={(label) => onFeedbackSaved(row.example.id, label)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span>
          {rows.length
            ? `${activePage * 10 + 1}–${Math.min((activePage + 1) * 10, rows.length)} of ${rows.length}`
            : '0 messages'}{' '}
          · Human labels are shared across matching saved samples.
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="Previous review page"
            disabled={activePage === 0}
            onClick={() => setPage(activePage - 1)}
          >
            <ChevronLeft size={15} />
          </button>
          <span>
            {activePage + 1}/{pages}
          </span>
          <button
            className="icon-button"
            aria-label="Next review page"
            disabled={activePage + 1 >= pages}
            onClick={() => setPage(activePage + 1)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div className="results-footer">
        Model scores are suggestions. Your labels are the ground truth. Original run labels,
        prompts, and predictions stay saved; review labels and metrics remain editable. Review a
        representative mix, including messages every model allowed.
      </div>
    </section>
  );
}

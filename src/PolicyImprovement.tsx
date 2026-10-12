import { useCallback, useMemo, useState } from 'react';
import { RefreshCw, Check, Play, RotateCcw, LoaderCircle } from 'lucide-react';
import { apiForGroup } from './api';
import { useVisiblePoll } from './poll';
import {
  digest,
  feedbackReasons,
  policyDiff,
  type ImprovementOverview,
  type PolicyDraft,
  type PolicyGate,
} from '../shared/improvement';

const title: Record<string, string> = {
  queued: 'Queued',
  drafting: 'Drafting',
  draft: 'Review the draft',
  development: 'Development replay',
  validation: 'Validation replay',
  validated: 'Validation passed',
  test: 'Sealed test running',
  ready: 'Ready for owner approval',
  published: 'Published',
  rejected: 'Rejected by regression checks',
  failed: 'Interrupted or failed',
  unchanged: 'No policy change',
  stale: 'Settings changed',
  discarded: 'Discarded',
};
function Metrics({ result, label }: { result: PolicyGate; label: string }) {
  return (
    <section className="policy-result">
      <h3>
        {label} · {result.pass ? 'Passed' : 'Needs work'}
      </h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Policy</th>
              <th>False positives</th>
              <th>Spam allowed</th>
              <th>Spam flagged</th>
              <th>Spam deferred</th>
              <th>Correct ambiguity reviews</th>
              <th>Unnecessary reviews</th>
              <th>Total reviews</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Baseline', result.baseline],
              ['Candidate', result.candidate],
            ].map(([name, m]) => {
              const row = m as PolicyGate['baseline'];
              return (
                <tr key={String(name)}>
                  <td>{String(name)}</td>
                  <td>{row.falsePositives.length}</td>
                  <td>{row.misses.length}</td>
                  <td>{row.spamFlagged}</td>
                  <td>{row.spamDeferred}</td>
                  <td>{row.correctReviews.length}</td>
                  <td>{row.unnecessaryReviews.length}</td>
                  <td>{row.reviews}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        {result.baseline.total} references · {result.baseline.families} families · weighted loss{' '}
        {result.baseline.loss} → {result.candidate.loss} · cost ratio{' '}
        {result.costRatio === null ? 'unknown' : result.costRatio.toFixed(2)}
      </p>
      <p>
        {Object.entries(result.checks)
          .filter(([, ok]) => !ok)
          .map(([key]) => key.replaceAll(/([A-Z])/g, ' $1').toLowerCase())
          .join(' · ') || 'All checks passed.'}
      </p>
    </section>
  );
}
export function PolicyImprovement({
  chatId,
  onPublished,
}: {
  chatId: string;
  onPublished: () => Promise<void>;
}) {
  const api = useMemo(() => apiForGroup(chatId), [chatId]);
  const [data, setData] = useState<ImprovementOverview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [clarification, setClarification] = useState(''),
    [ack, setAck] = useState<Record<string, boolean>>({});
  const load = useCallback(async () => {
    setData(await api<ImprovementOverview>('/improvement'));
    setError('');
  }, [api]);
  const active = data?.drafts.some((d) =>
    ['queued', 'drafting', 'development', 'validation', 'test'].includes(d.status),
  );
  useVisiblePoll(load, active ? 5000 : 30000, (e) => setError(e.message));
  const action = async (key: string, path: string, body: unknown = {}, published = false) => {
    setBusy(key);
    setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
      if (published) await onPublished();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">REASON, REPLAY, REVIEW</div>
          <h1>A policy that evolves.</h1>
          <p>Corrections propose changes. You decide when a tested change becomes live.</p>
        </div>
        <button
          className="button secondary"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <section className="panel improvement-intro">
        <h2>When does feedback trigger a draft?</h2>
        <p>
          Three new reasoned corrections from independent message families for the same cause queue
          one draft on the next minute tick. Repeated labels and related variants count once.
          Ordinary labels without reasons are saved for adjudication. An explicit owner
          clarification can queue a draft immediately.
        </p>
        <p>
          Nothing updates the live prompt until development replay, untouched validation, a fresh
          sealed test, and your approval. Replays issue no strikes or deletions. Correct required
          reviews are not penalized as unnecessary reviews.
        </p>
        <p>
          Approval starts the new policy in Observe. Inspect its live decisions, then enable Enforce
          in Settings when you are ready.
        </p>
        <small>
          Text and captions are replayed. Image feedback is held until visual evidence can be
          evaluated. A saved label is separate from a moderation action.
        </small>
        <div className="policy-causes">
          {data?.readyCauses.map((c) => (
            <span className="tag" key={`${c.reason}:${c.label}`}>
              {feedbackReasons[c.reason as keyof typeof feedbackReasons] || c.reason} ·{' '}
              {c.label === 'ham' ? 'legitimate' : c.label} · {c.families}/{data.triggerFamilies} new
              families
            </span>
          ))}
        </div>
      </section>
      <section className="panel improvement-clarification">
        <h2>Clarify a policy boundary</h2>
        <p>
          Use a general criterion rather than quoting a message. This starts a draft without waiting
          for three corrections.
        </p>
        <textarea
          aria-label="Owner policy clarification"
          rows={3}
          value={clarification}
          maxLength={1000}
          onChange={(e) => setClarification(e.target.value)}
          placeholder="Explain the community boundary you want clarified…"
        />
        <button
          className="button primary"
          disabled={!!busy || clarification.trim().length < 20}
          onClick={() => void action('clarify', '/improvement/clarify', { clarification })}
        >
          <Play size={15} />
          Draft clarification
        </button>
      </section>
      {!data && (
        <p>
          <LoaderCircle size={16} className="spin" />
          Loading policy history…
        </p>
      )}
      {data?.drafts.map((d: PolicyDraft) => (
        <section className="panel policy-draft" key={d.id}>
          <div className="panel-heading">
            <div>
              <h2>{title[d.status] || d.status}</h2>
              <p>
                {new Date(d.created_at).toLocaleString()} · fixed model {d.baseline.model}
              </p>
            </div>
            <span className="tag">{d.evidenceIds.length} reasoned sources</span>
          </div>
          {d.proposalRoute && (
            <p>
              Drafting model: {d.proposalRoute.model} · {d.proposalRoute.provider}
              {d.proposalRoute.model !== d.baseline.model
                ? ' (drafting fallback; replay model stays fixed)'
                : ''}
            </p>
          )}
          {d.observedRoute && (
            <p>
              Observed replay model: {d.observedRoute.model} · {d.observedRoute.provider}
            </p>
          )}
          {d.error && <p className="policy-error">{d.error}</p>}
          {d.candidate && (
            <div className="policy-diff">
              <div>
                <h3>Original policy</h3>
                <pre>{d.baseline.policy}</pre>
              </div>
              <div>
                <h3>Proposed replacement</h3>
                <pre>{d.candidate}</pre>
              </div>
            </div>
          )}
          {d.candidate && (
            <details className="policy-text-diff">
              <summary>Exact text diff · removed / added</summary>
              <pre>
                {policyDiff(d.baseline.policy, d.candidate).map((line, i) => (
                  <span className={line.kind} key={i}>
                    {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                    {line.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </details>
          )}
          {d.referenceCounts && (
            <p>
              Frozen references: development {d.referenceCounts.development} · validation{' '}
              {d.referenceCounts.validation} · sealed test {d.referenceCounts.test}. Related
              families remain in one split; previously opened test families are excluded.
            </p>
          )}
          {d.results?.development && <Metrics result={d.results.development} label="Development" />}
          {d.results?.validation && <Metrics result={d.results.validation} label="Validation" />}
          {d.results?.test && <Metrics result={d.results.test} label="Fresh sealed test" />}
          <div className="policy-actions">
            {d.status === 'draft' && (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void action(d.id, `/improvement/${d.id}/evaluate`)}
              >
                <Play size={15} />
                Freeze references & replay
              </button>
            )}
            {d.status === 'validated' && (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void action(d.id, `/improvement/${d.id}/test`)}
              >
                <Play size={15} />
                Lock candidate & run sealed test
              </button>
            )}
            {d.status === 'ready' && (
              <>
                <label className="feedback-check">
                  <input
                    type="checkbox"
                    checked={!!ack[d.id]}
                    onChange={(e) => setAck({ ...ack, [d.id]: e.target.checked })}
                  />
                  I reviewed the exact replacement and the measured tradeoffs
                </label>
                <button
                  className="button primary"
                  disabled={!!busy || !ack[d.id]}
                  onClick={() =>
                    void digest(d.candidate).then((hash) =>
                      action(
                        d.id,
                        `/improvement/${d.id}/publish`,
                        {
                          expectedParent: d.parent,
                          candidateHash: hash,
                          acknowledgeTradeoffs: true,
                        },
                        true,
                      ),
                    )
                  }
                >
                  <Check size={16} />
                  Approve & publish in Observe
                </button>
              </>
            )}
            {d.status === 'failed' && !d.corpusHash && (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void action(d.id, `/improvement/${d.id}/retry`)}
              >
                Retry drafting · provider calls apply
              </button>
            )}
            {d.status === 'failed' && d.failedPhase && (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void action(d.id, `/improvement/${d.id}/retry`)}
              >
                Continue frozen replay · resume failed runs in Model lab first
              </button>
            )}
            {['draft', 'queued', 'unchanged', 'rejected', 'failed', 'stale'].includes(d.status) && (
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void action(d.id, `/improvement/${d.id}/discard`)}
              >
                Discard draft
              </button>
            )}
            {busy === d.id && <LoaderCircle size={15} className="spin" />}
          </div>
          <small>
            {d.usage?.tokens ?? 'Unknown'} drafting tokens · drafting cost{' '}
            {d.usage?.cost == null ? 'unknown' : `$${d.usage.cost.toFixed(6)}`}. Replay calls use
            the Model lab usage counter.
          </small>
        </section>
      ))}
      {data && !data.drafts.length && (
        <section className="panel improvement-intro">
          <h2>Waiting for reasoned corrections</h2>
          <p>
            Open a message or saved model result and choose “Add reasoned feedback”. Imported labels
            alone do not trigger drafting.
          </p>
        </section>
      )}
      <section className="panel improvement-intro">
        <h2>Feedback history</h2>
        <p>
          {data?.referenceCount || 0} labelled dataset references. Replay requires at least two
          spam, two legitimate, and one review reference in each split, with five independent
          families.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Your label</th>
                <th>Reason</th>
                <th>Evidence status</th>
              </tr>
            </thead>
            <tbody>
              {data?.feedback.map((e) => (
                <tr key={e.id}>
                  <td>{e.source}</td>
                  <td>{e.label === 'ham' ? 'legitimate' : e.label || 'retracted'}</td>
                  <td>
                    {feedbackReasons[e.reason_code as keyof typeof feedbackReasons] ||
                      'Reason needed'}
                  </td>
                  <td>{e.disposition.replaceAll('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel improvement-intro">
        <h2>Published policy versions & rollback</h2>
        <p>Restoring a version preserves the current enforcement mode and operational limits.</p>
        {data?.versions.map((v) => (
          <div className="policy-version" key={v.id}>
            <span>
              {v.id.slice(0, 10)} · {v.source} · {new Date(v.created_at).toLocaleString()}
            </span>
            {v.id === data.activeVersion ? (
              <span className="tag">Current</span>
            ) : (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() =>
                  void action(
                    v.id,
                    '/improvement/rollback',
                    { versionId: v.id, expectedParent: data.activeVersion },
                    true,
                  )
                }
              >
                <RotateCcw size={14} />
                Restore version
              </button>
            )}
            <details>
              <summary>View saved policy</summary>
              <pre>{v.policy}</pre>
            </details>
          </div>
        ))}
      </section>
    </>
  );
}

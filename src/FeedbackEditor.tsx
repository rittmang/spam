import { useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { feedbackReasons, type FeedbackInput } from '../shared/improvement';
import type { Label } from '../shared/types';
import { apiForGroup } from './api';

export function FeedbackEditor({
  chatId,
  endpoint,
  id,
  label,
  onSaved,
  disabled = false,
}: {
  chatId: string;
  endpoint: string;
  id?: string;
  label: Label;
  onSaved?: (label: Label) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<Exclude<Label, null>>(label || 'spam'),
    [reason, setReason] = useState<keyof typeof feedbackReasons | ''>(''),
    [note, setNote] = useState(''),
    [family, setFamily] = useState(''),
    [complete, setComplete] = useState(true),
    [resolve, setResolve] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (label) setValue(label);
  }, [label]);
  return (
    <details className="feedback-editor">
      <summary>Add reasoned feedback</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setMessage('');
          const body: FeedbackInput = {
            label: value,
            reasonCode: reason || undefined,
            note,
            family,
            contextComplete: complete,
            resolveConflict: resolve,
            eventId: crypto.randomUUID(),
          };
          void apiForGroup(chatId)<{ disposition?: string }>(endpoint, {
            method: 'POST',
            body: JSON.stringify(id ? [{ ...body, id }] : body),
          })
            .then((result) => {
              onSaved?.(value);
              setMessage(
                result.disposition === 'accepted'
                  ? 'Saved. Eligible corrections count toward a policy draft.'
                  : result.disposition
                    ? `Saved for adjudication: ${result.disposition.replaceAll('_', ' ')}.`
                    : 'Feedback saved; check Policy improvement for its evidence status.',
              );
            })
            .catch((e) => setMessage(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label className="field">
          Your decision
          <select
            aria-label="Feedback decision"
            value={value}
            onChange={(e) => setValue(e.target.value as Exclude<Label, null>)}
          >
            <option value="spam">Spam</option>
            <option value="ham">Legitimate</option>
            <option value="review">Needs context / review</option>
          </select>
        </label>
        <label className="field">
          Reason
          <select
            aria-label="Feedback reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value as keyof typeof feedbackReasons)}
          >
            <option value="">Choose a reason</option>
            {Object.entries(feedbackReasons).map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Explanation
          <textarea
            aria-label="Feedback explanation"
            required={reason === 'other'}
            maxLength={1000}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What boundary should the policy recognize?"
          />
        </label>
        <label className="field">
          Related-message family (optional)
          <input
            aria-label="Feedback family"
            value={family}
            maxLength={100}
            onChange={(e) => setFamily(e.target.value)}
            placeholder="Use the same name for one campaign or related variants"
          />
        </label>
        <label className="feedback-check">
          <input
            type="checkbox"
            checked={complete}
            onChange={(e) => setComplete(e.target.checked)}
          />
          All context needed for my label is available
        </label>
        <label className="feedback-check">
          <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />
          This intentionally resolves my previous conflicting label
        </label>
        <button className="button secondary" disabled={busy || disabled || !reason}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save feedback
        </button>
        <small role="status">
          {message ||
            'A label alone does not change the live prompt. Missing images or context require adjudication.'}
        </small>
      </form>
    </details>
  );
}

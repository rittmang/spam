import { z } from 'zod';
import type { Example, Label, Prediction, Settings } from './types';

export const feedbackReasons = {
  scam: 'Scam or phishing',
  promotion: 'Unsolicited commercial promotion',
  repetition: 'Disruptive repeated messages',
  ordinary_conversation: 'Ordinary conversation',
  relevant_announcement: 'Relevant community announcement',
  requested_resource: 'Requested recommendation or resource',
  missing_context: 'Material context is missing',
  other: 'Another policy boundary',
} as const;
export const feedbackSchema = z.object({
  label: z.enum(['spam', 'ham', 'review']).nullable(),
  reasonCode: z
    .enum(
      Object.keys(feedbackReasons) as [
        keyof typeof feedbackReasons,
        ...Array<keyof typeof feedbackReasons>,
      ],
    )
    .optional(),
  note: z.string().max(1000).default(''),
  family: z.string().max(100).default(''),
  contextComplete: z.boolean().default(true),
  resolveConflict: z.boolean().default(false),
  eventId: z.uuid().optional(),
});
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export const AUTO_DRAFT_FAMILIES = 3;
export const referenceMinimum = { spam: 2, ham: 2, review: 1 };
export const normalizedPolicy = (text: string) => text.trim().replace(/\s+/g, ' ');
export function policyDiff(before: string, after: string) {
  const a = before.split('\n'),
    b = after.split('\n');
  if (a.length * b.length > 40000)
    return [
      ...a.map((text) => ({ kind: 'removed', text })),
      ...b.map((text) => ({ kind: 'added', text })),
    ];
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i][j] =
        a[i] === b[j] ? 1 + lengths[i + 1][j + 1] : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const diff: { kind: string; text: string }[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      diff.push({ kind: 'unchanged', text: a[i++] });
      j++;
    } else if (j < b.length && (i === a.length || lengths[i][j + 1] >= lengths[i + 1][j]))
      diff.push({ kind: 'added', text: b[j++] });
    else diff.push({ kind: 'removed', text: a[i++] });
  }
  return diff;
}
export const familyText = (text: string) =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/@\w+/g, '<user>')
    .replace(/\d+/g, '#')
    .replace(/(.)\1{3,}/g, '$1$1')
    .replace(/[^\p{L}\p{M}\p{N}<>#]+/gu, ' ')
    .trim();
export function relatedText(a: string, b: string) {
  if (a === b) return true;
  const x = new Set(a.split(' ')),
    y = new Set(b.split(' '));
  if (x.size < 6 || y.size < 6) return false;
  const common = [...x].filter((w) => y.has(w)).length;
  return common / (x.size + y.size - common) >= 0.7;
}
export async function digest(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export function decisionSettings(s: Settings) {
  return {
    policy: s.policy,
    provider: s.provider,
    model: s.model,
    threshold: s.threshold,
    reviewThreshold: s.reviewThreshold,
    imageModeration: s.imageModeration,
    imageProvider: s.imageProvider,
    imageModel: s.imageModel,
  };
}
export const policyFingerprint = (s: Settings) => digest(decisionSettings(s));
export function routed(
  p: Prediction,
  s: Pick<Settings, 'threshold' | 'reviewThreshold'>,
): Exclude<Label, null> {
  return p.needs_review
    ? 'review'
    : p.score >= s.threshold
      ? 'spam'
      : p.score >= s.reviewThreshold
        ? 'review'
        : 'ham';
}
export interface PolicyMetrics {
  total: number;
  families: number;
  falsePositives: string[];
  misses: string[];
  ambiguousSpam: string[];
  correctReviews: string[];
  unnecessaryReviews: string[];
  spamFlagged: number;
  spamDeferred: number;
  reviews: number;
  loss: number;
  rows: {
    id: string;
    family: string;
    label: Exclude<Label, null>;
    decision: Exclude<Label, null>;
  }[];
}
export function policyMetrics(
  examples: Example[],
  predictions: Prediction[],
  s: Pick<Settings, 'threshold' | 'reviewThreshold'>,
): PolicyMetrics {
  if (!examples.length || examples.some((e) => !e.label || !e.family))
    throw new Error('Every reference needs a label and family.');
  if (
    predictions.length !== examples.length ||
    new Set(predictions.map((p) => p.id)).size !== examples.length ||
    new Set(examples.map((e) => e.id)).size !== examples.length
  )
    throw new Error('Exactly one unique prediction per reference is required.');
  const byId = new Map(predictions.map((p) => [p.id, p]));
  const rows = examples.map((e) => {
    const p = byId.get(e.id);
    if (!p || !Number.isFinite(p.score) || p.score < 0 || p.score > 1)
      throw new Error('Invalid or missing prediction.');
    return { id: e.id, family: e.family!, label: e.label!, decision: routed(p, s) };
  });
  const ids = (label: Label, decision: Label) =>
    rows.filter((r) => r.label === label && r.decision === decision).map((r) => r.id);
  const loss = {
    ham: { ham: 0, spam: 10, review: 0.25 },
    spam: { ham: 2, spam: 0, review: 0.5 },
    review: { ham: 1, spam: 5, review: 0 },
  };
  return {
    total: rows.length,
    families: new Set(rows.map((r) => r.family)).size,
    falsePositives: ids('ham', 'spam'),
    misses: ids('spam', 'ham'),
    ambiguousSpam: ids('review', 'spam'),
    correctReviews: ids('review', 'review'),
    unnecessaryReviews: ids('ham', 'review'),
    spamFlagged: ids('spam', 'spam').length,
    spamDeferred: ids('spam', 'review').length,
    reviews: rows.filter((r) => r.decision === 'review').length,
    loss: rows.reduce((n, r) => n + loss[r.label][r.decision], 0),
    rows,
  };
}
export interface PolicyGate {
  pass: boolean;
  checks: Record<string, boolean>;
  baseline: PolicyMetrics;
  candidate: PolicyMetrics;
  costRatio: number | null;
}
export function policyGate(
  baseline: PolicyMetrics,
  candidate: PolicyMetrics,
  costRatio: number | null,
): PolicyGate {
  const signature = (m: PolicyMetrics) =>
    JSON.stringify(m.rows.map((r) => [r.id, r.family, r.label]).sort());
  const checks = {
    pairedReferences: signature(baseline) === signature(candidate),
    noNewFalsePositives: candidate.falsePositives.every((id) =>
      baseline.falsePositives.includes(id),
    ),
    noNewMisses: candidate.misses.every((id) => baseline.misses.includes(id)),
    noNewAmbiguousSpam: candidate.ambiguousSpam.every((id) => baseline.ambiguousSpam.includes(id)),
    preserveCorrectReviews: baseline.correctReviews.every((id) =>
      candidate.correctReviews.includes(id),
    ),
    improvesWeightedLoss: baseline.loss - candidate.loss >= 1,
    unnecessaryReviewCap:
      candidate.unnecessaryReviews.length <=
      baseline.unnecessaryReviews.length + Math.floor(0.05 * baseline.total),
    inferenceCostKnownAndBounded:
      costRatio !== null && Number.isFinite(costRatio) && costRatio >= 0 && costRatio <= 1.5,
  };
  return { pass: Object.values(checks).every(Boolean), checks, baseline, candidate, costRatio };
}
export function referenceIssues(examples: Example[]) {
  const counts = { spam: 0, ham: 0, review: 0 };
  for (const e of examples) if (e.label) counts[e.label]++;
  const issues = Object.entries(referenceMinimum)
    .filter(([label, min]) => counts[label as keyof typeof counts] < min)
    .map(([label, min]) => `Needs ${min} ${label === 'ham' ? 'legitimate' : label} references`);
  if (new Set(examples.map((e) => e.family)).size < 5)
    issues.push('Needs at least five independent message families');
  return issues;
}
export function splitReferences(pool: Example[], developmentFamilies: Set<string>) {
  // Identical classifier inputs cannot become independent through renamed family aliases.
  const identities = new Map<string, Example>();
  for (const e of pool) {
    const key = JSON.stringify({ text: e.text, context: e.context || [], media: e.media || '' });
    const old = identities.get(key);
    if (old && old.label !== e.label)
      throw new Error('Conflicting labels for identical message/context must be adjudicated.');
    if (!old || developmentFamilies.has(e.family || '')) identities.set(key, e);
  }
  pool = [...identities.values()];
  const phases: { development: Example[]; validation: Example[]; test: Example[] } = {
    development: [],
    validation: [],
    test: [],
  };
  const groups = new Map<string, Example[]>();
  for (const e of pool) {
    if (!e.family || !e.label) continue;
    const g = groups.get(e.family) || [];
    g.push(e);
    groups.set(e.family, g);
  }
  const remaining = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [f, g] of remaining)
    if (developmentFamilies.has(f)) {
      phases.development.push(...g);
      groups.delete(f);
    }
  // Required reviews count as correct decisions: the oracle always has zero loss.
  for (const phase of ['validation', 'test', 'development'] as const)
    for (const label of ['ham', 'spam', 'review'] as const) {
      for (const [family, g] of [...groups]) {
        if (phases[phase].filter((e) => e.label === label).length >= referenceMinimum[label]) break;
        if (!g.some((e) => e.label === label)) continue;
        phases[phase].push(...g);
        groups.delete(family);
      }
    }
  for (const phase of ['validation', 'test', 'development'] as const)
    for (const [family, g] of [...groups]) {
      if (new Set(phases[phase].map((e) => e.family)).size >= 5) break;
      phases[phase].push(...g);
      groups.delete(family);
    }
  let i = 0;
  for (const g of groups.values())
    phases[(['development', 'validation', 'test'] as const)[i++ % 3]].push(...g);
  return {
    phases,
    issues: Object.entries(phases).flatMap(([phase, examples]) =>
      referenceIssues(examples).map((issue) => `${phase}: ${issue}`),
    ),
  };
}
export interface CorrectionSnapshot {
  unresolvedConflict?: boolean;
  example: Example;
  prediction: Prediction | null;
  policy: string;
  settings: Settings | null;
  model?: { provider: string; model: string };
  action: { status: string; deleted?: number; strikeAwarded?: number };
  feedback?: { reasonCode: string; note: string };
}
export interface CorrectionEvent {
  id: string;
  source: string;
  input_hash: string;
  family: string;
  label: Label;
  reason_code: string;
  note: string;
  disposition: string;
  snapshot: string;
  created_at: number;
}
export interface PolicyDraft {
  id: string;
  status: string;
  parent: string;
  created_at: number;
  baseline: Settings;
  candidate: string;
  causes: string[];
  evidenceIds: string[];
  clarification: string;
  corpus?: ReturnType<typeof splitReferences>['phases'];
  corpusHash?: string;
  runs?: Partial<Record<'development' | 'validation' | 'test', string[]>>;
  results?: Partial<Record<'development' | 'validation' | 'test', PolicyGate>>;
  error: string;
  usage?: { tokens: number | null; cost: number | null };
  updatedAt: number;
  referenceCounts?: Record<string, number>;
  proposalRoute?: { model: string; provider: string };
  observedRoute?: { model: string; provider: string };
  failedPhase?: 'development' | 'validation' | 'test';
  referenceOrigins?: { source: string; state: string }[];
}
export interface ImprovementOverview {
  triggerFamilies: number;
  readyCauses: { reason: string; label: Label; families: number }[];
  feedback: CorrectionEvent[];
  drafts: PolicyDraft[];
  activeVersion: string;
  versions: { id: string; parent: string; policy: string; created_at: number; source: string }[];
  referenceCount: number;
}

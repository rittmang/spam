import { describe, expect, it } from 'vitest';
import {
  decisionSettings,
  familyText,
  normalizedPolicy,
  policyDiff,
  policyFingerprint,
  policyGate,
  policyMetrics,
  referenceIssues,
  relatedText,
  routed,
  splitReferences,
} from '../shared/improvement';
import { defaultSettings, type Example, type Label, type Prediction } from '../shared/types';

type Decision = Exclude<Label, null>;
const thresholds = { threshold: 0.9, reviewThreshold: 0.6 };

function reference(id: string, label: Label, family = id): Example {
  return { id, text: `Independent message ${id}`, label, family };
}

function prediction(id: string, decision: Decision): Prediction {
  return {
    id,
    score: decision === 'spam' ? 1 : 0,
    needs_review: decision === 'review',
    category: 'not a routing instruction',
    reason: 'Synthetic domain-test result',
  };
}

function measured(examples: Example[], decisions: Record<string, Decision>) {
  return policyMetrics(
    examples,
    examples.map((e) => prediction(e.id, decisions[e.id] ?? (e.label as Decision))),
    thresholds,
  );
}

// Twenty paired inputs make the 5% unnecessary-review allowance exactly one.
function gateFixture() {
  const examples = [
    reference('ham-stable', 'ham'),
    reference('ham-fix-a', 'ham'),
    reference('ham-fix-b', 'ham'),
    reference('spam-stable', 'spam'),
    reference('spam-fix', 'spam'),
    reference('review-required', 'review'),
    reference('review-fix', 'review'),
    ...Array.from({ length: 13 }, (_, i) => reference(`ham-extra-${i}`, 'ham')),
  ];
  const baseline = measured(examples, {
    'ham-fix-a': 'spam',
    'ham-fix-b': 'spam',
    'spam-fix': 'ham',
    'review-fix': 'ham',
  });
  return { examples, baseline, candidate: measured(examples, {}) };
}

function independentPool(): Example[] {
  return Array.from({ length: 18 }, (_, i) => {
    const family = `campaign-${String(i).padStart(2, '0')}`;
    return (['ham', 'spam', 'review'] as const).map((label) =>
      reference(`${family}-${label}`, label, family),
    );
  }).flat();
}

describe('policy routing and reference metrics', () => {
  it.each([0, 0.6, 0.9, 1])('routes an explicit review to review even with score %s', (score) => {
    expect(routed({ ...prediction('x', 'spam'), score, needs_review: true }, thresholds)).toBe(
      'review',
    );
  });

  it.each([
    [0.5999, 'ham'],
    [0.6, 'review'],
    [0.8999, 'review'],
    [0.9, 'spam'],
  ] as const)('routes score %s to %s at the configured boundaries', (score, decision) => {
    expect(routed({ ...prediction('x', 'ham'), score, category: 'spam' }, thresholds)).toBe(
      decision,
    );
  });

  it('counts review workload, distinct errors, and losses from predictions paired by ID', () => {
    const examples = (['ham', 'spam', 'review'] as const).flatMap((label) =>
      (['ham', 'spam', 'review'] as const).map((decision) =>
        reference(`${label}-${decision}`, label, `family-${label}`),
      ),
    );
    const predictions = examples
      .map((e) => prediction(e.id, e.id.split('-')[1] as Decision))
      .reverse();
    const metrics = policyMetrics(examples, predictions, thresholds);
    expect(metrics).toMatchObject({
      total: 9,
      families: 3,
      falsePositives: ['ham-spam'],
      misses: ['spam-ham'],
      ambiguousSpam: ['review-spam'],
      correctReviews: ['review-review'],
      unnecessaryReviews: ['ham-review'],
      spamFlagged: 1,
      spamDeferred: 1,
      reviews: 3,
      loss: 18.75,
    });
    expect(metrics.rows.map((row) => row.id)).toEqual(examples.map((e) => e.id));
  });

  it.each([
    { name: 'empty corpus', examples: [] as Example[] },
    { name: 'unlabelled message', examples: [reference('unlabelled', null)] },
    {
      name: 'missing family',
      examples: [{ ...reference('no-family', 'ham'), family: undefined }],
    },
  ])('requires labelled family-aware references: $name', ({ examples }) => {
    expect(() => policyMetrics(examples, [], thresholds)).toThrow(
      'Every reference needs a label and family',
    );
  });

  it('rejects duplicate, missing, or unknown result IDs instead of silently pairing rows', () => {
    const examples = [reference('a', 'ham'), reference('b', 'spam')];
    expect(() => policyMetrics(examples, [prediction('a', 'ham')], thresholds)).toThrow();
    expect(() =>
      policyMetrics(examples, [prediction('a', 'ham'), prediction('a', 'spam')], thresholds),
    ).toThrow();
    expect(() =>
      policyMetrics(examples, [prediction('a', 'ham'), prediction('unknown', 'spam')], thresholds),
    ).toThrow();
    expect(() =>
      policyMetrics(
        [examples[0], examples[0]],
        [prediction('a', 'ham'), prediction('b', 'spam')],
        thresholds,
      ),
    ).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01])(
    'rejects invalid score %s before computing metrics',
    (score) => {
      expect(() =>
        policyMetrics([reference('a', 'ham')], [{ ...prediction('a', 'ham'), score }], thresholds),
      ).toThrow('Invalid or missing prediction');
    },
  );
});

describe('paired policy regression gates', () => {
  it('accepts a safer improvement that repairs errors and adds an appropriate review', () => {
    const { baseline, candidate } = gateFixture();
    const gate = policyGate(baseline, candidate, 1.5);
    expect(gate.pass).toBe(true);
    expect(Object.values(gate.checks).every(Boolean)).toBe(true);
    expect(candidate.correctReviews).toEqual(['review-required', 'review-fix']);
    expect(candidate.loss).toBe(0);
  });

  it.each([
    ['ham-stable', 'spam', 'noNewFalsePositives'],
    ['spam-stable', 'ham', 'noNewMisses'],
    ['review-fix', 'spam', 'noNewAmbiguousSpam'],
    ['review-required', 'ham', 'preserveCorrectReviews'],
  ] as const)(
    'rejects a new %s → %s regression even when total loss improves',
    (id, decision, check) => {
      const { examples, baseline } = gateFixture();
      const candidate = measured(examples, { [id]: decision });
      const gate = policyGate(baseline, candidate, 1);
      expect(gate.checks.improvesWeightedLoss).toBe(true);
      expect(gate.checks[check]).toBe(false);
      expect(gate.pass).toBe(false);
    },
  );

  it('rejects swapping false positives even when the count and loss improve', () => {
    const { examples, baseline } = gateFixture();
    const candidate = measured(examples, { 'ham-stable': 'spam', 'ham-fix-a': 'spam' });
    expect(candidate.falsePositives).toHaveLength(baseline.falsePositives.length);
    const gate = policyGate(baseline, candidate, 1);
    expect(gate.checks.improvesWeightedLoss).toBe(true);
    expect(gate.checks.noNewFalsePositives).toBe(false);
    expect(gate.pass).toBe(false);
  });

  it('allows existing errors to remain while other errors are corrected', () => {
    const { examples, baseline } = gateFixture();
    const candidate = measured(examples, { 'ham-fix-a': 'spam', 'spam-fix': 'ham' });
    expect(policyGate(baseline, candidate, 1).pass).toBe(true);
  });

  it('caps unnecessary reviews independently of preserving required reviews', () => {
    const { examples, baseline } = gateFixture();
    const one = measured(examples, { 'ham-stable': 'review' });
    const two = measured(examples, { 'ham-stable': 'review', 'ham-extra-0': 'review' });
    expect(policyGate(baseline, one, 1).pass).toBe(true);
    const gate = policyGate(baseline, two, 1);
    expect(gate.checks.preserveCorrectReviews).toBe(true);
    expect(gate.checks.improvesWeightedLoss).toBe(true);
    expect(gate.checks.unnecessaryReviewCap).toBe(false);
    expect(gate.pass).toBe(false);
  });

  it('has no rounded-up unnecessary-review allowance for a small reference set', () => {
    const examples = [reference('repair', 'ham'), reference('stable', 'ham')];
    const baseline = measured(examples, { repair: 'spam' });
    const candidate = measured(examples, { stable: 'review' });
    expect(policyGate(baseline, candidate, 1).checks.unnecessaryReviewCap).toBe(false);
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.5001])(
    'requires known bounded inference cost, rejecting ratio %s',
    (costRatio) => {
      const { baseline, candidate } = gateFixture();
      const gate = policyGate(baseline, candidate, costRatio);
      expect(gate.checks.inferenceCostKnownAndBounded).toBe(false);
      expect(gate.pass).toBe(false);
    },
  );

  it.each([0, 1, 1.5])('accepts a known in-budget cost ratio of %s', (ratio) => {
    const { baseline, candidate } = gateFixture();
    expect(policyGate(baseline, candidate, ratio).pass).toBe(true);
  });

  it('requires at least one full unit of weighted improvement', () => {
    const reviewExample = [reference('uncertain', 'review')];
    const corrected = measured(reviewExample, {});
    expect(policyGate(measured(reviewExample, { uncertain: 'ham' }), corrected, 1).pass).toBe(true);
    expect(policyGate(corrected, corrected, 1).checks.improvesWeightedLoss).toBe(false);
    const spamExample = [reference('scam', 'spam')];
    expect(
      policyGate(measured(spamExample, { scam: 'review' }), measured(spamExample, {}), 1).checks
        .improvesWeightedLoss,
    ).toBe(false);
  });

  it.each(['id', 'family', 'label'] as const)(
    'rejects comparisons where a reference %s changes',
    (field) => {
      const { examples, baseline } = gateFixture();
      const altered = structuredClone(examples);
      if (field === 'label') altered[0].label = 'spam';
      else altered[0][field] = 'different-reference';
      const gate = policyGate(baseline, measured(altered, {}), 1);
      expect(gate.checks.pairedReferences).toBe(false);
      expect(gate.pass).toBe(false);
    },
  );

  it('compares paired references by identity rather than input ordering', () => {
    const { examples, baseline } = gateFixture();
    expect(policyGate(baseline, measured([...examples].reverse(), {}), 1).pass).toBe(true);
  });
});

describe('independent reference phases', () => {
  it('keeps campaign families together and reserves correction families for development', () => {
    const pool = independentPool();
    const original = structuredClone(pool);
    const developmentFamilies = new Set(['campaign-00', 'campaign-01']);
    const { phases, issues } = splitReferences(pool, developmentFamilies);
    expect(issues).toEqual([]);
    expect(pool).toEqual(original);
    const owners = new Map<string, string>();
    for (const [phase, examples] of Object.entries(phases)) {
      expect(referenceIssues(examples)).toEqual([]);
      for (const e of examples) {
        expect(owners.get(e.family!) ?? phase).toBe(phase);
        owners.set(e.family!, phase);
        if (developmentFamilies.has(e.family!)) expect(phase).toBe('development');
      }
    }
    const all = Object.values(phases).flat();
    expect(all).toHaveLength(pool.length);
    expect(new Set(all.map((e) => e.id)).size).toBe(pool.length);
    expect(owners.size).toBe(18);
  });

  it('has a feasible zero-loss review-aware oracle in every complete phase', () => {
    const { phases, issues } = splitReferences(independentPool(), new Set(['campaign-00']));
    expect(issues).toEqual([]);
    for (const examples of Object.values(phases)) {
      const wrong = Object.fromEntries(
        examples.map((e) => [e.id, e.label === 'ham' ? 'spam' : 'ham']),
      ) as Record<string, Decision>;
      const oracle = measured(examples, {});
      expect(oracle.loss).toBe(0);
      expect(oracle.correctReviews).toHaveLength(
        examples.filter((e) => e.label === 'review').length,
      );
      expect(oracle.reviews).toBeGreaterThan(0);
      expect(policyGate(measured(examples, wrong), oracle, 1).pass).toBe(true);
    }
  });

  it.each([false, true])(
    'deduplicates identical input aliases into the development family regardless of order (%s)',
    (reverse) => {
      const alias = { ...reference('alias-heldout', 'ham', 'heldout-alias'), text: 'Same input' };
      const development = {
        ...reference('alias-development', 'ham', 'correction-family'),
        text: 'Same input',
        context: [],
        media: '',
      };
      const aliases = reverse ? [development, alias] : [alias, development];
      const { phases, issues } = splitReferences(
        [...independentPool(), ...aliases],
        new Set(['correction-family']),
      );
      expect(issues).toEqual([]);
      const copies = Object.values(phases)
        .flat()
        .filter((e) => e.text === 'Same input');
      expect(copies.map((e) => e.id)).toEqual(['alias-development']);
      expect(phases.development.some((e) => e.id === 'alias-development')).toBe(true);
    },
  );

  it.each(['spam', 'review'] as const)(
    'requires adjudication when identical input has conflicting ham/%s labels',
    (otherLabel) => {
      const same = {
        ...reference('a', 'ham', 'family-a'),
        text: 'Identical',
        context: ['Context'],
        media: 'photo',
      };
      const conflict = { ...same, id: 'b', family: 'family-b', label: otherLabel };
      expect(() => splitReferences([same, conflict], new Set())).toThrow(
        'Conflicting labels for identical message/context must be adjudicated',
      );
    },
  );

  it('retains different contextual or media evidence even when current message text matches', () => {
    const variants: Example[] = [
      {
        ...reference('context-a', 'ham', 'context-family'),
        text: 'Hello',
        context: ['Invited greeting'],
      },
      {
        ...reference('context-b', 'spam', 'context-family'),
        text: 'Hello',
        context: ['Repeated disruption'],
      },
      { ...reference('media-a', 'ham', 'media-family'), text: 'Hello', media: '' },
      { ...reference('media-b', 'review', 'media-family'), text: 'Hello', media: 'photo' },
    ];
    const { phases } = splitReferences([...independentPool(), ...variants], new Set());
    const retained = Object.values(phases)
      .flat()
      .filter((e) => e.text === 'Hello');
    expect(retained.map((e) => e.id).sort()).toEqual(variants.map((e) => e.id).sort());
  });

  it('reports infeasible phase coverage instead of presenting a tiny corpus as independent validation', () => {
    const { issues } = splitReferences(
      [reference('a', 'ham', 'one-family')],
      new Set(['one-family']),
    );
    for (const phase of ['development', 'validation', 'test']) {
      expect(issues.some((issue) => issue.startsWith(`${phase}:`))).toBe(true);
    }
    expect(issues).toContain('development: Needs at least five independent message families');
    expect(issues).toContain('test: Needs 1 review references');
  });
});

describe('policy identity and human-readable diffs', () => {
  it('preserves the decision fingerprint when only mode, budgets, or operating settings change', async () => {
    const changed = {
      ...defaultSettings,
      mode: 'enforce' as const,
      dailyTokenBudget: defaultSettings.dailyTokenBudget + 1000,
      batchSeconds: 5,
      batchSize: 10,
      retentionDays: 365,
      exemptUserIds: ['123'],
    };
    const original = structuredClone(defaultSettings);
    expect(decisionSettings(changed)).toEqual(decisionSettings(defaultSettings));
    const fingerprint = await policyFingerprint(defaultSettings);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await policyFingerprint(changed)).toBe(fingerprint);
    expect(defaultSettings).toEqual(original);
  });

  it.each([
    { policy: `${defaultSettings.policy}\nPreserve relevant announcements.` },
    { provider: 'another-provider' },
    { model: 'another-model' },
    { threshold: 0.95 },
    { reviewThreshold: 0.5 },
    { imageModeration: !defaultSettings.imageModeration },
    { imageProvider: 'another-image-provider' },
    { imageModel: 'another-image-model' },
  ])('changes the fingerprint for a decision setting %j', async (change) => {
    expect(await policyFingerprint({ ...defaultSettings, ...change })).not.toBe(
      await policyFingerprint(defaultSettings),
    );
  });

  it('normalizes policy formatting without changing its words or case', () => {
    expect(normalizedPolicy('  Allow greetings.\n\n  Block\t scams.  ')).toBe(
      'Allow greetings. Block scams.',
    );
  });

  it.each([
    [
      'Keep greetings.\nBlock scams.\nAsk for context.',
      'Keep greetings.\nBlock phishing.\nAsk for context.\nAllow event posts.',
    ],
    ['repeat\n\nrepeat\nend', '\nrepeat\nend\nrepeat'],
    ['', 'Allow greetings.'],
    ['Allow greetings.', ''],
  ])('reconstructs both policies without losing blank or repeated lines', (before, after) => {
    const diff = policyDiff(before, after);
    expect(
      diff
        .filter((line) => line.kind !== 'added')
        .map((line) => line.text)
        .join('\n'),
    ).toBe(before);
    expect(
      diff
        .filter((line) => line.kind !== 'removed')
        .map((line) => line.text)
        .join('\n'),
    ).toBe(after);
    expect(diff.every((line) => ['unchanged', 'added', 'removed'].includes(line.kind))).toBe(true);
  });

  it('preserves unchanged context around a replacement and an appended rule', () => {
    const diff = policyDiff(
      'Keep greetings.\nBlock scams.',
      'Keep greetings.\nBlock phishing.\nAsk for context.',
    );
    expect(diff).toContainEqual({ kind: 'unchanged', text: 'Keep greetings.' });
    expect(diff).toContainEqual({ kind: 'removed', text: 'Block scams.' });
    expect(diff).toContainEqual({ kind: 'added', text: 'Block phishing.' });
    expect(diff).toContainEqual({ kind: 'added', text: 'Ask for context.' });
  });

  it('returns an unchanged policy entirely as unchanged lines', () => {
    expect(
      policyDiff('Allow greetings.\n\nBlock scams.', 'Allow greetings.\n\nBlock scams.'),
    ).toEqual([
      { kind: 'unchanged', text: 'Allow greetings.' },
      { kind: 'unchanged', text: '' },
      { kind: 'unchanged', text: 'Block scams.' },
    ]);
  });

  it('keeps large-policy diffs bounded while preserving the complete old and new text', () => {
    const before = Array.from({ length: 220 }, (_, i) => `Old policy line ${i}`).join('\n');
    const after = Array.from({ length: 220 }, (_, i) => `New policy line ${i}`).join('\n');
    const diff = policyDiff(before, after);
    expect(diff.length).toBeLessThanOrEqual(440);
    expect(
      diff
        .filter((line) => line.kind !== 'added')
        .map((line) => line.text)
        .join('\n'),
    ).toBe(before);
    expect(
      diff
        .filter((line) => line.kind !== 'removed')
        .map((line) => line.text)
        .join('\n'),
    ).toBe(after);
  });

  it('groups cosmetic campaign changes while retaining multilingual text', () => {
    const a = familyText('Hiiii @alice claim 123 at https://first.invalid now! नमस्ते');
    const b = familyText('Hiiiiii @bob claim 456 at https://second.invalid now? नमस्ते');
    expect(a).toBe(b);
    expect(a).toContain('नमस्ते');
    expect(relatedText(a, b)).toBe(true);
  });

  it('treats canonically equivalent Unicode campaign text as the same family', () => {
    expect(familyText('Café learners say नमस्ते')).toBe(
      familyText('Cafe\u0301 learners say नमस्ते'),
    );
  });

  it('does not merge distinct short greetings on weak word overlap', () => {
    expect(relatedText(familyText('hello there'), familyText('hello again'))).toBe(false);
    expect(relatedText(familyText('hello'), familyText('hello'))).toBe(true);
  });
});

import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Settings } from '../shared/types';
import {
  feedbackSchema,
  policyFingerprint,
  type CorrectionSnapshot,
  type FeedbackInput,
} from '../shared/improvement';
import { SqliteDatabase } from '../worker/database';
import type { Env } from '../worker/env';
import { GroupService } from '../worker/group';
import { ImprovementService } from '../worker/improvement';
import { GroupModerator } from '../worker/local-group';

let externalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  externalFetch = vi.fn(async () => {
    throw new Error('Correction recording must not call Telegram or a model provider.');
  });
  vi.stubGlobal('fetch', externalFetch);
});
afterEach(async () => {
  try {
    expect(externalFetch).not.toHaveBeenCalled();
  } finally {
    await reset();
    vi.unstubAllGlobals();
  }
});

function snapshot(id: string, text = `Independent synthetic message ${id}`): CorrectionSnapshot {
  return {
    example: { id, text, label: null, context: [], media: '' },
    prediction: { id, score: 0.05, category: 'ordinary', reason: 'Original model judgment' },
    policy: defaultSettings.policy,
    settings: structuredClone(defaultSettings),
    model: { provider: defaultSettings.provider, model: defaultSettings.model },
    action: { status: 'allowed', deleted: 0, strikeAwarded: 0 },
  };
}
function feedback(values: Partial<FeedbackInput> = {}): FeedbackInput {
  return feedbackSchema.parse({ label: 'spam', reasonCode: 'promotion', ...values });
}
interface Services {
  db: SqliteDatabase;
  improvement: ImprovementService;
  group: GroupService;
  settings: () => Promise<Settings>;
  wake: ReturnType<typeof vi.fn>;
}
async function withServices(task: (services: Services) => Promise<void>) {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(crypto.randomUUID()));
  await runInDurableObject<GroupModerator, void>(stub, async (_instance, state) => {
    // GroupModerator constructs the real additive schema before this callback.
    const db = new SqliteDatabase(state);
    const settings = async () => {
      const [row] = await db.exec<{ value: string }>('SELECT value FROM config WHERE id=1');
      return { ...defaultSettings, ...JSON.parse(row.value) } as Settings;
    };
    const wake = vi.fn(async () => {});
    const localEnv = env as unknown as Env;
    await task({
      db,
      settings,
      wake,
      improvement: new ImprovementService(db, localEnv, settings, wake),
      group: new GroupService(db, localEnv, wake),
    });
  });
}
function request(path: string, body: unknown) {
  return new Request(`https://group.internal/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('reasoned correction intake in local Durable Object storage', () => {
  it('queues one draft after three fresh correction families without changing live settings', async () => {
    await withServices(async ({ db, improvement, settings, wake }) => {
      const before = await settings();
      for (const [index, text] of [
        'Unrequested commercial enrollment solicitation',
        'Unrelated referral commission recruitment',
        'Paid membership advertisement without a request',
      ].entries()) {
        const result = await improvement.record(
          `live:${index}`,
          snapshot(String(index), text),
          feedback({
            family: `promotion-boundary-${index}`,
            note: 'Unsolicited commercial intent.',
          }),
        );
        expect(result.disposition).toBe('accepted');
        expect((await improvement.overview()).drafts).toHaveLength(index === 2 ? 1 : 0);
      }
      const overview = await improvement.overview();
      expect(overview.drafts[0]).toMatchObject({
        status: 'queued',
        parent: await policyFingerprint(before),
        candidate: '',
        causes: ['promotion:spam'],
        baseline: before,
      });
      expect(overview.drafts[0].evidenceIds).toHaveLength(3);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(await settings()).toEqual(before);
      expect(await db.exec('SELECT * FROM actions')).toEqual([]);
      expect(await db.exec('SELECT * FROM evaluations')).toEqual([]);
    });
  });

  it('does not count confirmations or corrections without a reason toward a draft', async () => {
    await withServices(async ({ improvement, wake }) => {
      for (let index = 0; index < 3; index++) {
        expect(
          await improvement.record(
            `confirmation:${index}`,
            snapshot(`confirmation-${index}`),
            feedback({
              label: 'ham',
              reasonCode: 'ordinary_conversation',
              family: `confirmed-${index}`,
            }),
          ),
        ).toMatchObject({ disposition: 'accepted' });
        expect(
          await improvement.record(
            `unexplained:${index}`,
            snapshot(`unexplained-${index}`),
            feedback({ reasonCode: undefined, family: `unexplained-${index}` }),
          ),
        ).toMatchObject({ disposition: 'needs_reason' });
      }
      const overview = await improvement.overview();
      expect(overview.feedback).toHaveLength(6);
      expect(overview.readyCauses).toEqual([]);
      expect(overview.drafts).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    });
  });

  it('counts repeated corrections from the same family only once', async () => {
    await withServices(async ({ improvement, wake }) => {
      for (let index = 0; index < 4; index++) {
        await improvement.record(
          `same-family:${index}`,
          snapshot(`same-family-${index}`, `Distinct wording for solicitation ${index}`),
          feedback({ family: 'one promotion template' }),
        );
      }
      expect((await improvement.overview()).readyCauses).toEqual([
        { reason: 'promotion', label: 'spam', families: 1 },
      ]);
      expect((await improvement.overview()).drafts).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    });
  });

  it('groups normalized copies into one automatic family without owner family aliases', async () => {
    await withServices(async ({ improvement, wake }) => {
      for (const [index, text] of [
        'Join https://one.invalid/offer for 123 credits @seller_one',
        'Join https://two.invalid/deal for 456 credits @seller_two',
        'Join https://three.invalid/sale for 789 credits @seller_three',
      ].entries()) {
        await improvement.record(`copy:${index}`, snapshot(`copy-${index}`, text), feedback());
      }
      expect((await improvement.overview()).readyCauses[0].families).toBe(1);
      expect((await improvement.overview()).drafts).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    });
  });

  it('requires three families for one reason and label rather than mixing unrelated causes', async () => {
    await withServices(async ({ improvement }) => {
      for (const [index, reasonCode] of ['promotion', 'promotion', 'scam'].entries()) {
        await improvement.record(
          `cause:${index}`,
          snapshot(`cause-${index}`),
          feedback({
            family: `cause-family-${index}`,
            reasonCode: reasonCode as FeedbackInput['reasonCode'],
          }),
        );
      }
      expect((await improvement.overview()).drafts).toEqual([]);
      await improvement.record(
        'cause:3',
        snapshot('cause-3'),
        feedback({ family: 'cause-family-3' }),
      );
      expect((await improvement.overview()).drafts[0].evidenceIds).toHaveLength(3);
      expect((await improvement.overview()).drafts[0].causes).toEqual(['promotion:spam']);
    });
  });

  it('does not recycle consumed families after a queued draft is discarded', async () => {
    await withServices(async ({ improvement, wake }) => {
      for (let index = 0; index < 3; index++) {
        await improvement.record(
          `fresh:${index}`,
          snapshot(`fresh-${index}`),
          feedback({ family: `fresh-${index}` }),
        );
      }
      const draft = (await improvement.overview()).drafts[0];
      const response = await improvement.handle(request(`/improvement/${draft.id}/discard`, {}));
      expect(response?.status).toBe(200);
      await improvement.record('fresh:3', snapshot('fresh-3'), feedback({ family: 'fresh-3' }));
      const overview = await improvement.overview();
      expect(overview.drafts).toHaveLength(1);
      expect(overview.drafts[0].status).toBe('discarded');
      expect(overview.readyCauses).toEqual([{ reason: 'promotion', label: 'spam', families: 1 }]);
      expect(wake).toHaveBeenCalledTimes(1);
    });
  });

  it('makes event IDs idempotent and rejects reuse with different correction content', async () => {
    await withServices(async ({ db, improvement }) => {
      const original = snapshot('idempotent');
      const event = feedback({ eventId: crypto.randomUUID(), family: 'idempotent' });
      const first = await improvement.record('live:idempotent', original, event);
      expect(await improvement.record('live:idempotent', original, event)).toEqual(first);
      const before = await db.exec('SELECT * FROM feedback_events');
      await expect(
        improvement.record('live:idempotent', original, { ...event, note: 'Changed correction.' }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await db.exec('SELECT * FROM feedback_events')).toEqual(before);
      expect(before).toHaveLength(1);
    });
  });

  it('keeps conflicting labels held until an explicit resolution, preserving every earlier event', async () => {
    await withServices(async ({ db, improvement }) => {
      const original = snapshot('conflict');
      expect(await improvement.record('live:conflict', original, feedback())).toMatchObject({
        disposition: 'accepted',
      });
      const first = (
        await db.exec<{ snapshot: string; label: string }>('SELECT * FROM feedback_events')
      )[0];
      for (const label of ['ham', 'ham', 'spam'] as const) {
        expect(
          await improvement.record('live:conflict', original, feedback({ label })),
        ).toMatchObject({ disposition: 'conflicting_label' });
      }
      expect((await improvement.overview()).readyCauses).toEqual([]);
      expect(
        await improvement.record('live:conflict', original, feedback({ label: null })),
      ).toMatchObject({ disposition: 'retracted' });
      expect(await improvement.record('live:conflict', original, feedback())).toMatchObject({
        disposition: 'conflicting_label',
      });
      expect(
        await improvement.record('live:conflict', original, feedback({ resolveConflict: true })),
      ).toMatchObject({ disposition: 'accepted' });
      const events = await db.exec<{ snapshot: string; label: string }>(
        'SELECT * FROM feedback_events ORDER BY created_at',
      );
      expect(events).toHaveLength(7);
      expect(events[0].snapshot).toBe(first.snapshot);
      expect(events[0].label).toBe('spam');
      expect(JSON.parse(events[0].snapshot).prediction).toEqual(original.prediction);
      expect((await improvement.overview()).drafts).toEqual([]);
    });
  });

  it('holds incomplete context, image evidence, absent predictions and unknown original thresholds', async () => {
    await withServices(async ({ improvement, wake }) => {
      const image = snapshot('image');
      image.example.media = 'photo';
      const unclassified = snapshot('unclassified');
      unclassified.prediction = null;
      const legacy = snapshot('legacy');
      legacy.settings = null;
      const cases = [
        {
          source: 'incomplete',
          original: snapshot('incomplete'),
          body: feedback({ contextComplete: false }),
          disposition: 'needs_context',
        },
        { source: 'image', original: image, body: feedback(), disposition: 'needs_image_evidence' },
        {
          source: 'unclassified',
          original: unclassified,
          body: feedback(),
          disposition: 'needs_original_prediction',
        },
        {
          source: 'legacy',
          original: legacy,
          body: feedback(),
          disposition: 'needs_original_thresholds',
        },
      ];
      for (const entry of cases) {
        expect(await improvement.record(entry.source, entry.original, entry.body)).toMatchObject({
          disposition: entry.disposition,
        });
      }
      expect((await improvement.overview()).readyCauses).toEqual([]);
      expect((await improvement.overview()).drafts).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    });
  });
});

describe('GroupService correction provenance', () => {
  it('appends feedback from frozen predictions while later labels and actions remain independent', async () => {
    await withServices(async ({ db, group, settings }) => {
      const original = snapshot('41', 'A relevant community announcement');
      original.prediction = {
        id: '41',
        score: 0.99,
        category: 'spam',
        reason: 'Original false positive',
      };
      const frozen = JSON.stringify(original);
      await db.exec(
        "INSERT INTO messages (id,user_id,user_name,text,sent_at,status,score,reason,category,model,telegram_revision,classification_snapshot) VALUES (41,'42','Synthetic sender',?,?,'observed_spam',0.99,'Original false positive','spam',?,1,?)",
        original.example.text,
        Date.now(),
        defaultSettings.model,
        frozen,
      );
      const beforeSettings = await settings();
      const first = await group.fetch(
        request('/messages/41/label', {
          label: 'ham',
          reasonCode: 'relevant_announcement',
          note: 'Relevant to this community.',
          eventId: crypto.randomUUID(),
        }),
      );
      expect(first.status).toBe(200);
      const [before] = await db.exec<{ snapshot: string }>('SELECT snapshot FROM feedback_events');
      await db.exec(
        "INSERT INTO actions (kind,user_id,message_id,payload,status) VALUES ('delete','42',41,'{}','complete')",
      );
      await db.exec(
        "UPDATE messages SET status='deleted',deleted=1,strike_awarded=1,score=0.02,reason='Later action state' WHERE id=41",
      );
      const second = await group.fetch(
        request('/messages/41/label', {
          label: 'ham',
          reasonCode: 'relevant_announcement',
          note: 'Confirm correction after the independent action.',
          eventId: crypto.randomUUID(),
        }),
      );
      expect(second.status).toBe(200);
      const rows = await db.exec<{ snapshot: string; label: string }>(
        'SELECT snapshot,label FROM feedback_events ORDER BY created_at',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].snapshot).toBe(before.snapshot);
      const earlier = JSON.parse(rows[0].snapshot) as CorrectionSnapshot;
      const later = JSON.parse(rows[1].snapshot) as CorrectionSnapshot;
      expect(earlier.prediction).toEqual(original.prediction);
      expect(later.prediction).toEqual(original.prediction);
      expect(earlier.action).toMatchObject({
        status: 'observed_spam',
        deleted: 0,
        strikeAwarded: 0,
      });
      expect(later.action).toMatchObject({ status: 'deleted', deleted: 1, strikeAwarded: 1 });
      expect(
        (
          await db.exec<{ classification_snapshot: string; label: string }>(
            'SELECT classification_snapshot,label FROM messages WHERE id=41',
          )
        )[0],
      ).toEqual({ classification_snapshot: frozen, label: 'ham' });
      expect(await db.exec('SELECT * FROM actions')).toHaveLength(1);
      expect(await settings()).toEqual(beforeSettings);
    });
  });

  it('keeps saved evaluation predictions and original labels unchanged when an owner supplies a correction', async () => {
    await withServices(async ({ db, group }) => {
      const settings = JSON.stringify(defaultSettings);
      await db.exec(
        "INSERT INTO datasets (id,name,created_at) VALUES ('source','Synthetic reference',?)",
        Date.now(),
      );
      await db.exec("INSERT INTO dataset_stats (id,count,labelled) VALUES ('source',1,1)");
      await db.exec(
        "INSERT INTO examples (dataset_id,id,position,text,label,context,media) VALUES ('source','reference',0,'Community study session','spam','[]','')",
      );
      await db.exec(
        "INSERT INTO evaluations (id,dataset_id,dataset_name,provider,model,policy,status,total,created_at,settings_snapshot) VALUES ('saved-run','source','Synthetic reference',?,?,?,'complete',1,?,?)",
        defaultSettings.provider,
        defaultSettings.model,
        defaultSettings.policy,
        Date.now(),
        settings,
      );
      await db.exec(
        "INSERT INTO run_examples (run_id,id,position,text,label,context,media) VALUES ('saved-run','reference',0,'Community study session','spam','[]','')",
      );
      await db.exec(
        "INSERT INTO predictions (run_id,id,score,category,reason,needs_review) VALUES ('saved-run','reference',0.99,'spam','Original false positive',0)",
      );
      const before = await db.exec("SELECT * FROM predictions WHERE run_id='saved-run'");
      const response = await group.fetch(
        request('/evaluations/saved-run/reviews', [
          {
            id: 'reference',
            label: 'ham',
            reasonCode: 'relevant_announcement',
            note: 'A relevant student announcement.',
            eventId: crypto.randomUUID(),
          },
        ]),
      );
      expect(response.status).toBe(200);
      expect(await db.exec("SELECT * FROM predictions WHERE run_id='saved-run'")).toEqual(before);
      expect(
        (
          await db.exec<{ label: string }>(
            "SELECT label FROM run_examples WHERE run_id='saved-run'",
          )
        )[0].label,
      ).toBe('spam');
      expect(
        (
          await db.exec<{ label: string }>("SELECT label FROM examples WHERE dataset_id='source'")
        )[0].label,
      ).toBe('ham');
      const [event] = await db.exec<{ snapshot: string; disposition: string }>(
        'SELECT snapshot,disposition FROM feedback_events',
      );
      expect(event.disposition).toBe('accepted');
      expect(JSON.parse(event.snapshot)).toMatchObject({
        prediction: { score: 0.99, reason: 'Original false positive' },
        settings: defaultSettings,
        action: { status: 'label_only' },
      });
    });
  });
});

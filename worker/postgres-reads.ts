import type { PostgresDatabase } from './database';
import type { Overview } from '../shared/types';
import { HttpError } from './http';

const jsonText = (payload: string) =>
  new Response(payload, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

export async function evaluationIndexResponse(db: PostgresDatabase, hidden: string[]) {
  const where = hidden.length ? `r.id NOT IN (${hidden.map(() => '?').join(',')})` : '1=1';
  const [row] = await db.exec<{ payload: string }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(r) || jsonb_build_object('snapshot_key',
      md5(COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',e.id,'text',e.text,'label',e.label,'userId',e.user_id,
        'context',e.context::jsonb,'media',e.media,'family',e.family) ORDER BY e.position)
        FROM run_examples e WHERE e.run_id=r.id), '[]'::jsonb)::text))
      ORDER BY r.created_at DESC), '[]'::jsonb)::text AS payload
      FROM (SELECT r.* FROM evaluations r WHERE ${where} ORDER BY r.created_at DESC LIMIT 12) r`,
    ...hidden,
  );
  return jsonText(row.payload);
}

// Page by both row count and encoded JSON size. A single large message is always
// included so the cursor can advance without truncating its evidence.
export async function evaluationPageResponse(
  db: PostgresDatabase,
  id: string,
  section: 'examples' | 'results',
  offset: number,
  limit: number,
) {
  const examples = section === 'examples';
  const value = examples
    ? `jsonb_build_object('id',e.id,'text',e.text,'label',e.label,'userId',e.user_id,
        'context',e.context::jsonb,'media',e.media,'family',e.family)`
    : `CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id',p.id,'score',p.score,
        'category',p.category,'reason',p.reason,'needs_review',p.needs_review=1) END`;
  const [row] = await db.exec<{ payload: string }>(
    `WITH candidates AS (
      SELECT e.*,${value} AS value FROM run_examples e
      ${examples ? '' : 'LEFT JOIN predictions p ON p.run_id=e.run_id AND p.id=e.id'}
      WHERE e.run_id=? AND e.position>=? ORDER BY e.position LIMIT ?
    ), sized AS (
      SELECT *,ROW_NUMBER() OVER (ORDER BY position) AS ordinal,
        SUM(octet_length(COALESCE(value::text,''))+256) OVER (ORDER BY position) AS bytes
      FROM candidates
    ), page AS (SELECT * FROM sized WHERE bytes<=24000 OR ordinal=1)
    SELECT jsonb_build_object(
      '${examples ? 'examples' : 'predictions'}',COALESCE((SELECT jsonb_agg(value ORDER BY position)
        ${examples ? '' : 'FILTER (WHERE value IS NOT NULL)'} FROM page), '[]'::jsonb),
      ${
        examples
          ? ''
          : `'reviewLabels',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',l.id,'label',l.label,'updated_at',l.updated_at) ORDER BY e.position)
        FROM evaluation_labels l JOIN page e ON e.id=l.id AND e.text=l.text
          AND e.context=l.context AND e.media=l.media
        WHERE l.dataset_id=r.dataset_id), '[]'::jsonb),`
      }
      'nextOffset',CASE WHEN EXISTS(SELECT 1 FROM run_examples e WHERE e.run_id=r.id
        AND e.position>COALESCE((SELECT MAX(position) FROM page),?))
        THEN (SELECT MAX(position)+1 FROM page) ELSE NULL END
    )::text AS payload FROM evaluations r WHERE r.id=?`,
    id,
    offset,
    limit,
    offset,
    id,
  );
  if (!row) throw new HttpError(404, 'Run not found.');
  return jsonText(row.payload);
}

// Return large saved-run JSON as text: parsing thousands of pg rows, decoding their
// contexts, and serializing them again can exhaust the free Worker's CPU budget.
export async function evaluationResponse(db: PostgresDatabase, hidden: string[]) {
  const where = hidden.length ? `r.id NOT IN (${hidden.map(() => '?').join(',')})` : '1=1';
  const [row] = await db.exec<{ payload: string }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(r) || jsonb_build_object(
      'examples', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',e.id,'text',e.text,'label',e.label,'userId',e.user_id,
        'context',e.context::jsonb,'media',e.media,'family',e.family) ORDER BY e.position)
        FROM run_examples e WHERE e.run_id=r.id), '[]'::jsonb),
      'predictions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'score',p.score,'category',p.category,'reason',p.reason,'needs_review',p.needs_review=1) ORDER BY p.id)
        FROM predictions p WHERE p.run_id=r.id), '[]'::jsonb),
      'reviewLabels', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',l.id,'label',l.label,'updated_at',l.updated_at) ORDER BY l.id)
        FROM evaluation_labels l JOIN run_examples e ON e.run_id=r.id AND e.id=l.id
          AND e.text=l.text AND e.context=l.context AND e.media=l.media
        WHERE l.dataset_id=r.dataset_id), '[]'::jsonb)
    ) ORDER BY r.created_at DESC), '[]'::jsonb)::text AS payload
    FROM (SELECT r.* FROM evaluations r WHERE ${where} ORDER BY r.created_at DESC LIMIT 12) r`,
    ...hidden,
  );
  return jsonText(row.payload);
}

export async function overviewRows(db: PostgresDatabase, day: string, since: number) {
  const [row] = await db.exec<{ payload: string }>(
    `SELECT jsonb_build_object(
      'settings',(SELECT value::jsonb FROM config WHERE id=1),
      'state',(SELECT value::jsonb FROM storage_state WHERE id=1),
      'stats',jsonb_build_object(
        'total',(SELECT COUNT(*) FROM messages),
        'spam',(SELECT COUNT(*) FROM messages WHERE status IN ('spam','observed_spam')),
        'deleted',(SELECT COALESCE(SUM(deleted),0) FROM messages),
        'pending',(SELECT COUNT(*) FROM messages WHERE status='pending'),
        'review',(SELECT COUNT(*) FROM messages WHERE status IN ('review','unsupported')),
        'banned',(SELECT COUNT(*) FROM users WHERE banned=1),
        'tokens',COALESCE((SELECT tokens FROM usage WHERE day=?),0),
        'labTokens',COALESCE((SELECT lab_tokens FROM usage WHERE day=?),0),
        'failures',(SELECT COUNT(*) FROM messages WHERE status='error')+
          (SELECT COUNT(*) FROM actions WHERE status='failed')),
      'daily',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.day) FROM (
        SELECT to_char(to_timestamp(sent_at/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
          COUNT(*) AS total,SUM(CASE WHEN status IN ('spam','observed_spam') THEN 1 ELSE 0 END) AS spam
        FROM messages WHERE sent_at>? GROUP BY day) d), '[]'::jsonb),
      'messages',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.sent_at DESC,m.id DESC)
        FROM (SELECT * FROM messages ORDER BY sent_at DESC,id DESC LIMIT 20) m), '[]'::jsonb),
      'users',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.last_seen DESC) FROM (
        SELECT u.*,(SELECT COUNT(*) FROM messages m WHERE m.user_id=u.user_id) AS messages
        FROM users u WHERE strikes>0 ORDER BY last_seen DESC LIMIT 100) u), '[]'::jsonb),
      'audit',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id DESC)
        FROM (SELECT * FROM audit ORDER BY id DESC LIMIT 20) a), '[]'::jsonb)
    )::text AS payload`,
    day,
    day,
    since,
  );
  return JSON.parse(row.payload) as Pick<
    Overview,
    'settings' | 'stats' | 'daily' | 'messages' | 'users' | 'audit'
  > & { state: Awaited<ReturnType<typeof import('./storage').migrationState>> };
}

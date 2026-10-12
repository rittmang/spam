// Local SQLite adapter only. This module is excluded from the production entry point.
import { GroupService } from './group';
import { SqliteDatabase } from './database';
import { defaultSettings } from '../shared/types';
import type { Env } from './env';
import { IMPROVEMENT_SCHEMA } from './improvement-schema';
export interface LocalEnv extends Env {
  GROUPS: DurableObjectNamespace;
}
export class GroupModerator extends GroupService {
  constructor(ctx: DurableObjectState, env: Env) {
    super(new SqliteDatabase(ctx), env, async (delay) => {
      const current = await ctx.storage.getAlarm();
      const when = Date.now() + delay;
      if (current === null || current > when) await ctx.storage.setAlarm(when);
    });
    const first = <T>(sql: string, ...params: (string | number | null)[]) =>
      ctx.storage.sql.exec(sql, ...params).toArray()[0] as T | undefined;
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, name TEXT NOT NULL, strikes INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL,
        status TEXT NOT NULL, score REAL, reason TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        strike_awarded INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, label TEXT, media TEXT NOT NULL DEFAULT '', image_file_id TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1, telegram_revision INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_sender ON messages(user_id, sent_at);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(status, next_at);
      CREATE INDEX IF NOT EXISTS messages_recent ON messages(sent_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', message_id INTEGER, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, user_id TEXT NOT NULL, message_id INTEGER, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending');
      CREATE INDEX IF NOT EXISTS actions_pending ON actions(status, next_at);
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dataset_stats (id TEXT PRIMARY KEY, count INTEGER NOT NULL, labelled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS examples (dataset_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, label TEXT, user_id TEXT, context TEXT NOT NULL, media TEXT NOT NULL, PRIMARY KEY(dataset_id,id));
      CREATE INDEX IF NOT EXISTS examples_position ON examples(dataset_id,position);
      CREATE TABLE IF NOT EXISTS dataset_imports (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'uploading', count INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dataset_import_chunks (dataset_id TEXT NOT NULL, sequence INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(dataset_id,sequence));
      CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, dataset_name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, usage_estimated INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, cost REAL, cost_complete INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_examples (run_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, label TEXT, user_id TEXT, context TEXT NOT NULL, media TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE INDEX IF NOT EXISTS run_examples_position ON run_examples(run_id,position);
      CREATE INDEX IF NOT EXISTS evaluations_recent ON evaluations(created_at DESC);
      CREATE INDEX IF NOT EXISTS evaluations_active ON evaluations(status,created_at);
      CREATE TABLE IF NOT EXISTS predictions (run_id TEXT NOT NULL, id TEXT NOT NULL, score REAL NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS evaluation_labels (dataset_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, context TEXT NOT NULL, media TEXT NOT NULL, label TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(dataset_id,id));
    `);
    ctx.storage.sql.exec(`INSERT OR IGNORE INTO dataset_stats (id,count,labelled)
      SELECT d.id,COUNT(e.id),COALESCE(SUM(CASE WHEN e.label IS NOT NULL THEN 1 ELSE 0 END),0)
      FROM datasets d LEFT JOIN examples e ON e.dataset_id=d.id
      WHERE NOT EXISTS(SELECT 1 FROM dataset_stats s WHERE s.id=d.id) GROUP BY d.id`);
    ctx.storage.sql.exec(IMPROVEMENT_SCHEMA);
    for (const [table, column, definition] of [
      ['messages', 'classification_snapshot', "TEXT NOT NULL DEFAULT ''"],
      ['predictions', 'needs_review', 'INTEGER NOT NULL DEFAULT 0'],
      ['evaluations', 'model_meta', "TEXT NOT NULL DEFAULT '{}'"],
      ['evaluations', 'settings_snapshot', "TEXT NOT NULL DEFAULT ''"],
      ['examples', 'family', "TEXT NOT NULL DEFAULT ''"],
      ['run_examples', 'family', "TEXT NOT NULL DEFAULT ''"],
      ['feedback_events', 'request_hash', "TEXT NOT NULL DEFAULT ''"],
      ['feedback_events', 'normalized_text', "TEXT NOT NULL DEFAULT ''"],
    ])
      if (
        !ctx.storage.sql
          .exec(`PRAGMA table_info('${table}')`)
          .toArray()
          .some((c) => c.name === column)
      )
        ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    // Additive schema upgrades preserve existing local and deployed data.
    if (
      !ctx.storage.sql
        .exec("PRAGMA table_info('messages')")
        .toArray()
        .some((c) => c.name === 'image_file_id')
    )
      ctx.storage.sql.exec(
        "ALTER TABLE messages ADD COLUMN image_file_id TEXT NOT NULL DEFAULT ''",
      );
    const evaluationColumns = ctx.storage.sql
      .exec("PRAGMA table_info('evaluations')")
      .toArray()
      .map((c) => c.name);
    if (!evaluationColumns.includes('usage_estimated'))
      ctx.storage.sql.exec(
        'ALTER TABLE evaluations ADD COLUMN usage_estimated INTEGER NOT NULL DEFAULT 0',
      );
    if (!evaluationColumns.includes('cost_complete'))
      ctx.storage.sql.exec(
        'ALTER TABLE evaluations ADD COLUMN cost_complete INTEGER NOT NULL DEFAULT 1',
      );
    for (const [column, definition] of [
      ['batch_size', 'INTEGER NOT NULL DEFAULT 20'],
      ['provider_request_id', 'TEXT'],
    ]) {
      if (!evaluationColumns.includes(column))
        ctx.storage.sql.exec(`ALTER TABLE evaluations ADD COLUMN ${column} ${definition}`);
    }
    if (!evaluationColumns.includes('usage_incomplete')) {
      ctx.storage.sql.exec(
        'ALTER TABLE evaluations ADD COLUMN usage_incomplete INTEGER NOT NULL DEFAULT 0',
      );
      // Earlier versions lost billed usage when this validation failed. Keep that gap visible after Resume.
      ctx.storage.sql.exec(
        "UPDATE evaluations SET usage_incomplete=1,cost_complete=0,cost=NULL WHERE status='failed' AND input_tokens=0 AND output_tokens=0 AND error LIKE 'Model response must contain exactly one result%'",
      );
    }
    const usageColumns = ctx.storage.sql
      .exec("PRAGMA table_info('usage')")
      .toArray()
      .map((c) => c.name);
    if (!usageColumns.includes('lab_tokens')) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec('ALTER TABLE usage ADD COLUMN lab_tokens INTEGER NOT NULL DEFAULT 0');
        // With no live activity, today's previous shared usage belongs to the lab.
        // Mixed historical usage remains conservative until its daily reset.
        const live = first<{
          count: number;
        }>(
          "SELECT (SELECT COUNT(*) FROM messages)+(SELECT COUNT(*) FROM users)+(SELECT COUNT(*) FROM actions)+(SELECT COUNT(*) FROM audit WHERE kind='classification_error') AS count",
        )!.count;
        if (!live)
          ctx.storage.sql.exec(
            'UPDATE usage SET lab_tokens=tokens,tokens=0 WHERE day=?',
            new Date().toISOString().slice(0, 10),
          );
      });
    }
    ctx.storage.sql.exec(
      "UPDATE evaluations SET status='queued',error='' WHERE status='waiting_budget'",
    );
    ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO config (id, value) VALUES (1, ?)',
      JSON.stringify(defaultSettings),
    );
  }
}

import pg from 'pg';
import { PostgresDatabase, databaseSchema, postgresConfig } from './database';
import { POSTGRES_SCHEMA } from './postgres-schema';
import { defaultSettings } from '../shared/types';
import type { Env } from './env';

export interface MigrationState {
  ready: boolean;
  status: 'waiting_source' | 'copying' | 'complete' | 'cancelled';
  tables: { table: string; count: number; copied: number }[];
  cancelledAt?: number;
  tableIndex: number;
  offset: number;
  error: string;
  nextAttemptAt?: number;
  sourceDatasetIds?: string[];
  sourceRunIds?: string[];
}
export const initialMigration = (): MigrationState => ({
  ready: false,
  status: 'waiting_source',
  tables: [],
  tableIndex: 0,
  offset: 0,
  error: '',
});
export async function initializePostgres(
  env: Pick<Env, 'PLANETSCALE_DATABASE_URL' | 'DEV_MODE' | 'TELEGRAM_CHAT_ID'>,
  fresh = true,
) {
  if (!env.PLANETSCALE_DATABASE_URL)
    throw new Error('Save PLANETSCALE_DATABASE_URL in .dev.vars first.');
  const schema = databaseSchema(env.TELEGRAM_CHAT_ID);
  const client = new pg.Client(
    postgresConfig(env.PLANETSCALE_DATABASE_URL, env.DEV_MODE === 'true'),
  );
  client.on('error', () => {});
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    if (!existing.rows.length) await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(POSTGRES_SCHEMA);
    await client.query(
      'CREATE TABLE IF NOT EXISTS storage_state (id BIGINT PRIMARY KEY,value TEXT NOT NULL)',
    );
    await client.query('INSERT INTO config (id,value) VALUES (1,$1) ON CONFLICT DO NOTHING', [
      JSON.stringify(defaultSettings),
    ]);
    const state = initialMigration();
    if (fresh) {
      state.ready = true;
      state.status = 'complete';
    }
    // Re-running setup cannot reset a completed migration or its progress.
    await client.query(
      'INSERT INTO storage_state (id,value) VALUES (1,$1) ON CONFLICT DO NOTHING',
      [JSON.stringify(state)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}
export async function migrationState(db: PostgresDatabase): Promise<MigrationState> {
  const rows = await db.exec<{ value: string }>('SELECT value FROM storage_state WHERE id=1');
  if (!rows[0]) throw new Error('Initialize the PlanetScale database before deployment.');
  return JSON.parse(rows[0].value);
}
export async function writeMigration(db: PostgresDatabase, state: MigrationState) {
  await db.exec('UPDATE storage_state SET value=? WHERE id=1', JSON.stringify(state));
}

// Explicit abandonment never overwrites the current Postgres config, labels or runs.
// Reject partial copies: those need an inventory before old and new live state can mix.
export async function discardLegacyHistory(db: PostgresDatabase) {
  return db.transaction(async () => {
    const state = await migrationState(db);
    if (state.ready) return state;
    if (state.tables.some((t) => t.copied > 0))
      throw new Error(
        'Some legacy rows have already copied. Review them before abandoning history.',
      );
    const cancelled: MigrationState = {
      ...initialMigration(),
      ready: true,
      status: 'cancelled',
      cancelledAt: Date.now(),
    };
    await writeMigration(db, cancelled);
    return cancelled;
  });
}

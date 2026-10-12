import { existsSync } from 'node:fs';
import { initializePostgres, discardLegacyHistory } from '../worker/storage';
import { PostgresDatabase } from '../worker/database';
import { initializeDirectory, provision } from '../worker/directory';
import { defaultSettings } from '../shared/types';
if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
let url = process.env.PLANETSCALE_ADMIN_DATABASE_URL || process.env.PLANETSCALE_DATABASE_URL;
const chatId = process.env.TELEGRAM_CHAT_ID || '-1001255868451';
if (!url) throw new Error('Save PLANETSCALE_DATABASE_URL in ignored .dev.vars.');
const connection = new URL(url);
if (connection.hostname.endsWith('.psdb.cloud')) {
  connection.port = '5432';
  url = connection.href;
}
try {
  await initializePostgres(
    {
      PLANETSCALE_DATABASE_URL: url,
      TELEGRAM_CHAT_ID: chatId,
      DEV_MODE: process.env.DEV_MODE || 'false',
    },
    true,
  );
  if (process.argv.includes('--discard-legacy-history'))
    await discardLegacyHistory(
      new PostgresDatabase({
        PLANETSCALE_DATABASE_URL: url,
        TELEGRAM_CHAT_ID: chatId,
        DEV_MODE: process.env.DEV_MODE || 'false',
      }),
    );
  const db = new PostgresDatabase({
    PLANETSCALE_DATABASE_URL: url,
    TELEGRAM_CHAT_ID: chatId,
    DEV_MODE: process.env.DEV_MODE || 'false',
  });
  await initializeDirectory(db, { TELEGRAM_CHAT_ID: chatId });
  await db.transaction(async () => {
    const groups = await db.exec<{ chat_id: string }>(
      `SELECT chat_id FROM ${db.table('watchtower_groups')} WHERE provisioned=1`,
    );
    for (const group of groups) await provision(db.forGroup(group.chat_id), defaultSettings);
  });
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === '42501') {
    console.error(
      'This role cannot create the initial schema. Save a temporary default-role connection as PLANETSCALE_ADMIN_DATABASE_URL in ignored .dev.vars, then rerun setup. The Worker will keep using the separate application role.',
    );
  } else
    console.error(
      'Database setup failed. Verify the database connection and schema privileges. No connection credentials were printed.',
    );
  process.exit(1);
}
console.log('Postgres schema is ready. Existing application data was preserved.');

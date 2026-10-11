import { PostgresDatabase, LostWorkLeaseError } from './database';
import { GroupService } from './group';
import type { Env } from './env';

// Cron is the recovery mechanism as well as the batching timer. It never relies on
// browser polling or a response's short waitUntil lifetime to finish provider calls.
export async function runScheduledWork(
  env: Env,
  durationMs = 45_000,
  db = new PostgresDatabase(env),
) {
  const group = new GroupService(db, env);
  const deadline = Date.now() + durationMs;
  try {
    return await db.withWorkLease(async () => {
      for (let batches = 0; batches < 20 && (await group.hasDueWork()); batches++) {
        await group.alarm();
        if (Date.now() >= deadline) break;
      }
    });
  } catch (e) {
    if (e instanceof LostWorkLeaseError) return false;
    throw e;
  }
}

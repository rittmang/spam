import {
  DatabaseUnavailableError,
  LostWorkLeaseError,
  PostgresDatabase,
  type Database,
} from './database';
import { migrationState } from './storage';
import {
  evaluationIndexResponse,
  evaluationPageResponse,
  evaluationResponse,
  overviewRows,
} from './postgres-reads';
import { z } from 'zod';
import {
  settingsSchema,
  defaultSettings,
  REPETITION_CONTEXT_MS,
  type Dataset,
  type Example,
  type Prediction,
  type Settings,
  type StoredMessage,
  type Evaluation,
  type Overview,
} from '../shared/types';
import {
  classify,
  estimateTokens,
  fitExamples,
  configuredProvider,
  publicProviders,
  ClassificationError,
  type ClassificationUsage,
  type ClassificationExample,
} from './classifier';
import { telegramImageFileId, imageRoute, imageData, telegramImage } from './images';
import { VISION_CHECK_IMAGE } from './vision-check';
import type { Env } from './env';
import { HttpError, json, readJson, databaseQuotaResponse } from './http';
import { importExamples } from './import';
import { IMPORT_BATCH_MESSAGES, validateExamples } from '../shared/import';
import {
  mediaType,
  messageText,
  telegram,
  TelegramError,
  updateSchema,
  type TelegramUpdate,
} from './telegram';
interface Action {
  id: number;
  kind: string;
  user_id: string;
  message_id: number | null;
  payload: string;
  attempts: number;
  next_at: number;
  status: string;
}
interface MessageRow extends StoredMessage {
  telegram_revision: number;
  attempts: number;
  next_at: number;
}
const labelSchema = z.enum(['spam', 'ham']).nullable();
const safeError = (e: unknown) => (e instanceof Error ? e.message.slice(0, 300) : 'Unknown error');
class BudgetError extends Error {
  constructor() {
    super(
      'Daily token budget reached. Progress is saved; resumes at midnight UTC or when the budget is increased.',
    );
  }
}
const nextBudgetReset = () => new Date(new Date().toISOString().slice(0, 10)).getTime() + 86400000;
const excludeIds = (column: string, ids: string[]) =>
  ids.length ? `${column} NOT IN (${ids.map(() => '?').join(',')})` : '1=1';
export class GroupService {
  private execution: Promise<unknown> = Promise.resolve();
  private overviewCache: {
    at: number;
    day: string;
    value: Omit<Overview, 'dev' | 'owner'>;
  } | null = null;
  constructor(
    private db: Database,
    protected env: Env,
    private schedule: (delay: number) => Promise<void> = async () => {},
  ) {}
  private async rows<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]> {
    return this.db.exec<T>(sql, ...params);
  }
  private async one<T>(sql: string, ...params: (string | number | null)[]): Promise<T | undefined> {
    return (await this.rows<T>(sql, ...params))[0];
  }
  async settings(): Promise<Settings> {
    return {
      ...defaultSettings,
      ...JSON.parse(
        (await this.one<{
          value: string;
        }>('SELECT value FROM config WHERE id=1'))!.value,
      ),
    };
  }
  private async requireLiveStorage() {
    if (this.db instanceof PostgresDatabase && !(await migrationState(this.db)).ready) {
      await this.scheduleRemaining();
      throw new HttpError(503, 'Finish the PlanetScale database setup to enable live moderation.');
    }
  }
  private async hiddenLabIds(kind: 'dataset' | 'run') {
    if (!(this.db instanceof PostgresDatabase)) return [];
    const state = await migrationState(this.db);
    return state.ready
      ? []
      : (kind === 'dataset' ? state.sourceDatasetIds : state.sourceRunIds) || [];
  }
  private async requireLabRecord(kind: 'dataset' | 'run', id: string) {
    if ((await this.hiddenLabIds(kind)).includes(id))
      throw new HttpError(
        409,
        'This historical record is still being copied. Use a new or recovered dataset until migration completes.',
      );
  }
  private async log(kind: string, detail: string, userId = '', messageId: number | null = null) {
    if (this.db instanceof PostgresDatabase && !(await migrationState(this.db)).ready) return;
    await this.db.exec(
      'INSERT INTO audit (kind, user_id, message_id, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      kind,
      userId,
      messageId,
      detail,
      Date.now(),
    );
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.execution.then(fn, fn);
    this.execution = next.catch(() => {});
    return next;
  }
  private async wake(delay = 1000) {
    await this.schedule(delay);
  }
  private async assertWorkLease() {
    if (this.db instanceof PostgresDatabase) await this.db.assertWorkLease();
  }
  async ingest(update: TelegramUpdate) {
    return this.db.session(() => this.ingestWithinSession(update));
  }
  private async ingestWithinSession(update: TelegramUpdate) {
    await this.requireLiveStorage();
    this.overviewCache = null;
    const m = update.edited_message || update.message;
    if (!m || String(m.chat.id) !== this.env.TELEGRAM_CHAT_ID || m.chat.type !== 'supergroup')
      return { ignored: true };
    const settings = await this.settings();
    const userId = m.from ? String(m.from.id) : `chat:${m.sender_chat?.id || 'unknown'}`;
    const name = m.from
      ? [m.from.first_name, m.from.last_name].filter(Boolean).join(' ')
      : 'Channel / anonymous admin';
    const text = messageText(m),
      media = mediaType(m),
      imageFileId = telegramImageFileId(m);
    const protectedSender =
      !m.from ||
      Boolean(m.sender_chat) ||
      m.from.is_bot ||
      userId === this.env.OWNER_TELEGRAM_ID ||
      settings.exemptUserIds.includes(userId);
    let accepted = false;
    await this.db.transaction(async () => {
      if (await this.one('SELECT id FROM updates WHERE id=?', update.update_id)) return;
      await this.db.exec(
        'INSERT INTO updates (id, received_at) VALUES (?,?)',
        update.update_id,
        Date.now(),
      );
      const existing = await this.one<MessageRow>(
        'SELECT * FROM messages WHERE id=?',
        m.message_id,
      );
      const version = m.edit_date || m.date;
      if (
        existing &&
        (version < existing.telegram_revision ||
          (version === existing.telegram_revision &&
            text === existing.text &&
            imageFileId === existing.image_file_id &&
            media === existing.media))
      )
        return;
      if (existing?.strike_awarded || existing?.deleted) return;
      // Ignore service messages. Photos with retrievable image content are queued even without captions.
      if (!text && !media) return;
      const status = protectedSender
        ? 'protected'
        : settings.mode === 'paused'
          ? 'paused'
          : settings.imageModeration && media === 'photo' && !imageFileId
            ? 'unsupported'
            : !text && !(settings.imageModeration && imageFileId)
              ? 'unsupported'
              : 'pending';
      await this.db.exec(
        `INSERT INTO users (user_id,name,last_seen) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen`,
        userId,
        name,
        m.date * 1000,
      );
      await this.db.exec(
        `INSERT INTO messages (id,user_id,user_name,text,sent_at,status,media,image_file_id,telegram_revision,next_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text,status=excluded.status,media=excluded.media,image_file_id=excluded.image_file_id,telegram_revision=excluded.telegram_revision,revision=messages.revision+1,score=NULL,reason='',category='',model='',attempts=0,next_at=excluded.next_at`,
        m.message_id,
        userId,
        name,
        text,
        m.date * 1000,
        status,
        media,
        imageFileId,
        version,
        this.db.kind === 'planetscale' ? Date.now() + settings.batchSeconds * 1000 : 0,
      );
      accepted = status === 'pending';
    });
    // Even duplicate delivery repairs a missed alarm if a previous invocation died here.
    if (accepted || (await this.one("SELECT id FROM messages WHERE status='pending' LIMIT 1")))
      await this.wake(settings.batchSeconds * 1000);
    return { accepted };
  }
  private async examplesFor(messages: MessageRow[]): Promise<Example[]> {
    return Promise.all(
      messages.map(async (m) => ({
        id: String(m.id),
        text: m.text,
        label: m.label,
        userId: m.user_id,
        media: m.media,
        context: (
          await this.rows<{
            text: string;
          }>(
            'SELECT text FROM messages WHERE user_id=? AND sent_at>=? AND (sent_at < ? OR (sent_at=? AND id<?)) ORDER BY sent_at DESC,id DESC LIMIT 3',
            m.user_id,
            m.sent_at - REPETITION_CONTEXT_MS,
            m.sent_at,
            m.sent_at,
            m.id,
          )
        )
          .reverse()
          .map((r) => r.text.slice(0, 2000)),
      })),
    );
  }
  private async reserve(tokens: number) {
    const day = new Date().toISOString().slice(0, 10);
    await this.db.transaction(async () => {
      await this.db.exec('INSERT OR IGNORE INTO usage (day,tokens) VALUES (?,0)', day);
      const used = (await this.one<{
        tokens: number;
      }>('SELECT tokens FROM usage WHERE day=?', day))!.tokens;
      if (used + tokens > (await this.settings()).dailyTokenBudget) throw new BudgetError();
      await this.db.exec('UPDATE usage SET tokens=tokens+? WHERE day=?', tokens, day);
    });
    return day;
  }
  private async settle(day: string, reserved: number, input: number | null, output: number | null) {
    if (input === null || output === null) return;
    await this.db.exec(
      'UPDATE usage SET tokens=MAX(0,tokens+?) WHERE day=?',
      input + output - reserved,
      day,
    );
  }
  private async remainingBudget() {
    const used =
      (
        await this.one<{
          tokens: number;
        }>('SELECT tokens FROM usage WHERE day=?', new Date().toISOString().slice(0, 10))
      )?.tokens || 0;
    return Math.max(0, (await this.settings()).dailyTokenBudget - used);
  }
  private async recordEvaluationUsage(id: string, usage: ClassificationUsage, reserved: number) {
    const estimated = usage.input === null || usage.output === null;
    await this.db.exec(
      'UPDATE evaluations SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,usage_estimated=MAX(usage_estimated,?),latency_ms=latency_ms+?,cost=CASE WHEN cost_complete=0 OR ? IS NULL THEN NULL ELSE COALESCE(cost,0)+? END,cost_complete=CASE WHEN ? IS NULL THEN 0 ELSE cost_complete END,provider_request_id=? WHERE id=?',
      estimated ? reserved : usage.input!,
      estimated ? 0 : usage.output!,
      Number(estimated),
      usage.latency,
      usage.cost,
      usage.cost,
      usage.cost,
      usage.requestId,
      id,
    );
  }
  private async classifyBatch(
    provider: string,
    model: string,
    policy: string,
    examples: ClassificationExample[],
    runId?: string,
  ) {
    if (!examples.length) throw new BudgetError();
    await this.assertWorkLease();
    const reserved = estimateTokens(this.env, provider, model, policy, examples);
    const day = runId ? new Date().toISOString().slice(0, 10) : await this.reserve(reserved);
    let measured: ClassificationUsage | undefined;
    try {
      const result = await classify(this.env, provider, model, policy, examples);
      measured = result;
      return result;
    } catch (error) {
      if (error instanceof ClassificationError) measured = error.usage;
      throw error;
    } finally {
      if (measured) {
        if (runId) {
          const tokens =
            measured.input === null || measured.output === null
              ? reserved
              : measured.input + measured.output;
          await this.db.exec(
            'INSERT INTO usage (day,tokens,lab_tokens) VALUES (?,0,?) ON CONFLICT(day) DO UPDATE SET lab_tokens=lab_tokens+excluded.lab_tokens',
            day,
            tokens,
          );
          await this.recordEvaluationUsage(runId, measured, reserved);
        } else await this.settle(day, reserved, measured.input, measured.output);
      }
    }
  }
  private async isProtected(userId: string) {
    if (
      !/^\d+$/.test(userId) ||
      userId === this.env.OWNER_TELEGRAM_ID ||
      (await this.settings()).exemptUserIds.includes(userId)
    )
      return true;
    const member = await telegram<{
      status: string;
    }>(this.env, 'getChatMember', {
      chat_id: this.env.TELEGRAM_CHAT_ID,
      user_id: Number(userId),
    });
    return ['administrator', 'creator'].includes(member.status);
  }
  private async queueAction(
    kind: string,
    userId: string,
    messageId: number | null,
    payload: Record<string, unknown>,
  ) {
    await this.db.exec(
      'INSERT INTO actions (kind,user_id,message_id,payload) VALUES (?,?,?,?)',
      kind,
      userId,
      messageId,
      JSON.stringify(payload),
    );
  }
  private async awardStrike(m: MessageRow, prediction: Prediction, model: string, policy: string) {
    await this.db.transaction(async () => {
      const current = await this.one<MessageRow>('SELECT * FROM messages WHERE id=?', m.id);
      if (!current || current.revision !== m.revision || current.strike_awarded) return;
      await this.db.exec(
        "UPDATE messages SET status='spam',score=?,reason=?,category=?,model=?,strike_awarded=1 WHERE id=?",
        prediction.score,
        prediction.reason,
        prediction.category,
        model,
        m.id,
      );
      await this.db.exec('UPDATE users SET strikes=MIN(3,strikes+1) WHERE user_id=?', m.user_id);
      const strikes = (await this.one<{
        strikes: number;
      }>('SELECT strikes FROM users WHERE user_id=?', m.user_id))!.strikes;
      await this.log(
        'spam',
        JSON.stringify({
          strike: strikes,
          score: prediction.score,
          reason: prediction.reason,
          model,
          policy,
        }),
        m.user_id,
        m.id,
      );
      await this.queueAction('delete', m.user_id, m.id, { message_ids: [m.id] });
      if (strikes === 2) {
        const ids = (
          await this.rows<{
            id: number;
          }>(
            'SELECT id FROM messages WHERE user_id=? AND deleted=0 AND sent_at>? ORDER BY id',
            m.user_id,
            Date.now() - 48 * 3600000,
          )
        ).map((r) => r.id);
        for (let i = 0; i < ids.length; i += 100)
          await this.queueAction('purge', m.user_id, m.id, { message_ids: ids.slice(i, i + 100) });
        await this.log(
          'purge_queued',
          `Strike two: queued ${ids.length} tracked messages within Telegram's 48-hour deletion window.`,
          m.user_id,
          m.id,
        );
      }
      if (strikes === 3) await this.queueAction('ban', m.user_id, m.id, {});
    });
  }
  private async processMessages() {
    const settings = await this.settings();
    if (settings.mode === 'paused') return;
    const messages = await this.rows<MessageRow>(
      "SELECT * FROM messages WHERE status='pending' AND next_at<=? ORDER BY sent_at,id LIMIT ?",
      Date.now(),
      settings.batchSize,
    );
    if (!messages.length) return;
    let processing = messages;
    let route = { provider: settings.provider, model: settings.model };
    const usesImage = (m: MessageRow) =>
      settings.imageModeration && (m.media === 'photo' || Boolean(m.image_file_id));
    try {
      // One group-level lookup keeps administrators out of model calls.
      const admins = await telegram<
        {
          user: {
            id: number;
          };
        }[]
      >(this.env, 'getChatAdministrators', {
        chat_id: this.env.TELEGRAM_CHAT_ID,
      });
      const protectedIds = new Set(admins.map((a) => String(a.user.id)));
      const eligible: MessageRow[] = [];
      for (const m of messages) {
        if (
          protectedIds.has(m.user_id) ||
          m.user_id === this.env.OWNER_TELEGRAM_ID ||
          settings.exemptUserIds.includes(m.user_id)
        ) {
          await this.db.exec(
            "UPDATE messages SET status='protected' WHERE id=? AND revision=?",
            m.id,
            m.revision,
          );
        } else eligible.push(m);
      }
      if (!eligible.length) return;
      // Preserve chronological strike allocation. Images use one bounded request;
      // adjacent text messages keep the existing economical batch path.
      const image = usesImage(eligible[0]);
      processing = image
        ? eligible.slice(0, 1)
        : eligible.slice(
            0,
            eligible.findIndex(usesImage) < 0 ? eligible.length : eligible.findIndex(usesImage),
          );
      if (image) {
        route = await imageRoute(this.env, settings);
        if (!processing[0].image_file_id)
          throw new Error('No supported image file is available for this photo.');
      }
      const examples = fitExamples(
        this.env,
        route.provider,
        route.model,
        settings.policy,
        (await this.examplesFor(processing)).map((e) =>
          image ? { ...e, image: 'pending-download' } : e,
        ),
        await this.remainingBudget(),
      );
      if (image && examples.length)
        examples[0].image = await imageData(this.env, processing[0].image_file_id!);
      const result = await this.classifyBatch(
        route.provider,
        route.model,
        settings.policy,
        examples,
      );
      // Config changes during an upstream call invalidate its decisions.
      if (JSON.stringify(await this.settings()) !== JSON.stringify(settings)) return;
      // Model output order must never change the chronology of strikes.
      for (const m of processing.filter((m) => examples.some((e) => e.id === String(m.id)))) {
        const prediction = result.results.find((p) => p.id === String(m.id))!;
        const current = await this.one<MessageRow>('SELECT * FROM messages WHERE id=?', m.id);
        if (!current || current.revision !== m.revision || current.status !== 'pending') continue;
        if (settings.mode === 'enforce' && prediction.score >= settings.threshold) {
          // Recheck before allocating a strike; a lookup failure leaves the message pending.
          if (await this.isProtected(m.user_id)) {
            await this.db.exec(
              "UPDATE messages SET status='protected' WHERE id=? AND revision=?",
              m.id,
              m.revision,
            );
            continue;
          }
          if (JSON.stringify(await this.settings()) !== JSON.stringify(settings)) return;
          await this.awardStrike(
            m,
            prediction,
            `${route.provider}:${route.model}`,
            settings.policy,
          );
        } else {
          const status =
            prediction.score >= settings.threshold
              ? 'observed_spam'
              : prediction.score >= settings.reviewThreshold
                ? 'review'
                : 'allowed';
          await this.db.exec(
            "UPDATE messages SET status=?,score=?,reason=?,category=?,model=? WHERE id=? AND revision=? AND status='pending' AND strike_awarded=0",
            status,
            prediction.score,
            prediction.reason,
            prediction.category,
            `${route.provider}:${route.model}`,
            m.id,
            m.revision,
          );
        }
      }
    } catch (e) {
      if (e instanceof DatabaseUnavailableError || e instanceof LostWorkLeaseError) throw e;
      const error = safeError(e);
      for (const m of processing) {
        if (usesImage(m) && !(e instanceof BudgetError)) {
          await this.db.exec(
            "UPDATE messages SET status='unsupported',score=NULL,reason=?,category='image_review' WHERE id=? AND revision=? AND status='pending'",
            `Image review required: ${error}`,
            m.id,
            m.revision,
          );
          continue;
        }
        const attempts = m.attempts + Number(!(e instanceof BudgetError));
        await this.db.exec(
          "UPDATE messages SET attempts=?,next_at=?,reason=?,status=? WHERE id=? AND revision=? AND status='pending'",
          attempts,
          e instanceof BudgetError
            ? nextBudgetReset()
            : Date.now() + Math.min(300000, 5000 * 2 ** attempts),
          error,
          attempts >= 5 ? 'error' : 'pending',
          m.id,
          m.revision,
        );
      }
      await this.log('classification_error', error);
    }
  }
  private async processActions() {
    if ((await this.settings()).mode !== 'enforce') return;
    const actions = await this.rows<Action>(
      "SELECT * FROM actions WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 12",
      Date.now(),
    );
    for (const action of actions) {
      try {
        if ((await this.settings()).mode !== 'enforce') break;
        if (await this.isProtected(action.user_id)) {
          await this.db.exec("UPDATE actions SET status='cancelled' WHERE id=?", action.id);
          await this.log(
            'protected',
            'Action cancelled: sender is now exempt or an administrator.',
            action.user_id,
            action.message_id,
          );
          continue;
        }
        if ((await this.settings()).mode !== 'enforce') break;
        if (action.kind === 'ban') {
          await this.assertWorkLease();
          await telegram(this.env, 'banChatMember', {
            chat_id: this.env.TELEGRAM_CHAT_ID,
            user_id: Number(action.user_id),
            revoke_messages: true,
          });
          await this.db.exec('UPDATE users SET banned=1 WHERE user_id=?', action.user_id);
          await this.db.exec('UPDATE messages SET deleted=1 WHERE user_id=?', action.user_id);
          await this.log(
            'banned',
            'Strike three: permanently banned; Telegram revokes message history in supergroups.',
            action.user_id,
            action.message_id,
          );
        } else {
          const payload = JSON.parse(action.payload) as {
            message_ids: number[];
          };
          const ids: number[] = [];
          for (const id of payload.message_ids) {
            const row = await this.one<MessageRow>('SELECT * FROM messages WHERE id=?', id);
            if (row && !row.deleted && Date.now() - row.sent_at < 48 * 3600000) ids.push(id);
          }
          if (ids.length) {
            await this.assertWorkLease();
            await telegram(this.env, 'deleteMessages', {
              chat_id: this.env.TELEGRAM_CHAT_ID,
              message_ids: ids,
            });
            for (const id of ids)
              await this.db.exec('UPDATE messages SET deleted=1 WHERE id=?', id);
            await this.log(
              action.kind === 'purge' ? 'purged' : 'deleted',
              `${ids.length} tracked message(s) deleted.`,
              action.user_id,
              action.message_id,
            );
          } else
            await this.log(
              'deletion_skipped',
              'Message already removed or outside the deletion window.',
              action.user_id,
              action.message_id,
            );
        }
        await this.db.exec("UPDATE actions SET status='done' WHERE id=?", action.id);
      } catch (e) {
        if (e instanceof DatabaseUnavailableError || e instanceof LostWorkLeaseError) throw e;
        const attempts = action.attempts + 1;
        const retry =
          e instanceof TelegramError && e.retryAfter
            ? e.retryAfter * 1000
            : Math.min(3600000, 5000 * 2 ** attempts);
        await this.db.exec(
          'UPDATE actions SET attempts=?,next_at=?,status=? WHERE id=?',
          attempts,
          Date.now() + retry,
          attempts >= 8 ? 'failed' : 'pending',
          action.id,
        );
        await this.log(
          'action_error',
          `${action.kind}: ${safeError(e)}`,
          action.user_id,
          action.message_id,
        );
        if (e instanceof TelegramError && e.code === 429) {
          await this.db.exec(
            "UPDATE actions SET next_at=MAX(next_at,?) WHERE status='pending'",
            Date.now() + retry,
          );
          break;
        }
      }
    }
  }
  private async decodedExamples(
    table: 'examples' | 'run_examples',
    field: 'dataset_id' | 'run_id',
    id: string,
    offset = 0,
    limit = 10000,
  ): Promise<Example[]> {
    return this.decodeExamples(
      await this.rows<{
        id: string;
        text: string;
        label: 'spam' | 'ham' | null;
        user_id: string;
        context: string;
        media: string;
      }>(
        `SELECT * FROM ${table} WHERE ${field}=? AND position>=? ORDER BY position LIMIT ?`,
        id,
        offset,
        limit,
      ),
    );
  }
  private decodeExamples(
    rows: {
      id: string;
      text: string;
      label: 'spam' | 'ham' | null;
      user_id: string;
      context: string;
      media: string;
    }[],
  ): Example[] {
    return rows.map((e) => ({
      id: e.id,
      text: e.text,
      label: e.label,
      userId: e.user_id,
      context: JSON.parse(e.context),
      media: e.media,
    }));
  }
  private async datasetMeta(id: string) {
    return await this.one<Dataset>(
      `SELECT d.*,s.count,s.labelled FROM datasets d JOIN dataset_stats s ON s.id=d.id
       WHERE d.id=? AND NOT EXISTS(SELECT 1 FROM dataset_imports i WHERE i.id=d.id AND i.status='uploading')`,
      id,
    );
  }
  private async sampleDataset(id: string, count: number, size: number) {
    return this.decodeExamples(
      await this.rows(
        `WITH RECURSIVE picks(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM picks WHERE i+1<?)
       SELECT e.* FROM picks JOIN examples e ON e.dataset_id=? AND e.position=CAST((picks.i*?)/? AS INTEGER)
       ORDER BY e.position`,
        size,
        id,
        count,
        size,
      ),
    );
  }
  private async insertExample(
    table: 'examples' | 'run_examples',
    id: string,
    e: Example,
    position: number,
  ) {
    const field = table === 'examples' ? 'dataset_id' : 'run_id';
    await this.db.exec(
      `INSERT INTO ${table} (${field},id,position,text,label,user_id,context,media) VALUES (?,?,?,?,?,?,?,?)`,
      id,
      e.id,
      position,
      e.text,
      e.label,
      e.userId || '',
      JSON.stringify(e.context || []),
      e.media || '',
    );
  }
  private async insertExamples(
    table: 'examples' | 'run_examples',
    id: string,
    examples: Example[],
    position = 0,
  ) {
    if (!(this.db instanceof PostgresDatabase)) {
      for (const [i, example] of examples.entries())
        await this.insertExample(table, id, example, position + i);
      return;
    }
    const field = table === 'examples' ? 'dataset_id' : 'run_id';
    // One round trip per upload batch, with all text still bound as parameters.
    for (let start = 0; start < examples.length; start += 250) {
      const batch = examples.slice(start, start + 250);
      await this.db.exec(
        `INSERT INTO ${table} (${field},id,position,text,label,user_id,context,media) VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`,
        ...batch.flatMap((e, i) => [
          id,
          e.id,
          position + start + i,
          e.text,
          e.label,
          e.userId || '',
          JSON.stringify(e.context || []),
          e.media || '',
        ]),
      );
    }
  }
  private async saveReviewLabel(
    datasetId: string,
    example: {
      id: string;
      text: string;
      context: string;
      media: string;
    },
    label: 'spam' | 'ham' | null,
  ) {
    await this.db.exec(
      'INSERT INTO evaluation_labels (dataset_id,id,text,context,media,label,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(dataset_id,id) DO UPDATE SET text=excluded.text,context=excluded.context,media=excluded.media,label=excluded.label,updated_at=excluded.updated_at',
      datasetId,
      example.id,
      example.text,
      example.context,
      example.media,
      label,
      Date.now(),
    );
    const source = await this.one<{
      label: 'spam' | 'ham' | null;
    }>(
      'SELECT label FROM examples WHERE dataset_id=? AND id=? AND text=? AND context=? AND media=?',
      datasetId,
      example.id,
      example.text,
      example.context,
      example.media,
    );
    if (source) {
      await this.db.exec(
        'UPDATE examples SET label=? WHERE dataset_id=? AND id=?',
        label,
        datasetId,
        example.id,
      );
      await this.db.exec(
        'UPDATE dataset_stats SET labelled=labelled+? WHERE id=?',
        Number(label !== null) - Number(source.label !== null),
        datasetId,
      );
    }
  }
  private async processEvaluation() {
    const hidden = await this.hiddenLabIds('run');
    const run = await this.one<Evaluation>(
      `SELECT * FROM evaluations WHERE status IN ('queued','running') AND ${excludeIds('id', hidden)} ORDER BY created_at LIMIT 1`,
      ...hidden,
    );
    if (!run) return;
    const started = await this.db.exec(
      "UPDATE evaluations SET status='running' WHERE id=? AND status IN ('queued','running') RETURNING id",
      run.id,
    );
    if (!started.length) return;
    let attempted = 0;
    try {
      const examples = fitExamples(
        this.env,
        run.provider,
        run.model,
        run.policy,
        await this.decodedExamples(
          'run_examples',
          'run_id',
          run.id,
          run.cursor,
          Math.min((await this.settings()).batchSize, run.batch_size),
        ),
      );
      attempted = examples.length;
      const result = await this.classifyBatch(
        run.provider,
        run.model,
        run.policy,
        examples,
        run.id,
      );
      if (
        (
          await this.one<{
            status: string;
          }>('SELECT status FROM evaluations WHERE id=?', run.id)
        )?.status === 'cancelled'
      )
        return;
      await this.db.transaction(async () => {
        const current = await this.one<{ status: string; cursor: number }>(
          'SELECT status,cursor FROM evaluations WHERE id=?',
          run.id,
        );
        if (!current || current.status === 'cancelled' || current.cursor !== run.cursor) return;
        for (const p of result.results)
          await this.db.exec(
            'INSERT OR REPLACE INTO predictions (run_id,id,score,category,reason) VALUES (?,?,?,?,?)',
            run.id,
            p.id,
            p.score,
            p.category,
            p.reason,
          );
        const cursor = run.cursor + examples.length;
        await this.db.exec(
          "UPDATE evaluations SET cursor=?,status=?,error='' WHERE id=?",
          cursor,
          cursor >= run.total ? 'complete' : 'running',
          run.id,
        );
      });
    } catch (e) {
      if (e instanceof DatabaseUnavailableError || e instanceof LostWorkLeaseError) throw e;
      const shrink = e instanceof ClassificationError && e.invalidOutput && attempted > 1;
      const batchSize = shrink ? Math.max(1, Math.floor(attempted / 2)) : run.batch_size;
      await this.db.exec(
        "UPDATE evaluations SET status=?,error=?,batch_size=? WHERE id=? AND status!='cancelled'",
        shrink ? 'running' : 'failed',
        shrink ? `${safeError(e)} Retrying with at most ${batchSize} messages.` : safeError(e),
        batchSize,
        run.id,
      );
      await this.log('evaluation_error', `${run.model}: ${safeError(e)}`);
    }
  }
  async alarm() {
    return this.db.session(() =>
      this.serial(async () => {
        this.overviewCache = null;
        let retry = false;
        try {
          await this.requireLiveStorage();
          await this.processMessages();
          await this.processActions();
          await this.processEvaluation();
        } catch (e) {
          if (this.db.kind === 'planetscale') throw e;
          if (databaseQuotaResponse(e)) {
            retry = true;
            await this.wake(300000);
          } else await this.log('work_error', safeError(e));
        } finally {
          this.overviewCache = null;
          if (!retry) await this.scheduleRemaining();
        }
      }),
    );
  }
  async hasDueWork() {
    const settings = await this.settings();
    return Boolean(
      await this.one(
        `SELECT 1 AS due WHERE
        (?!='paused' AND EXISTS(SELECT 1 FROM messages WHERE status='pending' AND next_at<=?)) OR
        (?='enforce' AND EXISTS(SELECT 1 FROM actions WHERE status='pending' AND next_at<=?)) OR
        EXISTS(SELECT 1 FROM evaluations WHERE status IN ('queued','running'))`,
        settings.mode,
        Date.now(),
        settings.mode,
        Date.now(),
      ),
    );
  }
  private async scheduleRemaining() {
    // Only the local SQLite adapter supplies an alarm callback. Production uses cron.
    if (this.db.kind === 'planetscale') return;
    const settings = await this.settings();
    const nextMessage =
      settings.mode !== 'paused'
        ? (
            await this.one<{ at: number }>(
              "SELECT MIN(next_at) AS at FROM messages WHERE status='pending'",
            )
          )?.at
        : null;
    const nextAction =
      settings.mode === 'enforce'
        ? (
            await this.one<{ at: number }>(
              "SELECT MIN(next_at) AS at FROM actions WHERE status='pending'",
            )
          )?.at
        : null;
    const run = await this.one(
      "SELECT id FROM evaluations WHERE status IN ('queued','running') LIMIT 1",
    );
    const due = [nextMessage, nextAction, run ? Date.now() : null].filter(
      (n): n is number => n !== null && n !== undefined,
    );
    if (due.length) await this.wake(Math.max(1000, Math.min(...due) - Date.now()));
  }
  private async overview(): Promise<Omit<Overview, 'dev' | 'owner'>> {
    const day = new Date().toISOString().slice(0, 10);
    if (this.overviewCache?.day === day && Date.now() - this.overviewCache.at < 60000)
      return this.overviewCache.value;
    if (this.db instanceof PostgresDatabase) {
      const { state, ...rows } = await overviewRows(this.db, day, Date.now() - 7 * 86400000);
      const value: Omit<Overview, 'dev' | 'owner'> = {
        ...rows,
        settings: { ...defaultSettings, ...rows.settings },
        providers: publicProviders(this.env),
        chatId: this.env.TELEGRAM_CHAT_ID,
        storage: {
          backend: 'planetscale',
          ready: state.ready,
          status: state.status,
          copied: state.tables.reduce((sum, t) => sum + t.copied, 0),
          total: state.tables.reduce((sum, t) => sum + t.count, 0),
          error: state.error,
        },
      };
      if (!state.ready) await this.scheduleRemaining();
      this.overviewCache = { at: Date.now(), day, value };
      return value;
    }
    const stats = (await this.one<Record<string, number>>(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status IN ('spam','observed_spam') THEN 1 ELSE 0 END) AS spam,
      SUM(deleted) AS deleted,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status IN ('review','unsupported') THEN 1 ELSE 0 END) AS review FROM messages`))!;
    const banned = (await this.one<{
      count: number;
    }>('SELECT COUNT(*) AS count FROM users WHERE banned=1'))!.count;
    const tokens =
      (
        await this.one<{
          tokens: number;
        }>('SELECT tokens FROM usage WHERE day=?', new Date().toISOString().slice(0, 10))
      )?.tokens || 0;
    const labTokens =
      (
        await this.one<{
          lab_tokens: number;
        }>('SELECT lab_tokens FROM usage WHERE day=?', new Date().toISOString().slice(0, 10))
      )?.lab_tokens || 0;
    const failures = (await this.one<{
      count: number;
    }>(
      "SELECT (SELECT COUNT(*) FROM messages WHERE status='error')+(SELECT COUNT(*) FROM actions WHERE status='failed') AS count",
    ))!.count;
    const value: Omit<Overview, 'dev' | 'owner'> = {
      storage: { backend: 'sqlite', ready: true },
      settings: await this.settings(),
      providers: publicProviders(this.env),
      chatId: this.env.TELEGRAM_CHAT_ID,
      stats: {
        total: stats.total,
        spam: stats.spam || 0,
        deleted: stats.deleted || 0,
        pending: stats.pending || 0,
        review: stats.review || 0,
        banned,
        tokens,
        labTokens,
        failures,
      },
      daily: await this.rows(
        "SELECT strftime('%Y-%m-%d',sent_at/1000,'unixepoch') AS day,COUNT(*) AS total,SUM(CASE WHEN status IN ('spam','observed_spam') THEN 1 ELSE 0 END) AS spam FROM messages WHERE sent_at>? GROUP BY day ORDER BY day",
        Date.now() - 7 * 86400000,
      ),
      messages: await this.rows('SELECT * FROM messages ORDER BY sent_at DESC,id DESC LIMIT 20'),
      users: await this.rows(
        'SELECT u.*,(SELECT COUNT(*) FROM messages m WHERE m.user_id=u.user_id) AS messages FROM users u WHERE strikes>0 ORDER BY last_seen DESC LIMIT 100',
      ),
      audit: await this.rows('SELECT * FROM audit ORDER BY id DESC LIMIT 20'),
    };
    this.overviewCache = { at: Date.now(), day, value };
    return value;
  }
  private async createDataset(name: string, examples: Example[]) {
    const id = crypto.randomUUID();
    await this.db.transaction(async () => {
      await this.db.exec(
        'INSERT INTO datasets (id,name,created_at) VALUES (?,?,?)',
        id,
        name,
        Date.now(),
      );
      await this.insertExamples('examples', id, examples);
      await this.db.exec(
        'INSERT INTO dataset_stats (id,count,labelled) VALUES (?,?,?)',
        id,
        examples.length,
        examples.filter((e) => e.label !== null).length,
      );
    });
    return { id, count: examples.length };
  }
  async cleanup() {
    await this.requireLiveStorage();
    const cutoff = Date.now() - (await this.settings()).retentionDays * 86400000;
    await this.db.transaction(async () => {
      const expiredImports =
        "SELECT id FROM dataset_imports WHERE status='uploading' AND updated_at<?";
      const expiredAt = Date.now() - 86400000;
      await this.db.exec(`DELETE FROM examples WHERE dataset_id IN (${expiredImports})`, expiredAt);
      await this.db.exec(
        `DELETE FROM dataset_import_chunks WHERE dataset_id IN (${expiredImports})`,
        expiredAt,
      );
      await this.db.exec(`DELETE FROM datasets WHERE id IN (${expiredImports})`, expiredAt);
      await this.db.exec(`DELETE FROM dataset_stats WHERE id IN (${expiredImports})`, expiredAt);
      await this.db.exec(`DELETE FROM dataset_imports WHERE id IN (${expiredImports})`, expiredAt);
      await this.db.exec(
        "DELETE FROM messages AS m WHERE sent_at<? AND status NOT IN ('pending','error') AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.status IN ('pending','failed') AND a.user_id=m.user_id)",
        cutoff,
      );
      await this.db.exec('DELETE FROM updates WHERE received_at<?', Date.now() - 7 * 86400000);
      await this.db.exec('DELETE FROM audit WHERE created_at<?', cutoff);
      await this.db.exec("DELETE FROM actions WHERE status IN ('done','cancelled')");
      await this.db.exec(
        'DELETE FROM usage WHERE day<?',
        new Date(cutoff).toISOString().slice(0, 10),
      );
      // User strikes and evaluation datasets are retained until explicitly reset/deleted.
    });
  }
  async fetch(request: Request): Promise<Response> {
    return this.db.session(() => this.handleRequest(request));
  }
  private async handleRequest(request: Request): Promise<Response> {
    if (request.method !== 'GET') this.overviewCache = null;
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === '/api/storage' && request.method === 'GET')
        return json(
          this.db instanceof PostgresDatabase
            ? await migrationState(this.db)
            : { ready: true, status: 'complete' },
        );
      if (
        request.method !== 'GET' &&
        (path === '/api/settings' ||
          path.startsWith('/api/messages/') ||
          path.startsWith('/api/users/') ||
          path.startsWith('/api/actions/') ||
          path === '/api/datasets/capture')
      )
        await this.requireLiveStorage();
      const historicalPath = path.match(/^\/api\/(datasets|evaluations)\/([\w-]+)/);
      if (historicalPath)
        await this.requireLabRecord(
          historicalPath[1] === 'datasets' ? 'dataset' : 'run',
          historicalPath[2],
        );
      if (path === '/ingest' && request.method === 'POST')
        return json(await this.ingest(updateSchema.parse(await readJson(request))));
      if (path === '/cleanup' && request.method === 'POST') {
        await this.cleanup();
        return json({ ok: true });
      }
      if (path === '/api/overview' && request.method === 'GET') return json(await this.overview());
      if (path === '/api/images/check' && request.method === 'POST') {
        const saved = await this.settings();
        const draft = z
          .object({
            provider: z.string().min(1).max(60).optional(),
            model: z.string().min(1).max(200).optional(),
            imageProvider: z.string().min(1).max(60).optional(),
            imageModel: z.string().max(200).optional(),
            imageModeration: z.boolean().optional(),
          })
          .parse(await readJson(request));
        const route = await imageRoute(this.env, { ...saved, ...draft });
        const result = await this.classifyBatch(route.provider, route.model, saved.policy, [
          {
            id: 'vision-check',
            text: 'Connection check: classify this ordinary geometric illustration.',
            label: null,
            media: 'photo',
            image: VISION_CHECK_IMAGE,
          },
        ]);
        // This verifies the real provider path, never ingestion or enforcement.
        return json({
          ...route,
          inputTokens: result.input,
          outputTokens: result.output,
          cost: result.cost,
        });
      }
      if (path === '/api/settings' && request.method === 'PUT') {
        const settings = settingsSchema.parse(await readJson(request));
        if (!publicProviders(this.env).some((p) => p.id === settings.provider))
          throw new HttpError(400, 'Unknown provider.');
        if (!publicProviders(this.env).some((p) => p.id === settings.imageProvider))
          throw new HttpError(400, 'Unknown image fallback provider.');
        if (settings.mode === 'enforce') {
          if (!this.env.TELEGRAM_BOT_TOKEN || !this.env.OWNER_TELEGRAM_ID)
            throw new HttpError(400, 'Configure the bot token and owner Telegram ID first.');
          configuredProvider(this.env, settings.provider);
        }
        const previous = await this.settings(),
          previousMode = previous.mode;
        await this.db.transaction(async () => {
          await this.db.exec('UPDATE config SET value=? WHERE id=1', JSON.stringify(settings));
          if (previousMode === 'paused' && settings.mode !== 'paused') {
            await this.db.exec(
              "UPDATE messages SET status=CASE WHEN text!='' OR (?=1 AND image_file_id!='') THEN 'pending' ELSE 'unsupported' END,next_at=0 WHERE status='paused'",
              Number(settings.imageModeration),
            );
          }
          if (settings.dailyTokenBudget > previous.dailyTokenBudget) {
            await this.db.exec(
              "UPDATE messages SET next_at=0 WHERE status='pending' AND reason LIKE 'Daily token budget reached.%'",
            );
          }
        });
        await this.log('settings', JSON.stringify(settings));
        await this.scheduleRemaining();
        return json(settings);
      }
      if (path === '/api/messages' && request.method === 'GET') {
        const offset = Math.max(0, Math.min(10000000, Number(url.searchParams.get('offset')) || 0));
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 50));
        const status = url.searchParams.get('status') || '';
        const search = (url.searchParams.get('search') || '').slice(0, 200);
        const where =
          "WHERE (?='' OR status=? OR (?='review' AND status='unsupported')) AND (?='' OR instr(lower(text),lower(?))>0 OR instr(lower(user_name),lower(?))>0)";
        return json({
          messages: await this.rows(
            `SELECT * FROM messages ${where} ORDER BY sent_at DESC,id DESC LIMIT ? OFFSET ?`,
            status,
            status,
            status,
            search,
            search,
            search,
            limit,
            offset,
          ),
          total: (await this.one<{
            count: number;
          }>(
            `SELECT COUNT(*) AS count FROM messages ${where}`,
            status,
            status,
            status,
            search,
            search,
            search,
          ))!.count,
        });
      }
      if (path === '/api/export' && request.method === 'GET') {
        const before = Math.min(
          Number.MAX_SAFE_INTEGER,
          Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER,
        );
        const messages = await this.rows<MessageRow>(
          'SELECT * FROM messages WHERE id<? ORDER BY id DESC LIMIT 500',
          before,
        );
        return json({ messages, nextCursor: messages.length === 500 ? messages.at(-1)!.id : null });
      }
      const imagePath = path.match(/^\/api\/messages\/(\d+)\/image$/);
      if (imagePath && request.method === 'GET') {
        const m = await this.one<MessageRow>(
          'SELECT * FROM messages WHERE id=?',
          Number(imagePath[1]),
        );
        if (!m?.image_file_id) throw new HttpError(404, 'No captured image is available.');
        try {
          const { bytes, mime } = await telegramImage(this.env, m.image_file_id);
          return new Response(new Uint8Array(bytes), {
            headers: {
              'Content-Type': mime,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        } catch {
          throw new HttpError(502, 'The image is unavailable from Telegram.');
        }
      }
      const messagePath = path.match(/^\/api\/messages\/(\d+)\/(label|moderate|retry)$/);
      if (messagePath && request.method === 'POST') {
        const id = Number(messagePath[1]);
        if (messagePath[2] === 'label') {
          const { label } = z.object({ label: labelSchema }).parse(await readJson(request));
          if (!(await this.one('SELECT id FROM messages WHERE id=?', id)))
            throw new HttpError(404, 'Message not found.');
          await this.db.exec('UPDATE messages SET label=? WHERE id=?', label, id);
        } else if (messagePath[2] === 'retry') {
          const settings = await this.settings();
          await this.db.exec(
            "UPDATE messages SET status='pending',score=NULL,reason='',category='',model='',attempts=0,next_at=0 WHERE id=? AND strike_awarded=0 AND deleted=0 AND status!='protected' AND (text!='' OR (?=1 AND image_file_id!=''))",
            id,
            Number(settings.imageModeration),
          );
          await this.wake();
        } else
          await this.serial(async () => {
            if ((await this.settings()).mode !== 'enforce')
              throw new HttpError(409, 'Enable enforcement before manual moderation.');
            const m = await this.one<MessageRow>('SELECT * FROM messages WHERE id=?', id);
            if (!m) throw new HttpError(404, 'Message not found.');
            if (await this.isProtected(m.user_id))
              throw new HttpError(403, 'Owner, administrators, and exempt senders are protected.');
            await this.awardStrike(
              m,
              {
                id: String(id),
                score: 1,
                category: 'manual',
                reason: 'Marked as spam by the owner.',
              },
              'owner',
              (await this.settings()).policy,
            );
            await this.wake();
          });
        return json({ ok: true });
      }
      const userPath = path.match(/^\/api\/users\/(\d+)\/reset$/);
      if (userPath && request.method === 'POST')
        return await this.serial(async () => {
          const userId = userPath[1];
          const u = await this.one<{
            banned: number;
          }>('SELECT banned FROM users WHERE user_id=?', userId);
          if (!u) throw new HttpError(404, 'User not found.');
          if (u.banned)
            await telegram(this.env, 'unbanChatMember', {
              chat_id: this.env.TELEGRAM_CHAT_ID,
              user_id: Number(userId),
              only_if_banned: true,
            });
          await this.db.transaction(async () => {
            await this.db.exec('UPDATE users SET strikes=0,banned=0 WHERE user_id=?', userId);
            await this.db.exec(
              "UPDATE actions SET status='cancelled' WHERE user_id=? AND status IN ('pending','failed')",
              userId,
            );
            // Preserve each message's strike marker so retries cannot re-award a forgiven strike.
            await this.log(
              'reset',
              'Owner reset strikes and lifted the bot ban, if present.',
              userId,
            );
          });
          return json({ ok: true });
        });
      if (path === '/api/actions/retry' && request.method === 'POST') {
        await this.db.exec(
          "UPDATE actions SET status='pending',attempts=0,next_at=0 WHERE status='failed'",
        );
        await this.wake();
        return json({ ok: true });
      }
      if (path === '/api/datasets' && request.method === 'GET') {
        const hidden = await this.hiddenLabIds('dataset');
        return json(
          await this.rows(
            `SELECT d.*,s.count,s.labelled FROM datasets d JOIN dataset_stats s ON s.id=d.id WHERE NOT EXISTS(SELECT 1 FROM dataset_imports i WHERE i.id=d.id AND i.status='uploading') AND ${excludeIds('d.id', hidden)} ORDER BY created_at DESC`,
            ...hidden,
          ),
        );
      }
      if (path === '/api/datasets' && request.method === 'POST') {
        const { name, data, chatId } = z
          .object({
            name: z.string().min(1).max(100),
            data: z.unknown(),
            chatId: z.string().optional(),
          })
          .parse(await readJson(request, 12000000));
        return json(await this.createDataset(name, importExamples(data, chatId)), 201);
      }
      if (path === '/api/datasets/imports' && request.method === 'POST') {
        const { id, name } = z
          .object({ id: z.uuid(), name: z.string().min(1).max(100) })
          .parse(await readJson(request));
        const existing = await this.one<{
          name: string;
        }>('SELECT name FROM datasets WHERE id=?', id);
        if (existing) {
          if (
            existing.name !== name ||
            !(await this.one('SELECT id FROM dataset_imports WHERE id=?', id))
          )
            throw new HttpError(409, 'Import ID already exists.');
          return json({ id });
        }
        await this.db.transaction(async () => {
          await this.db.exec(
            'INSERT INTO datasets (id,name,created_at) VALUES (?,?,?)',
            id,
            name,
            Date.now(),
          );
          await this.db.exec(
            'INSERT INTO dataset_imports (id,updated_at) VALUES (?,?)',
            id,
            Date.now(),
          );
          await this.db.exec('INSERT INTO dataset_stats (id,count,labelled) VALUES (?,0,0)', id);
        });
        return json({ id }, 201);
      }
      const importChunk = path.match(/^\/api\/datasets\/([\w-]+)\/chunks$/);
      if (importChunk && request.method === 'POST') {
        const body = z
          .object({ sequence: z.number().int().min(0).max(1000000000), examples: z.unknown() })
          .parse(await readJson(request));
        const examples = validateExamples(body.examples, IMPORT_BATCH_MESSAGES);
        const digest = [
          ...new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(JSON.stringify(examples)),
            ),
          ),
        ]
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('');
        return json(
          await this.db.transaction(async () => {
            const state = await this.one<{
              status: string;
              count: number;
              chunks: number;
            }>('SELECT * FROM dataset_imports WHERE id=?', importChunk[1]);
            if (!state) throw new HttpError(404, 'Import not found.');
            const previous = await this.one<{
              digest: string;
            }>(
              'SELECT digest FROM dataset_import_chunks WHERE dataset_id=? AND sequence=?',
              importChunk[1],
              body.sequence,
            );
            if (previous) {
              if (previous.digest !== digest)
                throw new HttpError(
                  409,
                  'This upload batch was already stored with different messages.',
                );
              return { count: state.count, chunks: state.chunks };
            }
            if (state.status !== 'uploading' || body.sequence !== state.chunks)
              throw new HttpError(409, 'Upload batches must arrive in order.');
            try {
              await this.insertExamples('examples', importChunk[1], examples, state.count);
            } catch (e) {
              if (safeError(e).includes('UNIQUE'))
                throw new HttpError(409, 'Message IDs must be unique within a dataset.');
              throw e;
            }
            await this.db.exec(
              'INSERT INTO dataset_import_chunks (dataset_id,sequence,digest) VALUES (?,?,?)',
              importChunk[1],
              body.sequence,
              digest,
            );
            await this.db.exec(
              'UPDATE dataset_imports SET count=count+?,chunks=chunks+1,updated_at=? WHERE id=?',
              examples.length,
              Date.now(),
              importChunk[1],
            );
            await this.db.exec(
              'UPDATE dataset_stats SET count=count+?,labelled=labelled+? WHERE id=?',
              examples.length,
              examples.filter((e) => e.label !== null).length,
              importChunk[1],
            );
            return { count: state.count + examples.length, chunks: state.chunks + 1 };
          }),
        );
      }
      const importFinish = path.match(/^\/api\/datasets\/([\w-]+)\/complete$/);
      if (importFinish && request.method === 'POST') {
        const body = z
          .object({ count: z.number().int().positive(), chunks: z.number().int().positive() })
          .parse(await readJson(request));
        return json(
          await this.db.transaction(async () => {
            const state = await this.one<{
              count: number;
              chunks: number;
            }>('SELECT * FROM dataset_imports WHERE id=?', importFinish[1]);
            if (!state) throw new HttpError(404, 'Import not found.');
            if (state.count !== body.count || state.chunks !== body.chunks)
              throw new HttpError(
                409,
                'The import is incomplete. Some upload batches are missing.',
              );
            await this.db.exec(
              "UPDATE dataset_imports SET status='complete',updated_at=? WHERE id=?",
              Date.now(),
              importFinish[1],
            );
            return await this.datasetMeta(importFinish[1]);
          }),
        );
      }
      if (path === '/api/datasets/capture' && request.method === 'POST') {
        const { name } = z
          .object({ name: z.string().min(1).max(100) })
          .parse(await readJson(request));
        const messages = (
          await this.rows<MessageRow>(
            "SELECT * FROM messages WHERE text!='' ORDER BY sent_at DESC,id DESC LIMIT 10000",
          )
        ).reverse();
        if (!messages.length) throw new HttpError(400, 'No captured text messages yet.');
        return json(await this.createDataset(name, await this.examplesFor(messages)), 201);
      }
      const datasetPath = path.match(/^\/api\/datasets\/([\w-]+)$/);
      if (datasetPath && request.method === 'GET') {
        const dataset = await this.datasetMeta(datasetPath[1]);
        if (!dataset) throw new HttpError(404, 'Dataset not found.');
        const page = z
          .object({
            offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
            limit: z.coerce.number().int().min(1).max(250).default(25),
          })
          .parse(Object.fromEntries(url.searchParams));
        return json({
          dataset,
          examples: await this.decodedExamples(
            'examples',
            'dataset_id',
            datasetPath[1],
            page.offset,
            page.limit,
          ),
          offset: page.offset,
          nextOffset: page.offset + page.limit < dataset.count ? page.offset + page.limit : null,
        });
      }
      if (datasetPath && request.method === 'DELETE') {
        await this.db.transaction(async () => {
          await this.db.exec('DELETE FROM examples WHERE dataset_id=?', datasetPath[1]);
          await this.db.exec(
            'DELETE FROM dataset_import_chunks WHERE dataset_id=?',
            datasetPath[1],
          );
          await this.db.exec('DELETE FROM dataset_imports WHERE id=?', datasetPath[1]);
          await this.db.exec('DELETE FROM datasets WHERE id=?', datasetPath[1]);
          await this.db.exec('DELETE FROM dataset_stats WHERE id=?', datasetPath[1]);
        });
        return json({ ok: true });
      }
      const datasetLabel = path.match(/^\/api\/datasets\/([\w-]+)\/labels$/);
      if (datasetLabel && request.method === 'POST') {
        const labels = z
          .array(z.object({ id: z.string().max(120), label: labelSchema }))
          .max(10000)
          .parse(await readJson(request));
        await this.db.transaction(async () => {
          for (const l of labels) {
            const previous = await this.one<{
              id: string;
              text: string;
              context: string;
              media: string;
            }>(
              'SELECT id,text,context,media FROM examples WHERE dataset_id=? AND id=?',
              datasetLabel[1],
              l.id,
            );
            if (!previous) continue;
            await this.saveReviewLabel(datasetLabel[1], previous, l.label);
          }
        });
        return json({ ok: true });
      }
      if (path === '/api/evaluations/status' && request.method === 'GET') {
        const hidden = await this.hiddenLabIds('run');
        const snapshots = url.searchParams.get('snapshots') === '1';
        if (snapshots && this.db instanceof PostgresDatabase)
          return await evaluationIndexResponse(this.db, hidden);
        const runs = await this.rows<Evaluation>(
          `SELECT * FROM evaluations WHERE ${excludeIds('id', hidden)} ORDER BY created_at DESC LIMIT 12`,
          ...hidden,
        );
        return json(snapshots ? runs.map((r) => ({ ...r, snapshot_key: r.id })) : runs);
      }
      const pagePath = path.match(/^\/api\/evaluations\/([\w-]+)\/(examples|results)$/);
      if (pagePath && request.method === 'GET') {
        const { offset, limit } = z
          .object({
            offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(100),
          })
          .parse(Object.fromEntries(url.searchParams));
        const section = pagePath[2] as 'examples' | 'results';
        if (this.db instanceof PostgresDatabase)
          return await evaluationPageResponse(this.db, pagePath[1], section, offset, limit);
        const run = await this.one<Evaluation>('SELECT * FROM evaluations WHERE id=?', pagePath[1]);
        if (!run) throw new HttpError(404, 'Run not found.');
        const candidates = await this.decodedExamples(
          'run_examples',
          'run_id',
          run.id,
          offset,
          limit,
        );
        const examples: Example[] = [];
        let bytes = 0;
        for (const example of candidates) {
          bytes += new TextEncoder().encode(JSON.stringify(example)).length + 256;
          if (bytes > 24000 && examples.length) break;
          examples.push(example);
        }
        const nextOffset =
          examples.length && offset + examples.length < run.total ? offset + examples.length : null;
        if (section === 'examples') return json({ examples, nextOffset });
        const ids = examples.map((e) => e.id);
        const placeholders = ids.map(() => '?').join(',');
        return json({
          predictions: ids.length
            ? await this.rows<Prediction>(
                `SELECT id,score,category,reason FROM predictions WHERE run_id=? AND id IN (${placeholders})`,
                run.id,
                ...ids,
              )
            : [],
          reviewLabels: ids.length
            ? await this.rows(
                `SELECT l.id,l.label,l.updated_at FROM evaluation_labels l JOIN run_examples e
              ON e.run_id=? AND e.id=l.id AND e.text=l.text AND e.context=l.context AND e.media=l.media
              WHERE l.dataset_id=? AND e.id IN (${placeholders})`,
                run.id,
                run.dataset_id,
                ...ids,
              )
            : [],
          nextOffset,
        });
      }
      if (path === '/api/evaluations' && request.method === 'GET') {
        const hidden = await this.hiddenLabIds('run');
        if (this.db instanceof PostgresDatabase) return await evaluationResponse(this.db, hidden);
        const runs = await this.rows<Evaluation>(
          `SELECT * FROM evaluations WHERE ${excludeIds('id', hidden)} ORDER BY created_at DESC LIMIT 12`,
          ...hidden,
        );
        return json(
          await Promise.all(
            runs.map(async (r) => ({
              ...r,
              examples: await this.decodedExamples('run_examples', 'run_id', r.id),
              predictions: await this.rows<Prediction>(
                'SELECT id,score,category,reason FROM predictions WHERE run_id=?',
                r.id,
              ),
              reviewLabels: await this.rows(
                'SELECT l.id,l.label,l.updated_at FROM evaluation_labels l JOIN run_examples e ON e.run_id=? AND e.id=l.id AND e.text=l.text AND e.context=l.context AND e.media=l.media WHERE l.dataset_id=?',
                r.id,
                r.dataset_id,
              ),
            })),
          ),
        );
      }
      const reviewPath = path.match(/^\/api\/evaluations\/([\w-]+)\/reviews$/);
      if (reviewPath && request.method === 'POST') {
        const labels = z
          .array(z.object({ id: z.string().min(1).max(120), label: labelSchema }))
          .min(1)
          .max(250)
          .parse(await readJson(request));
        const run = await this.one<Evaluation>(
          'SELECT * FROM evaluations WHERE id=?',
          reviewPath[1],
        );
        if (!run) throw new HttpError(404, 'Run not found.');
        if (new Set(labels.map((l) => l.id)).size !== labels.length)
          throw new HttpError(400, 'Each message may be labelled once per request.');
        const examples = await Promise.all(
          labels.map(async (l) => {
            const example = await this.one<{
              id: string;
              text: string;
              context: string;
              media: string;
            }>(
              'SELECT id,text,context,media FROM run_examples WHERE run_id=? AND id=?',
              run.id,
              l.id,
            );
            if (!example) throw new HttpError(400, 'A review message is not in this saved sample.');
            return { example, label: l.label };
          }),
        );
        await this.db.transaction(async () => {
          for (const item of examples)
            await this.saveReviewLabel(run.dataset_id, item.example, item.label);
        });
        return json({ ok: true });
      }
      if (path === '/api/evaluations' && request.method === 'POST') {
        const body = z
          .object({
            datasetId: z.string(),
            models: z
              .array(z.object({ provider: z.string().max(60), model: z.string().min(1).max(200) }))
              .min(1)
              .max(5),
            limit: z.number().int().min(1).max(1000).default(200),
            policy: z.string().min(20).max(6000).optional(),
          })
          .parse(await readJson(request));
        await this.requireLabRecord('dataset', body.datasetId);
        const hidden = await this.hiddenLabIds('run');
        const active = (await this.one<{
          count: number;
        }>(
          `SELECT COUNT(*) AS count FROM evaluations WHERE status IN ('queued','running') AND ${excludeIds('id', hidden)}`,
          ...hidden,
        ))!.count;
        if (active + body.models.length > 5)
          throw new HttpError(429, 'At most five evaluation models may be queued at once.');
        for (const model of body.models) configuredProvider(this.env, model.provider);
        const dataset = await this.datasetMeta(body.datasetId);
        if (!dataset) throw new HttpError(404, 'Dataset not found.');
        // Evenly sample in dataset order; the same snapshot is used for every model.
        const size = Math.min(body.limit, dataset.count);
        const examples = await this.sampleDataset(body.datasetId, dataset.count, size);
        const ids: string[] = [];
        await this.db.transaction(async () => {
          for (const model of body.models) {
            const id = crypto.randomUUID();
            ids.push(id);
            await this.db.exec(
              "INSERT INTO evaluations (id,dataset_id,dataset_name,provider,model,policy,status,total,created_at) VALUES (?,?,?,?,?,?,'queued',?,?)",
              id,
              body.datasetId,
              dataset.name,
              model.provider,
              model.model,
              body.policy || (await this.settings()).policy,
              examples.length,
              Date.now(),
            );
            await this.insertExamples('run_examples', id, examples);
          }
        });
        await this.wake();
        return json({ ids }, 202);
      }
      const resumePath = path.match(/^\/api\/evaluations\/([\w-]+)\/resume$/);
      if (resumePath && request.method === 'POST') {
        const run = await this.one<Evaluation>(
          'SELECT * FROM evaluations WHERE id=?',
          resumePath[1],
        );
        if (!run) throw new HttpError(404, 'Run not found.');
        if (run.status !== 'failed') throw new HttpError(409, 'Only failed runs can be resumed.');
        const hidden = await this.hiddenLabIds('run');
        const active = (await this.one<{
          count: number;
        }>(
          `SELECT COUNT(*) AS count FROM evaluations WHERE status IN ('queued','running') AND id!=? AND ${excludeIds('id', hidden)}`,
          run.id,
          ...hidden,
        ))!.count;
        if (active >= 5)
          throw new HttpError(429, 'At most five evaluation models may be queued at once.');
        configuredProvider(this.env, run.provider);
        await this.db.exec("UPDATE evaluations SET status='queued',error='' WHERE id=?", run.id);
        await this.wake();
        return json({ ok: true }, 202);
      }
      const runPath = path.match(/^\/api\/evaluations\/([\w-]+)\/cancel$/);
      if (runPath && request.method === 'POST') {
        await this.db.exec(
          "UPDATE evaluations SET status='cancelled' WHERE id=? AND status IN ('queued','running')",
          runPath[1],
        );
        return json({ ok: true });
      }
      if (path === '/api/telegram/status' && request.method === 'GET') {
        if (!this.env.TELEGRAM_BOT_TOKEN) return json({ configured: false });
        const me = await telegram<{
          id: number;
          username: string;
        }>(this.env, 'getMe');
        const member = await telegram<{
          status: string;
          can_delete_messages?: boolean;
          can_restrict_members?: boolean;
        }>(this.env, 'getChatMember', { chat_id: this.env.TELEGRAM_CHAT_ID, user_id: me.id });
        const webhook = await telegram(this.env, 'getWebhookInfo');
        return json({ configured: true, bot: me.username, member, webhook });
      }
      if (
        path === '/api/demo' &&
        request.method === 'POST' &&
        request.headers.get('X-Local-Demo') === '1' &&
        this.env.DEV_MODE === 'true'
      ) {
        const { demoExamples } = await import('../shared/demo');
        return json(
          await this.createDataset('Starter dataset · illustrative examples', demoExamples),
          201,
        );
      }
      throw new HttpError(404, 'Route not found.');
    } catch (e) {
      const quota = databaseQuotaResponse(e);
      if (quota) return quota;
      if (e instanceof HttpError) {
        const response = json({ error: e.message }, e.status);
        if (e.status === 503)
          response.headers.set('Retry-After', e instanceof DatabaseUnavailableError ? '5' : '300');
        return response;
      }
      if (e instanceof z.ZodError)
        return json(
          {
            error: e.issues
              .map((i) => i.message)
              .join(' ')
              .slice(0, 500),
          },
          400,
        );
      return json({ error: safeError(e) }, 400);
    } finally {
      // A read can interleave while a mutation awaits Telegram or alarm storage.
      if (request.method !== 'GET') this.overviewCache = null;
    }
  }
}

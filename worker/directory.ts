import { z } from 'zod';
import { PostgresDatabase } from './database';
import { POSTGRES_SCHEMA } from './postgres-schema';
import { STORAGE_TABLES } from './database';
import { initialMigration } from './storage';
import {
  defaultSettings,
  settingsSchema,
  type WatchtowerGroup,
  type Settings,
} from '../shared/types';
import { telegram, TelegramError, type TelegramUpdate } from './telegram';
import { HttpError, json, readJson } from './http';
import type { Env } from './env';

const chatIdSchema = z.string().regex(/^-\d{1,16}$/);
export const groupEnv = (env: Env, chatId: string): Env => ({
  ...env,
  DATABASE_ROOT_CHAT_ID: env.DATABASE_ROOT_CHAT_ID || env.TELEGRAM_CHAT_ID,
  TELEGRAM_CHAT_ID: chatId,
});
const ready = (member: {
  status: string;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
}) =>
  member.status === 'administrator' &&
  !!member.can_delete_messages &&
  !!member.can_restrict_members;

export interface Directory {
  db?: PostgresDatabase;
  fetch(request: Request): Promise<Response>;
  discover(update: TelegramUpdate): Promise<string | null>;
  get(chatId: string): Promise<WatchtowerGroup | undefined>;
  active(): Promise<WatchtowerGroup[]>;
  session<T>(fn: () => Promise<T>): Promise<T>;
}

// One small registry lives alongside the original group's tables. Additional groups
// get namespaced tables in that existing schema, using the application's CREATE
// privilege there; the Worker never needs an administrator database credential.
export async function initializeDirectory(
  db: PostgresDatabase,
  env: Pick<Env, 'TELEGRAM_CHAT_ID'>,
) {
  await db.transaction(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS ${db.table('watchtower_groups')} (
      chat_id TEXT PRIMARY KEY, title TEXT NOT NULL, chat_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', provisioned BIGINT NOT NULL DEFAULT 0,
      bot_status TEXT NOT NULL DEFAULT 'unknown', can_delete BIGINT NOT NULL DEFAULT 0,
      can_ban BIGINT NOT NULL DEFAULT 0, event_at BIGINT NOT NULL DEFAULT 0,
      event_id BIGINT NOT NULL DEFAULT -1, created_at BIGINT NOT NULL,
      activated_at BIGINT
    )`);
    await db.exec(
      `INSERT INTO ${db.table('watchtower_groups')}
      (chat_id,title,chat_type,status,provisioned,created_at,activated_at)
      VALUES (?,'Telegram community','supergroup','active',1,?,?) ON CONFLICT DO NOTHING`,
      env.TELEGRAM_CHAT_ID,
      Date.now(),
      Date.now(),
    );
  });
}

async function provision(db: PostgresDatabase, settings: Settings) {
  // The schema is trusted source code; only validated numeric chat IDs form prefixes.
  const tables = [...STORAGE_TABLES, 'work_state'];
  let ddl = POSTGRES_SCHEMA.replace(
    new RegExp(`\\b(${tables.join('|')})\\b`, 'g'),
    (table) => db.tablePrefix + table,
  );
  ddl = ddl.replace(
    /(CREATE INDEX IF NOT EXISTS )([a-z_]+)/g,
    (_, keyword, name) => keyword + db.tablePrefix + name,
  );
  await db.exec(ddl);
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${db.table('storage_state')} (id BIGINT PRIMARY KEY,value TEXT NOT NULL)`,
  );
  await db.exec(
    'INSERT INTO config (id,value) VALUES (1,?) ON CONFLICT DO NOTHING',
    JSON.stringify(settings),
  );
  await db.exec(
    'INSERT INTO storage_state (id,value) VALUES (1,?) ON CONFLICT DO NOTHING',
    JSON.stringify({ ...initialMigration(), ready: true, status: 'complete' }),
  );
}

export class GroupDirectory implements Directory {
  constructor(
    readonly db: PostgresDatabase,
    private env: Env,
  ) {}
  session<T>(fn: () => Promise<T>) {
    return this.db.session(fn);
  }
  private get table() {
    return this.db.table('watchtower_groups');
  }
  async get(chatId: string) {
    return (
      await this.db.exec<WatchtowerGroup>(`SELECT * FROM ${this.table} WHERE chat_id=?`, chatId)
    )[0];
  }
  active() {
    return this.db.exec<WatchtowerGroup>(
      `SELECT * FROM ${this.table} WHERE status='active' ORDER BY chat_id`,
    );
  }
  private async pause(group: WatchtowerGroup) {
    if (group.provisioned)
      await this.db
        .forGroup(group.chat_id)
        .exec(
          `UPDATE config SET value=(value::jsonb || '{"mode":"paused"}'::jsonb)::text WHERE id=1`,
        );
  }
  private async ownerIsAdmin(chatId: string) {
    try {
      const owner = await telegram<{ status: string }>(this.env, 'getChatMember', {
        chat_id: chatId,
        user_id: Number(this.env.OWNER_TELEGRAM_ID),
      });
      return ['creator', 'administrator'].includes(owner.status);
    } catch (e) {
      if (e instanceof TelegramError && [400, 403].includes(e.code)) return false;
      throw e;
    }
  }
  async discover(update: TelegramUpdate): Promise<string | null> {
    const event = update.my_chat_member,
      message = update.message || update.edited_message;
    const chat = event?.chat || message?.chat;
    if (!chat || !['group', 'supergroup'].includes(chat.type) || chat.id >= 0) return null;
    const chatId = String(chat.id);
    let current = await this.get(chatId);
    const ownerCommand =
      message?.from?.id === Number(this.env.OWNER_TELEGRAM_ID) &&
      /^(?:\/watchtower(?:@\w+)?\s*$|\/start(?:@\w+)?\s+watchtower\s*$)/i.test(message.text || '');
    if (!current && !event && !ownerCommand) return null;
    if (
      !current &&
      event &&
      event.from.id !== Number(this.env.OWNER_TELEGRAM_ID) &&
      !(await this.ownerIsAdmin(chatId))
    )
      return null;
    if (event) {
      await this.db.transaction(async () => {
        current = await this.get(chatId);
        // Delayed/duplicate membership updates cannot undo more recent permissions.
        if (
          current &&
          (event.date < current.event_at ||
            (event.date === current.event_at && update.update_id <= current.event_id))
        )
          return;
        const member = event.new_chat_member;
        const gone = ['left', 'kicked'].includes(member.status);
        const status = gone
          ? 'removed'
          : current?.status === 'active'
            ? ready(member)
              ? 'active'
              : 'needs_permissions'
            : 'pending';
        await this.db.exec(
          `INSERT INTO ${this.table}
          (chat_id,title,chat_type,status,bot_status,can_delete,can_ban,event_at,event_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET
          title=excluded.title,chat_type=excluded.chat_type,status=excluded.status,
          bot_status=excluded.bot_status,can_delete=excluded.can_delete,can_ban=excluded.can_ban,
          event_at=excluded.event_at,event_id=excluded.event_id`,
          chatId,
          chat.title || 'Telegram group',
          chat.type,
          status,
          member.status,
          Number(!!member.can_delete_messages),
          Number(!!member.can_restrict_members),
          event.date,
          update.update_id,
          Date.now(),
        );
        if (current?.status === 'active' && status !== 'active') await this.pause(current);
      });
    } else if (!current) {
      await this.db.exec(
        `INSERT INTO ${this.table} (chat_id,title,chat_type,created_at)
        VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
        chatId,
        chat.title || 'Telegram group',
        chat.type,
        Date.now(),
      );
    } else if (chat.title && chat.title !== current.title) {
      await this.db.exec(`UPDATE ${this.table} SET title=? WHERE chat_id=?`, chat.title, chatId);
    }
    // Discovery stores metadata only. Unapproved groups spend no model tokens and
    // contribute no message contents to an existing group's feed or lab.
    const group = await this.get(chatId);
    return message && group?.status === 'active' ? chatId : null;
  }
  private async check(chatId: string) {
    const existing = await this.get(chatId);
    if (!existing)
      throw new HttpError(
        404,
        'This group has not been detected yet. Add the bot or send /watchtower as the owner.',
      );
    const me = await telegram<{ id: number; username: string }>(this.env, 'getMe');
    const chat = await telegram<{ id: number; title: string; type: string }>(this.env, 'getChat', {
      chat_id: chatId,
    });
    const member = await telegram<{
      status: string;
      can_delete_messages?: boolean;
      can_restrict_members?: boolean;
    }>(this.env, 'getChatMember', { chat_id: chatId, user_id: me.id });
    const ownerAdmin = await this.ownerIsAdmin(chatId);
    await this.db.transaction(async () => {
      const group = (await this.get(chatId))!;
      const gone = ['left', 'kicked'].includes(member.status);
      const status = gone
        ? 'removed'
        : group.status === 'active' && (!ready(member) || !ownerAdmin)
          ? 'needs_permissions'
          : group.status;
      await this.db.exec(
        `UPDATE ${this.table} SET title=?,chat_type=?,bot_status=?,can_delete=?,can_ban=?,status=? WHERE chat_id=?`,
        chat.title,
        chat.type,
        member.status,
        Number(!!member.can_delete_messages),
        Number(!!member.can_restrict_members),
        status,
        chatId,
      );
      if (status !== 'active' && group.status === 'active') await this.pause(group);
    });
    return { chat, member, ownerAdmin };
  }
  async fetch(request: Request) {
    return this.session(async () => {
      const path = new URL(request.url).pathname;
      if (path === '/api/groups' && request.method === 'GET') {
        const groups = await this.db.exec<WatchtowerGroup>(
          `SELECT * FROM ${this.table} ORDER BY provisioned DESC,created_at DESC`,
        );
        return json({
          groups,
          defaultChatId: this.env.TELEGRAM_CHAT_ID,
          botUsername: this.env.TELEGRAM_BOT_USERNAME || '',
        });
      }
      const match = path.match(/^\/api\/groups\/(-\d+)\/(activate|check)$/);
      if (!match || request.method !== 'POST') throw new HttpError(404, 'Route not found.');
      const chatId = chatIdSchema.parse(match[1]);
      const permission = await this.check(chatId);
      if (match[2] === 'check') return json({ group: await this.get(chatId), ...permission });
      if (!permission.ownerAdmin)
        throw new HttpError(
          403,
          'Your configured Telegram account must be an administrator of this group.',
        );
      if (permission.chat.type !== 'supergroup' || !/^-100\d+$/.test(chatId))
        throw new HttpError(
          409,
          'This must be a Telegram supergroup for the three-strike policy. Once upgraded, its new ID will be detected automatically.',
        );
      if (!ready(permission.member))
        throw new HttpError(
          409,
          'Promote the bot to administrator with Delete messages and Ban users, then check again.',
        );
      const body = z
        .object({
          copyFrom: z
            .string()
            .regex(/^-100\d+$/)
            .optional(),
        })
        .parse(await readJson(request));
      await this.db.transaction(async () => {
        const existing = (await this.get(chatId))!;
        if (existing.status === 'active') return; // A retry must not reset Enforce or strikes.
        if (existing.bot_status !== 'administrator' || !existing.can_delete || !existing.can_ban)
          throw new HttpError(
            409,
            'Bot permissions changed during setup. Check permissions again.',
          );
        let settings: Settings = defaultSettings;
        if (body.copyFrom) {
          if (!(await this.get(body.copyFrom))?.provisioned)
            throw new HttpError(404, 'The source group is not configured.');
          const [source] = await this.db
            .forGroup(body.copyFrom)
            .exec<{ value: string }>('SELECT value FROM config WHERE id=1');
          settings = settingsSchema.parse(JSON.parse(source.value));
        } else if (existing.provisioned) {
          const [saved] = await this.db
            .forGroup(chatId)
            .exec<{ value: string }>('SELECT value FROM config WHERE id=1');
          settings = settingsSchema.parse(JSON.parse(saved.value));
        }
        settings = {
          ...settings,
          mode: 'observe',
          exemptUserIds: body.copyFrom ? [] : settings.exemptUserIds,
        };
        const db = this.db.forGroup(chatId);
        await provision(db, settings);
        await db.exec('UPDATE config SET value=? WHERE id=1', JSON.stringify(settings));
        await db.exec(
          "UPDATE messages SET status=CASE WHEN text!='' OR (?=1 AND image_file_id!='') THEN 'pending' ELSE 'unsupported' END,next_at=0 WHERE status='paused'",
          Number(settings.imageModeration),
        );
        await this.db.exec(
          `UPDATE ${this.table} SET status='active',provisioned=1,activated_at=COALESCE(activated_at,?) WHERE chat_id=?`,
          Date.now(),
          chatId,
        );
      });
      return json({ group: await this.get(chatId) });
    });
  }
}

// The SQLite development adapter remains a single isolated group. Production
// multi-group routing and provisioning are tested against disposable Postgres.
export class LocalDirectory implements Directory {
  constructor(private env: Env) {}
  session<T>(fn: () => Promise<T>) {
    return fn();
  }
  async get(chatId: string) {
    return chatId === this.env.TELEGRAM_CHAT_ID
      ? ({
          chat_id: chatId,
          title: 'Local Telegram group',
          chat_type: 'supergroup',
          status: 'active',
          provisioned: 1,
          bot_status: 'administrator',
          can_delete: 1,
          can_ban: 1,
          event_at: 0,
          event_id: -1,
          created_at: 0,
          activated_at: 0,
        } as WatchtowerGroup)
      : undefined;
  }
  async active() {
    return [(await this.get(this.env.TELEGRAM_CHAT_ID))!];
  }
  async discover(update: TelegramUpdate) {
    const message = update.message || update.edited_message;
    return String(message?.chat.id) === this.env.TELEGRAM_CHAT_ID
      ? this.env.TELEGRAM_CHAT_ID
      : null;
  }
  async fetch(request: Request) {
    if (new URL(request.url).pathname !== '/api/groups' || request.method !== 'GET')
      throw new HttpError(
        409,
        'Use the deployed dashboard to connect additional groups. Local SQLite uses one test group.',
      );
    return json({
      groups: await this.active(),
      defaultChatId: this.env.TELEGRAM_CHAT_ID,
      botUsername: '',
    });
  }
}

import { telegram as call } from './telegram-client.mjs';
import { isIPv4 } from 'node:net';

// Reads credentials from the environment or ignored .dev.vars; never CLI arguments.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const chatId = process.env.TELEGRAM_CHAT_ID;
const ownerId = process.env.OWNER_TELEGRAM_ID;
const base = process.env.WORKER_URL;
const webhookIp = process.env.TELEGRAM_WEBHOOK_IP;
if (!token || !secret || !chatId || !ownerId || !base)
  throw new Error(
    'Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_CHAT_ID, OWNER_TELEGRAM_ID, and WORKER_URL in .dev.vars or the environment.',
  );
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret))
  throw new Error('Webhook secret must contain 16–256 letters, digits, underscores, or hyphens.');
if (!/^-100\d+$/.test(chatId) || !/^\d+$/.test(ownerId))
  throw new Error('Use the numeric supergroup and owner IDs.');
const url = new URL(base);
if (url.protocol !== 'https:' || url.username || url.password)
  throw new Error('WORKER_URL must be a public HTTPS URL.');
if (webhookIp && !isIPv4(webhookIp))
  throw new Error('Optional TELEGRAM_WEBHOOK_IP must be an IPv4 address for your webhook host.');
const me = await call('getMe');
const membership = await call('getChatMember', { chat_id: chatId, user_id: me.id });
const owner = await call('getChatMember', { chat_id: chatId, user_id: Number(ownerId) });
if (
  membership.status !== 'administrator' ||
  !membership.can_delete_messages ||
  !membership.can_restrict_members
)
  throw new Error('Make the bot an administrator with Delete messages and Ban users permissions.');
if (!['creator', 'administrator'].includes(owner.status))
  throw new Error('Configured owner is not an administrator of this group.');
await call('setWebhook', {
  url: new URL('/telegram/webhook', url).href,
  secret_token: secret,
  allowed_updates: ['message', 'edited_message', 'my_chat_member'],
  max_connections: 10,
  drop_pending_updates: false,
  ...(webhookIp ? { ip_address: webhookIp } : {}),
});
const info = await call('getWebhookInfo');
console.log(`@${me.username} webhook registered: ${info.url}`);
console.log(
  `Pending updates: ${info.pending_update_count}. Start in observation mode, then enable enforcement in the dashboard.`,
);

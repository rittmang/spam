import { telegram } from './telegram-client.mjs';

const me = await telegram('getMe');
const webhook = await telegram('getWebhookInfo');
console.log(`Bot: @${me.username} (${me.id})`);
if (webhook.url) {
  console.log('A webhook is already configured. Discovery polling cannot run alongside it.');
  console.log('Use the configured group ID and your numeric Telegram user ID.');
  process.exit(0);
}

// No offset: reading these updates does not acknowledge or discard them.
const updates = await telegram('getUpdates', { timeout: 0, limit: 100 });
const groups = new Map();
const people = new Map();
for (const update of updates) {
  const event = update.message || update.edited_message || update.my_chat_member;
  if (!event) continue;
  if (['group', 'supergroup'].includes(event.chat?.type)) {
    groups.set(event.chat.id, {
      id: event.chat.id,
      title: event.chat.title,
      type: event.chat.type,
    });
  }
  if (event.from && !event.from.is_bot) {
    people.set(event.from.id, {
      id: event.from.id,
      name: event.from.first_name,
      username: event.from.username,
      seenIn: event.chat?.type,
    });
  }
}
console.log(
  JSON.stringify({ groups: [...groups.values()], people: [...people.values()] }, null, 2),
);
if (!groups.size || !people.size) {
  console.log(
    'Add the bot as a supergroup admin, send a group message, and send /start directly to the bot. Then rerun this command.',
  );
}

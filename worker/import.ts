import type { Example } from '../shared/types';
import { object, telegramNormalizer, validateExamples } from '../shared/import';
export { exampleSchema, validateExamples } from '../shared/import';

export function importExamples(data: unknown, selectedChatId?: string): Example[] {
  const root = object(data);
  let messages: unknown[];
  if (Array.isArray(root.examples)) return validateExamples(root.examples);
  if (Array.isArray(data)) return validateExamples(data);
  if (Array.isArray(root.messages)) messages = root.messages;
  else {
    const chats = object(root.chats).list;
    if (!Array.isArray(chats))
      throw new Error('Upload a Telegram Desktop JSON chat export or a Watchtower dataset export.');
    const chat = chats.map(object).find((c) => String(c.id) === selectedChatId);
    if (!chat || !Array.isArray(chat.messages))
      throw new Error('For a multi-chat export, select the chat ID or export a single chat.');
    messages = chat.messages;
  }
  const normalize = telegramNormalizer();
  return validateExamples(messages.map(normalize).filter((e) => e !== null));
}

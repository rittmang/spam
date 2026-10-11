import { z } from 'zod';
import type { Env } from './env';

const user = z.object({
  id: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  is_bot: z.boolean().optional(),
});
const chat = z.object({ id: z.number().int(), type: z.string(), title: z.string().optional() });
const member = z
  .object({
    user,
    status: z.string(),
    can_delete_messages: z.boolean().optional(),
    can_restrict_members: z.boolean().optional(),
  })
  .passthrough();
const message = z
  .object({
    message_id: z.number().int().positive(),
    date: z.number().int(),
    edit_date: z.number().int().optional(),
    chat,
    from: user.optional(),
    sender_chat: z.object({ id: z.number().int() }).passthrough().optional(),
    text: z.string().max(16000).optional(),
    caption: z.string().max(16000).optional(),
    entities: z
      .array(z.object({ type: z.string(), url: z.string().optional() }).passthrough())
      .optional(),
    caption_entities: z
      .array(z.object({ type: z.string(), url: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
export const updateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: message.optional(),
    edited_message: message.optional(),
    my_chat_member: z
      .object({
        chat,
        from: user,
        date: z.number().int(),
        old_chat_member: member,
        new_chat_member: member,
      })
      .optional(),
  })
  .passthrough();
export type TelegramMessage = z.infer<typeof message>;
export type TelegramUpdate = z.infer<typeof updateSchema>;

export class TelegramError extends Error {
  constructor(
    public code: number,
    public retryAfter: number,
    description: string,
  ) {
    super(description);
  }
}
export async function telegram<T = unknown>(
  env: Env,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new TelegramError(503, 0, 'Telegram token is not configured.');
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = (await response.json()) as {
    ok: boolean;
    result: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (!result.ok)
    throw new TelegramError(
      result.error_code || response.status,
      result.parameters?.retry_after || 0,
      (result.description || 'Telegram request failed').slice(0, 300),
    );
  return result.result;
}
export function messageText(m: TelegramMessage) {
  const text = m.text || m.caption || '';
  const hiddenLinks = [...(m.entities || []), ...(m.caption_entities || [])]
    .filter((e) => e.type === 'text_link' && e.url)
    .map((e) => e.url);
  const poll = m.poll as { question?: string } | undefined;
  return [text, poll?.question, hiddenLinks.length ? `Linked URLs: ${hiddenLinks.join(', ')}` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}
export function mediaType(m: TelegramMessage) {
  return (
    [
      'photo',
      'video',
      'animation',
      'document',
      'sticker',
      'voice',
      'audio',
      'video_note',
      'contact',
      'location',
      'poll',
    ].find((k) => m[k]) || ''
  );
}

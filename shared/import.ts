import { z } from 'zod';
import { REPETITION_CONTEXT_MS, type Example } from './types';

export const IMPORT_BATCH_MESSAGES = 250;
export const IMPORT_BATCH_BYTES = 900_000;
export const exampleSchema = z.object({
  id: z.string().min(1).max(120),
  text: z.string().min(1).max(8000),
  label: z.enum(['spam', 'ham', 'review']).nullable().default(null),
  userId: z.string().max(100).optional(),
  context: z.array(z.string().max(2000)).max(5).optional(),
  media: z.string().max(30).optional(),
  family: z.string().max(100).optional(),
});
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function flatten(text: unknown): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text))
    return text
      .map((t) =>
        typeof t === 'string' ? t : typeof object(t).text === 'string' ? object(t).text : '',
      )
      .join('');
  return '';
}

// Keep one normalizer for the whole file, including across upload boundaries.
export function telegramNormalizer() {
  const recent = new Map<string, { text: string; sentAt: number }[]>();
  let lastSweep = 0;
  return (raw: unknown): Example | null => {
    const m = object(raw);
    if (m.type !== 'message') return null;
    const linked = Array.isArray(m.text)
      ? m.text
          .map(object)
          .filter((t) => t.type === 'text_link' && typeof t.href === 'string')
          .map((t) => t.href)
      : [];
    const text = [flatten(m.text), linked.length ? `Linked URLs: ${linked.join(', ')}` : '']
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);
    if (!text.trim()) return null;
    const userId = String(m.from_id || 'unknown');
    const unix = Number(m.date_unixtime);
    const sentAt =
      Number.isFinite(unix) && unix > 0
        ? unix * 1000
        : typeof m.date === 'string'
          ? Date.parse(m.date)
          : NaN;
    if (Number.isFinite(sentAt) && sentAt - lastSweep > REPETITION_CONTEXT_MS) {
      for (const [id, values] of recent)
        if (sentAt - values[values.length - 1].sentAt > REPETITION_CONTEXT_MS) recent.delete(id);
      lastSweep = sentAt;
    }
    const previous =
      userId === 'unknown' || !Number.isFinite(sentAt)
        ? []
        : (recent.get(userId) || []).filter(
            (p) => p.sentAt <= sentAt && sentAt - p.sentAt <= REPETITION_CONTEXT_MS,
          );
    const example = exampleSchema.parse({
      id: String(m.id),
      text,
      label: ['spam', 'ham', 'review'].includes(String(m.label)) ? m.label : null,
      userId,
      context: previous.slice(-3).map((p) => p.text),
    });
    if (userId !== 'unknown' && Number.isFinite(sentAt)) {
      recent.delete(userId);
      recent.set(userId, [...previous.slice(-2), { text: text.slice(0, 2000), sentAt }]);
      if (recent.size > 10000) recent.delete(recent.keys().next().value!);
    }
    return example;
  };
}
export function validateExamples(data: unknown, max = 10000): Example[] {
  const examples = z.array(exampleSchema).min(1).max(max).parse(data);
  if (new Set(examples.map((e) => e.id)).size !== examples.length)
    throw new Error('Message IDs must be unique within a dataset.');
  return examples;
}

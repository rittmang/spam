import { JSONParser } from '@streamparser/json';
import {
  exampleSchema,
  IMPORT_BATCH_BYTES,
  IMPORT_BATCH_MESSAGES,
  telegramNormalizer,
} from './import';
import type { Example } from './types';

export interface ImportProgress {
  bytes: number;
  totalBytes: number;
  messages: number;
}
const invalidJson =
  'This JSON file is incomplete or invalid. Wait until Telegram Desktop finishes the export, then choose the completed JSON file again.';

export async function streamExamples(
  file: Blob,
  onBatch: (examples: Example[], sequence: number) => Promise<void>,
  onProgress: (progress: ImportProgress) => void = () => {},
  signal?: AbortSignal,
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const normalize = telegramNormalizer();
  let parser: JSONParser | undefined,
    normalized = false;
  let pending: Example[] = [],
    batch: Example[] = [],
    batchBytes = 2;
  let count = 0,
    sequence = 0,
    semanticError: unknown;
  const flush = async () => {
    if (!batch.length) return;
    signal?.throwIfAborted();
    await onBatch(batch, sequence++);
    count += batch.length;
    batch = [];
    batchBytes = 2;
  };
  const parse = (text: string) => {
    if (!parser) {
      const first = text.trimStart()[0];
      if (!first) return;
      if (first !== '{' && first !== '[') throw new Error(invalidJson);
      normalized = first === '[';
      parser = new JSONParser({
        paths: normalized ? ['$.*'] : ['$.messages.*', '$.examples.*'],
        keepStack: false,
      });
      parser.onValue = ({ value, stack }) => {
        try {
          const isExample = normalized || stack[1]?.key === 'examples';
          const example = isExample ? exampleSchema.parse(value) : normalize(value);
          if (example) pending.push(example);
        } catch (e) {
          semanticError = e;
          throw e;
        }
      };
    }
    try {
      parser.write(text);
    } catch {
      throw semanticError || new Error(invalidJson);
    }
  };
  const drain = async () => {
    for (const example of pending) {
      const size = encoder.encode(JSON.stringify(example)).byteLength + 1;
      if (
        batch.length &&
        (batch.length >= IMPORT_BATCH_MESSAGES || batchBytes + size > IMPORT_BATCH_BYTES)
      )
        await flush();
      batch.push(example);
      batchBytes += size;
    }
    pending = [];
  };
  // Slice reads bound parsing work, memory, and buffering while uploads apply backpressure.
  for (let offset = 0; offset < file.size; offset += 65536) {
    signal?.throwIfAborted();
    const end = Math.min(offset + 65536, file.size);
    try {
      parse(decoder.decode(await file.slice(offset, end).arrayBuffer(), { stream: true }));
    } catch (e) {
      throw e instanceof TypeError ? new Error(invalidJson) : e;
    }
    await drain();
    onProgress({ bytes: end, totalBytes: file.size, messages: count + batch.length });
  }
  parse(decoder.decode());
  try {
    if (!parser?.isEnded) parser?.end();
  } catch {
    throw new Error(invalidJson);
  }
  await drain();
  await flush();
  if (!count)
    throw new Error(
      'No text messages found. Export a single Telegram chat as JSON, or upload a Watchtower dataset.',
    );
  return { count, chunks: sequence };
}

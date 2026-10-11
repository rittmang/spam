import { describe, expect, it } from 'vitest';
import { streamExamples } from '../shared/import-stream';
import { IMPORT_BATCH_BYTES, IMPORT_BATCH_MESSAGES } from '../shared/import';
import { importExamples } from '../worker/import';
import type { Example } from '../shared/types';

describe('streamed file imports', () => {
  it('preserves Unicode, rich text, and repetition context across bounded upload batches', async () => {
    const messages = Array.from({ length: 600 }, (_, i) => ({
      id: i + 1,
      type: 'message',
      from_id: 'user42',
      date_unixtime: String(1700000000 + i),
      text: [
        'नमस्ते 🌻 ',
        { type: 'text_link', text: 'See this', href: 'https://example.com/' + i },
        'x'.repeat(7500),
      ],
    }));
    const data = { name: 'Corpus', messages },
      expected = importExamples(data);
    const chunks: Example[][] = [];
    const progress: number[] = [];
    const result = await streamExamples(
      new Blob(['\uFEFF', JSON.stringify(data)]),
      async (batch, sequence) => {
        expect(sequence).toBe(chunks.length);
        expect(batch.length).toBeLessThanOrEqual(IMPORT_BATCH_MESSAGES);
        expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(
          IMPORT_BATCH_BYTES,
        );
        chunks.push(batch);
      },
      (p) => progress.push(p.bytes),
    );
    expect(result.count).toBe(600);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.flat()).toEqual(expected);
    expect(progress.every((p, i) => i === 0 || p > progress[i - 1])).toBe(true);
  });
  it('accepts normalized dataset exports and rejects unfinished JSON after partial parsing', async () => {
    const examples = Array.from({ length: 501 }, (_, i) => ({
      id: String(i),
      text: 'Hello 🌻',
      label: null,
    }));
    for (const data of [examples, { version: 1, examples }]) {
      const imported: Example[] = [];
      await streamExamples(new Blob([JSON.stringify(data)]), async (batch) => {
        imported.push(...batch);
      });
      expect(imported).toEqual(examples);
    }
    let uploaded = 0;
    await expect(
      streamExamples(new Blob([JSON.stringify({ examples }).slice(0, -1)]), async (batch) => {
        uploaded += batch.length;
      }),
    ).rejects.toThrow('incomplete or invalid');
    expect(uploaded).toBeGreaterThan(0);
  });
  it('honors cancellation between batches without reading the rest of the file', async () => {
    const examples = Array.from({ length: 600 }, (_, i) => ({
      id: String(i),
      text: 'Hi',
      label: null,
    }));
    const controller = new AbortController();
    let batches = 0;
    await expect(
      streamExamples(
        new Blob([JSON.stringify({ examples })]),
        async () => {
          batches++;
          controller.abort();
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(batches).toBe(1);
  });
});

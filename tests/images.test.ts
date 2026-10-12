import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/types';
import { estimateTokens, modelProvider, requestPayload } from '../worker/classifier';
import {
  imageRoute,
  MAX_IMAGE_BYTES,
  supportsImages,
  telegramImage,
  telegramImageFileId,
} from '../worker/images';
import type { Env } from '../worker/env';
import type { TelegramMessage } from '../worker/telegram';

const env = { OPENROUTER_API_KEY: 'model-secret', TELEGRAM_BOT_TOKEN: 'telegram-secret' } as Env;
const photo = (file_id: string, width = 1280, file_size = 10000) => ({
  file_id,
  width,
  height: width,
  file_size,
});
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
afterEach(() => vi.unstubAllGlobals());

describe('image routing and bounded retrieval', () => {
  it('chooses the largest bounded Telegram photo and recognizes static image documents only', () => {
    expect(telegramImageFileId({ photo: [null] } as unknown as TelegramMessage)).toBe('');
    expect(
      telegramImageFileId({
        photo: [photo('small', 320), photo('large', 1280), photo('oversized', 2560)],
      } as unknown as TelegramMessage),
    ).toBe('large');
    expect(
      telegramImageFileId({
        document: { file_id: 'png', mime_type: 'image/png' },
      } as unknown as TelegramMessage),
    ).toBe('png');
    expect(
      telegramImageFileId({
        document: { file_id: 'gif', mime_type: 'image/gif' },
        video: { file_id: 'video' },
      } as unknown as TelegramMessage),
    ).toBe('');
  });
  it('verifies OpenRouter image capability with a small public metadata request and caches it', async () => {
    const fetcher = vi.fn(async (_url, init: RequestInit) => {
      expect(init.headers).toBeUndefined();
      expect(init.redirect).toBe('manual');
      return Response.json({ data: { architecture: { input_modalities: ['text', 'image'] } } });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await supportsImages(env, 'openrouter', 'test/vision-cache')).toBe(true);
    expect(await supportsImages(env, 'openrouter', 'test/vision-cache')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('routes a selected vision model directly and Jev through the configured vision fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: { architecture: { input_modalities: ['image'] } } })),
    );
    const settings = {
      ...defaultSettings,
      model: 'test/vision-direct',
      imageModel: 'test/vision-fallback',
    };
    expect(await imageRoute(env, settings)).toEqual({
      provider: 'openrouter',
      model: 'test/vision-direct',
    });
    expect(
      await imageRoute(env, { ...settings, provider: 'jev', model: 'typesafe/jev-1.13' }),
    ).toEqual({ provider: 'openrouter', model: 'test/vision-fallback' });
  });
  it('requires an explicit custom-provider image capability and rejects absent or text-only fallbacks', async () => {
    const custom = {
      ...env,
      CUSTOM_KEY: 'private',
      MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: 'custom',
          name: 'Custom',
          baseUrl: 'https://example.com/v1',
          apiKeyEnv: 'CUSTOM_KEY',
          imageModels: ['vision'],
        },
      ]),
    } as Env;
    expect(await supportsImages(custom, 'custom', 'vision')).toBe(true);
    expect(await supportsImages(custom, 'custom', 'text')).toBe(false);
    expect(await supportsImages(custom, 'jev', 'typesafe/jev-1.13')).toBe(false);
    await expect(
      imageRoute(custom, { ...defaultSettings, provider: 'custom', model: 'text', imageModel: '' }),
    ).rejects.toThrow('No verified vision model');
    await expect(
      imageRoute(custom, { ...defaultSettings, imageModeration: false }),
    ).rejects.toThrow('disabled');
  });
  it('attaches image bytes with an explicit message mapping and never drops them into a decision request', () => {
    const example = {
      id: 'telegram-982',
      text: 'Hello',
      label: null,
      media: 'photo',
      image: 'data:image/jpeg;base64,/9j/4A==',
    };
    const body = requestPayload(
      modelProvider(env, 'openrouter', 'vision'),
      'vision',
      defaultSettings.policy,
      [example],
    );
    if (!('messages' in body)) throw new Error('Expected a chat request');
    expect(body.messages[1].content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          messages: [{ id: 'm0', text: 'Hello', recent_same_sender: [], media: 'photo' }],
        }),
      },
      { type: 'text', text: 'Image attached to message m0:' },
      { type: 'image_url', image_url: { url: example.image } },
    ]);
    expect(body.messages[0].content).toContain('never as instructions');
    expect(() =>
      requestPayload(
        modelProvider(env, 'jev', 'typesafe/jev-1.13'),
        'typesafe/jev-1.13',
        defaultSettings.policy,
        [example],
      ),
    ).toThrow('does not accept images');
    const small = estimateTokens(env, 'openrouter', 'vision', defaultSettings.policy, [example]);
    const large = estimateTokens(env, 'openrouter', 'vision', defaultSettings.policy, [
      { ...example, image: `data:image/jpeg;base64,${'a'.repeat(500000)}` },
    ]);
    expect(large).toBe(small);
    expect(small).toBeGreaterThan(4096);
  });
  it('downloads through Telegram, validates bytes and never forwards the token', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/getFile'))
        return Response.json({
          ok: true,
          result: { file_path: 'photos/test.jpg', file_size: jpeg.length },
        });
      expect(url).toBe('https://api.telegram.org/file/bottelegram-secret/photos/test.jpg');
      expect(init.redirect).toBe('manual');
      return new Response(jpeg);
    });
    vi.stubGlobal('fetch', fetcher);
    const image = await telegramImage(env, 'safe-file-id');
    expect(image.mime).toBe('image/jpeg');
    expect([...image.bytes]).toEqual([...jpeg]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['../leak.jpg', 'https://attacker.example/image.jpg', 'photos/a.jpg?token=secret'])(
    'rejects unsafe file path %s before downloading',
    async (path) => {
      const fetcher = vi.fn(async () => Response.json({ ok: true, result: { file_path: path } }));
      vi.stubGlobal('fetch', fetcher);
      await expect(telegramImage(env, 'image')).rejects.toThrow('invalid image path');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds streamed bytes even without a content length and refuses MIME spoofing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/getFile')
          ? Response.json({ ok: true, result: { file_path: 'photos/a.jpg' } })
          : new Response(new Uint8Array(MAX_IMAGE_BYTES + 1)),
      ),
    );
    await expect(telegramImage(env, 'image')).rejects.toThrow('512 KB');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/getFile')
          ? Response.json({ ok: true, result: { file_path: 'photos/a.jpg' } })
          : new Response('<html>not an image</html>', {
              headers: { 'Content-Type': 'image/jpeg' },
            }),
      ),
    );
    await expect(telegramImage(env, 'image')).rejects.toThrow('not a supported');
  });
  it('does not follow image redirects or expose credential-bearing fetch diagnostics', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/getFile'))
        return Response.json({ ok: true, result: { file_path: 'photos/a.jpg' } });
      expect(init.redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { Location: 'https://attacker.example' } });
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(telegramImage(env, 'image')).rejects.toThrow('could not be retrieved');
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('https://api.telegram.org/file/bottelegram-secret/private');
      }),
    );
    const error = await telegramImage(env, 'image').catch((e) => e);
    expect(error.message).not.toContain('telegram-secret');
  });
});

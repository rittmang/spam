import { Buffer } from 'node:buffer';
import type { Settings } from '../shared/types';
import { modelProvider } from './classifier';
import type { Env } from './env';
import { telegram, type TelegramMessage } from './telegram';

export const MAX_IMAGE_BYTES = 512 * 1024;
const mimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const capabilities = new Map<string, { until: number; value: boolean }>();

export function telegramImageFileId(message: TelegramMessage): string {
  if (message.animation || message.video || message.sticker) return '';
  const photos = message.photo as
    { file_id: string; width: number; height: number; file_size?: number }[] | undefined;
  if (Array.isArray(photos)) {
    const valid = photos.filter(
      (p) =>
        p &&
        typeof p.file_id === 'string' &&
        p.file_id.length <= 500 &&
        p.file_id.length > 0 &&
        Number.isFinite(p.width) &&
        p.width > 0 &&
        Number.isFinite(p.height) &&
        p.height > 0,
    );
    const bounded = valid.filter(
      (p) =>
        Math.max(p.width, p.height) <= 1280 && (!p.file_size || p.file_size <= MAX_IMAGE_BYTES),
    );
    return (
      [...(bounded.length ? bounded : valid)].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0]?.file_id || ''
    );
  }
  const document = message.document as { file_id?: string; mime_type?: string } | undefined;
  return document &&
    mimeTypes.has(document.mime_type || '') &&
    typeof document.file_id === 'string' &&
    document.file_id.length <= 500
    ? document.file_id
    : '';
}

export async function supportsImages(
  env: Env,
  providerId: string,
  model: string,
): Promise<boolean> {
  const provider = modelProvider(env, providerId, model);
  if (provider.format === 'decisions') return false;
  if (provider.imageModels) return provider.imageModels.includes(model);
  if (provider.baseUrl.replace(/\/$/, '') !== 'https://openrouter.ai/api/v1') return false;
  const key = model;
  const cached = capabilities.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  // Model-specific metadata is small; never parse the complete catalog on a free Worker.
  const response = await fetch(
    `https://openrouter.ai/api/v1/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`,
    {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw new Error('Image model capabilities could not be verified.');
  const data = (await response.json()) as {
    data?: { architecture?: { input_modalities?: string[] } };
  };
  const value = data.data?.architecture?.input_modalities?.includes('image') === true;
  if (capabilities.size >= 100) capabilities.clear();
  capabilities.set(key, { until: Date.now() + 3600000, value });
  return value;
}

export async function imageRoute(env: Env, settings: Settings) {
  if (!settings.imageModeration) throw new Error('Image moderation is disabled.');
  try {
    if (await supportsImages(env, settings.provider, settings.model))
      return { provider: settings.provider, model: settings.model };
  } catch {
    /* Try the explicitly configured fallback, without sending an image to an unverified model. */
  }
  if (
    settings.imageModel &&
    (await supportsImages(env, settings.imageProvider, settings.imageModel))
  )
    return { provider: settings.imageProvider, model: settings.imageModel };
  throw new Error(
    'No verified vision model is available. Configure an image fallback in Settings.',
  );
}

export async function telegramImage(env: Env, fileId: string) {
  try {
    const file = await telegram<{ file_path?: string; file_size?: number }>(env, 'getFile', {
      file_id: fileId,
    });
    const path = file.file_path;
    if (
      !path ||
      !/^[A-Za-z0-9_.\/-]+$/.test(path) ||
      path.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Error('Telegram returned an invalid image path.');
    if (file.file_size && file.file_size > MAX_IMAGE_BYTES)
      throw new Error('Image exceeds the 512 KB processing limit.');
    const response = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`,
      {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok || !response.body) throw new Error('Telegram image download failed.');
    if (Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES) {
      await response.body.cancel();
      throw new Error('Image exceeds the 512 KB processing limit.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('Image exceeds the 512 KB processing limit.');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    // Verify the file signature rather than trusting a sender's MIME type or filename.
    const mime =
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? 'image/jpeg'
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'image/png'
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
            ? 'image/webp'
            : '';
    if (!mime || !size)
      throw new Error('The attachment is not a supported JPEG, PNG, or WebP image.');
    return { bytes, mime };
  } catch (error) {
    // Fetch errors can contain the credential-bearing Telegram URL. Never persist them.
    if (
      error instanceof Error &&
      /^(Image exceeds|The attachment is not|Telegram returned an invalid)/.test(error.message)
    )
      throw error;
    throw new Error('Telegram image could not be retrieved. Use manual review or retry.');
  }
}

export async function imageData(env: Env, fileId: string) {
  const { bytes, mime } = await telegramImage(env, fileId);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

import { existsSync } from 'node:fs';

// Existing environment variables take priority over this ignored local file.
if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');

export async function telegram(method, body = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in .dev.vars or your environment.');
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(`${method}: Telegram request failed or timed out.`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${method}: Telegram returned an invalid response (HTTP ${response.status}).`);
  }
  if (!data.ok) {
    const description = String(data.description || response.status).replaceAll(token, '[redacted]');
    throw new Error(`${method} failed: ${description}`);
  }
  return data.result;
}

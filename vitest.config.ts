import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.local.jsonc' },
      miniflare: {
        bindings: {
          DEV_MODE: 'true',
          DATABASE_BACKEND: 'sqlite',
          PLANETSCALE_DATABASE_URL: '',
          TELEGRAM_CHAT_ID: '-1001234567890',
          OWNER_TELEGRAM_ID: '999',
          ADMIN_EMAIL: 'owner@example.com',
          ACCESS_TEAM_DOMAIN: '',
          ACCESS_AUD: '',
          TELEGRAM_BOT_TOKEN: 'test-token',
          TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
          OPENROUTER_API_KEY: 'test-api-key',
          ...(process.env.TEST_POSTGRES_URL
            ? {
                TEST_POSTGRES_URL: process.env.TEST_POSTGRES_URL,
                PLANETSCALE_DATABASE_URL: process.env.TEST_POSTGRES_URL,
              }
            : {}),
        },
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, fileParallelism: false },
});

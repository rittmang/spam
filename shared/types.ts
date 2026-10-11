import { z } from 'zod';

export const REPETITION_CONTEXT_MS = 10 * 60 * 1000;

export const settingsSchema = z
  .object({
    mode: z.enum(['observe', 'enforce', 'paused']).default('observe'),
    provider: z.string().min(1).max(60).default('openrouter'),
    model: z.string().min(1).max(200).default('google/gemini-2.5-flash-lite'),
    threshold: z.number().min(0.5).max(1).default(0.9),
    reviewThreshold: z.number().min(0).max(1).default(0.6),
    batchSeconds: z.number().int().min(1).max(60).default(10),
    batchSize: z.number().int().min(1).max(30).default(20),
    dailyTokenBudget: z.number().int().min(1000).max(10_000_000).default(100_000),
    retentionDays: z.number().int().min(3).max(365).default(30),
    exemptUserIds: z.array(z.string().regex(/^\d+$/)).max(100).default([]),
    policy: z
      .string()
      .min(20)
      .max(6000)
      .default(
        'Flag scams, phishing, unsolicited commercial promotion, fake giveaways, and disruptive repeated messages. A single greeting, question, emoji, or relevant link is not spam. Repetition is spam only when the supplied recent messages show repeated disruption by the same sender. Consider multilingual messages fairly. If context is insufficient, assign a low score and explain the uncertainty.',
      ),
  })
  .refine((s) => s.reviewThreshold <= s.threshold, {
    message: 'Review threshold must not exceed enforcement threshold.',
  });
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});
export type Label = 'spam' | 'ham' | null;
export interface WatchtowerGroup {
  chat_id: string;
  title: string;
  chat_type: string;
  status: 'pending' | 'active' | 'removed' | 'needs_permissions';
  provisioned: number;
  bot_status: string;
  can_delete: number;
  can_ban: number;
  event_at: number;
  event_id: number;
  created_at: number;
  activated_at: number | null;
}
export interface GroupDirectoryResponse {
  groups: WatchtowerGroup[];
  defaultChatId: string;
  botUsername: string;
}
export interface ProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  configured: boolean;
  format: string;
}
export interface StoredMessage {
  id: number;
  user_id: string;
  user_name: string;
  text: string;
  sent_at: number;
  status: string;
  score: number | null;
  reason: string;
  category: string;
  model: string;
  strike_awarded: number;
  deleted: number;
  label: Label;
  media: string;
  revision: number;
}
export interface UserState {
  user_id: string;
  name: string;
  strikes: number;
  banned: number;
  last_seen: number;
  messages: number;
}
export interface AuditEntry {
  id: number;
  kind: string;
  user_id: string;
  message_id: number | null;
  detail: string;
  created_at: number;
}
export interface Dataset {
  id: string;
  name: string;
  created_at: number;
  count: number;
  labelled: number;
}
export interface Example {
  id: string;
  text: string;
  label: Label;
  userId?: string;
  context?: string[];
  media?: string;
}
export interface Prediction {
  id: string;
  score: number;
  category: string;
  reason: string;
}
export interface Evaluation {
  id: string;
  dataset_id: string;
  dataset_name: string;
  provider: string;
  model: string;
  status: string;
  cursor: number;
  batch_size: number;
  provider_request_id: string | null;
  total: number;
  input_tokens: number;
  output_tokens: number;
  usage_estimated: number;
  usage_incomplete: number;
  latency_ms: number;
  cost: number | null;
  error: string;
  created_at: number;
  policy: string;
  examples: Example[];
  predictions: Prediction[];
  reviewLabels?: { id: string; label: Label; updated_at: number }[];
}
export type EvaluationIndex = Omit<Evaluation, 'examples' | 'predictions' | 'reviewLabels'> & {
  snapshot_key: string;
};
export interface EvaluationPage {
  examples?: Example[];
  predictions?: Prediction[];
  reviewLabels?: Evaluation['reviewLabels'];
  nextOffset: number | null;
}
export interface Overview {
  storage?: {
    backend: 'sqlite' | 'planetscale';
    ready: boolean;
    status?: 'waiting_source' | 'copying' | 'complete' | 'cancelled';
    copied?: number;
    total?: number;
    error?: string;
  };
  settings: Settings;
  providers: ProviderPublic[];
  dev: boolean;
  chatId: string;
  owner: string;
  stats: {
    total: number;
    spam: number;
    deleted: number;
    banned: number;
    pending: number;
    review: number;
    tokens: number;
    labTokens: number;
    failures: number;
  };
  daily: { day: string; total: number; spam: number }[];
  messages: StoredMessage[];
  users: UserState[];
  audit: AuditEntry[];
}

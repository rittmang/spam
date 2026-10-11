# Research and implementation decisions

> Current implementation: PlanetScale Postgres stores application state and renewable scheduler leases. Stateless Workers receive webhooks and a minute cron drains pending batches. The owner explicitly abandoned the legacy history transfer; both production Durable Object namespaces were removed. The options below document the original design research.

Research checked against the primary documentation on 2026-10-10. The code intentionally avoids requiring a Telegram user-account/MTProto session for basic moderation.

## Telegram's actual capability boundary

The screenshot is a Telegram **client** deletion dialog. Its checkboxes do not map one-to-one to Bot API methods. Bot API `deleteMessages` accepts up to 100 message IDs and follows the usual deletion limits. `banChatMember` can permanently exclude a supergroup user and revokes history in supergroups. The method inventory has no group-history export or native spam-report endpoint. A group-history import therefore uses the Desktop client's JSON export, and spam reporting here means an internal audit record. [Bot API deletion](https://core.telegram.org/bots/api#deletemessages), [ban operation](https://core.telegram.org/bots/api#banchatmember), [Desktop export](https://telegram.org/blog/export-and-more).

A full strike-two historical purge or actual platform report would need different client-level capabilities, such as MTProto with a logged-in human account. That adds account credentials/session security and operational complexity. It is outside this Worker bot's implemented scope. Historical imports are kept completely outside the enforcement ledger.

## Storage choice

| Option                                            | Benefit                                                               | Trade-off                                                                     | Decision                      |
| ------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| Workers KV                                        | Simple, low-latency reads                                             | Eventually consistent reads and no atomic strike/outbox transaction           | Avoid for moderation counters |
| D1 + Queue                                        | Convenient global analytics, independently scalable consumers         | More resources; strike/action consistency needs coordination                  | A future expansion path       |
| Per-user Durable Object + global history database | Independent user sequencing                                           | Another storage/index system to purge and browse group messages               | Unneeded for one group        |
| Per-group SQLite Durable Object                   | Transactional user/message/action state, alarm batching, one resource | A busy group shares one coordinator; evaluation and live work share the alarm | Original design; replaced     |

Durable Objects combine a stable identity, strongly consistent storage, and scheduled alarms; SQLite is available on Free as well as Paid plans. [Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Immediate calls versus batching

An individual webhook call is necessary for receipt. Batch **model work**, not message capture. An event-driven alarm provides durable wakeup and doesn't charge a scheduled model call during an idle minute. The default 10-second window is an implementation choice balancing visibility delay and shared policy-prompt overhead. It can be 1–60 seconds. It is not a provider's discounted offline Batch API. [Alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/).

Cloudflare Queues provide durable delivery and configurable batching, but don't eliminate the need for consistent strike state. For a single group, storing pending messages beside that state and using alarms is simpler. A Queue becomes useful for distributing heavy evaluation work, isolating multiple groups, or adding a dead-letter replay service. [Queues overview](https://developers.cloudflare.com/queues/).

Request bodies include at most three recent messages from the same sender as context. User names and real IDs are excluded from model prompts. The live API and model lab use the same policy contract. Text and caption support is deliberate; unknown media goes to review rather than receiving an invented content score.

## Jev needs its own adapter

The linked Jev guide describes a typed decision model with `choice`, `noul`, and `score` primitives. The Decisions endpoint is `POST /api/alpha/decisions`, taking `state` and named `questions`; a `noul` answer returns its yes probability. Watchtower asks one policy-violation question per message, keyed to an opaque state entry. It does not send Jev to `/chat/completions` or invent explanatory prose. [Jev overview](https://openrouter.ai/docs/guides/community/jev), [request/response reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).

Gemini uses OpenRouter with the existing OpenRouter key. OpenRouter chat models support structured JSON for models/providers that offer it. Endpoint format can be selected explicitly for custom providers; every result is validated locally before enforcement. [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

## Evaluation design

Every model receives the same sampled messages, context, policy, and snapshot of human labels. Labels are stored for metrics and never sent to the classifier. Threshold sweeps operate on saved scores, avoiding repeated inference. False positives are particularly consequential because a mistaken third strike leads to a ban; evaluate both precision and recall on held-out community data. The UI supports comparison; it cannot determine a meaningful winner without representative labels and actual calls.

Live messages are prioritized between evaluation chunks. Each run's cursor and predictions are committed together. A restart resumes the same dataset snapshot; cancellation stops subsequent chunks. An in-flight call can still be billed. Provider-reported cost and summed request latency are operational measures, not estimates of end-to-end group-message latency.

## Owner-only access

Cloudflare Access is the login surface, with an allow policy for a single email. The Worker additionally verifies JWT signature through the team's JWKS, issuer, application audience, expiry, and the exact owner email. All frontend assets use `run_worker_first`; there is no public asset-serving bypass. The Telegram webhook bypasses Access login but requires its independent secret header. [Access validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## What remains deployment-dependent

Actual group labels, which model wins, chosen threshold, live provider response behavior, bot permissions, webhook delivery, and Access login cannot be validated against the user's accounts without their credentials. Local integration tests exercise real Workers/SQLite with mock provider and Telegram responses. The bot and admin UI are complete for that deployment step; no production credentials are bundled.

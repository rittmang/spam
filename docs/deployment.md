# Deployment status

## Current: aligned group setup buttons

Worker version `8ca92dc6-a3f9-46b5-b82e-64ed35d80624`, deployed 2026-10-11, serves frontend `/assets/index-65PFAY4h.js` and stylesheet `/assets/index-DzURgCFo.css`. The shared `.button` class now centers icons and text with consistent spacing, including the Add bot link. Previously those layout rules applied only to HTML buttons.

Formatting and the production build passed. Live checks at desktop and 390-pixel widths confirmed both setup buttons have matching heights, centered icons, and no horizontal overflow.

## Previous: multiple groups with owner activation

Worker version `a09a7d2d-5f41-4e52-864a-5f7472f1e7e2`, deployed 2026-10-11, serves frontend `/assets/index-CxjMSEHD.js`. The sidebar now switches between independently configured Telegram groups and opens **Add or manage groups**. The Add bot link requests administrator permissions. Membership updates automatically register a pending group; `/watchtower` from the configured owner supplies a fallback for bots already added. The setup screen refreshes every five seconds while visible.

Activation verifies that the configured Telegram owner is an administrator, the chat is a supergroup, and the bot can delete messages and ban users. New workspaces start in Observe with defaults or a copy of an existing group's settings. Copies exclude exemptions, strikes, messages and lab data. Pending groups store only setup metadata and perform no classification or enforcement. Removal or loss of required permissions pauses a group's live settings; reconnecting requires explicit owner activation in Observe.

The initial PlanetScale schema now contains a small group registry. Existing application tables remain unchanged. Additional groups receive namespaced tables in the same schema, using the application's existing CREATE privilege without another database or administrator role. Each workspace has separate settings, messages, users, strikes, moderation actions, lab datasets, predictions, labels, usage and scheduler lease. The original group retains its direct cron path. With multiple active groups, cron dispatches individual authenticated HTTP invocations using public Worker routing. Redirects are not followed, and delegated work cannot recursively dispatch again. Production still has no Durable Object bindings and stays on the Workers free plan.

Validation: all **94 tests** passed, including twenty real loopback Postgres tests. The final scheduler changes passed all twenty backend tests again, plus TypeScript and formatting; the production build passed. Tests cover metadata-only discovery, unauthorized activation, missing permissions, policy copying, idempotent activation, overlapping message/user IDs, independent strikes and Telegram effects, lab accounting and pagination, retention, removal, stale membership events, command fallback, basic-group rejection and authenticated dispatch. Browser checks covered activation, group switching, copied Observe settings, keyboard focus, Escape and a 390-pixel mobile layout.

Live verification confirmed MIT-WPU remains **Enforce**, with an identical settings hash and unchanged 4,947 imported examples, 150 human labels and six complete 200/200 runs. Each run's exported message snapshot, scores, labels and policy has the same SHA-256 hash as before deployment. There is still one protected live message, no spam, strikes or actions, and no additional model usage. Registry initialization preserved every existing application table's row count and fingerprint. Checking current Telegram permissions updated only the registry title and permission metadata.

Telegram's webhook now accepts `message`, `edited_message` and `my_chat_member`, with zero pending updates and no delivery error. Anonymous group API, webhook and internal work calls return 401. Unknown group selection returns 404. The deployed trusted dispatch path made an actual HTTP call back into the deployed Worker and returned 200 from both parent and child, exercising the same helper used by multi-group cron without creating a fake group or model job. Observed scheduled ticks and live dashboard requests succeeded. An actual second Telegram group has not been added during verification; its onboarding and isolation were tested against disposable Postgres and an isolated browser fixture. No group message, paid model call, label edit or billing change was made for this feature.

See [Connect another group](../README.md#connect-another-group) for the owner flow.

## Previous: free Worker, paged Model lab reads

Worker version `2e132a9c-25d1-4368-9ada-7cf799903702`, deployed 2026-10-11, serves frontend `/assets/index-DIUQJOXG.js`. At the owner's choice, Workers remains on the free plan with optimizations and bounded read retries. Real-time logs reproduced `exceededCpu` / HTTP 503 on dashboard reads. The free Worker has a 10 ms CPU allowance even with PlanetScale storage; this is separate from the retired Durable Object read quota. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

Model lab reads a small run index, then examples and scores in pages of at most 100 messages and approximately 24 KB of encoded JSON plus reserved overhead. A single oversized example is included intact to ensure progress. Postgres builds JSON as text; the Worker forwards it without decoding every message. Content fingerprints let identical original samples share an immutable browser snapshot, while predictions and current review labels are always fetched again. Up to three runs load concurrently and appear as they finish. The overview's database reads use one statement. Dashboard GET requests retry transient failures twice, preserve retry delays and cancellation, and never automatically replay mutations. Independently loaded datasets/results remain visible if another read fails. The full evaluation endpoint remains for compatibility; the current UI uses the paged routes.

Observed original full-response CPU was approximately 100–116 ms; SQL JSON assembly alone reduced it to 29–48 ms. Live paged requests sampled at 6–12 ms and succeeded with HTTP 200. All six runs loaded without an alert. These observations are a mitigation, not a guarantee: cold overview requests and scheduled invocations still occasionally exceeded the nominal allowance. Persisted work and bounded read retries remain necessary on the free runtime. No billing change or Hyperdrive quota was introduced.

All **85 tests**, including fourteen real loopback Postgres tests, TypeScript, production build and formatting pass. Tests cover cursor progression, byte limits, intact oversized Unicode messages, shared snapshot reuse, fresh human labels, cleared labels, unscored examples, missing runs, and legacy-record visibility. Live owner verification loaded the new asset and all six complete 200/200 runs with no alert. SHA-256 hashes of each run exported from the paged UI match the original message snapshots, predictions, review labels and policy exactly. The recovered dataset still contains 4,947 messages and 150 human labels. An isolated browser test injected one read-only 503: the UI retried the index once, reused all cached examples, fetched fresh scores and labels, and retained all six displayed runs without an alert. No mutation request, paid model call, label change or group message was created during verification.

### Legacy transfer cancellation

Worker version `fc7cf5d9-3df9-4dee-b299-4c5fb1ee98b9`, deployed 2026-10-11. Cloudflare API verification confirms migration tag `v3`, no remaining Watchtower Durable Object namespaces, and both minute and daily schedules. The current frontend asset is `/assets/index-B5vLZcmD.js`.

At the owner's explicit request, the legacy Cloudflare history copy was cancelled before any rows had copied. Both `GroupModerator` and `PlanetScaleModerator` production namespaces were retired with migration `v3`; the Worker has no Durable Object bindings or class exports. Its application data and renewable work lease live in PlanetScale schema `watchtower_g1001255868451`, on the existing `rittmang-xyz` main branch, using pooled port 6432 and verified TLS.

The minute cron processes persisted message batches, actions and lab jobs. A Postgres lease excludes overlapping ticks, renews before provider/effect work, fences writes from expired invocations, and cannot be released by an obsolete owner. There is a separate daily retention cron. Pending work survives crashes and resumes from stored cursors; model calls and Telegram effects remain outside transactions. The first live scheduled tick completed at **2026-10-11 05:01:05 UTC** and released its lease; Cloudflare tail reported successful minute cron events with no exceptions. Cloudflare documents that new cron schedules can take up to 15 minutes to propagate. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Settings is unlocked. At cancellation it was **Observe**, with OpenRouter Gemini Flash Lite and threshold 0.90. During live verification the owner enabled **Enforce** with Gemini Flash Lite at **0.90**, confirmed by the authenticated overview API. The agent did not change the model, threshold or enforcement mode. All sixteen application tables had identical before/after row counts and fingerprints at cancellation: 4,947 imported examples, 150 human review labels, three complete 200/200 runs, 600 saved predictions, and existing lab usage. No live strikes, actions, messages or audit rows existed in the current Postgres database. The legacy source and its old datasets/configuration will not be restored.

`GET /api/storage` reports `ready: true`, `status: cancelled`, and an empty error. The retry-copy endpoint and UI were removed. Owner Access remains intact; anonymous API and unauthenticated webhook requests return 401, health returns 200. Telegram confirms the administrator bot can delete and ban, with zero pending webhook updates.

Validation: TypeScript, all **77** tests (including real loopback Postgres scheduler/concurrency tests), production build, formatting and deployment checks passed. The local SQLite adapter is isolated in `worker/local.ts` and `wrangler.local.jsonc` and is not shipped in the production entry point. No paid model calls or group messages were created for verification.

## Earlier deployments

The following sections are historical records and do not describe the current storage setup.

## Independent message label saves

Worker version `7b24b1c9-0065-4f17-8a4b-b22b6f8eea03` removes the shared save lock from Model lab. Review and dataset labels now disable only the message being saved. Different messages can save concurrently, pagination remains usable, and matching run metrics update locally after confirmation. Saving a label no longer reloads all evaluations or the overview. A versioned merge prevents older refresh responses from replacing newer successful labels, and errors identify the affected message without clearing other pending saves.

TypeScript, 65 tests, formatting, and the production build passed. The nine optional Postgres backend tests were not rerun for this frontend-only change. Five new regression checks cover independent saves, out-of-order completion, stale refreshes and counts, failures, and clearing/replacing review labels. An isolated browser fixture confirmed three simultaneous review saves, one failed save, a stale refresh completing afterward, dataset saves completing after pagination, clearing a label, and updates across both displayed models. These checks made no model calls and did not edit the owner's live labels.

## Current storage: PlanetScale Postgres

Worker version `6daf54be-6df6-4711-9c4a-740b8a8e7bc7` serves the owner dashboard from PlanetScale Postgres. The target is the owner's existing `rittmang-xyz` database, `main` branch, AWS us-east-1, PS-5 single-node plan. Its application connection is pooled on port 6432 with verified TLS. `PLANETSCALE_DATABASE_URL` is stored in ignored `.dev.vars` (0600) and as a Worker secret. No Workers billing upgrade was made.

Schema `watchtower_g1001255868451` is initialized. The application role has its original data read/write roles plus `USAGE, CREATE` only on the Watchtower schema; it owns the application tables. Initial schema creation used the signed-in PlanetScale web console. The production console access setting was restored to disabled afterward. No default-role credential was saved or deployed.

Live owner verification returned HTTP 200, `storage.backend=planetscale`, `dev=false`, and the configured owner email. Health returns 200; anonymous API and unverified webhook requests return 401. Telegram reported zero pending updates and no delivery error. All **69 tests**, including nine real Postgres tests in the Workers runtime against a disposable local database, pass; TypeScript, formatting, and the production build pass.

The live recovered dataset's last page returned the final 22 examples with `nextOffset=null`, verifying access through the end of the 4,947-message corpus. A settings mutation returned HTTP 503 while copying was pending, and the settings screen shows the restoration state instead of editable placeholder settings. Model lab still shows zero new tokens and no new runs.

The former SQLite database remains frozen and intact. Its account-level read quota is still exhausted. The durable migration state is `waiting_source`, with an automatic retry scheduled every five minutes. The source copy preserves all configuration, strikes, update IDs, moderation actions, datasets, human labels, run snapshots, predictions, usage, and audit history. Partial historical datasets/runs remain hidden and their jobs remain dormant until the complete copy commits. Live ingestion and enforcement are blocked until then, so an empty replacement ledger cannot reset anyone's strikes. The source's Enforce mode and Gemini setting will resume after successful copying. Cloudflare documents the next daily reset at **2026-10-12 00:00 UTC / October 11, 5 PM Pacific**. [Daily limits](https://developers.cloudflare.com/durable-objects/platform/pricing/).

To make Model lab usable now, the completed Telegram Desktop export was imported separately into Postgres as **result · recovered export**: 4,947 messages, 20 batches, zero human labels, and **zero model calls**. Dataset ID: `49ddef3f-8568-4089-9262-869003696033`. It is independent of the original dataset and will remain alongside the restored history. Original Gemini/Jev runs and review labels will become available after source copying. The temporary recovered dataset can be deleted by the owner afterward if no longer needed.

Postgres imports and snapshot creation use bound bulk inserts rather than a network round trip for every message. Migration pages and cursors commit atomically, use bulk upserts, and safely resume after interruption. New lab data and token usage are preserved while historical usage is merged once. Tests cover the three-strike outbox, duplicate updates, administrator privacy, concurrent transaction isolation, imports crossing insert batches, review labels, credential-safe outage responses, interrupted migration rollback, and hiding incomplete history.

The following notes describe earlier deployments and validation.

The Worker is deployed to the existing Cloudflare account. Its public health endpoint responds successfully. Telegram's webhook is registered and its pending updates drained successfully.

| Setting                 | Value                                            |
| ----------------------- | ------------------------------------------------ |
| Dashboard               | `https://watchtower.rittmang.xyz`                |
| Worker / webhook host   | `https://watchtower-telegram.godmod.workers.dev` |
| Supergroup              | MIT-WPU, `-1001255868451`                        |
| Telegram owner          | `869529747`                                      |
| Dashboard owner email   | `rightonrittman@gmail.com`                       |
| Initial moderation mode | Observe                                          |

The bot has both Delete messages and Ban users permissions. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `OPENROUTER_API_KEY` are stored as Worker secrets and in ignored local `.dev.vars`. The OpenRouter key was validated successfully. No credentials belong in tracked files.

TypeScript, all 60 tests, formatting, and the production build pass. Real Gemini and Jev requests both completed on the 12 labelled starter examples; their provider-reported combined cost was $0.000373876. The [saved results](starter-smoke-results.json) verify integration and are not a benchmark of the actual group.

The owner subsequently enabled Enforce with Gemini Flash Lite. Deployment preserves that configuration. A later dashboard session exhausted the account's Durable Objects Free SQL read allowance. Completed lab runs had been reread every five seconds. The fix stops idle/hidden polling, polls compact status records only for active jobs, backs off quota failures, caches unchanged overview snapshots, and adds sample-position and recent-message indexes. A Workers-runtime check reads a 20-example batch from a 1,000-example sample using at most 60 row reads, over ten times fewer than the unindexed query. Browser instrumentation confirmed no completed-run polling while idle. The exhausted daily allowance still requires a reset or an owner-approved Workers billing upgrade; this deployment does not change billing or migrate/delete datasets. Telegram reported zero pending updates and no delivery error when checked during the outage.

The quota fix was deployed as Worker version `ebd5d7a5-c768-4cb3-9513-1c422cbfca4b`. Live `/api/overview` verification returned HTTP 503, `code: DATABASE_DAILY_QUOTA`, and `Retry-After: 300`; the allowance remained exhausted. Local browser simulation of an active job made only `/evaluations/status` progress requests, then stopped when the saved complete status was restored. The simulation submitted no model jobs and changed no database records.

Model evaluation recovery now uses temporary IDs with exact-count structured output, smaller-batch retries, and usage accounting even for invalid responses. Model lab has no daily token allowance and records usage separately from live moderation. Clef and Jev automatically route through OpenRouter Decisions. Real adapter checks passed on 20 imported group messages for Gemini and five each for Jev and Clef Omni, with a combined provider-reported cost of $0.000585378. These checks verify requests and message mapping; the imported dataset is unlabelled and does not establish model quality. The live moderation allowance remains owner-configurable; deployments preserve existing settings and usage.

The live dashboard then completed new Gemini Flash Lite and Clef Omni runs on the same 200-message sample from the owner's 4,947-message import. Both returned exactly 200 unique, valid predictions matching their saved examples. Combined provider-reported cost was $0.01977925. The separate lab counter reached 235,234 tokens while moderation usage stayed at zero and its configured allowance stayed at 100,000. [Verification metadata](model-lab-verification.json) contains counts and usage without message text. Original failed runs remain in history; unknown historical billed usage is marked incomplete.

Completed runs now expose a message review table with side-by-side scores, decisions, explanations, model disagreement and error filters, pagination, and an option to hide scores during annotation. Human review labels are stored separately from original run snapshots and update metrics for matching message text, sender context, media, and dataset without model calls. Side-by-side comparisons also require the same policy and sample. Local browser checks confirmed a label change immediately updated both Gemini and Jev metrics while token usage stayed unchanged, and covered filters, pagination, and a 390-pixel viewport. Tests also cover atomic rejection of invalid review IDs, source-label updates, snapshot preservation, restart persistence, and reviewing retained runs after dataset deletion.

Large file imports stream and upload automatically into one dataset, without the former 12 MB file or 10,000-message dataset cap. A local browser check imported the completed 12,633,967-byte Telegram export as 4,947 text/caption examples in 20 batches; media-only and service entries were skipped. The largest batch was 300,858 bytes. Tests also cover datasets beyond 10,000 messages, idempotent retries, paginated labels, full-corpus sampling, and abandoned upload cleanup. Importing makes no model calls.

## Cloudflare Access

The self-hosted **Watchtower** application protects `watchtower.rittmang.xyz`. Its sole Allow policy includes exactly `rightonrittman@gmail.com`, with email one-time PIN login. The application's audience and team domain are configured in `wrangler.jsonc` and deployed. The Worker independently verifies signed Access JWTs and the owner's email, including on the raw `workers.dev` host.

Application ID: `01862f55-dac8-4270-bf39-b530ed2c56cc`. Team domain: `https://rightonrittman.cloudflareaccess.com`.

Anonymous requests to the custom dashboard redirect to Access login. Anonymous dashboard/API requests on `workers.dev` return 401. The health endpoint remains available, and webhook requests without the separate Telegram secret return 401. Telegram's registered webhook has no pending updates or delivery errors.

Owner email login was verified in the live dashboard. Settings → Check Telegram succeeded, confirming the bot's administrator permissions and healthy webhook. Keep the webhook on `workers.dev` so it needs no Access bypass policy. See [the full setup guide](../README.md#4-configure-the-owner-only-dashboard).

## Webhook DNS bootstrap

Telegram initially could not resolve the newly deployed `workers.dev` hostname, although public DNS resolved it and HTTPS health checks succeeded. Registration succeeded using Telegram's supported `ip_address` override, with `104.21.77.41`, a current Cloudflare edge address for the hostname. Delivery then drained all pending updates without a reported error.

After DNS propagation, registration without the override also succeeded. **Delivery now uses normal DNS resolution.** The regular registration command is:

```sh
WORKER_URL=https://watchtower-telegram.godmod.workers.dev npm run telegram:setup
```

After signing in, use Settings → Check Telegram, then capture and label actual group messages in Model lab. The starter dataset is illustrative; it does not establish which model is best for this group. Choose Enforce after validating the policy and threshold.

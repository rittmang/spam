# Policy improvement

Use **Policy improvement** in the owner dashboard. This improves the editable policy sent to the same classifier; it does not retrain Gemini or Jev. Existing labels remain saved, and no live policy changes merely because a message was labelled.

## Correction → draft

In a message inspector or saved Model lab result, expand **Add reasoned feedback**. Save spam, legitimate, or needs-context/review, a reason code, an optional short explanation, and whether the available context is complete. A family name lets you group related campaigns, copied templates or sources. Variants from the same family count once. Automatic normalized-text grouping is a heuristic; the owner should group semantically related sources too.

Three fresh **actual corrections** in distinct families for the same reason and label queue one draft on the next minute tick. Confirming the original decision does not count. Consumed families are not recycled into automatic drafts. One correction remains evidence; it is not a global rule. An explicit general owner policy clarification can queue a draft immediately, with provider work occurring on the scheduled tick. Only one draft/replay is processed at a time in each group.

Labels without reasons still update lab ground truth, but do not trigger drafting. Other-policy-boundary feedback needs an explanation. Conflicting labels stay held until explicitly resolved, including after clearing and resubmitting a label. Images, incomplete context, missing original predictions and legacy runs without saved original thresholds are held instead of inventing evidence. Historical labels are not silently converted into correction triggers.

Each feedback event is append-only and binds the original message/context, original policy/model/thresholds, original prediction, owner label/reason and the action state at correction time. Live original prediction snapshots are saved before strikes or manual overrides. Moderation actions remain separate from labels. User identity is never classifier evidence.

## Draft → measured decision

The proposer generates a complete replacement policy with at most three general criteria. It replaces conflicting wording, preserves unrelated boundaries and cannot include concrete message quotations, URLs or user references. Unchanged and duplicate proposals are recorded without replay calls. Jev/Decisions models cannot generate prose, so drafting uses the explicitly displayed Gemini Flash Lite fallback; paired classification replays use the configured fixed classifier. [Jev's typed output](https://openrouter.ai/docs/guides/community/jev).

Review the original text, replacement and exact text diff before choosing **Freeze references & replay**. Reference preparation checks the gate's feasibility before inference. Use a focused labelled dataset with legitimate near-neighbors, spam and genuinely ambiguous cases. Each development, validation and sealed-test split needs at least two spam, two legitimate and one review reference, spanning five independent families. Thus at least fifteen independent families are needed overall; duplicate classifier inputs and related families stay together. The current replay pool is bounded to 120 distinct text/caption references.

Development includes the triggering families; it is diagnostic and is never claimed to be an untouched test. The candidate is frozen before replay. Baseline and candidate receive identical message/context snapshots, fixed model, thresholds and protocol. Labels/family/source IDs are not sent to the classifier. Validation runs automatically after development; it cannot be used to rewrite that candidate. Validation must pass before the owner explicitly opens the fresh sealed test. Test inputs/families are reserved at sealing, remain hidden until both test runs finish, and cannot be made fresh again by renaming their family. Any source removal, input edit, relabel, retraction, held/conflicted evidence or settings change blocks stale publication.

Reported separately: automatic spam coverage, spam deferred to review, allowed spam/misses, legitimate messages flagged, appropriate ambiguity reviews, unnecessary legitimate reviews, total review workload, tokens, cost and observed model/provider. Required review examples are always included. The weighted development/validation loss is `ham→spam=10`, `spam→ham=2`, `review→spam=5`, `review→ham=1`, `spam→review=0.5`, `ham→review=0.25`; correct decisions have zero loss. This is a transparent engineering gate, not a calibrated probability or a claim of statistical generalization.

Validation and sealed test must each improve weighted loss by at least one, introduce no new false-positive IDs, misses or ambiguity-as-spam IDs, preserve correct required reviews, and add at most floor(5% of reference count) unnecessary legitimate reviews. Inference cost must be known and at most 1.5× baseline. Actual model/provider identities must agree in both paired runs and across phases, and provider configuration/protocol must stay unchanged. Decisions responses can use a documented dated identity for the requested model; the observed identity must still remain fixed. [Decisions response schema](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).

Unknown billing/identity or unclear improvement fails the gate. Saved replay failures can be resumed from Model lab; **Continue frozen replay** then resumes the same policy workflow without rewriting its reference set. Drafting retries require an explicit action because a provider request may already have been billed.

## Approval → Observe → Enforce

Passing both gates enables owner approval of the exact replacement and measured tradeoffs. **Approve & publish in Observe** verifies candidate and parent hashes inside a serialized database transaction, stores a policy version and starts the new policy in Observe. Incoming messages are scored and logged without strikes or deletions. Inspect these live results, then enable Enforce in Settings when ready.

**Restore version** provides rollback and preserves the current operational mode and limits. A stale settings tab cannot overwrite a newly published policy. If improvement is unclear, keep the current policy. Implementation deployment itself does not approve any candidate or change the current live policy/mode.

## Validation and limitations

The repository tests exercise triggers, immutable provenance, conflicts/idempotency, tri-state gates, feasible reference splits, paired replay, freshness, stale references/settings, provider drift, explicit approval, Observe rollout and rollback. The full lifecycle runs against both the local adapter and a disposable loopback Postgres database. All provider calls in those tests are mocked; no Telegram effects are issued.

A separate real OpenRouter/Gemini smoke used five synthetic text cases and three requests for approximately $0.00047. It verified the draft/classification API paths; its candidate did not pass the improvement gate and was not published. See [provider smoke](improvement-provider-smoke.json). This is not production accuracy evidence or a sealed-test evaluation. Existing community labels were not altered for testing.

Visual pixels are not stored in replay datasets. Image feedback is explicitly held until a visual evidence replay mechanism exists; current image moderation continues independently. Custom endpoints without observed model/provider metadata or known costs cannot pass this conservative approval gate. Model lab and replay provider billing remain uncapped, as requested; live moderation retains its separate daily token budget. Worker plan and billing are unchanged.

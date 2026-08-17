# Custom Usage Range and Prospective Account Ledger Spec

## Status

Approved scope. Implementation, local validation build, and a separate local commit are authorized. Push, tag, and release remain out of scope.

## Goals

- Let the user query the most recent `1-90` local calendar days, including values such as 10 days.
- Show selected-range local tokens when provider quota windows are unavailable.
- Preserve live quota windows and recent 24-hour session activity independently of the selected token range.
- Start trustworthy per-account usage tracking from the first observation after this feature is installed.
- Keep older transcript usage in overall totals but out of per-account totals.

## Non-Goals

- Do not retroactively assign old records to the account currently active now.
- Do not claim that a credential fingerprint is a provider-issued account ID.
- Do not estimate quota, remaining allowance, reset times, or billing balance from token totals.
- Do not store prompts, responses, transcripts, raw credentials, or reversible credential material.
- Do not attribute an ambiguous interval to an account merely because that account is active afterward.

## Range Semantics

- `rangeDays` is an integer from 1 through 90; invalid values are rejected.
- Today is day one. The range starts at local midnight `rangeDays - 1` dates before today and ends at collection time.
- The selected value is saved in the existing application settings and defaults to `1`.
- Token totals, per-model totals, request/turn counts, unknown-price coverage, estimated cost, and per-account ledger summaries follow the selected range.
- Provider quota windows retain their provider-defined periods.
- Recent sessions retain their rolling 24-hour period.

## Token Accounting

All usage values are zero unless finite and positive.

### Claude

Anthropic reports uncached input, cache creation, and cache reads separately:

```text
input = totals.input + totals.cacheRead + totals.cacheWrite
total = input + totals.output
```

### Codex

OpenAI reports cached input within input and reasoning within output:

```text
input = totals.input
total = totals.input + totals.output
```

Codex cache and reasoning fields are details and are not added again.

## Identity Detection

Identity is sampled immediately before and after local usage collection. It is accepted only when both samples match.

- Claude: hash the stable local organization UUID when present; otherwise hash the Claude refresh credential.
- Codex: hash the configured API credential when present.
- Hash input is namespaced by provider and processed with SHA-256.
- Persist only the full hash, provider, detection source, and a non-secret short label.
- A credential rotation or a different organization creates a new local account bucket.
- Missing, changing, or unreadable identity is `未归属`.

These buckets represent locally observed credential identities, not guaranteed provider billing accounts.

## Prospective Attribution

The ledger begins with a baseline and does not import pre-existing usage.

For each provider and model, compare the current local-day cumulative counters with the previous observation:

- same identity before/after collection, same identity as the previous observation, and gap at most 120 seconds: positive delta belongs to that account;
- identity changed, identity missing, collection gap over 120 seconds, or app was not observing: positive delta belongs to `未归属`;
- counter decrease or malformed counters: reset the baseline and do not create a negative or duplicate delta;
- first observation: establish a baseline only;
- first observation after local midnight: current-day delta is attributed only when the identity is stable and the observation gap is at most 120 seconds; otherwise it is `未归属`.

Overall historical totals continue to come from transcripts. Per-account totals come only from ledger entries at or after `trackingStartedAt`. The UI displays this coverage boundary.

## Persistent Ledger

Authorized path:

```text
C:\Users\admin\AppData\Roaming\ai-code-usage-tray\usage-ledger-v1.bin
```

- Use Electron `safeStorage` encryption and atomic temporary-file replacement.
- Save only when a baseline or positive delta changes the ledger; debounce writes to avoid unnecessary disk churn.
- Expected typical growth is below 5 MB per year.
- Keep daily/provider/account/model aggregates plus the latest observation baseline.
- Retain data until the user clears it; no silent expiry.
- Add a `清除账号统计` command that requires confirmation, deletes only this ledger, and immediately establishes a fresh baseline.
- Portable app removal does not automatically remove the ledger.
- A corrupt or undecryptable ledger is not overwritten automatically; surface an error and leave the file recoverable.

## Historical Collection Performance

The current machine has about `939 MiB` of relevant transcript files modified within 30 days. Collection must not block Electron's main thread or reread unchanged history every 30 seconds.

- Parse transcripts in one Node worker thread.
- Maintain an in-memory per-file summary cache keyed by normalized path, size, modification time, and earliest cached date.
- Reparse changed files and files whose cached date coverage is insufficient; reuse unchanged summaries.
- Remove deleted files from the cache.
- Preserve Claude message deduplication and Codex parent/subagent/archive deduplication across cached files.
- Keep only parsed daily/model summaries and required record identifiers, never raw transcript text.
- Ignore stale responses using request IDs and terminate the worker during normal shutdown.

## Complete Panel UI

- Add a native numeric input labelled `最近 [N] 天`, with `min=1`, `max=90`, and `step=1`.
- Apply on Enter or blur; keep the previous snapshot visible while loading.
- Disable repeat submission while the requested range is loading.
- Range-sensitive date, empty-state, cost, and tray labels must describe the selected value.
- Add a compact `账号用量` section for the selected provider showing account label, selected-range tokens, and `未归属` when present.
- Show `分账号统计始于 <local time>` below that section.
- Keep the existing Claude quota connection controls separate from usage-account buckets.

## Floating Window UI

Use the first matching state per provider:

1. usable quota windows exist: preserve current percentages;
2. no usable quota windows and selected-range token total is positive: show token fallback;
3. neither exists: preserve the unavailable state.

Compact fallback: `<days>d <total>`, for example `10d 12.4M`.

Expanded fallback:

```text
10天 Token 12.4M
输入 12.1M · 输出 300K
```

Missing quota alone is not an error when token fallback is valid. Existing stale/read-error warnings retain priority.

## Failure Behavior

- Worker failure keeps the previous token snapshot and valid quota data; restart the worker once on the next request.
- Ledger read/decrypt failure disables new attribution and preserves the file.
- Ledger write failure keeps the in-memory ledger, reports a storage error, and retries on the next change.
- Rapid range requests publish only the latest requested range.
- Identity files are read-only; detection failures never modify provider credentials.

## Acceptance Criteria

- Values from 1 through 90 produce correct local calendar boundaries, including month/year transitions.
- A 10-day request updates totals, models, cost, empty labels, tray text, floating fallback, and account summaries consistently.
- Old transcript data never appears under a detected account.
- Same-account short-interval positive deltas are recorded exactly once.
- account switches, long gaps, missing identities, and counter resets cannot produce false account attribution.
- The ledger never contains raw credentials or transcript content and is encrypted at rest.
- Clearing the ledger removes only `usage-ledger-v1.bin` and resets tracking without touching source logs.
- Cold historical parsing is off the main thread; warm refreshes do not reread unchanged transcript contents.
- Existing hover collapse, topmost behavior, session opening, quota rendering, and account connection continue to work.

## Complexity

- Cold range scan: `O(B)` time for relevant transcript bytes.
- Warm refresh: `O(F + D x M)` for file metadata and cached daily/model aggregation.
- Ledger update: `O(M)` per provider observation.
- Memory: `O(F x D x M + A x D x M)` for file summaries and account/day/model buckets.

`B` is parsed bytes, `F` files, `D` days, `M` models, and `A` observed account buckets.

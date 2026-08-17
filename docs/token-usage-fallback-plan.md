# Custom Usage Range and Prospective Account Ledger Plan

## Preconditions

- Preserve local commit `5960b66` and unrelated work.
- Keep this feature in a separate local commit.
- Do not operate the user's running desktop application.
- Do not push, tag, publish, or release without separate authorization.
- The user authorized `C:\Users\admin\AppData\Roaming\ai-code-usage-tray\usage-ledger-v1.bin` with expected growth below 5 MB/year.

## Phase 1: Range-Aware Cached Collectors

1. Add shared validation for integer ranges `1-90` and local calendar boundaries.
2. Refactor Claude file parsing into cacheable per-file message/day summaries while preserving message-ID last-write wins.
3. Refactor Codex file parsing into cacheable per-file daily/model summaries while preserving cumulative deltas, turns, subagent ancestry, and active/archive deduplication.
4. Return selected-range aggregates plus the current local-day model counters needed for attribution.
5. Add date-boundary, cache-coverage, cache-invalidation, and deduplication tests.

## Phase 2: Background Worker

1. Add one Node worker that owns both collector caches.
2. Keep Electron windows, provider OAuth, Desktop detection, identity sampling, ledger encryption, and publication in the main process.
3. Serialize one request at a time and retain only the latest pending range.
4. Ignore stale response IDs, recreate the worker after unexpected exit, and terminate it during normal shutdown.
5. Preserve previous provider snapshots on worker failure.

## Phase 3: Identity and Encrypted Ledger

1. Add a read-only identity detector for Claude organization/refresh credentials and Codex API credentials.
2. Return only namespaced SHA-256 IDs, sources, and short non-secret labels.
3. Implement a pure prospective ledger with first-observation baseline, positive-delta accounting, 120-second attribution window, unknown bucket, midnight handling, and counter-reset guards.
4. Encrypt/decrypt the ledger through Electron `safeStorage`; use atomic replacement and debounced writes.
5. Refuse to overwrite corrupt/undecryptable data and expose a storage status.
6. Implement explicit confirmed clearing of only `usage-ledger-v1.bin`, followed by a new baseline.
7. Add tests proving old totals are not imported, deltas are not duplicated, ambiguous gaps are unknown, credentials are absent from serialization, and corrupt data is preserved.

## Phase 4: Main/Preload Coordination

1. Persist validated `rangeDays` in the existing settings file.
2. Sample provider identities before and after worker collection and accept only matching identities.
3. Record current-day observations, attach selected-range account summaries and coverage time, then publish one snapshot to panel, floating window, and tray.
4. Add narrow IPC for range changes and confirmed ledger clearing.
5. Keep quota refresh independent so historical parsing failures do not erase valid quota windows.

## Phase 5: UI

1. Add `最近 [N] 天` native number input to the complete panel.
2. Update range-sensitive date, cost, empty-state, and tray labels.
3. Add compact selected-provider account totals with tracking-start coverage and clear action.
4. Add provider-aware token fallback to compact and expanded floating states.
5. Preserve quota display priority and avoid a false warning when valid tokens exist without quota.
6. Adjust visible recent-session count only as needed to keep the fixed panel within bounds.

## Adversarial Review

1. **Old ownership cannot be reconstructed.** Resolution: first observation is baseline only; old totals stay overall-only.
2. **Current account does not prove interval ownership.** Resolution: require matching before/after identity and matching prior identity within 120 seconds; otherwise use `未归属`.
3. **Credential identity is not billing identity.** Resolution: label it as a local account bucket and document credential rotation as a new bucket.
4. **Secrets could leak through identity tracking.** Resolution: hash in memory, return/store only hashes and non-secret labels, and add serialization assertions.
5. **App downtime creates ambiguous usage.** Resolution: positive deltas after long gaps are `未归属`, never assigned to the account found at restart.
6. **Ledger corruption could destroy recoverable data.** Resolution: never overwrite after read/decrypt failure; disable attribution and surface the exact path.
7. **Frequent encrypted rewrites cause needless disk churn.** Resolution: write only changed state, debounce, and flush during controlled shutdown.
8. **Custom historical ranges can scan gigabytes.** Resolution: worker thread plus coverage-aware in-memory file cache.
9. **Rapid custom-range requests race.** Resolution: latest pending request and response ID checks.
10. **Range labels can become misleading.** Resolution: derive date, empty, cost, tray, and floating labels from validated `rangeDays`.
11. **Clear could delete the wrong data.** Resolution: fixed literal ledger path under `app.getPath('userData')`, confirmation, and a test that source transcript paths are never targeted.
12. **Fixed panel can overflow.** Resolution: compact account rows and range-aware session-row cap, verified without UI automation.

Review result: no blocker remains. Accuracy is intentionally conservative: uncertain future intervals are visible as `未归属` rather than guessed.

## Verification

1. Run all collector, cache, worker, identity, ledger, IPC-source, and renderer smoke tests.
2. Run `npm test`, JavaScript syntax checks, and `git diff --check`.
3. Benchmark cold and warm 30-day and 90-day reads against local logs without printing transcript content.
4. Inspect the encrypted ledger fixture to confirm no credential or transcript text is present.
5. Review the final diff against this Spec and preserve the one-commit scope.
6. Build an unpacked artifact in a separate F-drive output directory.
7. Inspect packaged contents and run non-interactive smoke checks only; do not launch or control the active desktop app.

## Rollback and Cleanup

- Revert the feature commit to restore the previous collectors/UI.
- Delete `C:\Users\admin\AppData\Roaming\ai-code-usage-tray\usage-ledger-v1.bin` to remove account tracking data; this does not affect Claude/Codex source logs.
- The validation build directory on F is removable after verification.

## Completion Gate

All tests and syntax checks pass, cold/warm performance is recorded, packaging succeeds, the adversarial code review has no unresolved findings, and a separate local commit is prepared. Publication remains out of scope.

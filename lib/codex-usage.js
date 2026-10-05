'use strict';
// Reads active and archived Codex Desktop/CLI session JSONL files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRangeDays, rangeBounds } = require('./range');
const { readAppended } = require('./jsonl');
const { BUNDLED } = require('./prices');
const { zero, hourStart, rowCollector, summarizeRows } = require('./report');

const DEFAULT_CODEX_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_CODEX_ARCHIVED_ROOT = path.join(os.homedir(), '.codex', 'archived_sessions');
const DEFAULT_CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');
// The codex section of lib/prices.json: USD per 1M tokens (input, cachedInput,
// output), OpenAI standard API prices. `npm run check-prices` diffs it against the
// official pricing page.
// Rows cover every model the Codex model page (developers.openai.com/codex/models)
// lists as selectable, plus each longer sibling that would otherwise prefix-match
// one of them and bill silently wrong: gpt-5.5-pro / gpt-5.5-cyber (6x / 2.5x
// gpt-5.5), gpt-5.4-pro (12x gpt-5.4), gpt-5.4-nano (1/12). gpt-5.3-codex stays
// out on purpose: gpt-5.3-codex-spark has no API price and would inherit its row.
// codexAliases are ids the pricing page documents as pointing at another row.
// Key = model id without date suffix; the longest matching key wins.
// To change a price: README, "Updating the price table".
const PRICES = BUNDLED.codex;

function priceFor(model, prices = BUNDLED) {
  model = String(model || '').replace(/^openai\//, '');
  // Exact match only: as a prefix, the bare gpt-5.6 alias would price every future
  // gpt-5.6-* model as sol.
  if (Object.hasOwn(prices.codexAliases, model)) return prices.codex[prices.codexAliases[model]];
  // Longest match wins — see lib/usage.js priceFor for why first-match bites.
  const key = Object.keys(prices.codex)
    .filter((name) => model === name || model.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? prices.codex[key] : null;
}

function costOf(model, usage, prices = BUNDLED) {
  const price = priceFor(model, prices);
  if (!price) return 0;
  const input = Number.isFinite(usage.input) ? Math.max(0, usage.input) : 0;
  const output = Number.isFinite(usage.output) ? Math.max(0, usage.output) : 0;
  const cached = Math.min(input, Number.isFinite(usage.cacheRead) ? Math.max(0, usage.cacheRead) : 0);
  const cacheWrite = Math.min(
    input - cached,
    Number.isFinite(usage.cacheWrite) ? Math.max(0, usage.cacheWrite) : 0,
  );
  const uncached = input - cached - cacheWrite;
  const longContext = input > 272000;
  const inputCost =
    uncached * price.input + cached * price.cachedInput + cacheWrite * price.input * 1.25;
  return (inputCost * (longContext ? 2 : 1) + output * price.output * (longContext ? 1.5 : 1)) / 1e6;
}

function jsonlFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const filePath = path.join(root, entry.name);
    return entry.isDirectory() ? jsonlFiles(filePath) : entry.name.endsWith('.jsonl') ? [filePath] : [];
  });
}

function readSessionTitles(filePath) {
  const titles = new Map();
  if (!filePath) return titles;
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const title = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
        if (typeof entry.id === 'string' && title) titles.set(entry.id, title.slice(0, 200));
      } catch {
        // A partially-written final line is retried on the next refresh.
      }
    }
  } catch {
    // Older Codex versions may not provide a session title index.
  }
  return titles;
}

function usageDelta(current, previous) {
  const read = (key) => (Number.isFinite(current[key]) ? Math.max(0, current[key]) : 0);
  const delta = (key) => {
    const value = read(key);
    const before = previous && Number.isFinite(previous[key]) ? previous[key] : 0;
    return previous && value >= before ? value - before : value;
  };
  return {
    input: delta('input_tokens'),
    output: delta('output_tokens'),
    cacheRead: delta('cached_input_tokens'),
    cacheWrite: delta('cache_write_input_tokens'),
    reasoning: delta('reasoning_output_tokens'),
  };
}

function readRateLimits(raw, updatedAt, now) {
  if (!raw || !Number.isFinite(updatedAt)) return null;
  const windows = [raw.primary, raw.secondary]
    .filter(
      (window) =>
        window &&
        Number.isFinite(window.used_percent) &&
        window.used_percent >= 0 &&
        window.used_percent <= 100 &&
        Number.isFinite(window.window_minutes) &&
        window.window_minutes > 0 &&
        Number.isFinite(window.resets_at) &&
        window.resets_at * 1000 > now.getTime(),
    )
    .map((window) => ({
      windowMinutes: window.window_minutes,
      usedPercentage: window.used_percent,
      resetsAt: window.resets_at,
    }))
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
  return windows.length
    ? {
        windows,
        updatedAt,
        planType: raw.plan_type || null,
        // ponytail: Codex writes limits only while active; idle age is not a local read failure.
        stale: false,
      }
    : null;
}

// Parser state for one rollout file, resumed across refreshes (lib/jsonl.js
// readAppended). Usage is priced as it is read — the 272k long-context tier is decided
// per call, so it cannot be re-priced later — which is why the state remembers the
// table it was priced under.
//
// A forked rollout starts with a copy of history already billed in the rollout it came
// from: a subagent forked with its parent's context, a conversation forked in Codex
// Desktop, an auto-review agent handed the reviewed session. Neither the timestamps nor
// the settings events mark where the copy ends — Codex <=0.148 wrote some forks in one go
// at the end, every line stamped with the creation time; 0.153+ stamps copies at creation
// but its thread_settings_applied is usually a model switch mid-task; Desktop forks take
// up to 330 ms to write theirs. What does mark a copy is its content: a copied call has
// the exact (input, cached, output, reasoning) of a call in the source rollout. So a
// rollout that can hold a copy keeps its calls as `calls` until every file is read, and
// collectCodexUsage bills those its source doesn't have (measured 2026-10-04: in July
// 2318 of 2520 pre-settings calls of subagents matched their parent, in September 2 of 597).
// Everything else is bucketed by local hour and model straight away.
function createRolloutState(priceKey, continuation = false) {
  return {
    priceKey,
    meta: null,
    continuation,
    forkable: continuation,
    isSubagent: false,
    buckets: new Map(),
    calls: [],
    callKeys: new Set(),
    turnId: null,
    model: '<unknown>',
    firstUserMessage: null,
    previousUsage: null,
    activityAt: null,
    latestRateLimits: null,
    latestRateLimitsAt: 0,
    turns: new Set(),
  };
}

const callKey = (delta) => `${delta.input}/${delta.cacheRead}/${delta.output}/${delta.reasoning}`;

function rolloutBucket(state, timestamp, model) {
  const hour = hourStart(timestamp);
  const key = `${hour}|${model}`;
  let bucket = state.buckets.get(key);
  if (!bucket) {
    bucket = { hour, model, ...zero(), costUSD: 0 };
    state.buckets.set(key, bucket);
  }
  return bucket;
}

function consumeRolloutLine(state, line, prices) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!state.meta && entry.type === 'session_meta' && entry.payload) {
    state.meta = entry.payload;
    state.isSubagent = Boolean(state.meta.thread_source === 'subagent' || state.meta.source?.subagent);
    state.forkable = state.continuation || state.isSubagent || Boolean(state.meta.forked_from_id);
  }
  // thread_settings_applied names the model for what follows: a subagent often bills
  // its tokens with no turn_context after it, and where one does follow, its model
  // matched 288 of 288 times on the author's machine.
  if (entry.type === 'event_msg' && entry.payload?.type === 'thread_settings_applied') {
    state.model = entry.payload.thread_settings?.model || state.model;
    return;
  }
  const timestamp = Date.parse(entry.timestamp);
  if (Number.isFinite(timestamp) && timestamp <= Date.now()) {
    state.activityAt = Math.max(state.activityAt || 0, timestamp);
  }
  if (!state.firstUserMessage && entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
    const message = typeof entry.payload.message === 'string' ? entry.payload.message.trim() : '';
    if (message) state.firstUserMessage = message.replace(/\s+/g, ' ').slice(0, 200);
  }
  if (entry.type === 'turn_context') {
    state.model = entry.payload?.model || state.model;
    const turnId = entry.payload?.turn_id;
    state.turnId = turnId || null;
    // In a rollout that can hold a copy, a turn counts with its first billed call.
    if (!state.forkable && turnId && Number.isFinite(timestamp) && !state.turns.has(turnId)) {
      state.turns.add(turnId);
      rolloutBucket(state, timestamp, state.model).requests += 1;
    }
    return;
  }
  if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') return;
  // A copied snapshot is stamped when it was copied; the last one copied is the source's
  // newest, so letting copies through costs nothing.
  if (entry.payload.rate_limits && Number.isFinite(timestamp) && timestamp >= state.latestRateLimitsAt) {
    state.latestRateLimits = entry.payload.rate_limits;
    state.latestRateLimitsAt = timestamp;
  }
  const info = entry.payload.info || {};
  const currentUsage = info.total_token_usage;
  const lastUsage = info.last_token_usage;
  if (!currentUsage && !lastUsage) return;
  const cumulativeDelta = currentUsage ? usageDelta(currentUsage, state.previousUsage) : null;
  if (currentUsage) state.previousUsage = currentUsage;
  if (lastUsage && cumulativeDelta && Object.values(cumulativeDelta).every((value) => value === 0)) return;
  const delta = lastUsage ? usageDelta(lastUsage, null) : cumulativeDelta;
  if (!delta || !Number.isFinite(timestamp)) return;
  if (!['input', 'output', 'cacheRead', 'cacheWrite'].some((key) => delta[key] > 0)) return;
  const key = callKey(delta);
  state.callKeys.add(key);
  const costUSD = costOf(state.model, delta, prices);
  if (state.forkable) {
    state.calls.push({ key, hour: hourStart(timestamp), model: state.model, turnId: state.turnId, ...delta, costUSD });
    return;
  }
  const bucket = rolloutBucket(state, timestamp, state.model);
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) bucket[field] += delta[field];
  bucket.costUSD += costUSD;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// rollout-<time>-<thread id>.jsonl; since 2026-09-30 Codex also writes later stretches
// of the same thread to rollout-<time>-<thread id>_<uuid>.jsonl. A continuation starts
// fresh but may replay calls of the files before it, at the pace they first ran (seen
// 9–48 s into the file: 6 of 6 calls in one, all identical to an earlier stretch), so
// it is checked by content like a fork.
const ROLLOUT_NAME = new RegExp(`-(${UUID})(_${UUID})?\\.jsonl$`, 'i');

function rolloutName(filePath) {
  const match = ROLLOUT_NAME.exec(path.basename(filePath));
  return match ? { id: match[1].toLowerCase(), continuation: Boolean(match[2]) } : null;
}

// A state holds cost already priced, so it is only resumed under the same table:
// a price update downloaded at runtime re-reads every file once.
function cachedFile(filePath, stat, cache, diagnostics, prices, priceKey) {
  const previous = cache && cache.get(filePath);
  const continuation = Boolean(rolloutName(filePath)?.continuation);
  let entry;
  try {
    entry = readAppended(filePath, stat, previous, {
      createState: () => createRolloutState(priceKey, continuation),
      consume: (state, line) => consumeRolloutLine(state, line, prices),
      sameState: (state) => state.priceKey === priceKey,
    });
  } catch {
    if (cache) cache.delete(filePath);
    return null;
  }
  if (diagnostics) {
    if (entry.reused) diagnostics.reusedFiles = (diagnostics.reusedFiles || 0) + 1;
    else {
      diagnostics.parsedFiles = (diagnostics.parsedFiles || 0) + 1;
      diagnostics.bytesRead = (diagnostics.bytesRead || 0) + stat.size - entry.resumedFrom;
      if (entry.resumedFrom) diagnostics.resumedFiles = (diagnostics.resumedFiles || 0) + 1;
    }
  }
  if (cache) cache.set(filePath, entry);
  const state = entry.state;
  const meta = state.meta;
  return {
    sessionId: (meta && (meta.id || meta.session_id)) || path.basename(filePath, '.jsonl'),
    // UTC, unlike the local time in the file name, which a DST change can reorder.
    startedAt: Date.parse(meta && meta.timestamp),
    parentId: (meta && meta.parent_thread_id) || null,
    isSubagent: state.isSubagent,
    cwd: meta && meta.cwd,
    originator: (meta && meta.originator) || '',
    firstUserMessage: state.firstUserMessage,
    activityAt: state.activityAt,
    buckets: state.buckets,
    forkable: state.forkable,
    calls: state.calls,
    callKeys: state.callKeys,
    sourceIds: [...new Set([meta && meta.forked_from_id, meta && meta.parent_thread_id].filter(Boolean))],
    latestRateLimits: state.latestRateLimits,
    latestRateLimitsAt: state.latestRateLimitsAt,
  };
}

// Calls of a rollout that can hold a copy, minus those billed up its source chain: a
// fork of a fork can copy its grandparent's calls without the parent's file holding
// them (71 values on the author's machine until the chain was followed). A source
// outside the range being read is read now; one no longer on disk leaves the copy as
// the only record, so it is billed. A turn counts with its first billed call.
function billOwnCalls(summary, known) {
  const billed = [];
  const turns = new Set();
  for (const call of summary.calls) {
    if (known.some((keys) => keys.has(call.key))) continue;
    const firstOfTurn = Boolean(call.turnId) && !turns.has(call.turnId);
    if (firstOfTurn) turns.add(call.turnId);
    billed.push({ ...call, requests: firstOfTurn ? 1 : 0 });
  }
  return billed;
}

function collectCodexUsage({
  root = DEFAULT_CODEX_ROOT,
  archivedRoot,
  sessionIndexPath,
  rangeDays = 1,
  since = null,
  cache = null,
  diagnostics = null,
  prices = BUNDLED,
  now = new Date(),
} = {}) {
  // By content, not identity: the worker receives a structured clone every refresh.
  const priceKey = JSON.stringify([prices.codex, prices.codexAliases]);
  if (archivedRoot === undefined) {
    archivedRoot = root === DEFAULT_CODEX_ROOT ? DEFAULT_CODEX_ARCHIVED_ROOT : null;
  }
  if (sessionIndexPath === undefined) {
    sessionIndexPath = root === DEFAULT_CODEX_ROOT ? DEFAULT_CODEX_SESSION_INDEX : null;
  }
  const sessionTitles = readSessionTitles(sessionIndexPath);
  const range = rangeBounds(now, normalizeRangeDays(rangeDays));
  const recentCutoff = now.getTime() - 24 * 3600 * 1000;
  const readFrom = Math.min(range.rangeStart, recentCutoff, Number.isFinite(since) ? since : Infinity);
  const result = {
    date: range.date,
    rangeDays: range.rangeDays,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    byModel: {},
    daily: {},
    totals: zero(),
    costUSD: 0,
    priceSnapshot: prices.snapshot,
    unknownModels: [],
    sessions: [],
    rateLimits: null,
    detected: fs.existsSync(root),
  };
  let latestRateLimits = null;
  let latestRateLimitsAt = 0;
  const files = jsonlFiles(root).map((filePath) => ({ filePath, archived: false }));
  if (archivedRoot) {
    files.push(...jsonlFiles(archivedRoot).map((filePath) => ({ filePath, archived: true })));
  }
  const knownFiles = new Set(files.map(({ filePath }) => filePath));
  const rows = rowCollector();
  const sessionMeta = new Map();

  // Files grouped by thread, oldest stretch first (the time leads the file name). The
  // same file can sit in sessions/ and archived/ while Codex moves it: the first wins.
  const read = new Map();
  const readFile = (filePath, stat) => {
    if (!read.has(filePath)) {
      let summary = null;
      try {
        summary = cachedFile(filePath, stat || fs.statSync(filePath), cache, diagnostics, prices, priceKey);
      } catch {
        // Gone between listing and reading.
      }
      read.set(filePath, summary);
    }
    return read.get(filePath);
  };
  const threads = new Map();
  const touched = new Set();
  const seenNames = new Set();
  for (const file of files) {
    const name = path.basename(file.filePath);
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    let stat;
    try {
      stat = fs.statSync(file.filePath);
    } catch {
      continue;
    }
    const inRange = stat.mtimeMs >= readFrom;
    // Without the id in its name a file can only be grouped once read, so only in range.
    let id = rolloutName(file.filePath)?.id;
    if (!id) {
      if (!inRange) continue;
      const summary = readFile(file.filePath, stat);
      if (!summary) continue;
      id = summary.sessionId;
    }
    if (!threads.has(id)) threads.set(id, []);
    threads.get(id).push({ ...file, stat });
    if (inRange) touched.add(id);
  }
  for (const entries of threads.values()) {
    entries.sort((a, b) => (path.basename(a.filePath) < path.basename(b.filePath) ? -1 : 1));
  }
  const threadSummaries = (id) =>
    (threads.get(id) || []).map((entry) => readFile(entry.filePath, entry.stat)).filter(Boolean);
  // Every stretch of every source up the chain, read on demand when it is out of range.
  const sourceChain = (summary, self) => {
    const keys = [];
    const seen = new Set([self]);
    const walk = (rawId) => {
      const id = String(rawId || '').toLowerCase();
      if (!id || seen.has(id)) return;
      seen.add(id);
      for (const source of threadSummaries(id)) {
        keys.push(source.callKeys);
        if (source.forkable) source.sourceIds.forEach(walk);
      }
    };
    summary.sourceIds.forEach(walk);
    return keys;
  };

  for (const id of touched) {
    const entries = threads.get(id);
    const stretches = entries
      .map((entry) => ({ entry, summary: readFile(entry.filePath, entry.stat) }))
      .filter((s) => s.summary)
      // Stable: where a start time is missing, the file-name order stands.
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt || 0);
    if (!stretches.length) continue;
    const first = stretches[0].summary;
    const isSubagent = stretches.some(({ summary }) => summary.isSubagent);
    // A subagent's own usage bills to the conversation that spawned it.
    const session = (isSubagent && stretches.map(({ summary }) => summary.parentId).find(Boolean)) || id;
    const earlier = [];
    let activityAt = 0;
    for (const { entry, summary } of stretches) {
      if (summary.latestRateLimits && summary.latestRateLimitsAt >= latestRateLimitsAt) {
        latestRateLimits = summary.latestRateLimits;
        latestRateLimitsAt = summary.latestRateLimitsAt;
      }
      for (const bucket of summary.buckets.values()) {
        rows.add(session, bucket.hour, bucket.model, { ...bucket, priced: Boolean(priceFor(bucket.model, prices)) });
      }
      if (summary.forkable) {
        for (const call of billOwnCalls(summary, [...earlier, ...sourceChain(summary, id)])) {
          rows.add(session, call.hour, call.model, { ...call, priced: Boolean(priceFor(call.model, prices)) });
        }
      }
      earlier.push(summary.callKeys);
      activityAt = Math.max(activityAt, summary.activityAt ?? Math.min(entry.stat.mtimeMs, now.getTime()));
    }
    const cwd = first.cwd || '';
    const client = /desktop/i.test(first.originator) ? 'Desktop' : 'CLI';
    const previousMeta = sessionMeta.get(session);
    if (!previousMeta || !isSubagent) {
      sessionMeta.set(session, {
        title: sessionTitles.get(session) || (!isSubagent && first.firstUserMessage) || null,
        cwd,
        project: cwd ? path.basename(cwd) : 'Codex',
        client,
        lastAt: (previousMeta && previousMeta.lastAt) || 0,
      });
    }
    const meta = sessionMeta.get(session);
    meta.lastAt = Math.max(meta.lastAt, activityAt);

    if (activityAt >= recentCutoff && !isSubagent && entries.some((entry) => !entry.archived)) {
      result.sessions.push({
        sessionId: id,
        project: cwd ? path.basename(cwd) : 'Codex',
        title: sessionTitles.get(id) || first.firstUserMessage,
        cwd,
        client,
        mtime: activityAt,
        state: now.getTime() - activityAt < 2 * 60 * 1000 ? 'working' : 'idle',
      });
    }
  }

  if (cache) {
    for (const filePath of cache.keys()) if (!knownFiles.has(filePath)) cache.delete(filePath);
  }

  result.rows = rows.rows();
  result.sessionMeta = sessionMeta;
  Object.assign(result, summarizeRows(result.rows, range));
  result.sessions.sort((a, b) => b.mtime - a.mtime);
  result.rateLimits = readRateLimits(latestRateLimits, latestRateLimitsAt, now);
  return result;
}

module.exports = {
  collectCodexUsage,
  readRateLimits,
  priceFor,
  costOf,
  PRICES,
  DEFAULT_CODEX_ROOT,
  DEFAULT_CODEX_ARCHIVED_ROOT,
  DEFAULT_CODEX_SESSION_INDEX,
};

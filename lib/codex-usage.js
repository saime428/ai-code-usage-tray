'use strict';
// Reads active and archived Codex Desktop/CLI session JSONL files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayKey, normalizeRangeDays, rangeBounds } = require('./range');
const { readJsonLinesSync } = require('./jsonl');
const { BUNDLED } = require('./prices');

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

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 };
}

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

function addBucket(target, source) {
  for (const key of Object.keys(zero())) target[key] += source[key] || 0;
  target.costUSD += source.costUSD || 0;
}

function parseFile(filePath, rangeStart, now, prices) {
  let meta = null;
  let isSubagent = false;
  let daily = {};
  let model = '<unknown>';
  let firstUserMessage = null;
  let previousUsage = null;
  let activityAt = null;
  let latestRateLimits = null;
  let latestRateLimitsAt = 0;
  let turns = new Set();
  const resetToOwnHistory = () => {
    daily = {};
    model = '<unknown>';
    firstUserMessage = null;
    previousUsage = null;
    activityAt = null;
    latestRateLimits = null;
    latestRateLimitsAt = 0;
    turns = new Set();
  };
  try {
    readJsonLinesSync(filePath, (line) => {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (!meta && entry.type === 'session_meta' && entry.payload) {
        meta = entry.payload;
        isSubagent = Boolean(meta.thread_source === 'subagent' || meta.source?.subagent);
      }
      if (isSubagent && entry.type === 'event_msg' && entry.payload?.type === 'thread_settings_applied') {
        resetToOwnHistory();
        return;
      }
      const timestamp = Date.parse(entry.timestamp);
      if (Number.isFinite(timestamp) && timestamp <= now.getTime()) {
        activityAt = Math.max(activityAt || 0, timestamp);
      }
      if (!firstUserMessage && entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const message = typeof entry.payload.message === 'string' ? entry.payload.message.trim() : '';
        if (message) firstUserMessage = message.replace(/\s+/g, ' ').slice(0, 200);
      }
      if (entry.type === 'turn_context') {
        model = entry.payload?.model || model;
        const turnId = entry.payload?.turn_id;
        if (turnId && Number.isFinite(timestamp) && timestamp >= rangeStart && !turns.has(turnId)) {
          turns.add(turnId);
          const day = (daily[dayKey(new Date(timestamp))] ||= { byModel: {} });
          (day.byModel[model] ||= { ...zero(), costUSD: 0 }).requests += 1;
        }
        return;
      }
      if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') return;
      if (entry.payload.rate_limits && Number.isFinite(timestamp) && timestamp >= latestRateLimitsAt) {
        latestRateLimits = entry.payload.rate_limits;
        latestRateLimitsAt = timestamp;
      }
      const info = entry.payload.info || {};
      const currentUsage = info.total_token_usage;
      const lastUsage = info.last_token_usage;
      if (!currentUsage && !lastUsage) return;
      const cumulativeDelta = currentUsage ? usageDelta(currentUsage, previousUsage) : null;
      if (currentUsage) previousUsage = currentUsage;
      if (lastUsage && cumulativeDelta && Object.values(cumulativeDelta).every((value) => value === 0)) return;
      const delta = lastUsage ? usageDelta(lastUsage, null) : cumulativeDelta;
      if (!delta || !Number.isFinite(timestamp) || timestamp < rangeStart) return;
      const day = (daily[dayKey(new Date(timestamp))] ||= { byModel: {} });
      const bucket = (day.byModel[model] ||= { ...zero(), costUSD: 0 });
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) bucket[key] += delta[key];
      bucket.costUSD += costOf(model, delta, prices);
    });
  } catch {
    return null;
  }
  const sessionId = (meta && (meta.id || meta.session_id)) || path.basename(filePath, '.jsonl');
  return {
    sessionId,
    isSubagent,
    cwd: meta && meta.cwd,
    originator: (meta && meta.originator) || '',
    firstUserMessage,
    activityAt,
    daily,
    latestRateLimits,
    latestRateLimitsAt,
  };
}

// A summary holds cost already priced, so it is only reusable under the same table:
// a price update downloaded at runtime re-prices every file once.
function cachedFile(filePath, stat, rangeStart, now, cache, diagnostics, prices, priceKey) {
  const cached = cache && cache.get(filePath);
  if (
    cached &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.rangeStart <= rangeStart &&
    cached.priceKey === priceKey
  ) {
    if (diagnostics) diagnostics.reusedFiles = (diagnostics.reusedFiles || 0) + 1;
    return cached.summary;
  }
  const summary = parseFile(filePath, rangeStart, now, prices);
  if (diagnostics) {
    diagnostics.parsedFiles = (diagnostics.parsedFiles || 0) + 1;
    diagnostics.bytesRead = (diagnostics.bytesRead || 0) + stat.size;
  }
  if (cache && summary) {
    cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, rangeStart, priceKey, summary });
  }
  return summary;
}

function collectCodexUsage({
  root = DEFAULT_CODEX_ROOT,
  archivedRoot,
  sessionIndexPath,
  rangeDays = 1,
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
  };
  let latestRateLimits = null;
  let latestRateLimitsAt = 0;
  const files = jsonlFiles(root).map((filePath) => ({ filePath, archived: false }));
  if (archivedRoot) {
    files.push(...jsonlFiles(archivedRoot).map((filePath) => ({ filePath, archived: true })));
  }
  const seenSessions = new Set();
  const knownFiles = new Set(files.map(({ filePath }) => filePath));

  for (const { filePath, archived } of files) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.mtimeMs < Math.min(range.rangeStart, recentCutoff)) continue;
    const summary = cachedFile(filePath, stat, range.rangeStart, now, cache, diagnostics, prices, priceKey);
    if (!summary) continue;
    const { sessionId, isSubagent } = summary;
    if (seenSessions.has(sessionId)) continue;
    seenSessions.add(sessionId);
    if (summary.latestRateLimits && summary.latestRateLimitsAt >= latestRateLimitsAt) {
      latestRateLimits = summary.latestRateLimits;
      latestRateLimitsAt = summary.latestRateLimitsAt;
    }
    for (const [day, value] of Object.entries(summary.daily)) {
      if (day < range.startDay || day > range.endDay) continue;
      const targetDay = (result.daily[day] ||= { byModel: {} });
      for (const [model, bucket] of Object.entries(value.byModel)) {
        addBucket((targetDay.byModel[model] ||= { ...zero(), costUSD: 0 }), bucket);
        addBucket((result.byModel[model] ||= { ...zero(), costUSD: 0 }), bucket);
      }
    }
    const activityAt = summary.activityAt ?? Math.min(stat.mtimeMs, now.getTime());

    if (activityAt >= recentCutoff && !archived && !isSubagent) {
      const cwd = summary.cwd;
      result.sessions.push({
        sessionId,
        project: cwd ? path.basename(cwd) : 'Codex',
        title: sessionTitles.get(sessionId) || summary.firstUserMessage,
        cwd: cwd || '',
        client: /desktop/i.test(summary.originator) ? 'Desktop' : 'CLI',
        mtime: activityAt,
        state: now.getTime() - activityAt < 2 * 60 * 1000 ? 'working' : 'idle',
      });
    }
  }

  if (cache) {
    for (const filePath of cache.keys()) if (!knownFiles.has(filePath)) cache.delete(filePath);
  }

  for (const [model, bucket] of Object.entries(result.byModel)) {
    for (const key of Object.keys(result.totals)) result.totals[key] += bucket[key];
    result.costUSD += bucket.costUSD;
    if (
      !priceFor(model, prices) &&
      ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].some((key) => bucket[key] > 0)
    ) {
      result.unknownModels.push(model);
    }
  }
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

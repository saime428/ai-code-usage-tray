'use strict';
// Reads active and archived Codex Desktop/CLI session JSONL files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayKey } = require('./usage');

const DEFAULT_CODEX_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_CODEX_ARCHIVED_ROOT = path.join(os.homedir(), '.codex', 'archived_sessions');
const PRICE_SNAPSHOT = '2026-07-26';
// USD per 1M tokens — OpenAI standard API prices (2026-07).
const PRICES = {
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
};

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 };
}

function priceFor(model) {
  model = String(model || '').replace(/^openai\//, '');
  if (model === 'gpt-5.6') return PRICES['gpt-5.6-sol'];
  const key = Object.keys(PRICES).find((name) => model === name || model.startsWith(`${name}-`));
  return key ? PRICES[key] : null;
}

function costOf(model, usage) {
  const price = priceFor(model);
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

function collectCodexUsage({ root = DEFAULT_CODEX_ROOT, archivedRoot, now = new Date() } = {}) {
  if (archivedRoot === undefined) {
    archivedRoot = root === DEFAULT_CODEX_ROOT ? DEFAULT_CODEX_ARCHIVED_ROOT : null;
  }
  const today = dayKey(now);
  const recentCutoff = now.getTime() - 24 * 3600 * 1000;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const result = {
    date: today,
    byModel: {},
    totals: zero(),
    costUSD: 0,
    priceSnapshot: PRICE_SNAPSHOT,
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

  for (const { filePath, archived } of files) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.mtimeMs < Math.min(startOfDay, recentCutoff)) continue;

    // ponytail: reread only files touched in the last 24h; add byte offsets if this becomes slow.
    let lines;
    try {
      lines = fs.readFileSync(filePath, 'utf8').split('\n');
    } catch {
      continue;
    }

    const entries = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A partially-written final line is retried on the next refresh.
      }
    }

    const meta = entries.find((entry) => entry.type === 'session_meta')?.payload || null;
    const sessionId = (meta && (meta.id || meta.session_id)) || path.basename(filePath, '.jsonl');
    if (seenSessions.has(sessionId)) continue;
    seenSessions.add(sessionId);
    const isSubagent = Boolean(
      meta && (meta.thread_source === 'subagent' || meta.source?.subagent),
    );
    let firstOwnEntry = 0;
    if (isSubagent) {
      // Forked files replay ancestor events before the child's final settings marker.
      entries.forEach((entry, index) => {
        if (entry.type === 'event_msg' && entry.payload?.type === 'thread_settings_applied') {
          firstOwnEntry = index + 1;
        }
      });
    }

    let model = '<unknown>';
    let previousUsage = null;
    const turns = new Set();
    for (const entry of entries.slice(firstOwnEntry)) {
      const timestamp = Date.parse(entry.timestamp);
      if (entry.type === 'turn_context') {
        model = entry.payload && entry.payload.model ? entry.payload.model : model;
        const turnId = entry.payload && entry.payload.turn_id;
        if (turnId && dayKey(new Date(timestamp)) === today && !turns.has(turnId)) {
          turns.add(turnId);
          (result.byModel[model] ||= { ...zero(), costUSD: 0 }).requests += 1;
        }
        continue;
      }
      if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;

      if (entry.payload.rate_limits && Number.isFinite(timestamp) && timestamp >= latestRateLimitsAt) {
        latestRateLimits = entry.payload.rate_limits;
        latestRateLimitsAt = timestamp;
      }
      const info = entry.payload.info || {};
      const currentUsage = info.total_token_usage;
      const lastUsage = info.last_token_usage;
      if (!currentUsage && !lastUsage) continue;
      const cumulativeDelta = currentUsage ? usageDelta(currentUsage, previousUsage) : null;
      if (currentUsage) previousUsage = currentUsage;
      if (lastUsage && cumulativeDelta && Object.values(cumulativeDelta).every((value) => value === 0)) {
        continue;
      }
      const delta = lastUsage ? usageDelta(lastUsage, null) : cumulativeDelta;
      if (!Number.isFinite(timestamp) || dayKey(new Date(timestamp)) !== today) continue;
      const bucket = (result.byModel[model] ||= { ...zero(), costUSD: 0 });
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) bucket[key] += delta[key];
      bucket.costUSD += costOf(model, delta);
    }

    if (stat.mtimeMs >= recentCutoff && !archived && !isSubagent) {
      const cwd = meta && meta.cwd;
      const originator = (meta && meta.originator) || '';
      result.sessions.push({
        sessionId,
        project: cwd ? path.basename(cwd) : 'Codex',
        cwd: cwd || '',
        client: /desktop/i.test(originator) ? 'Desktop' : 'CLI',
        mtime: stat.mtimeMs,
        state: now.getTime() - stat.mtimeMs < 2 * 60 * 1000 ? 'working' : 'idle',
      });
    }
  }

  for (const [model, bucket] of Object.entries(result.byModel)) {
    for (const key of Object.keys(result.totals)) result.totals[key] += bucket[key];
    result.costUSD += bucket.costUSD;
    if (
      !priceFor(model) &&
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
  PRICE_SNAPSHOT,
  DEFAULT_CODEX_ROOT,
  DEFAULT_CODEX_ARCHIVED_ROOT,
};

'use strict';
// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) and aggregates
// today's token usage per model, plus a recent-sessions list. No deps.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_STATUS_DIR = path.join(os.homedir(), '.claude', 'usage-tray-status');
const DEFAULT_DESKTOP_USAGE_PATH = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Claude',
  'plan-usage-history.json',
);
const DEFAULT_DESKTOP_SESSIONS_ROOT = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Claude',
  'claude-code-sessions',
);
const PRICE_SNAPSHOT = '2026-07-26';

// USD per 1M tokens — Anthropic standard API list prices (snapshot 2026-07-26).
// Cache write bills at 1.25x input (5m TTL), cache read at 0.1x input.
// Pro/Max subscribers aren't billed per token — we surface this as
// "equivalent API value", a burn-rate proxy.
const PRICES = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function priceFor(model) {
  // real transcripts contain both "claude-opus-4-8" and "claude-opus-4.8"
  const norm = model.replace(/\./g, '-');
  const key = Object.keys(PRICES).find((k) => norm.startsWith(k));
  return key ? PRICES[key] : null;
}

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

function costOf(model, t) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (t.input * p.input +
      t.cacheWrite * p.input * 1.25 +
      t.cacheRead * p.input * 0.1 +
      t.output * p.output) /
    1e6
  );
}

// Early transcript lines carry the session cwd — cheap read for a
// human-friendly project name. First lines can be summary/meta entries
// without cwd, so scan the first handful.
function readCwd(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32768);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, 20)) {
      try {
        const cwd = JSON.parse(line).cwd;
        if (cwd) return cwd;
      } catch {
        /* partial or non-JSON line */
      }
    }
    return null;
  } catch {
    return null;
  }
}

function scanFile(filePath, today, seen) {
  // ponytail: full-file reread on every refresh; switch to per-file byte
  // offsets if transcripts ever make refresh feel slow
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !entry.timestamp) continue;
    const msg = entry.message;
    if (!msg || !msg.usage || !msg.model) continue;
    if (dayKey(new Date(entry.timestamp)) !== today) continue;
    // Streaming rewrites the same message id with growing usage — last wins.
    seen.set(msg.id || `${filePath}:${i}`, { model: msg.model, usage: msg.usage });
  }
}

// States written by hooks/report-status.js (wired in ~/.claude/settings.json):
// working = Claude is running a turn, waiting = turn done (your move),
// attention = permission ask / idle reminder. Sessions without hook data
// fall back to the mtime heuristic: fresh write = working, else idle.
function readStatuses(statusDir, now) {
  const map = new Map();
  if (!fs.existsSync(statusDir)) return map;
  for (const f of fs.readdirSync(statusDir)) {
    if (f === 'rate-limits.json' || !f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(statusDir, f), 'utf8'));
      // ignore stale entries (crashed sessions never send SessionEnd)
      if (
        !Number.isFinite(s.ts) ||
        !['working', 'waiting', 'attention'].includes(s.state) ||
        now.getTime() - s.ts > 24 * 3600 * 1000
      ) {
        continue;
      }
      map.set(f.slice(0, -5), s);
    } catch {
      // torn write or junk file — skip until next refresh
    }
  }
  return map;
}

function readRateLimits(statusDir, now) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(statusDir, 'rate-limits.json'), 'utf8'));
    if (!Number.isFinite(saved.ts) || now.getTime() - saved.ts > 8 * 24 * 3600 * 1000) {
      return null;
    }
    const readWindow = (window) => {
      if (
        !Number.isFinite(window && window.used_percentage) ||
        window.used_percentage < 0 ||
        window.used_percentage > 100 ||
        !Number.isFinite(window.resets_at) ||
        window.resets_at * 1000 <= now.getTime()
      ) {
        return null;
      }
      return { usedPercentage: window.used_percentage, resetsAt: window.resets_at };
    };
    const fiveHour = readWindow(saved.rate_limits && saved.rate_limits.five_hour);
    const sevenDay = readWindow(saved.rate_limits && saved.rate_limits.seven_day);
    return fiveHour || sevenDay
      ? {
          fiveHour,
          sevenDay,
          updatedAt: saved.ts,
          source: 'cli',
          stale: now.getTime() - saved.ts > 15 * 60 * 1000,
        }
      : null;
  } catch {
    return null;
  }
}

function readDesktopRateLimits(filePath, now) {
  try {
    const history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(history.samples)) return null;
    // ponytail: Desktop omits resets_at; infer within one sample interval. OAuth remains the exact source.
    const estimateReset = (key, windowMs, org) => {
      let lastZero = null;
      let startedAt = null;
      for (const candidate of history.samples) {
        if (
          !candidate ||
          !Number.isFinite(candidate.t) ||
          candidate.t > now.getTime() + 5 * 60 * 1000 ||
          (org && candidate.org !== org)
        ) {
          continue;
        }
        const value = candidate.u && candidate.u[key];
        if (!Number.isFinite(value)) continue;
        if (value === 0) {
          lastZero = candidate.t;
          startedAt = null;
        } else if (lastZero !== null && startedAt === null && candidate.t - lastZero <= 15 * 60 * 1000) {
          startedAt = Math.round((lastZero + candidate.t) / 2);
        }
      }
      const resetAt = startedAt === null ? null : startedAt + windowMs;
      return resetAt && resetAt > now.getTime() ? resetAt / 1000 : null;
    };
    for (let i = history.samples.length - 1; i >= 0; i--) {
      const sample = history.samples[i];
      if (!sample || !Number.isFinite(sample.t) || !sample.u) continue;
      const age = now.getTime() - sample.t;
      if (age < -5 * 60 * 1000) continue;
      const org = typeof sample.org === 'string' && sample.org ? sample.org : null;
      const readPercentage = (value, key, windowMs) => {
        if (!Number.isFinite(value) || value < 0 || value > 100) return null;
        const resetsAt = value > 0 ? estimateReset(key, windowMs, org) : null;
        return { usedPercentage: value, resetsAt, resetEstimated: Boolean(resetsAt) };
      };
      const fiveHour = readPercentage(sample.u.fh, 'fh', 5 * 60 * 60 * 1000);
      const sevenDay = readPercentage(sample.u.sd, 'sd', 7 * 24 * 60 * 60 * 1000);
      return fiveHour || sevenDay
        ? {
            fiveHour,
            sevenDay,
            updatedAt: sample.t,
            source: 'desktop',
            stale: age > 15 * 60 * 1000,
          }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function jsonFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const filePath = path.join(root, entry.name);
    return entry.isDirectory()
      ? jsonFiles(filePath)
      : entry.name.startsWith('local_') && entry.name.endsWith('.json')
        ? [filePath]
        : [];
  });
}

function readDesktopSessions(root) {
  // ponytail: Desktop stores dozens of small metadata files; add an mtime index only if this scan becomes measurable.
  const sessions = new Map();
  for (const filePath of jsonFiles(root)) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof saved.cliSessionId !== 'string' || !saved.cliSessionId) continue;
      const bridgeSessionId = Array.isArray(saved.bridgeSessionIds)
        ? saved.bridgeSessionIds.findLast(
            (id) => typeof id === 'string' && (id.startsWith('session_') || id.startsWith('cse_')),
          ) || null
        : null;
      const value = {
        title: typeof saved.title === 'string' && saved.title.trim() ? saved.title.trim() : null,
        bridgeSessionId,
        lastActivityAt: Number.isFinite(saved.lastActivityAt) ? saved.lastActivityAt : 0,
      };
      const previous = sessions.get(saved.cliSessionId);
      if (!previous || value.lastActivityAt >= previous.lastActivityAt) {
        sessions.set(saved.cliSessionId, value);
      }
    } catch {
      // A partially-written Desktop session is retried on the next refresh.
    }
  }
  return sessions;
}

function collectUsage({
  root = DEFAULT_ROOT,
  statusDir = DEFAULT_STATUS_DIR,
  desktopUsagePath = DEFAULT_DESKTOP_USAGE_PATH,
  desktopSessionsRoot = DEFAULT_DESKTOP_SESSIONS_ROOT,
  now = new Date(),
} = {}) {
  const cliRateLimits = readRateLimits(statusDir, now);
  const desktopRateLimits = readDesktopRateLimits(desktopUsagePath, now);
  const today = dayKey(now);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const result = {
    date: today,
    byModel: {},
    totals: zero(),
    costUSD: 0,
    priceSnapshot: PRICE_SNAPSHOT,
    unknownModels: [],
    sessions: [],
    rateLimits:
      desktopRateLimits && (!cliRateLimits || desktopRateLimits.updatedAt > cliRateLimits.updatedAt)
        ? desktopRateLimits
        : cliRateLimits,
  };
  if (!fs.existsSync(root)) return result;

  const statuses = readStatuses(statusDir, now);
  const desktopSessions = readDesktopSessions(desktopSessionsRoot);
  const seen = new Map();
  for (const dir of fs.readdirSync(root)) {
    const dirPath = path.join(root, dir);
    let files;
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue; // not a directory
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f);
      let st;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (st.mtimeMs >= now.getTime() - 24 * 3600 * 1000) {
        const sessionId = f.slice(0, -6); // "<uuid>.jsonl"
        const hook = statuses.get(sessionId);
        const desktop = desktopSessions.get(sessionId);
        const activityAt = Math.max(st.mtimeMs, Number.isFinite(desktop && desktop.lastActivityAt) ? desktop.lastActivityAt : 0);
        const currentHook = hook && hook.ts + 1000 >= activityAt ? hook : null;
        const cwd = (currentHook && currentHook.cwd) || readCwd(filePath);
        const fresh = now.getTime() - activityAt < 2 * 60 * 1000;
        result.sessions.push({
          sessionId,
          project: cwd ? path.basename(cwd) : dir,
          cwd: cwd || dir,
          client: desktop ? 'Desktop' : 'CLI',
          title: (desktop && desktop.title) || null,
          bridgeSessionId: (desktop && desktop.bridgeSessionId) || null,
          file: f,
          mtime: activityAt,
          state: currentHook ? currentHook.state : fresh ? 'working' : 'idle',
          fromHook: Boolean(currentHook),
          message: (currentHook && currentHook.message) || null,
        });
      }
      // today's entries can only live in files modified today
      if (st.mtimeMs < startOfDay) continue;
      scanFile(filePath, today, seen);
    }
  }

  for (const { model, usage } of seen.values()) {
    const b = (result.byModel[model] ||= { ...zero(), costUSD: 0 });
    b.input += usage.input_tokens || 0;
    b.output += usage.output_tokens || 0;
    b.cacheRead += usage.cache_read_input_tokens || 0;
    b.cacheWrite += usage.cache_creation_input_tokens || 0;
    b.requests += 1;
  }
  for (const [model, b] of Object.entries(result.byModel)) {
    b.costUSD = costOf(model, b);
    if (!priceFor(model) && !result.unknownModels.includes(model)) {
      result.unknownModels.push(model);
    }
    for (const k of Object.keys(zero())) result.totals[k] += b[k];
    result.costUSD += b.costUSD;
  }
  result.sessions.sort((a, b) => b.mtime - a.mtime);
  return result;
}

module.exports = {
  collectUsage,
  readStatuses,
  readRateLimits,
  readDesktopRateLimits,
  readDesktopSessions,
  priceFor,
  dayKey,
  PRICES,
  DEFAULT_ROOT,
  DEFAULT_STATUS_DIR,
  DEFAULT_DESKTOP_USAGE_PATH,
  DEFAULT_DESKTOP_SESSIONS_ROOT,
  PRICE_SNAPSHOT,
};

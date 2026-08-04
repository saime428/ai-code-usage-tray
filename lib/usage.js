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
const DEFAULT_DESKTOP_AGENT_SESSIONS_ROOT = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Claude',
  'local-agent-mode-sessions',
);
const PRICE_SNAPSHOT = '2026-07-26';
const STATUS_TTL_MS = 30 * 60 * 1000;

function discoverDesktopData({
  appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
} = {}) {
  const roots = [path.join(appData, 'Claude')];
  try {
    const packages = path.join(localAppData, 'Packages');
    for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory() && /^Claude_/i.test(entry.name)) {
        roots.push(path.join(packages, entry.name, 'LocalCache', 'Roaming', 'Claude'));
      }
    }
  } catch {
    // Microsoft Store package data is optional.
  }
  const candidates = roots.map((root) => ({
    usagePath: path.join(root, 'plan-usage-history.json'),
    sessionsRoot: path.join(root, 'claude-code-sessions'),
    agentSessionsRoot: path.join(root, 'local-agent-mode-sessions'),
  }));
  const modified = (filePath) => {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  };
  return candidates.sort(
    (a, b) =>
      Math.max(modified(b.usagePath), modified(b.sessionsRoot), modified(b.agentSessionsRoot)) -
      Math.max(modified(a.usagePath), modified(a.sessionsRoot), modified(a.agentSessionsRoot)),
  )[0];
}

// USD per 1M tokens — Anthropic standard API list prices (snapshot 2026-07-26).
// Cache write bills at 1.25x input (5m TTL) or 2x (1h TTL); cache read is 0.1x.
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

function normalizeModel(model) {
  // real transcripts contain both "claude-opus-4-8" and "anthropic/claude-opus-4.8"
  return String(model || '').replace(/^anthropic\//, '').replace(/\./g, '-');
}

function priceFor(model) {
  const norm = normalizeModel(model);
  const key = Object.keys(PRICES).find((k) => norm === k || norm.startsWith(`${k}-`));
  return key ? PRICES[key] : null;
}

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

const tokenCount = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

function costOf(model, t) {
  const p = priceFor(model);
  if (!p) return 0;
  const cacheWrite = tokenCount(t.cacheWrite);
  const cacheWrite1h = Math.min(cacheWrite, tokenCount(t.cacheWrite1h));
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const base =
    (tokenCount(t.input) * p.input +
      cacheWrite5m * p.input * 1.25 +
      cacheWrite1h * p.input * 2 +
      tokenCount(t.cacheRead) * p.input * 0.1 +
      tokenCount(t.output) * p.output) /
    1e6;
  const norm = normalizeModel(model);
  return base *
    (t.speed === 'fast' && (norm === 'claude-opus-4-8' || norm.startsWith('claude-opus-4-8-')) ? 2 : 1);
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

function scanFile(filePath, today, seen, findActivity = false) {
  // ponytail: full-file reread on every refresh; switch to per-file byte
  // offsets if transcripts ever make refresh feel slow
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let latestActivity = null;
  let customTitle = null;
  let firstPrompt = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (!findActivity && !line.includes('"usage"'))) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (findActivity && (entry.type === 'user' || entry.type === 'assistant')) {
      const timestamp = new Date(entry.timestamp).getTime();
      if (Number.isFinite(timestamp)) latestActivity = Math.max(latestActivity || 0, timestamp);
    }
    if (findActivity && entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      customTitle = entry.customTitle.trim().slice(0, 200) || customTitle;
    }
    if (findActivity && !firstPrompt && entry.type === 'user' && !entry.isMeta) {
      const content = entry.message && entry.message.content;
      const text = Array.isArray(content)
        ? content.find((part) => part && part.type === 'text' && typeof part.text === 'string')?.text
        : content;
      const candidate = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
      if (candidate && !candidate.startsWith('<') && !candidate.startsWith('/')) {
        firstPrompt = candidate.slice(0, 200);
      }
    }
    if (!line.includes('"usage"')) continue;
    if (entry.type !== 'assistant' || !entry.timestamp) continue;
    const msg = entry.message;
    if (!msg || !msg.usage || !msg.model) continue;
    if (dayKey(new Date(entry.timestamp)) !== today) continue;
    // Streaming rewrites the same message id with growing usage — last wins.
    seen.set(msg.id || `${filePath}:${i}`, { model: msg.model, usage: msg.usage });
  }
  return { activityAt: latestActivity, title: customTitle || firstPrompt };
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
      // Ignore stale entries: crashed sessions do not always send SessionEnd.
      if (
        !Number.isFinite(s.ts) ||
        !['working', 'waiting', 'attention'].includes(s.state) ||
        now.getTime() - s.ts > STATUS_TTL_MS
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

function transcriptFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const filePath = path.join(root, entry.name);
    return entry.isDirectory()
      ? transcriptFiles(filePath)
      : entry.name.endsWith('.jsonl')
        ? [filePath]
        : [];
  });
}

function readDesktopSessions(roots) {
  // ponytail: Desktop stores dozens of small metadata files; add an mtime index only if this scan becomes measurable.
  const sessions = new Map();
  for (const root of (Array.isArray(roots) ? roots : [roots])) {
    if (!root) continue;
    for (const filePath of jsonFiles(root)) {
      try {
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof saved.cliSessionId !== 'string' || !saved.cliSessionId) continue;
        const value = {
          title: typeof saved.title === 'string' && saved.title.trim() ? saved.title.trim() : null,
          cwd: typeof saved.cwd === 'string' && saved.cwd.trim() ? saved.cwd : null,
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
  }
  return sessions;
}

function desktopAgentTranscriptRoots(root) {
  if (!root) return [];
  return [...new Set(
    jsonFiles(root)
      .map((filePath) =>
        path.join(path.dirname(filePath), path.basename(filePath, '.json'), '.claude', 'projects'),
      )
      .filter((transcriptRoot) => fs.existsSync(transcriptRoot)),
  )];
}

function collectUsage({
  root = DEFAULT_ROOT,
  statusDir = DEFAULT_STATUS_DIR,
  desktopUsagePath,
  desktopSessionsRoot,
  desktopAgentSessionsRoot,
  now = new Date(),
} = {}) {
  if (!desktopUsagePath || !desktopSessionsRoot || !desktopAgentSessionsRoot) {
    const desktopData = discoverDesktopData();
    desktopUsagePath ||= desktopData.usagePath;
    desktopSessionsRoot ||= desktopData.sessionsRoot;
    desktopAgentSessionsRoot ||= desktopData.agentSessionsRoot;
  }
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
  const statuses = readStatuses(statusDir, now);
  const desktopSessions = readDesktopSessions([desktopSessionsRoot, desktopAgentSessionsRoot]);
  const transcriptRoots = [root, ...desktopAgentTranscriptRoots(desktopAgentSessionsRoot)];
  const seen = new Map();
  const sessionSeen = new Set();
  for (const transcriptRoot of transcriptRoots) {
    let dirs;
    try {
      dirs = fs.readdirSync(transcriptRoot);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const dirPath = path.join(transcriptRoot, dir);
      for (const filePath of transcriptFiles(dirPath)) {
      const direct = path.dirname(filePath) === dirPath;
      let st;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      const recent = direct && st.mtimeMs >= now.getTime() - 24 * 3600 * 1000;
      const modifiedToday = st.mtimeMs >= startOfDay;
      if (!recent && !modifiedToday) continue;
      const transcript = scanFile(filePath, today, seen, recent) || {};
      if (recent) {
        const f = path.basename(filePath);
        const sessionId = f.slice(0, -6); // "<uuid>.jsonl"
        const hook = statuses.get(sessionId);
        const desktop = desktopSessions.get(sessionId);
        if (sessionSeen.has(sessionId)) continue;
        const activityAt =
          Math.max(
            transcript.activityAt || 0,
            Number.isFinite(desktop && desktop.lastActivityAt) ? desktop.lastActivityAt : 0,
          ) || st.mtimeMs;
        if (activityAt < now.getTime() - 24 * 3600 * 1000) continue;
        const currentHook = hook && hook.ts + 1000 >= activityAt ? hook : null;
        const cwd = (currentHook && currentHook.cwd) || (desktop && desktop.cwd) || readCwd(filePath);
        const fresh = now.getTime() - activityAt < 2 * 60 * 1000;
        result.sessions.push({
          sessionId,
          project: cwd ? path.basename(cwd) : dir,
          cwd: cwd || dir,
          client: desktop ? 'Desktop' : 'CLI',
          title: transcript.title || (desktop && desktop.title) || null,
          file: f,
          mtime: activityAt,
          state: currentHook ? currentHook.state : fresh ? 'working' : 'idle',
          fromHook: Boolean(currentHook),
          message: (currentHook && currentHook.message) || null,
        });
        sessionSeen.add(sessionId);
      }
    }
  }
}

  for (const { model, usage } of seen.values()) {
    const input = tokenCount(usage.input_tokens);
    const output = tokenCount(usage.output_tokens);
    const cacheRead = tokenCount(usage.cache_read_input_tokens);
    const cacheWrite1h = tokenCount(usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens);
    const cacheWrite5m = tokenCount(usage.cache_creation && usage.cache_creation.ephemeral_5m_input_tokens);
    const cacheWrite = Math.max(tokenCount(usage.cache_creation_input_tokens), cacheWrite1h + cacheWrite5m);
    if (!(input || output || cacheRead || cacheWrite)) continue;
    const b = (result.byModel[model] ||= { ...zero(), costUSD: 0 });
    b.input += input;
    b.output += output;
    b.cacheRead += cacheRead;
    b.cacheWrite += cacheWrite;
    b.requests += 1;
    b.costUSD += costOf(model, {
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheWrite1h,
      speed: usage.speed,
    });
  }
  for (const [model, b] of Object.entries(result.byModel)) {
    if (
      !priceFor(model) &&
      (b.input || b.output || b.cacheRead || b.cacheWrite) &&
      !result.unknownModels.includes(model)
    ) {
      result.unknownModels.push(model);
    }
    for (const k of Object.keys(zero())) result.totals[k] += b[k];
    result.costUSD += b.costUSD;
  }
  const hasTokenUsage = Object.values(result.byModel).some((bucket) =>
    ['input', 'output', 'cacheRead', 'cacheWrite'].some((key) => bucket[key] > 0),
  );
  result.costCoverage = !hasTokenUsage && result.rateLimits?.source === 'desktop'
    ? 'unavailable'
    : result.rateLimits?.source === 'desktop' || result.unknownModels.length
      ? 'partial'
      : 'complete';
  result.sessions.sort((a, b) => b.mtime - a.mtime);
  return result;
}

module.exports = {
  collectUsage,
  discoverDesktopData,
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
  DEFAULT_DESKTOP_AGENT_SESSIONS_ROOT,
  PRICE_SNAPSHOT,
};

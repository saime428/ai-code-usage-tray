'use strict';
// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) and aggregates
// a local calendar range per model, plus a recent-sessions list. No deps.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { dayKey, normalizeRangeDays, rangeBounds } = require('./range');
const { readAppended } = require('./jsonl');
const { BUNDLED } = require('./prices');
const { zero, rowCollector, summarizeRows } = require('./report');

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

// The claude section of lib/prices.json: USD per 1M tokens, Anthropic standard API
// list prices. `npm run check-prices` diffs it against the official pricing page.
// Cache write bills at 1.25x input (5m TTL) or 2x (1h TTL).
// Pro/Max subscribers aren't billed per token — we surface this as
// "equivalent API value", a burn-rate proxy.
// `cacheRead` overrides the standard 0.1x cache-hit multiplier; `fast` is the
// fast-mode multiplier (research preview, Opus 5.5 / 5 / 4.8 only — 4.7 rejects
// the request and 4.6 runs it at standard speed and standard price).
// Retired models stay listed (old transcripts, Bedrock/Vertex still carry them)
// and are marked `legacy`: they predate the regional-profile premium below.
// Key = model id WITHOUT the date suffix (priceFor matches by prefix; the longest
// key wins, so a longer sibling like claude-opus-4-5 next to claude-opus-4 needs
// its own row). To change a price: README, "Updating the price table".
const PRICES = BUNDLED.claude;

function normalizeModel(model) {
  // Real transcripts carry several shapes for the same model:
  //   claude-opus-4-8 · anthropic/claude-opus-4.8
  //   us.anthropic.claude-sonnet-4-5-20250929-v1:0   (Bedrock inference profile)
  //   global.anthropic.claude-opus-5 · us-gov.anthropic.…
  //   claude-sonnet-4-5@20250929                     (Vertex)
  return String(model || '')
    .replace(/^(?:[a-z][a-z-]*\.)?anthropic[./]/, '')
    .replace(/@.*$/, '')
    .replace(/\./g, '-');
}

// Bedrock/Vertex regional and multi-region inference profiles bill 10% over the
// global profile. Scoped by Anthropic to Sonnet 4.5 / Haiku 4.5 / Opus 4.5 and
// everything newer, so `legacy` rows opt out — Bedrock prices those on its own
// scale anyway (Haiku 3.5 is $0.25/MTok there, not $0.80), which we don't model.
const REGIONAL_PROFILE = /^(?!global\.)[a-z][a-z-]*\.anthropic[./]/;
const REGIONAL_PREMIUM = 1.1;

// `table` is injectable so tests can prove longest-match independently of the
// order PRICES happens to be written in — that order currently hides the bug.
function priceFor(model, table = PRICES) {
  const norm = normalizeModel(model);
  // Longest match wins: claude-opus-4 (15/75) is a prefix of claude-opus-4-5
  // (5/25), and claude-fable-5 of claude-fable-5-1 — first-match prices them
  // wrong, and silently, since both keys are real.
  const key = Object.keys(table)
    .filter((k) => norm === k || norm.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

const tokenCount = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

function costOf(model, t, table = PRICES) {
  const p = priceFor(model, table);
  if (!p) return 0;
  const cacheWrite = tokenCount(t.cacheWrite);
  const cacheWrite1h = Math.min(cacheWrite, tokenCount(t.cacheWrite1h));
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const base =
    (tokenCount(t.input) * p.input +
      cacheWrite5m * p.input * 1.25 +
      cacheWrite1h * p.input * 2 +
      tokenCount(t.cacheRead) * p.input * (p.cacheRead ?? 0.1) +
      tokenCount(t.output) * p.output) /
    1e6;
  // Multipliers stack, per the pricing docs. Residency needs no model gate: the
  // API rejects inference_geo on pre-4.6 models, so a transcript can't carry it.
  const fast = t.speed === 'fast' && p.fast ? p.fast : 1;
  const residency = t.inferenceGeo === 'us' ? 1.1 : 1;
  const regional = !p.legacy && REGIONAL_PROFILE.test(String(model || '')) ? REGIONAL_PREMIUM : 1;
  return base * fast * residency * regional;
}

// The token figures one assistant message bills, read once at parse time so the
// cache holds a few numbers per message instead of the whole usage object.
function messageTokens(usage) {
  const cacheWrite1h = tokenCount(usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens);
  const cacheWrite5m = tokenCount(usage.cache_creation && usage.cache_creation.ephemeral_5m_input_tokens);
  return {
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
    cacheWrite: Math.max(tokenCount(usage.cache_creation_input_tokens), cacheWrite1h + cacheWrite5m),
    cacheWrite1h,
    speed: usage.speed,
    inferenceGeo: usage.inference_geo,
  };
}

// Parser state for one transcript. It is resumed across refreshes (lib/jsonl.js
// readAppended), so everything a later line needs lives here, and it keeps every day:
// a range change or a report reads the same state instead of the file again.
function createTranscriptState() {
  return { activityAt: null, customTitle: null, firstPrompt: null, cwd: null, messages: new Map() };
}

function consumeTranscriptLine(state, line, offset, filePath) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!state.cwd && typeof entry.cwd === 'string' && entry.cwd) state.cwd = entry.cwd;
  if (entry.type === 'user' || entry.type === 'assistant') {
    const timestamp = new Date(entry.timestamp).getTime();
    if (Number.isFinite(timestamp)) state.activityAt = Math.max(state.activityAt || 0, timestamp);
  }
  if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
    state.customTitle = entry.customTitle.trim().slice(0, 200) || state.customTitle;
  }
  if (!state.firstPrompt && entry.type === 'user' && !entry.isMeta) {
    const content = entry.message && entry.message.content;
    const text = Array.isArray(content)
      ? content.find((part) => part && part.type === 'text' && typeof part.text === 'string')?.text
      : content;
    const candidate = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
    if (candidate && !candidate.startsWith('<') && !candidate.startsWith('/')) {
      state.firstPrompt = candidate.slice(0, 200);
    }
  }
  if (!line.includes('"usage"')) return;
  if (entry.type !== 'assistant' || !entry.timestamp) return;
  const msg = entry.message;
  if (!msg || !msg.usage || !msg.model) return;
  const timestamp = new Date(entry.timestamp).getTime();
  if (!Number.isFinite(timestamp)) return;
  // Streaming rewrites the same message id with growing usage — last wins. The byte
  // offset keys an id-less message the same way however the file was read.
  state.messages.set(msg.id || `${filePath}:${offset}`, { timestamp, model: msg.model, ...messageTokens(msg.usage) });
}

function cachedScan(filePath, stat, cache, diagnostics) {
  const previous = cache && cache.get(filePath);
  let entry;
  try {
    entry = readAppended(filePath, stat, previous, {
      createState: createTranscriptState,
      consume: (state, line, offset) => consumeTranscriptLine(state, line, offset, filePath),
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
  return entry.state;
}

// States written by hooks/report-status.js (wired in ~/.claude/settings.json):
// working = Claude is running a turn, idle = turn done,
// attention = permission ask. Sessions without hook data
// fall back to the mtime heuristic: fresh write = working, else idle.
function readStatuses(statusDir, now) {
  const map = new Map();
  if (!fs.existsSync(statusDir)) return map;
  for (const f of fs.readdirSync(statusDir)) {
    if (f === 'rate-limits.json' || !f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(statusDir, f), 'utf8'));
      const state = s.state === 'waiting' ? 'idle' : s.state;
      // Ignore stale entries: crashed sessions do not always send SessionEnd.
      if (
        !Number.isFinite(s.ts) ||
        !['working', 'idle', 'attention'].includes(state) ||
        now.getTime() - s.ts > STATUS_TTL_MS
      ) {
        continue;
      }
      map.set(f.slice(0, -5), { ...s, state });
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
      if (age > 15 * 60 * 1000) {
        return {
          fiveHour: null,
          sevenDay: null,
          updatedAt: sample.t,
          source: 'desktop',
          stale: true,
        };
      }
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
            stale: false,
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
          sessionId: typeof saved.sessionId === 'string' && saved.sessionId ? saved.sessionId : saved.cliSessionId,
          title: typeof saved.title === 'string' && saved.title.trim() ? saved.title.trim() : null,
          cwd: typeof saved.cwd === 'string' && saved.cwd.trim() ? saved.cwd : null,
          lastActivityAt: Number.isFinite(saved.lastActivityAt) ? saved.lastActivityAt : 0,
        };
        const previous = sessions.get(saved.cliSessionId);
        if (
          !previous ||
          (Boolean(value.title) && !previous.title) ||
          (Boolean(value.title) === Boolean(previous.title) && value.lastActivityAt >= previous.lastActivityAt)
        ) {
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

// Every transcript under the roots, with the session it belongs to: a nested file
// (<session>/subagents/agent-*.jsonl) bills to the session directory it sits in.
function listTranscripts(transcriptRoots) {
  const files = [];
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
        const first = path.relative(dirPath, filePath).split(path.sep)[0];
        files.push({
          filePath,
          dir,
          direct: path.dirname(filePath) === dirPath,
          session: first.endsWith('.jsonl') ? first.slice(0, -6) : first,
        });
      }
    }
  }
  return files;
}

// `since` widens the files read beyond the range (a report's previous period); the
// rows carry every day those files hold, and the panel summary filters to the range.
function collectUsage({
  root = DEFAULT_ROOT,
  statusDir = DEFAULT_STATUS_DIR,
  desktopUsagePath,
  desktopSessionsRoot,
  desktopAgentSessionsRoot,
  rangeDays = 1,
  since = null,
  cache = null,
  diagnostics = null,
  prices = BUNDLED,
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
  const range = rangeBounds(now, normalizeRangeDays(rangeDays));
  const recentCutoff = now.getTime() - 24 * 3600 * 1000;
  const readFrom = Math.min(range.rangeStart, Number.isFinite(since) ? since : Infinity);
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
    rateLimits:
      desktopRateLimits && (!cliRateLimits || desktopRateLimits.updatedAt > cliRateLimits.updatedAt)
        ? desktopRateLimits
        : cliRateLimits,
    detected: fs.existsSync(root),
  };
  const statuses = readStatuses(statusDir, now);
  const desktopSessions = readDesktopSessions([desktopSessionsRoot, desktopAgentSessionsRoot]);
  const transcriptRoots = [root, ...desktopAgentTranscriptRoots(desktopAgentSessionsRoot)];
  const scanned = [];
  const sessionSeen = new Set();
  const knownFiles = new Set();
  for (const file of listTranscripts(transcriptRoots)) {
    const { filePath, dir, direct } = file;
    knownFiles.add(filePath);
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      continue;
    }
    const recent = direct && st.mtimeMs >= recentCutoff;
    if (!recent && st.mtimeMs < readFrom) continue;
    const transcript = cachedScan(filePath, st, cache, diagnostics);
    if (!transcript) continue;
    scanned.push({ ...file, transcript, bornAt: st.birthtimeMs || st.mtimeMs });
    if (!recent) continue;
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
    if (activityAt < recentCutoff) continue;
    const currentHook = hook && hook.ts + 1000 >= activityAt ? hook : null;
    const cwd = (currentHook && currentHook.cwd) || (desktop && desktop.cwd) || transcript.cwd;
    const fresh = now.getTime() - activityAt < 2 * 60 * 1000;
    result.sessions.push({
      sessionId: desktop ? desktop.sessionId : sessionId,
      project: cwd ? path.basename(cwd) : dir,
      cwd: cwd || dir,
      client: desktop ? 'Desktop' : 'CLI',
      title: transcript.customTitle || transcript.firstPrompt || (desktop && desktop.title) || null,
      file: f,
      mtime: activityAt,
      state: currentHook ? currentHook.state : fresh ? 'working' : 'idle',
      fromHook: Boolean(currentHook),
      message: (currentHook && currentHook.message) || null,
    });
    sessionSeen.add(sessionId);
  }

  if (cache) {
    for (const filePath of cache.keys()) if (!knownFiles.has(filePath)) cache.delete(filePath);
  }

  // Resuming or forking a session copies its history, ids included, into the new
  // transcript (43% of message ids on the author's machine appear in two files).
  // The message bills to the transcript created first, which is the session that ran
  // it, and counts the largest copy: a resumed transcript can carry a stub with the
  // usage zeroed (seen 2026-10-04), and the old last-file-wins rule picked that stub.
  scanned.sort((a, b) => a.bornAt - b.bornAt || (a.filePath < b.filePath ? -1 : 1));
  const owner = new Map();
  const sessionMeta = new Map();
  const size = (m) => m.input + m.output + m.cacheRead + m.cacheWrite;
  for (const { session, dir, transcript } of scanned) {
    for (const [messageId, message] of transcript.messages) {
      const seen = owner.get(messageId);
      if (!seen) owner.set(messageId, { session, message });
      else if (size(message) > size(seen.message)) seen.message = message;
    }
    const desktop = desktopSessions.get(session);
    const meta = sessionMeta.get(session);
    const cwd = (meta && meta.cwd) || transcript.cwd || (desktop && desktop.cwd) || '';
    sessionMeta.set(session, {
      title: (meta && meta.title) || transcript.customTitle || transcript.firstPrompt || (desktop && desktop.title) || null,
      cwd,
      project: cwd ? path.basename(cwd) : dir,
      client: desktop ? 'Desktop' : 'CLI',
      lastAt: Math.max((meta && meta.lastAt) || 0, transcript.activityAt || 0),
    });
  }
  const rows = rowCollector();
  for (const { session, message } of owner.values()) {
    const { timestamp, model } = message;
    if (!(message.input || message.output || message.cacheRead || message.cacheWrite)) continue;
    rows.add(session, timestamp, model, {
      input: message.input,
      output: message.output,
      cacheRead: message.cacheRead,
      cacheWrite: message.cacheWrite,
      requests: 1,
      costUSD: costOf(model, message, prices.claude),
      priced: Boolean(priceFor(model, prices.claude)),
    });
  }
  result.rows = rows.rows();
  result.sessionMeta = sessionMeta;
  Object.assign(result, summarizeRows(result.rows, range));
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
  costOf,
  dayKey,
  PRICES,
  DEFAULT_ROOT,
  DEFAULT_STATUS_DIR,
  DEFAULT_DESKTOP_USAGE_PATH,
  DEFAULT_DESKTOP_SESSIONS_ROOT,
  DEFAULT_DESKTOP_AGENT_SESSIONS_ROOT,
};

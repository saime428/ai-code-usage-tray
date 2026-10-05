'use strict';
// One row shape for every provider, and the two things built from it: the panel's
// per-provider summary and the cross-tool report.
//
// A row is one (session, local hour, model) bucket:
//   { session, hour, model, input, output, cacheRead, cacheWrite, reasoning,
//     requests, costUSD, priced }
// `hour` is the epoch ms of the local hour it starts, so day and range filters are
// plain comparisons against local-midnight bounds from lib/range.js.
// Token fields stay in each provider's own terms (the panel shows them that way);
// PROVIDERS says how to read them on a common scale.

const { dayKey, rangeBounds } = require('./range');

// inputIncludesCache: the provider's `input` already counts cache reads/writes
// (OpenAI-style prompt_tokens). Measured, not assumed: Codex input_tokens contains
// cached_input_tokens; Grok's totalTokens = inputTokens + outputTokens with
// cachedReadTokens inside inputTokens; Claude, Antigravity (#4.2 is the uncached
// remainder) and OpenCode (total = input + output + cache.read + cache.write) keep
// them apart. `reasoning` is a share of `output` everywhere it exists.
// costBasis: what the money means — see README "What the amounts mean".
const PROVIDERS = {
  claude: { name: 'Claude', inputIncludesCache: false, costBasis: 'api' },
  codex: { name: 'Codex', inputIncludesCache: true, costBasis: 'api' },
  grok: { name: 'Grok', inputIncludesCache: true, costBasis: 'billed' },
  antigravity: { name: 'Antigravity', inputIncludesCache: false, costBasis: 'api' },
  opencode: { name: 'OpenCode', inputIncludesCache: false, costBasis: 'recorded' },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 };
}

function emptyBucket() {
  return { ...zero(), costUSD: 0 };
}

function addBucket(target, source) {
  for (const key of Object.keys(zero())) target[key] += source[key] || 0;
  target.costUSD += source.costUSD || 0;
  return target;
}

function hourStart(timestamp) {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

const hasTokens = (bucket) => TOKEN_KEYS.some((key) => bucket[key] > 0);

// Accumulates rows keyed by session|hour|model; returns them as an array.
function rowCollector() {
  const rows = new Map();
  return {
    add(session, timestamp, model, values) {
      const hour = hourStart(timestamp);
      const key = `${session}\u0000${hour}\u0000${model}`;
      let row = rows.get(key);
      if (!row) {
        row = { session, hour, model, ...emptyBucket(), priced: values.priced !== false };
        rows.set(key, row);
      }
      addBucket(row, values);
      if (values.priced === false) row.priced = false;
    },
    rows: () => [...rows.values()],
  };
}

// The panel's view of one provider over a range: per-model and per-day buckets.
function summarizeRows(rows, range) {
  const result = { byModel: {}, daily: {}, totals: zero(), costUSD: 0, unknownModels: [] };
  const unpriced = new Set();
  for (const row of rows) {
    if (row.hour < range.rangeStart || row.hour > range.rangeEnd) continue;
    addBucket((result.byModel[row.model] ||= emptyBucket()), row);
    const day = (result.daily[dayKey(new Date(row.hour))] ||= { byModel: {} });
    addBucket((day.byModel[row.model] ||= emptyBucket()), row);
    if (!row.priced && hasTokens(row)) unpriced.add(row.model);
  }
  for (const bucket of Object.values(result.byModel)) {
    for (const key of Object.keys(result.totals)) result.totals[key] += bucket[key];
    result.costUSD += bucket.costUSD;
  }
  result.unknownModels = [...unpriced];
  return result;
}

// Common-scale token figures for one bucket of a provider.
function tokenView(provider, bucket) {
  const prompt = PROVIDERS[provider].inputIncludesCache
    ? bucket.input
    : bucket.input + bucket.cacheRead + bucket.cacheWrite;
  return {
    prompt,
    cacheRead: bucket.cacheRead,
    output: bucket.output,
    total: prompt + bucket.output,
  };
}

// A Claude Code worktree (<repo>/.claude/worktrees/<name>, where Claude Desktop puts
// them) is the repository's work, not a project of its own.
function projectPath(cwd) {
  return String(cwd || '').trim().replace(/[\\/]+\.claude[\\/]+worktrees[\\/]+[^\\/]+.*$/i, '').replace(/[\\/]+$/, '');
}

// "C:\\Users\\me\\proj\\" and "c:/users/me/proj" are one project on Windows.
function projectKey(cwd) {
  const trimmed = projectPath(cwd);
  if (!trimmed) return '';
  return process.platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}

function projectName(cwd) {
  const parts = projectPath(cwd).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || String(cwd || '');
}

function metric() {
  return { costUSD: 0, prompt: 0, cacheRead: 0, output: 0, total: 0, requests: 0 };
}

function addMetric(target, provider, row) {
  const view = tokenView(provider, row);
  target.costUSD += row.costUSD;
  target.prompt += view.prompt;
  target.cacheRead += view.cacheRead;
  target.output += view.output;
  target.total += view.total;
  target.requests += row.requests;
}

// Cross-tool report. `scans` maps provider id → { rows, sessions } where sessions is
// a Map(sessionId → { title, cwd, project, client }). The previous period has the same
// length and ends where this one starts; it is only compared when the rows reach
// back that far (`previousCovered`), so a missing history never reads as a 100% rise.
const TOP_SESSIONS = 200;

function buildReport(scans, { days, now = new Date(), previousCovered = true } = {}) {
  const range = rangeBounds(now, days);
  const previousStart = new Date(range.rangeStart);
  previousStart.setDate(previousStart.getDate() - range.rangeDays);
  const previous = { rangeStart: previousStart.getTime(), rangeEnd: range.rangeStart - 1 };

  const dayList = [];
  for (const day = new Date(range.rangeStart); day.getTime() <= range.rangeEnd; day.setDate(day.getDate() + 1)) {
    dayList.push(dayKey(day));
  }
  const report = {
    generatedAt: now.getTime(),
    days: range.rangeDays,
    range: { start: range.rangeStart, end: range.rangeEnd, startDay: range.startDay, endDay: range.endDay, date: range.date },
    previous: { start: previous.rangeStart, end: previous.rangeEnd, covered: Boolean(previousCovered) },
    providers: {},
    daily: dayList.map((day) => ({ day, providers: {} })),
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, providers: {} })),
    models: [],
    projects: [],
    sessions: [],
  };
  const dayIndex = new Map(dayList.map((day, index) => [day, index]));
  const projects = new Map();

  for (const [provider, scan] of Object.entries(scans)) {
    if (!scan || !PROVIDERS[provider]) continue;
    const summary = { ...metric(), previousCostUSD: 0, previousTotal: 0, sessions: 0, unknownModels: [] };
    const models = new Map();
    const sessions = new Map();
    const unpriced = new Set();
    for (const row of scan.rows) {
      if (row.hour >= previous.rangeStart && row.hour <= previous.rangeEnd) {
        summary.previousCostUSD += row.costUSD;
        summary.previousTotal += tokenView(provider, row).total;
        continue;
      }
      if (row.hour < range.rangeStart || row.hour > range.rangeEnd) continue;
      addMetric(summary, provider, row);
      if (!row.priced && hasTokens(row)) unpriced.add(row.model);

      const date = new Date(row.hour);
      const daily = report.daily[dayIndex.get(dayKey(date))];
      if (daily) addMetric((daily.providers[provider] ||= metric()), provider, row);
      addMetric((report.hourly[date.getHours()].providers[provider] ||= metric()), provider, row);

      let model = models.get(row.model);
      if (!model) {
        model = { provider, model: row.model, ...emptyBucket(), priced: true, ...metric() };
        models.set(row.model, model);
      }
      addBucket(model, row);
      model.prompt += tokenView(provider, row).prompt;
      model.total += tokenView(provider, row).total;
      if (!row.priced && hasTokens(row)) model.priced = false;

      let session = sessions.get(row.session);
      if (!session) {
        const meta = scan.sessions.get(row.session) || {};
        session = {
          provider,
          sessionId: row.session,
          title: meta.title || null,
          cwd: meta.cwd || '',
          project: projectName(meta.cwd) || meta.project || '',
          client: meta.client || '',
          // Rows only know their hour; the provider's own activity time is exact.
          lastAt: Math.min(range.rangeEnd, Math.max(row.hour, meta.lastAt || 0)),
          ...metric(),
        };
        sessions.set(row.session, session);
      }
      addMetric(session, provider, row);
      session.lastAt = Math.max(session.lastAt, row.hour);
    }
    summary.sessions = sessions.size;
    summary.unknownModels = [...unpriced];
    report.providers[provider] = summary;
    report.models.push(...models.values());
    for (const session of sessions.values()) {
      report.sessions.push(session);
      const key = projectKey(session.cwd) || `${provider}:${session.project || '(unknown)'}`;
      let project = projects.get(key);
      if (!project) {
        project = { key, name: session.project || '(未知项目)', cwd: projectPath(session.cwd), providers: {}, ...metric(), sessions: 0 };
        projects.set(key, project);
      }
      const perProvider = (project.providers[provider] ||= { ...metric(), sessions: 0 });
      for (const target of [project, perProvider]) {
        for (const key of Object.keys(metric())) target[key] += session[key];
        target.sessions += 1;
      }
    }
  }
  report.models.sort((a, b) => b.costUSD - a.costUSD || b.total - a.total);
  report.projects = [...projects.values()].sort((a, b) => b.costUSD - a.costUSD || b.total - a.total);
  report.sessions = report.sessions
    .sort((a, b) => b.costUSD - a.costUSD || b.total - a.total)
    .slice(0, TOP_SESSIONS);
  return report;
}

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  zero,
  emptyBucket,
  addBucket,
  hourStart,
  hasTokens,
  rowCollector,
  summarizeRows,
  tokenView,
  projectKey,
  projectName,
  projectPath,
  buildReport,
};

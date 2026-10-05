'use strict';

// Grok CLI 本地用量:~/.grok/sessions/<url编码cwd>/<会话id>/ 下
// updates.jsonl 的 turn_completed 事件带逐轮 token 和官方结算费用(costUsdTicks,
// 1 USD = 10^10 ticks),summary.json 带标题/模型/活动时间;
// ~/.grok/logs/unified.jsonl 里 CLI 自己记录了订阅周额度百分比。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRangeDays, rangeBounds } = require('./range');
const { readAppended } = require('./jsonl');
const { zero, addBucket, hourStart, rowCollector, summarizeRows } = require('./report');

const DEFAULT_GROK_ROOT = path.join(os.homedir(), '.grok');
const TICKS_PER_USD = 1e10;
const QUOTA_LOG_TAIL_BYTES = 512 * 1024;

function usageBucket(raw) {
  return {
    input: Math.max(0, raw.inputTokens || 0),
    output: Math.max(0, raw.outputTokens || 0),
    cacheRead: Math.max(0, raw.cachedReadTokens || 0),
    cacheWrite: Math.max(0, raw.cacheCreationTokens || 0),
    reasoning: Math.max(0, raw.reasoningTokens || 0),
    requests: Math.max(0, raw.modelCalls || 1),
    costUSD: Number.isFinite(raw.costUsdTicks) ? Math.max(0, raw.costUsdTicks) / TICKS_PER_USD : 0,
  };
}

// Parser state for one updates.jsonl, resumed across refreshes (lib/jsonl.js
// readAppended): hour × model buckets over every day the file holds.
function consumeUpdateLine(state, line) {
  if (!line.includes('"turn_completed"')) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const update = entry.params && entry.params.update;
  if (!update || update.sessionUpdate !== 'turn_completed' || !update.usage) return;
  const timestamp = Number(entry.timestamp) * 1000;
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return;
  state.activityAt = Math.max(state.activityAt || 0, timestamp);
  const hour = hourStart(timestamp);
  const models = update.usage.modelUsage;
  const entries = models && Object.keys(models).length
    ? Object.entries(models)
    : [['<unknown>', update.usage]];
  for (const [model, raw] of entries) {
    const key = `${hour}|${model}`;
    if (!state.buckets.has(key)) state.buckets.set(key, { hour, model, ...zero(), costUSD: 0 });
    addBucket(state.buckets.get(key), usageBucket(raw));
  }
}

function cachedUpdates(filePath, stat, cache, diagnostics) {
  const previous = cache && cache.get(filePath);
  let entry;
  try {
    entry = readAppended(filePath, stat, previous, {
      createState: () => ({ activityAt: null, buckets: new Map() }),
      consume: consumeUpdateLine,
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

function readSummary(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'summary.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 读 unified.jsonl 尾部,找最后一条 "billing: fetched credits config"。
// 周期长度按 start/end 差值换算成分钟(周额度 = 10080,与 UI 的 windowLabel 天然对齐)。
function readQuota(logPath, now) {
  let text;
  try {
    const stat = fs.statSync(logPath);
    const fd = fs.openSync(logPath, 'r');
    try {
      const start = Math.max(0, stat.size - QUOTA_LOG_TAIL_BYTES);
      const buffer = Buffer.allocUnsafe(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('billing: fetched credits config')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const config = entry.ctx && entry.ctx.config;
    const period = config && config.currentPeriod;
    // xAI omits creditUsagePercent when it is 0 — proto3 drops default scalars.
    // Absent therefore means "nothing used yet this period", not "unknown":
    // across 122 local records the field is never literally 0, and every one of
    // the 17 absences sits in the first days of a billing period. Treating it as
    // unknown hid the whole quota block every Monday until usage crossed 1%.
    const percent = config ? config.creditUsagePercent ?? 0 : undefined;
    const updatedAt = Date.parse(entry.ts);
    const start = period && Date.parse(period.start);
    const end = period && Date.parse(period.end);
    if (
      !Number.isFinite(percent) ||
      percent < 0 ||
      !Number.isFinite(updatedAt) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end <= now.getTime()
    ) {
      return null; // 最新一条不可用就放弃,不用更旧的额度冒充当前值
    }
    return {
      windows: [
        {
          windowMinutes: Math.round((end - start) / 60000),
          usedPercentage: Math.min(100, percent),
          resetsAt: Math.round(end / 1000),
        },
      ],
      updatedAt,
      planType: (entry.ctx && entry.ctx.subscriptionTier) || null,
      // ponytail: CLI 不跑时这条日志不会更新;resets 过期会整体隐藏,不标 stale。
      stale: false,
    };
  }
  return null;
}

function sessionDirs(sessionsRoot) {
  const dirs = [];
  let cwdDirs;
  try {
    cwdDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const base = path.join(sessionsRoot, cwdDir.name);
    let children;
    try {
      children = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isDirectory()) dirs.push(path.join(base, child.name));
    }
  }
  return dirs;
}

function collectGrokUsage({
  root = DEFAULT_GROK_ROOT,
  rangeDays = 1,
  since = null,
  cache = null,
  diagnostics = null,
  now = new Date(),
} = {}) {
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
    unknownModels: [],
    sessions: [],
    rateLimits: readQuota(path.join(root, 'logs', 'unified.jsonl'), now),
    detected: fs.existsSync(path.join(root, 'sessions')),
  };
  const knownFiles = new Set();
  const rows = rowCollector();
  const sessionMeta = new Map();
  for (const sessionDir of sessionDirs(path.join(root, 'sessions'))) {
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    let stat = null;
    try {
      stat = fs.statSync(updatesPath);
    } catch {
      continue; // 没有 updates.jsonl 的目录既无用量也无可靠活动时间
    }
    knownFiles.add(updatesPath);
    if (stat.mtimeMs < readFrom) continue;
    const summary = cachedUpdates(updatesPath, stat, cache, diagnostics);
    if (!summary) continue;
    const meta = readSummary(sessionDir) || {};
    const sessionId = (meta.info && meta.info.id) || path.basename(sessionDir);
    for (const bucket of summary.buckets.values()) rows.add(sessionId, bucket.hour, bucket.model, bucket);
    const metaCwd = (meta.info && meta.info.cwd) || '';
    sessionMeta.set(sessionId, {
      title: meta.generated_title || meta.session_summary || null,
      cwd: metaCwd,
      project: metaCwd ? path.basename(metaCwd) : 'Grok',
      client: 'CLI',
      lastAt: summary.activityAt || 0,
    });
    const activityAt = Math.min(
      Math.max(
        summary.activityAt || 0,
        Date.parse(meta.last_active_at || meta.updated_at || '') || 0,
        0,
      ) || stat.mtimeMs,
      now.getTime(),
    );
    if (activityAt >= recentCutoff) {
      result.sessions.push({
        sessionId,
        project: metaCwd ? path.basename(metaCwd) : 'Grok',
        title: meta.generated_title || meta.session_summary || null,
        cwd: metaCwd,
        client: 'CLI',
        model: meta.current_model_id || null,
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
  // Grok's money is what the CLI says xAI billed, so every model counts as priced.
  Object.assign(result, summarizeRows(result.rows, range));
  result.sessions.sort((a, b) => b.mtime - a.mtime);
  return result;
}

module.exports = { collectGrokUsage, readQuota, DEFAULT_GROK_ROOT, TICKS_PER_USD };

'use strict';
// OpenCode usage from its SQLite store: $XDG_DATA_HOME/opencode/opencode.db, which is
// ~/.local/share/opencode/opencode.db on every platform including Windows.
//
// `message.data` is JSON; an assistant message carries modelID, providerID,
// time.created, tokens { input, output, reasoning, cache { read, write } } and cost.
// input excludes the cache (measured: total = input + output + cache.read +
// cache.write on every local row) and reasoning is a share of output.
//
// Money is OpenCode's own `cost`: what it priced each message at from its models.dev
// table. It is an estimate for API keys and 0 for providers OpenCode doesn't price
// (subscriptions, local models) — shown as recorded, not re-priced here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRangeDays, rangeBounds } = require('./range');
const { rowCollector, summarizeRows } = require('./report');

function defaultDbPath() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

let sqlite;
function openReadOnly(file) {
  sqlite ||= require('node:sqlite'); // Node 22.13+ (Electron 35+)
  return new sqlite.DatabaseSync(file, { readOnly: true, timeout: 250 });
}

const count = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

function parseMessage(row) {
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return null;
  }
  if (!data || data.role !== 'assistant' || !data.tokens) return null;
  const created = data.time && Number(data.time.created);
  if (!Number.isFinite(created) || created <= 0) return null;
  const tokens = data.tokens;
  const cache = tokens.cache || {};
  return {
    session: row.session_id,
    at: created,
    model: String(data.modelID || '<unknown>'),
    input: count(tokens.input),
    output: count(tokens.output),
    reasoning: count(tokens.reasoning),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
    costUSD: count(data.cost),
    cwd: (data.path && data.path.cwd) || '',
  };
}

// After the first read only rows updated since the last one are parsed. `ids` holds
// every message id seen (user rows too); when it no longer matches the row count, a
// row was deleted (a deleted session, even if another row arrived in the same pass)
// or one appeared with an older time_updated (an import) — so read everything again.
function readStore(file, previous) {
  const db = openReadOnly(file);
  try {
    const stats = db.prepare('SELECT count(*) AS n, max(time_updated) AS t FROM message').get();
    const read = (full) => {
      const messages = full ? new Map() : new Map(previous.messages);
      const ids = full ? new Set() : new Set(previous.ids);
      const rows = full
        ? db.prepare('SELECT id, session_id, data FROM message').all()
        : db.prepare('SELECT id, session_id, data FROM message WHERE time_updated >= ?').all(previous.updatedAt);
      for (const row of rows) {
        ids.add(row.id);
        const parsed = parseMessage(row);
        if (parsed) messages.set(row.id, parsed);
        else messages.delete(row.id);
      }
      return { ids, messages, reloaded: full };
    };
    let store = previous ? read(false) : read(true);
    if (store.ids.size !== stats.n) store = read(true);
    const sessions = new Map();
    for (const row of db.prepare('SELECT id, parent_id, directory, title, time_updated FROM session').all()) {
      sessions.set(row.id, {
        parentId: row.parent_id || null,
        cwd: row.directory || '',
        title: String(row.title || '').trim().slice(0, 200) || null,
        updatedAt: Number(row.time_updated) || 0,
      });
    }
    return { ...store, updatedAt: Number(stats.t) || 0, sessions };
  } finally {
    db.close();
  }
}

function signature(file) {
  return ['', '-wal']
    .map((suffix) => {
      try {
        const stat = fs.statSync(file + suffix);
        return `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return '0:0';
      }
    })
    .join('|');
}

// A subagent session bills to the session at the top of its parent chain.
function rootSession(sessions, id) {
  let current = id;
  for (let depth = 0; depth < 32; depth++) {
    const parent = sessions.get(current) && sessions.get(current).parentId;
    if (!parent || !sessions.has(parent)) return current;
    current = parent;
  }
  return current;
}

function collectOpenCodeUsage({
  dbPath = defaultDbPath(),
  rangeDays = 1,
  cache = null,
  diagnostics = null,
  now = new Date(),
} = {}) {
  const range = rangeBounds(now, normalizeRangeDays(rangeDays));
  const recentCutoff = now.getTime() - 24 * 3600 * 1000;
  const result = {
    date: range.date,
    rangeDays: range.rangeDays,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    byModel: {},
    daily: {},
    totals: {},
    costUSD: 0,
    unknownModels: [],
    sessions: [],
    rateLimits: null,
    detected: fs.existsSync(dbPath),
  };
  let store = null;
  if (result.detected) {
    const sig = signature(dbPath);
    const cached = cache && cache.get(dbPath);
    if (cached && cached.sig === sig) {
      store = cached.store;
      if (diagnostics) diagnostics.reusedFiles = (diagnostics.reusedFiles || 0) + 1;
    } else {
      try {
        store = readStore(dbPath, cached && cached.store);
        if (cache) cache.set(dbPath, { sig, store });
        if (diagnostics) {
          diagnostics.parsedFiles = (diagnostics.parsedFiles || 0) + 1;
          if (!store.reloaded) diagnostics.resumedFiles = (diagnostics.resumedFiles || 0) + 1;
        }
      } catch {
        // Busy mid-write or an older schema: keep the last good read.
        if (diagnostics) diagnostics.failedFiles = (diagnostics.failedFiles || 0) + 1;
        store = cached ? cached.store : null;
      }
    }
  }
  const rows = rowCollector();
  const sessionMeta = new Map();
  if (store) {
    for (const message of store.messages.values()) {
      const session = rootSession(store.sessions, message.session);
      rows.add(session, message.at, message.model, { ...message, requests: 1, priced: true });
      if (!sessionMeta.has(session)) {
        const meta = store.sessions.get(session) || {};
        const cwd = meta.cwd || message.cwd || '';
        sessionMeta.set(session, {
          title: meta.title || null,
          cwd,
          project: cwd ? path.basename(cwd) : 'OpenCode',
          client: 'CLI',
          lastAt: 0,
        });
      }
      const meta = sessionMeta.get(session);
      meta.lastAt = Math.max(meta.lastAt, message.at);
    }
    for (const [id, session] of store.sessions) {
      if (session.parentId || session.updatedAt < recentCutoff) continue;
      const activityAt = Math.min(session.updatedAt, now.getTime());
      result.sessions.push({
        sessionId: id,
        project: session.cwd ? path.basename(session.cwd) : 'OpenCode',
        title: session.title,
        cwd: session.cwd,
        client: 'CLI',
        mtime: activityAt,
        state: now.getTime() - activityAt < 2 * 60 * 1000 ? 'working' : 'idle',
      });
    }
  }
  result.rows = rows.rows();
  result.sessionMeta = sessionMeta;
  Object.assign(result, summarizeRows(result.rows, range));
  result.sessions.sort((a, b) => b.mtime - a.mtime);
  return result;
}

module.exports = { collectOpenCodeUsage, parseMessage, defaultDbPath };

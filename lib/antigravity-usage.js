'use strict';
// Antigravity (Google's agent IDE and its `agy` CLI) usage from the conversation
// databases it keeps under ~/.gemini/<root>/conversations/<conversation id>.db.
//
// Each database is SQLite (WAL); token counts sit in protobuf blobs. Field numbers
// follow the reverse engineering in TokenMe (github.com/Bencibr/tokenme,
// crates/adapters/antigravity, MIT), itself cross-checked against tokscale and
// TokenTracker, and were re-checked against this machine's databases on 2026-10-04:
//
//   gen_metadata.data      #1 chat-model message
//     #1.#4 usage          #2 uncached input · #3 total output · #5 cache read
//                          #9 + #10 the output split (#10 read as reasoning) · #11 responseId
//     #1.#9 timing         #4 Timestamp (written by agy <= 1.1.17)
//     #1.#19               machine model id (gemini-3.8-flash, claude-opus-4-6-thinking)
//   steps.metadata         (step_type 15 = a model turn) #1 Timestamp · #9.#11 responseId
//                          · #20.#3 gen_metadata idx — dates the turns newer agy builds
//                          no longer stamp themselves
//   trajectory_metadata_blob.data   #2 created-at Timestamp · #1.#1 workspace file:// URI
//
// #1.#4.#1 is a fixed system-and-tools prefix count and is not billed. Streamed
// partials of one response share a responseId; the largest value per stage is the
// finished count. Older roots (antigravity-ide, antigravity-backup) hold copies of
// the same conversations, so turns merge by conversation id + responseId across
// every root instead of being added up.
//
// Money: Antigravity does not record any, and subscribers aren't billed per token,
// so this is the standard API value — Gemini rows from the gemini section of
// lib/prices.json, Claude rows from the claude section.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRangeDays, rangeBounds } = require('./range');
const { BUNDLED } = require('./prices');
const claude = require('./usage');
const { rowCollector, summarizeRows } = require('./report');

const DEFAULT_ANTIGRAVITY_HOME = path.join(os.homedir(), '.gemini');
// Scan order decides a conversation's client label when it shows up in two roots.
const ROOTS = [
  { name: 'antigravity-cli', client: 'CLI' },
  { name: 'antigravity', client: 'IDE' },
  { name: 'antigravity-ide', client: 'IDE' },
  { name: 'antigravity-backup', client: 'IDE' },
];
const IMPLAUSIBLE_TOKENS = 1e12; // a stage this large is a moved field number, not a turn
const MODEL_TURN = 15;

// --- protobuf wire reading -------------------------------------------------

// [value, nextPos] or null when the buffer ends mid-varint. Plain arithmetic, not
// bitwise ops, so counts past 2^31 stay exact (up to 2^53, far beyond any count).
function readVarint(buf, pos) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) return null;
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) return [value, pos];
    scale *= 128;
  }
  return null;
}

// Every top-level field of one message, or null when the bytes don't parse as one:
// a torn record yields nothing rather than whatever happened to decode first.
function decodeFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key) return null;
    pos = key[1];
    const number = Math.floor(key[0] / 8);
    const wire = key[0] % 8;
    if (wire === 0) {
      const value = readVarint(buf, pos);
      if (!value) return null;
      fields.push({ number, wire, value: value[0] });
      pos = value[1];
    } else if (wire === 2) {
      const length = readVarint(buf, pos);
      if (!length || length[1] + length[0] > buf.length) return null;
      fields.push({ number, wire, value: buf.subarray(length[1], length[1] + length[0]) });
      pos = length[1] + length[0];
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4;
      if (pos > buf.length) return null;
    } else {
      return null; // groups are not used by these messages
    }
  }
  return fields;
}

function message(buf, number) {
  const fields = buf && decodeFields(buf);
  const field = fields && fields.find((f) => f.number === number && f.wire === 2);
  return field ? field.value : null;
}

function varint(fields, number) {
  const field = fields && fields.find((f) => f.number === number && f.wire === 0);
  return field ? field.value : 0;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

// A printable string field, or null. Binary that merely decodes is not a model id.
function text(buf, number) {
  const bytes = message(buf, number);
  if (!bytes || !bytes.length) return null;
  try {
    const value = utf8.decode(bytes).trim();
    return value && !/[\u0000-\u001f\ufffd]/.test(value) ? value : null;
  } catch {
    return null;
  }
}

// protobuf Timestamp {#1 seconds, #2 nanos} → epoch ms, or null.
function timestampMs(buf) {
  const fields = buf && decodeFields(buf);
  if (!fields) return null;
  const seconds = varint(fields, 1);
  const nanos = varint(fields, 2);
  if (!seconds || nanos > 999999999) return null;
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

// --- one database ----------------------------------------------------------

function decodeGeneration(blob) {
  const chat = message(blob, 1);
  if (!chat || !decodeFields(chat)) return null;
  const usageBytes = message(chat, 4);
  const usage = usageBytes && decodeFields(usageBytes);
  if (!usage) return null;
  const stages = {
    input: varint(usage, 2),
    output: varint(usage, 3),
    cacheRead: varint(usage, 5),
    outA: varint(usage, 9),
    outB: varint(usage, 10),
  };
  if (Object.values(stages).some((value) => value >= IMPLAUSIBLE_TOKENS)) return null;
  return {
    stages,
    model: text(chat, 19),
    responseId: text(usageBytes, 11),
    ownTimestamp: timestampMs(message(message(chat, 9), 4)),
  };
}

function maxStages(a, b) {
  return Object.fromEntries(Object.keys(a).map((key) => [key, Math.max(a[key], b[key])]));
}

// The billed stages of one turn. #3 is the server's own output total and equals
// #9 + #10 on every local row; the split is only the fallback when #3 is missing.
function turnTokens(stages) {
  return {
    input: stages.input,
    cacheRead: stages.cacheRead,
    output: stages.output || stages.outA + stages.outB,
    reasoning: stages.outB,
  };
}

function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(uri.slice('file://'.length));
  } catch {
    return null;
  }
  // file:///C:/x → C:/x; a POSIX path keeps its leading slash.
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

let sqlite;
function openReadOnly(file) {
  sqlite ||= require('node:sqlite'); // Node 22.13+ (Electron 35+); required lazily so the rest still loads
  return new sqlite.DatabaseSync(file, { readOnly: true, timeout: 250 });
}

// The turns in one conversation database, keyed by responseId (or gen index).
function readConversation(file, mtimeMs) {
  const db = openReadOnly(file);
  try {
    const blob = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
    const createdAt = blob && blob.data ? timestampMs(message(blob.data, 2)) : null;
    const workspace = blob && blob.data ? fileUriToPath(text(message(blob.data, 1), 1)) : null;
    const byResponse = new Map();
    const byGen = new Map();
    for (const row of db.prepare(`SELECT metadata FROM steps WHERE step_type = ${MODEL_TURN} AND metadata IS NOT NULL`).all()) {
      const at = timestampMs(message(row.metadata, 1));
      if (!at) continue;
      const responseId = text(message(row.metadata, 9), 11);
      if (responseId) byResponse.set(responseId, at);
      const genRef = message(row.metadata, 20);
      const genFields = genRef && decodeFields(genRef);
      if (genFields && genFields.some((f) => f.number === 3 && f.wire === 0)) byGen.set(varint(genFields, 3), at);
    }
    const turns = new Map();
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all()) {
      if (!row.data || !row.data.length) continue;
      const gen = decodeGeneration(row.data);
      if (!gen) continue;
      const key = gen.responseId || `gen${row.idx}`;
      const at = gen.ownTimestamp || byResponse.get(gen.responseId) || byGen.get(row.idx) || createdAt || mtimeMs;
      const seen = turns.get(key);
      if (seen) {
        seen.stages = maxStages(seen.stages, gen.stages);
        seen.model ||= gen.model;
      } else {
        turns.set(key, { stages: gen.stages, model: gen.model, at });
      }
    }
    return { createdAt, workspace, turns };
  } finally {
    db.close();
  }
}

function signature(file) {
  const parts = [];
  for (const suffix of ['', '-wal']) {
    try {
      const stat = fs.statSync(file + suffix);
      parts.push(stat.size, stat.mtimeMs);
    } catch {
      parts.push(0, 0);
    }
  }
  return parts.join(':');
}

// Titles and workspaces from the root's own summary index (conversation_summaries.db).
function readSummaries(rootDir, cache) {
  const file = path.join(rootDir, 'conversation_summaries.db');
  const sig = signature(file);
  const key = `summaries:${file}`;
  const cached = cache && cache.get(key);
  if (cached && cached.sig === sig) return cached.value;
  const value = new Map();
  if (fs.existsSync(file)) {
    try {
      const db = openReadOnly(file);
      try {
        for (const row of db.prepare('SELECT conversation_id, title, preview, workspace_uris, last_modified_time FROM conversation_summaries').all()) {
          let workspace = null;
          try {
            workspace = fileUriToPath(JSON.parse(row.workspace_uris || '[]')[0]);
          } catch {
            // Not JSON: leave the workspace to the conversation's own blob.
          }
          value.set(row.conversation_id, {
            title: String(row.title || row.preview || '').trim().slice(0, 200) || null,
            workspace,
            modifiedAt: Date.parse(String(row.last_modified_time || '').replace(' ', 'T')) || 0,
          });
        }
      } finally {
        db.close();
      }
    } catch {
      // Busy or a schema we don't know: titles are optional.
    }
  }
  if (cache) cache.set(key, { sig, value });
  return value;
}

// --- pricing ---------------------------------------------------------------

// Gemini rows in lib/prices.json: USD per 1M tokens (input, cachedInput, output) and
// an optional longContext tier { above, input, cachedInput, output } that applies to
// the whole call once its prompt exceeds `above` tokens. Longest matching key wins,
// so Antigravity's experiment ids (gemini-3.7-flash-control, gemini-3-flash-a) price
// as their model. A router label such as gemini-pro-default names no model and stays
// unpriced rather than guessed.
function geminiPriceFor(model, prices = BUNDLED) {
  const id = String(model || '').replace(/^(?:models|google)\//, '');
  const table = prices.gemini || {};
  const key = Object.keys(table)
    .filter((name) => id === name || id.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

function geminiCostOf(model, tokens, prices = BUNDLED) {
  const price = geminiPriceFor(model, prices);
  if (!price) return 0;
  const prompt = tokens.input + tokens.cacheRead;
  const rates = price.longContext && prompt > price.longContext.above ? price.longContext : price;
  return (tokens.input * rates.input + tokens.cacheRead * rates.cachedInput + tokens.output * rates.output) / 1e6;
}

function priceFor(model, prices = BUNDLED) {
  return /^claude-/.test(String(model)) ? claude.priceFor(model, prices.claude) : geminiPriceFor(model, prices);
}

function costOf(model, tokens, prices = BUNDLED) {
  if (/^claude-/.test(String(model))) {
    return claude.costOf(model, { ...tokens, cacheWrite: 0 }, prices.claude);
  }
  return geminiCostOf(model, tokens, prices);
}

// --- collection ------------------------------------------------------------

function conversationFiles(home) {
  const files = [];
  for (const root of ROOTS) {
    const dir = path.join(home, root.name, 'conversations');
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.db')) files.push({ root, file: path.join(dir, name), id: name.slice(0, -3) });
    }
  }
  return files;
}

function collectAntigravityUsage({
  home = DEFAULT_ANTIGRAVITY_HOME,
  rangeDays = 1,
  since = null,
  cache = null,
  diagnostics = null,
  prices = BUNDLED,
  now = new Date(),
} = {}) {
  const range = rangeBounds(now, normalizeRangeDays(rangeDays));
  const recentCutoff = now.getTime() - 24 * 3600 * 1000;
  const readFrom = Math.min(range.rangeStart, recentCutoff, Number.isFinite(since) ? since : Infinity);
  const files = conversationFiles(home);
  const result = {
    date: range.date,
    rangeDays: range.rangeDays,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    byModel: {},
    daily: {},
    totals: {},
    costUSD: 0,
    priceSnapshot: prices.snapshot,
    unknownModels: [],
    sessions: [],
    rateLimits: null,
    detected: ROOTS.some((root) => fs.existsSync(path.join(home, root.name, 'conversations'))),
  };
  const summaries = new Map();
  for (const root of ROOTS) {
    for (const [id, summary] of readSummaries(path.join(home, root.name), cache)) {
      if (!summaries.has(id)) summaries.set(id, summary);
    }
  }
  const knownKeys = new Set(ROOTS.map((root) => `summaries:${path.join(home, root.name, 'conversation_summaries.db')}`));
  const conversations = new Map(); // id → { client, workspace, activityAt, turns }
  for (const { root, file, id } of files) {
    knownKeys.add(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = signature(file);
    const walAt = Number(sig.split(':')[3]) || 0;
    if (Math.max(stat.mtimeMs, walAt) < readFrom) continue;
    let entry = cache && cache.get(file);
    if (entry && entry.sig === sig) {
      if (diagnostics) diagnostics.reusedFiles = (diagnostics.reusedFiles || 0) + 1;
    } else {
      try {
        entry = { sig, value: readConversation(file, stat.mtimeMs) };
        if (cache) cache.set(file, entry);
        if (diagnostics) diagnostics.parsedFiles = (diagnostics.parsedFiles || 0) + 1;
      } catch {
        // Locked mid-checkpoint or not a conversation database: keep what we had.
        if (diagnostics) diagnostics.failedFiles = (diagnostics.failedFiles || 0) + 1;
        if (!entry) continue;
      }
    }
    const { createdAt, workspace, turns } = entry.value;
    let conversation = conversations.get(id);
    if (!conversation) {
      conversation = { client: root.client, workspace: null, activityAt: 0, turns: new Map() };
      conversations.set(id, conversation);
    }
    conversation.workspace ||= workspace;
    conversation.activityAt = Math.max(conversation.activityAt, createdAt || 0, Math.min(stat.mtimeMs, now.getTime()));
    for (const [key, turn] of turns) {
      const seen = conversation.turns.get(key);
      conversation.turns.set(key, seen ? { ...seen, stages: maxStages(seen.stages, turn.stages), model: seen.model || turn.model } : turn);
    }
  }
  if (cache) {
    for (const key of cache.keys()) if (!knownKeys.has(key)) cache.delete(key);
  }

  const rows = rowCollector();
  const sessionMeta = new Map();
  for (const [id, conversation] of conversations) {
    const summary = summaries.get(id) || {};
    const cwd = summary.workspace || conversation.workspace || '';
    const meta = {
      title: summary.title || null,
      cwd,
      project: cwd ? path.basename(cwd) : 'Antigravity',
      client: conversation.client,
      lastAt: 0,
    };
    sessionMeta.set(id, meta);
    let lastTurnAt = 0;
    for (const turn of conversation.turns.values()) {
      const tokens = turnTokens(turn.stages);
      if (!(tokens.input || tokens.cacheRead || tokens.output)) continue;
      const model = turn.model || '<unknown>';
      lastTurnAt = Math.max(lastTurnAt, turn.at);
      rows.add(id, turn.at, model, {
        ...tokens,
        requests: 1,
        costUSD: costOf(model, tokens, prices),
        priced: Boolean(priceFor(model, prices)),
      });
    }
    const activityAt = Math.min(Math.max(lastTurnAt, summary.modifiedAt || 0) || conversation.activityAt, now.getTime());
    meta.lastAt = lastTurnAt;
    if (activityAt >= recentCutoff) {
      result.sessions.push({
        sessionId: id,
        project: cwd ? path.basename(cwd) : 'Antigravity',
        title: summary.title || null,
        cwd,
        client: conversation.client,
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

module.exports = {
  collectAntigravityUsage,
  decodeFields,
  decodeGeneration,
  readConversation,
  priceFor,
  costOf,
  geminiPriceFor,
  DEFAULT_ANTIGRAVITY_HOME,
  ROOTS,
};

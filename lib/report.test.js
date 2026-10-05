'use strict';
// Incremental reading, the two SQLite sources, and the cross-tool report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAppended, readJsonLinesSync } = require('./jsonl');
const { collectUsage } = require('./usage');
const { collectCodexUsage } = require('./codex-usage');
const { collectGrokUsage } = require('./grok-usage');
const { collectAntigravityUsage, decodeGeneration, priceFor: antigravityPriceFor, costOf: antigravityCostOf } = require('./antigravity-usage');
const { collectOpenCodeUsage } = require('./opencode-usage');
const { buildReport, projectKey, projectName, tokenView, rowCollector } = require('./report');
const { collectReport } = require('./usage-worker');
const { BUNDLED } = require('./prices');

const NOW = new Date('2026-07-26T12:00:00');
const HOUR = 3600 * 1000;
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `cut-${prefix}-`));
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: got ${actual}, want ${expected}`);
const jsonl = (lines) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
const NO_DESKTOP = {
  desktopUsagePath: path.join(os.tmpdir(), 'cut-none.json'),
  desktopSessionsRoot: path.join(os.tmpdir(), 'cut-none-sessions'),
  desktopAgentSessionsRoot: path.join(os.tmpdir(), 'cut-none-agents'),
};

test('appended reads resume at the last complete line and start over after a rewrite', () => {
  const file = path.join(tmp('append'), 'log.jsonl');
  const consume = (state, line, offset) => state.push([JSON.parse(line).n, offset]);
  const read = (entry) => readAppended(file, fs.statSync(file), entry, { createState: () => [], consume });
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
  let entry = read();
  assert.deepEqual(entry.state, [[1, 0], [2, 8]]);
  assert.equal(read(entry).reused, true, 'unchanged size and mtime read nothing');

  fs.appendFileSync(file, '{"n":3}\n{"n":');
  entry = read(entry);
  assert.equal(entry.resumedFrom, 16, 'only the appended bytes are read');
  assert.deepEqual(entry.state.map(([n]) => n), [1, 2, 3], 'the torn line waits');
  fs.appendFileSync(file, '4}\n');
  entry = read(entry);
  assert.deepEqual(entry.state, [[1, 0], [2, 8], [3, 16], [4, 24]], 'offsets stay absolute across resumes');

  // Same length or longer but different bytes before the resume point: a rewrite.
  fs.writeFileSync(file, '{"n":9}\n{"n":8}\n{"n":7}\n{"n":6}\n{"n":5}\n');
  entry = read(entry);
  assert.equal(entry.resumedFrom, 0);
  assert.deepEqual(entry.state.map(([n]) => n), [9, 8, 7, 6, 5]);
  fs.writeFileSync(file, '{"n":1}\n');
  assert.deepEqual(read(entry).state.map(([n]) => n), [1], 'a shrunk file is read from the start');
  // A state from an older price table is not resumed.
  const priced = readAppended(file, fs.statSync(file), { ...entry, state: Object.assign([], { key: 'old' }) }, {
    createState: () => Object.assign([], { key: 'new' }),
    consume,
    sameState: (state) => state.key === 'new',
  });
  assert.equal(priced.state.key, 'new');
  assert.equal(readJsonLinesSync(file, () => {}, { start: 8 }), 8, 'reading from the end returns the end');
});

const claudeEntry = (id, usage, timestamp = NOW.toISOString(), cwd = 'C:\\work\\alpha') => ({
  type: 'assistant',
  timestamp,
  cwd,
  message: { id, model: 'claude-opus-5', usage },
});

test('a growing Claude transcript reads only its tail and totals match a fresh read', () => {
  const root = tmp('claude-grow');
  fs.mkdirSync(path.join(root, 'proj'));
  const file = path.join(root, 'proj', 'sess.jsonl');
  fs.writeFileSync(file, jsonl([claudeEntry('a', { input_tokens: 10, output_tokens: 1 })]));
  const options = { root, statusDir: root, ...NO_DESKTOP, now: NOW };
  const cache = new Map();
  collectUsage({ ...options, cache });
  // Streaming rewrites message a, and message b arrives.
  fs.appendFileSync(file, jsonl([
    claudeEntry('a', { input_tokens: 10, output_tokens: 50 }),
    claudeEntry('b', { input_tokens: 5, output_tokens: 5 }),
  ]));
  const diagnostics = {};
  const resumed = collectUsage({ ...options, cache, diagnostics });
  const fresh = collectUsage(options);
  assert.equal(diagnostics.resumedFiles, 1);
  assert.ok(diagnostics.bytesRead < fs.statSync(file).size, 'the first line is not read again');
  assert.deepEqual(resumed.totals, fresh.totals);
  assert.equal(resumed.totals.output, 55, 'the rewrite replaces, the new message adds');
  assert.equal(resumed.totals.requests, 2);
});

test('copied Claude history bills to the session that ran it, at its full size', () => {
  const root = tmp('claude-copy');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const usage = { input_tokens: 100, output_tokens: 3622, cache_read_input_tokens: 853146 };
  const original = path.join(proj, 'original.jsonl');
  fs.writeFileSync(original, jsonl([claudeEntry('m1', usage)]));
  // The resumed transcript is created later and carries a zeroed stub of m1.
  const resumed = path.join(proj, 'resumed.jsonl');
  fs.writeFileSync(resumed, jsonl([
    claudeEntry('m1', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }),
    claudeEntry('m2', { input_tokens: 1, output_tokens: 1 }),
  ]));
  // The stub must lose whichever file is read first.
  const u = collectUsage({ root, statusDir: root, ...NO_DESKTOP, now: NOW });
  assert.equal(u.totals.output, 3623);
  const owners = new Map(u.rows.map((row) => [row.output, row.session]));
  assert.equal(owners.get(3622), 'original');
  assert.equal(owners.get(1), 'resumed');

  // A subagent transcript bills to its parent session.
  const nested = path.join(proj, 'original', 'subagents');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'agent-1.jsonl'), jsonl([claudeEntry('child', { input_tokens: 7, output_tokens: 7 })]));
  const withChild = collectUsage({ root, statusDir: root, ...NO_DESKTOP, now: NOW });
  assert.deepEqual([...new Set(withChild.rows.map((row) => row.session))].sort(), ['original', 'resumed']);
});

test('a resumed Codex rollout keeps its cumulative baseline and model', () => {
  const root = tmp('codex-grow');
  const file = path.join(root, 'rollout.jsonl');
  const iso = NOW.toISOString();
  const tokens = (input, output) => ({
    type: 'event_msg',
    timestamp: iso,
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
  });
  fs.writeFileSync(file, jsonl([
    { type: 'session_meta', timestamp: iso, payload: { id: 'c1', cwd: 'C:\\work\\beta' } },
    { type: 'turn_context', timestamp: iso, payload: { turn_id: 't1', model: 'gpt-6-sol' } },
    tokens(100, 10),
  ]));
  const options = { root, archivedRoot: null, sessionIndexPath: null, now: NOW };
  const cache = new Map();
  collectCodexUsage({ ...options, cache });
  fs.appendFileSync(file, jsonl([tokens(250, 30), { type: 'turn_context', timestamp: iso, payload: { turn_id: 't2', model: 'gpt-6-sol' } }]));
  const diagnostics = {};
  const resumed = collectCodexUsage({ ...options, cache, diagnostics });
  assert.equal(diagnostics.resumedFiles, 1);
  assert.deepEqual(resumed.totals, collectCodexUsage(options).totals);
  assert.equal(resumed.totals.input, 250, 'the second snapshot adds only its delta');
  assert.equal(resumed.totals.requests, 2);
  near(resumed.costUSD, (250 * 2 + 30 * 10) / 1e6, 'priced under gpt-6-sol');
});

test('Codex rollouts bill their own work only: copies are found by content, model switches are not resets', () => {
  const at = (ms) => new Date(NOW.getTime() - HOUR + ms).toISOString();
  const tokens = (ms, input, output) => ({ type: 'event_msg', timestamp: at(ms), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, output_tokens: output } } } });
  const settings = (ms, model) => ({ type: 'event_msg', timestamp: at(ms), payload: { type: 'thread_settings_applied', thread_settings: { model } } });
  const turn = (ms, id, model) => ({ type: 'turn_context', timestamp: at(ms), payload: { turn_id: id, model } });
  // The rollout something was forked from: one call, already billed there.
  const source = (id) => [
    { type: 'session_meta', timestamp: at(-600000), payload: { id } },
    turn(-599000, `${id}-turn`, 'gpt-5.5'),
    tokens(-590000, 999, 9),
  ];
  const collect = (rollouts) => {
    const root = tmp('codex-shape');
    rollouts.forEach((lines, index) => fs.writeFileSync(path.join(root, `rollout-${index}.jsonl`), jsonl(lines)));
    return collectCodexUsage({ root, archivedRoot: null, sessionIndexPath: null, now: NOW });
  };

  // Forked subagent, as Codex 0.159 writes it: the parent's history copied in at creation,
  // then the subagent's settings, then its own calls with no turn_context.
  const forked = collect([source('parent'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'child', parent_thread_id: 'parent', forked_from_id: 'parent', thread_source: 'subagent' } },
    turn(0, 'parent-turn', 'gpt-5.5'),
    tokens(3, 999, 9),
    settings(5, 'gpt-6-sol'),
    tokens(4000, 1000, 100),
  ]]);
  near(forked.byModel['gpt-6-sol'].costUSD, (1000 * 2 + 100 * 10) / 1e6, 'priced under the model thread_settings names, not $0');
  assert.equal(forked.totals.input, 999 + 1000, 'the copied call counts once, in the parent');
  assert.equal(forked.totals.requests, 2, 'the parent’s turn, and the subagent’s work as one turn though it wrote no turn_context');
  assert.deepEqual([...new Set(forked.rows.map((row) => row.session))], ['parent'], 'bills to the parent conversation');

  // Codex <=0.148 sometimes wrote a fork in one go at the end: every line, the subagent's
  // own work included, carries the creation instant. Timing can't separate them; content can.
  const oneWrite = collect([source('parent'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'child', parent_thread_id: 'parent', forked_from_id: 'parent', thread_source: 'subagent' } },
    turn(0, 'parent-turn', 'gpt-5.5'),
    tokens(0, 999, 9),
    turn(0, 'own-turn', 'gpt-6-sol'),
    tokens(0, 1000, 10),
    tokens(0, 1200, 12),
  ]]);
  assert.equal(oneWrite.totals.input, 999 + 1000 + 1200);
  assert.equal(oneWrite.totals.requests, 2, 'one turn in the parent, one of the subagent’s own');

  // Subagent that worked, then had its model switched (Codex 0.153+): both stretches count.
  const switched = collect([source('parent'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'worker', parent_thread_id: 'parent', thread_source: 'subagent' } },
    turn(1500, 't1', 'gpt-6-sol'),
    tokens(6000, 1000, 10),
    settings(60000, 'gpt-5.5'),
    tokens(65000, 2000, 20),
  ]]);
  assert.equal(switched.totals.input, 999 + 3000, 'work before the switch is not dropped');

  // A conversation forked in Codex Desktop copies the source's calls the same way.
  const desktopFork = collect([source('source'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'fork', forked_from_id: 'source', originator: 'Codex Desktop' } },
    turn(1, 'source-turn', 'gpt-5.5'),
    tokens(330, 999, 9),
    turn(30000, 'own-turn', 'gpt-6-sol'),
    tokens(34000, 1000, 10),
  ]]);
  assert.equal(desktopFork.totals.input, 999 + 1000, 'a copy written 330 ms after creation still counts once');
  assert.equal(desktopFork.totals.requests, 2);

  // A fork of a fork can carry its grandparent's calls without its parent's file holding them.
  const chain = collect([source('grand'), [
    { type: 'session_meta', timestamp: at(-300000), payload: { id: 'middle', forked_from_id: 'grand', parent_thread_id: 'grand', thread_source: 'subagent' } },
    tokens(-290000, 2000, 20),
  ], [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'leaf', forked_from_id: 'middle', parent_thread_id: 'middle', thread_source: 'subagent' } },
    tokens(0, 999, 9),
    tokens(0, 2000, 20),
    tokens(5000, 3000, 30),
  ]]);
  assert.equal(chain.totals.input, 999 + 2000 + 3000, 'each call once, wherever up the chain it was billed');

  // A source last written before the range is read anyway, so its calls are not billed again.
  const root = tmp('codex-old-source');
  // Codex names the file after the session id; that is how a source is found.
  const oldFile = path.join(root, 'rollout-2026-06-16T12-00-00-019f0000-0000-7000-8000-000000000001.jsonl');
  fs.writeFileSync(oldFile, jsonl([
    { type: 'session_meta', timestamp: new Date(NOW.getTime() - 40 * 24 * HOUR).toISOString(), payload: { id: '019f0000-0000-7000-8000-000000000001' } },
    { type: 'event_msg', timestamp: new Date(NOW.getTime() - 40 * 24 * HOUR).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 999, output_tokens: 9 } } } },
  ]));
  const forty = new Date(NOW.getTime() - 40 * 24 * HOUR);
  fs.utimesSync(oldFile, forty, forty);
  fs.writeFileSync(path.join(root, 'rollout-new.jsonl'), jsonl([
    { type: 'session_meta', timestamp: at(0), payload: { id: 'fork', forked_from_id: '019f0000-0000-7000-8000-000000000001' } },
    tokens(0, 999, 9),
    tokens(5000, 1000, 10),
  ]));
  const pathFork = collectCodexUsage({ root, archivedRoot: null, sessionIndexPath: null, now: NOW });
  assert.equal(pathFork.totals.input, 1000, 'the 40-day-old source is read to recognise the copy');

  // Since 2026-09-30 a thread continues in rollout-<time>-<id>_<uuid>.jsonl: same thread id,
  // new work — and sometimes a replay of earlier calls, at the pace they first ran.
  const threadRoot = tmp('codex-thread');
  const thread = '01a0f592-3e5f-7000-8000-000000000001';
  fs.writeFileSync(path.join(threadRoot, `rollout-2026-07-26T10-00-00-${thread}.jsonl`), jsonl([
    { type: 'session_meta', timestamp: at(0), payload: { id: thread, cwd: 'C:\\work\\thread', originator: 'Codex Desktop' } },
    turn(1000, 'a', 'gpt-6-sol'),
    tokens(5000, 999, 9),
  ]));
  fs.writeFileSync(path.join(threadRoot, `rollout-2026-07-26T10-30-00-${thread}_01a0f5bf-7110-7000-8000-000000000002.jsonl`), jsonl([
    { type: 'session_meta', timestamp: at(1800000), payload: { id: thread, cwd: 'C:\\work\\thread', originator: 'Codex Desktop' } },
    settings(1800001, 'gpt-6-sol'),
    tokens(1810000, 999, 9),
    turn(1820000, 'b', 'gpt-6-sol'),
    tokens(1830000, 4000, 40),
  ]));
  const continued = collectCodexUsage({ root: threadRoot, archivedRoot: null, sessionIndexPath: null, now: NOW });
  assert.equal(continued.totals.input, 999 + 4000, 'the continuation’s own call counts, its replay does not');
  assert.equal(continued.totals.requests, 2);
  assert.deepEqual(continued.sessions.map((s) => s.sessionId), [thread], 'one thread, one session');
  assert.equal(continued.sessions[0].mtime, Date.parse(at(1830000)), 'last active in the continuation');

  // The source is gone from disk: the copy is the only record left, so it is billed.
  const orphan = collect([[
    { type: 'session_meta', timestamp: at(0), payload: { id: 'fork', forked_from_id: 'deleted' } },
    tokens(0, 999, 9),
    tokens(5000, 1000, 10),
  ]]);
  assert.equal(orphan.totals.input, 1999);
});

test('a resumed Grok updates file adds only new turns', () => {
  const root = tmp('grok-grow');
  const dir = path.join(root, 'sessions', 'C%3A%5Cwork', 'g1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'updates.jsonl');
  const turn = (seconds, ticks) => ({
    timestamp: seconds,
    params: { update: { sessionUpdate: 'turn_completed', usage: { modelUsage: { 'grok-4.7': { inputTokens: 10, outputTokens: 2, costUsdTicks: ticks } } } } },
  });
  const t = NOW.getTime() / 1000;
  fs.writeFileSync(file, jsonl([turn(t - 60, 1e10)]));
  const cache = new Map();
  collectGrokUsage({ root, cache, now: NOW });
  fs.appendFileSync(file, jsonl([turn(t - 30, 2e10)]));
  const u = collectGrokUsage({ root, cache, now: NOW });
  near(u.costUSD, 3, 'two turns, billed $1 + $2');
  assert.equal(u.totals.requests, 2);
});

// --- protobuf fixtures for Antigravity ------------------------------------
function varint(value) {
  const bytes = [];
  let n = value;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
}
const vfield = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);
const bfield = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(Buffer.byteLength(bytes)), Buffer.from(bytes)]);
const timestamp = (ms) => Buffer.concat([vfield(1, Math.floor(ms / 1000)), vfield(2, (ms % 1000) * 1e6)]);
function generation({ model, input = 0, output = 0, cacheRead = 0, outA = 0, outB = 0, responseId, at }) {
  const usage = Buffer.concat([
    vfield(1, 1071), // fixed prefix, never billed
    vfield(2, input),
    vfield(3, output),
    vfield(5, cacheRead),
    vfield(9, outA),
    vfield(10, outB),
    responseId ? bfield(11, responseId) : Buffer.alloc(0),
  ]);
  const chat = Buffer.concat([
    bfield(4, usage),
    at ? bfield(9, bfield(4, timestamp(at))) : Buffer.alloc(0),
    model ? bfield(19, model) : Buffer.alloc(0),
    bfield(17, usage), // the second copy that must not be counted twice
  ]);
  return bfield(1, chat);
}

function conversationDb(file, { createdAt, workspace, gens = [], steps = [] }) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
    CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob);
    CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id));`);
  db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(
    Buffer.concat([bfield(2, timestamp(createdAt)), bfield(1, bfield(1, workspace))]),
  );
  gens.forEach((gen, idx) => db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(idx, generation(gen)));
  steps.forEach(({ at, responseId }, idx) => db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, 15, ?)').run(
    idx,
    Buffer.concat([bfield(1, timestamp(at)), bfield(9, bfield(11, responseId))]),
  ));
  db.close();
}

test('Antigravity decodes turns, dates them from steps, merges backups and prices per model', () => {
  const home = tmp('agy');
  const created = NOW.getTime() - 2 * HOUR;
  const turnAt = NOW.getTime() - HOUR;
  const conversation = {
    createdAt: created,
    workspace: 'file:///F:/codex%20project/demo',
    gens: [
      // Two streamed partials of one response: the largest value per stage wins.
      { model: 'gemini-3.7-flash-control', input: 1000, output: 100, cacheRead: 5000, outA: 60, outB: 40, responseId: 'r1' },
      { model: 'gemini-3.7-flash-control', input: 1000, output: 200, cacheRead: 9000, outA: 120, outB: 80, responseId: 'r1' },
      { model: 'claude-opus-4-6-thinking', input: 2000, output: 10, responseId: 'r2', at: turnAt },
      { model: 'gemini-pro-default', input: 300, output: 3, responseId: 'r3' },
      { model: 'gemini-3.1-pro-preview', input: 150000, cacheRead: 60000, output: 1000, responseId: 'r4' },
      { input: 0, output: 0, responseId: 'empty' },
    ],
    steps: [{ at: turnAt, responseId: 'r1' }],
  };
  for (const root of ['antigravity', 'antigravity-backup']) {
    fs.mkdirSync(path.join(home, root, 'conversations'), { recursive: true });
    conversationDb(path.join(home, root, 'conversations', 'conv-1.db'), conversation);
  }
  const cache = new Map();
  const u = collectAntigravityUsage({ home, cache, now: NOW });
  assert.equal(u.detected, true);
  assert.equal(u.totals.requests, 4, 'the backup copy merges instead of doubling; an empty turn is skipped');
  const flash = u.byModel['gemini-3.7-flash-control'];
  assert.deepEqual([flash.input, flash.cacheRead, flash.output, flash.reasoning], [1000, 9000, 200, 80]);
  near(flash.costUSD, (1000 * 0.75 + 9000 * 0.075 + 200 * 3.75) / 1e6, 'experiment id prices as gemini-3.7-flash');
  near(u.byModel['claude-opus-4-6-thinking'].costUSD, (2000 * 5 + 10 * 25) / 1e6, 'Claude via Antigravity uses the Claude table');
  // 150k + 60k cached = 210k prompt: over 200k, so the whole call takes the long-context rates.
  near(u.byModel['gemini-3.1-pro-preview'].costUSD, (150000 * 4 + 60000 * 0.4 + 1000 * 18) / 1e6, 'long-context tier');
  assert.deepEqual(u.unknownModels, ['gemini-pro-default'], 'a router label is not priced by guess');
  assert.ok(u.rows.every((row) => row.hour === new Date(turnAt).setMinutes(0, 0, 0) || row.hour === new Date(created).setMinutes(0, 0, 0)));
  assert.equal(u.rows.find((row) => row.model === 'gemini-3.7-flash-control').hour, new Date(turnAt).setMinutes(0, 0, 0), 'dated by the step, not the creation time');
  assert.equal(u.sessionMeta.get('conv-1').cwd, 'F:/codex project/demo');
  assert.equal(u.sessions[0].client, 'IDE');

  const diagnostics = {};
  collectAntigravityUsage({ home, cache, diagnostics, now: NOW });
  assert.equal(diagnostics.reusedFiles, 2, 'unchanged databases are not reopened');
  assert.equal(decodeGeneration(Buffer.from([0x0a, 0x05, 0x01])), null, 'a torn blob decodes to nothing');
  assert.equal(antigravityPriceFor('gemini-3.5-flash-lite').input, 0.3, 'longest key wins over gemini-3.5-flash');
  near(antigravityCostOf('gemini-2.5-pro', { input: 100000, cacheRead: 0, output: 0 }), 0.125, 'under 200k stays on the base rate');
});

test('OpenCode reads its store incrementally and rolls subagents up to their session', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(tmp('opencode'), 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text, title text, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);`);
  const at = NOW.getTime() - HOUR;
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('root', null, 'C:\\work\\gamma', '修复登录', at);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('child', 'root', 'C:\\work\\gamma', 'subtask', at);
  const message = (id, session, cost, updated = at) => db.prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)').run(
    id, session, at, updated,
    JSON.stringify({ role: 'assistant', time: { created: at }, modelID: 'deepseek-v4-flash', providerID: 'deepseek', cost, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } } }),
  );
  message('m1', 'root', 0.01);
  message('m2', 'child', 0.02);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('u1', 'root', at, at, JSON.stringify({ role: 'user', time: { created: at } }));
  const cache = new Map();
  const first = collectOpenCodeUsage({ dbPath, cache, now: NOW });
  near(first.costUSD, 0.03, 'the cost OpenCode recorded');
  assert.equal(first.totals.requests, 2, 'user messages are not requests');
  assert.deepEqual([...new Set(first.rows.map((row) => row.session))], ['root']);
  assert.equal(first.sessions.length, 1, 'only top-level sessions are listed');

  message('m3', 'root', 0.04, at + 1);
  const diagnostics = {};
  const second = collectOpenCodeUsage({ dbPath, cache, diagnostics, now: NOW });
  assert.equal(diagnostics.resumedFiles, 1, 'only rows updated since the last read are parsed');
  near(second.costUSD, 0.07, 'the new message adds');
  db.prepare('DELETE FROM message WHERE id = ?').run('m2');
  near(collectOpenCodeUsage({ dbPath, cache, now: NOW }).costUSD, 0.05, 'a deleted message is dropped on reload');
  // A delete and an insert in one pass leave the row count unchanged.
  db.prepare('DELETE FROM message WHERE id = ?').run('m1');
  message('m5', 'root', 0.1, at + 2);
  near(collectOpenCodeUsage({ dbPath, cache, now: NOW }).costUSD, 0.14, 'the deleted row goes even when the count holds');
  // An imported row older than everything read so far is invisible to the incremental query.
  message('m6', 'root', 1, at - 1000);
  near(collectOpenCodeUsage({ dbPath, cache, now: NOW }).costUSD, 1.14, 'an older row is picked up');
  db.close();
  assert.equal(collectOpenCodeUsage({ dbPath: path.join(os.tmpdir(), 'cut-no-opencode.db'), now: NOW }).detected, false);
});

test('the report compares periods, merges projects across tools and reads tokens on one scale', () => {
  const day = 24 * HOUR;
  const rows = (provider, entries) => {
    const collector = rowCollector();
    for (const [session, at, model, values] of entries) collector.add(session, at, model, values);
    return collector.rows();
  };
  const scans = {
    claude: {
      rows: rows('claude', [
        ['s1', NOW.getTime() - HOUR, 'claude-opus-5', { input: 10, cacheRead: 80, cacheWrite: 10, output: 5, requests: 1, costUSD: 2 }],
        ['s1', NOW.getTime() - 8 * day, 'claude-opus-5', { input: 10, output: 5, requests: 1, costUSD: 1 }],
      ]),
      sessions: new Map([['s1', { title: 'alpha work', cwd: 'C:\\Work\\Alpha\\.claude\\worktrees\\brave-cat', client: 'CLI', lastAt: NOW.getTime() - 30 * 60 * 1000 }]]),
    },
    codex: {
      // Codex input already contains its cached tokens.
      rows: rows('codex', [['c1', NOW.getTime() - 2 * HOUR, 'gpt-6-sol', { input: 100, cacheRead: 90, output: 10, requests: 1, costUSD: 3 }]]),
      sessions: new Map([['c1', { title: 'beta', cwd: 'c:/work/alpha/', client: 'Desktop' }]]),
    },
    opencode: { rows: [], sessions: new Map() },
  };
  const report = buildReport(scans, { days: 7, now: NOW });
  assert.equal(report.daily.length, 7);
  near(report.providers.claude.costUSD, 2, 'claude in range');
  near(report.providers.claude.previousCostUSD, 1, 'the day 8 row lands in the previous period');
  assert.equal(report.providers.claude.prompt, 100, 'claude input + cache read + cache write');
  assert.equal(report.providers.codex.prompt, 100, 'codex input as is');
  assert.equal(report.providers.codex.cacheRead, 90);
  assert.equal(report.projects.length, 1, 'one directory, a worktree of it, two tools, one project');
  assert.equal(report.projects[0].name, 'Alpha');
  assert.deepEqual(Object.keys(report.projects[0].providers).sort(), ['claude', 'codex']);
  near(report.projects[0].costUSD, 5, 'project total');
  assert.deepEqual(report.sessions.map((s) => s.sessionId), ['c1', 's1'], 'sessions by cost');
  assert.equal(report.sessions[1].lastAt, NOW.getTime() - 30 * 60 * 1000, 'exact activity time, not the hour bucket');
  const hour = new Date(NOW.getTime() - HOUR).getHours();
  near(report.hourly[hour].providers.claude.costUSD, 2, 'hour of day');
  assert.equal(tokenView('grok', { input: 50, cacheRead: 40, cacheWrite: 0, output: 5 }).total, 55, 'grok input includes its cache');
  assert.equal(projectKey('C:/Work/Alpha/'), projectKey('c:\\work\\alpha'));
  assert.equal(projectName('/home/me/repo/.claude/worktrees/x'), 'repo');
});

test('report windows past 45 days skip the comparison instead of reading twice the range', () => {
  const empty = tmp('empty-home');
  const options = {
    claude: { root: empty, statusDir: empty, ...NO_DESKTOP },
    codex: { root: empty, archivedRoot: null, sessionIndexPath: null },
    grok: { root: empty },
    antigravity: { home: empty },
    opencode: { dbPath: path.join(empty, 'none.db') },
  };
  const report = collectReport({ days: 90, now: NOW, caches: {}, options });
  assert.equal(report.previous.covered, false);
  assert.equal(collectReport({ days: 30, now: NOW, caches: {}, options }).previous.covered, true);
  assert.equal(report.status.opencode.detected, false);
  assert.throws(() => collectReport({ days: 91, now: NOW, caches: {}, options }), /1 to 90/);
});

test('the gemini price rows are a validated part of the shipped table', () => {
  for (const [id, row] of Object.entries(BUNDLED.gemini)) {
    assert.ok(row.cachedInput <= row.input, `${id}: cached input is not dearer than input`);
    if (row.longContext) assert.ok(row.longContext.input > row.input, `${id}: the long tier costs more`);
  }
});

test('the report window is wired through a sender-checked channel', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const report = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'report.html'), 'utf8');
  assert.match(main, /ipcMain\.handle\('report', \(event, days\) => \{\s*if \(!reportWin \|\| event\.sender !== reportWin\.webContents\)/);
  assert.match(main, /ipcMain\.on\('open-report', \(event\) => \{\s*if \(panelWin && event\.sender === panelWin\.webContents\)/);
  assert.match(preload, /getReport: \(days\) => ipcRenderer\.invoke\('report', days\)/);
  assert.ok(main.includes("{ label: '打开用量报表', click: openReportWindow }"), 'reachable from the tray menu');
  assert.ok(report.includes("window.api.onUsage(() => load())"), 'refreshes with the 30-second snapshot');
});

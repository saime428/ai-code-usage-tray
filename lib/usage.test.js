'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { collectUsage, discoverDesktopData, priceFor } = require('./usage');
const {
  collectCodexUsage,
  costOf: codexCostOf,
  readRateLimits: readCodexRateLimits,
} = require('./codex-usage');
const { sessionTarget } = require('./open-session');
const {
  createAuthorization,
  parseAuthorizationCode,
  exchangeAuthorizationCode,
  parseUsage,
  REDIRECT_URI,
} = require('./claude-oauth');

function fixture(lines, { sessionId = 'session-1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-test-'));
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-status-'));
  const proj = path.join(root, 'C--fake-project');
  fs.mkdirSync(proj);
  const file = path.join(proj, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(file, NOW, NOW);
  return { root, statusDir, proj, file, sessionId };
}

function codexFixture(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-codex-'));
  const dir = path.join(root, '2026', '07', '26');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  fs.utimesSync(file, NOW, NOW);
  return root;
}

const NOW = new Date('2026-07-26T12:00:00');
const iso = NOW.toISOString();
const yesterdayIso = new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString();
const NO_DESKTOP_USAGE = path.join(os.tmpdir(), `cut-no-desktop-${process.pid}.json`);
const NO_DESKTOP_SESSIONS = path.join(os.tmpdir(), `cut-no-sessions-${process.pid}`);
const collect = (options) =>
  collectUsage({
    desktopUsagePath: NO_DESKTOP_USAGE,
    desktopSessionsRoot: NO_DESKTOP_SESSIONS,
    ...options,
  });

const entry = (id, model, usage, timestamp = iso) => ({
  type: 'assistant',
  timestamp,
  cwd: 'C:\\fake\\my-project',
  message: { id, model, usage },
});

test('aggregates, dedups by message id, filters date, prices correctly', () => {
  const { root, statusDir } = fixture([
    entry('m1', 'claude-haiku-4-5-20251001', {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 4000,
    }),
    // same id rewritten by streaming — must replace, not double-count
    entry('m1', 'claude-haiku-4-5-20251001', {
      input_tokens: 1000,
      output_tokens: 3000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 4000,
    }),
    entry('m2', 'claude-opus-5', { input_tokens: 100, output_tokens: 200 }),
    entry('m3', 'claude-opus-5', { input_tokens: 999, output_tokens: 999 }, yesterdayIso),
    entry('m4', 'weird-model-x', { input_tokens: 50, output_tokens: 5 }),
    { type: 'custom-title', customTitle: '修复真实会话名称' },
    { type: 'user', timestamp: iso, message: { content: 'usage of "usage" word' } },
  ]);

  const u = collect({ root, statusDir, now: NOW });

  const haiku = u.byModel['claude-haiku-4-5-20251001'];
  assert.equal(haiku.output, 3000, 'dedup keeps the last rewrite');
  assert.equal(haiku.requests, 1);
  // (1000*1 + 4000*1*1.25 + 10000*1*0.1 + 3000*5) / 1e6 = 0.022
  assert.ok(Math.abs(haiku.costUSD - 0.022) < 1e-9, `got ${haiku.costUSD}`);

  assert.equal(u.byModel['claude-opus-5'].input, 100, 'yesterday excluded');
  assert.deepEqual(u.unknownModels, ['weird-model-x']);
  assert.equal(u.totals.input, 1000 + 100 + 50);
  assert.equal(u.totals.output, 3000 + 200 + 5);

  assert.equal(u.sessions.length, 1);
  assert.equal(u.sessions[0].project, 'my-project', 'project name from cwd');
  assert.equal(u.sessions[0].state, 'working', 'fresh mtime falls back to working');
  assert.equal(u.sessions[0].fromHook, false);
  assert.equal(u.sessions[0].client, 'CLI');
  assert.equal(u.sessions[0].title, '修复真实会话名称');
});

test('Claude title falls back to the first human text prompt', () => {
  const { root, statusDir } = fixture([
    {
      type: 'user',
      timestamp: iso,
      message: { content: [{ type: 'text', text: '检查真正的会话名称' }] },
    },
    entry('m1', 'claude-opus-5', { input_tokens: 1, output_tokens: 1 }),
  ]);

  assert.equal(collect({ root, statusDir, now: NOW }).sessions[0].title, '检查真正的会话名称');
});

test('Claude pricing handles 1h cache writes, fast mode, namespaced ids, and zero-token synthetic rows', () => {
  const { root, statusDir } = fixture([
    entry('cached', 'anthropic/claude-opus-4.8', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
    }),
    entry('fast', 'claude-opus-4-8', {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      speed: 'fast',
    }),
    entry('synthetic', '<synthetic>', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  ]);

  const u = collect({ root, statusDir, now: NOW });
  assert.ok(Math.abs(u.byModel['anthropic/claude-opus-4.8'].costUSD - 0.01) < 1e-12);
  assert.ok(Math.abs(u.byModel['claude-opus-4-8'].costUSD - 0.015) < 1e-12);
  assert.ok(Math.abs(u.costUSD - 0.025) < 1e-12);
  assert.equal(u.byModel['<synthetic>'], undefined, 'zero-token synthetic rows are omitted');
  assert.deepEqual(u.unknownModels, []);
});

test('files not modified today are skipped for usage but old sessions drop off', () => {
  const { root, statusDir, file } = fixture([
    entry('m1', 'claude-opus-5', { input_tokens: 100, output_tokens: 100 }),
  ]);
  const old = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);

  const u = collect({ root, statusDir, now: NOW });
  assert.equal(Object.keys(u.byModel).length, 0, 'mtime gate skips the file');
  assert.equal(u.sessions.length, 0, 'older than 24h not listed');
});

test('nested subagent transcripts are included without creating extra sessions', () => {
  const { root, statusDir, proj, sessionId } = fixture([
    entry('parent', 'claude-opus-5', { input_tokens: 10, output_tokens: 5 }),
  ]);
  const nestedDir = path.join(proj, sessionId, 'subagents');
  fs.mkdirSync(nestedDir, { recursive: true });
  const nestedFile = path.join(nestedDir, 'agent-child.jsonl');
  fs.writeFileSync(
    nestedFile,
    JSON.stringify(entry('child', 'claude-opus-5', { input_tokens: 20, output_tokens: 7 })) + '\n',
  );
  fs.utimesSync(nestedFile, NOW, NOW);

  const u = collect({ root, statusDir, now: NOW });
  assert.equal(u.totals.requests, 2);
  assert.equal(u.totals.input, 30);
  assert.equal(u.sessions.length, 1, 'subagents belong to their parent session');
});

test('metadata-only writes do not make an old transcript active', () => {
  const old = new Date(NOW.getTime() - 10 * 60 * 1000);
  const { root, statusDir } = fixture([
    entry('old', 'claude-opus-5', { input_tokens: 10, output_tokens: 5 }, old.toISOString()),
    { type: 'mode', mode: 'default', sessionId: 'session-1' },
  ]);

  const session = collect({ root, statusDir, now: NOW }).sessions[0];
  assert.equal(session.mtime, old.getTime());
  assert.equal(session.state, 'idle');
});

test('missing root returns empty result', () => {
  const u = collect({
    root: path.join(os.tmpdir(), 'does-not-exist-xyz'),
    statusDir: path.join(os.tmpdir(), 'does-not-exist-status'),
    now: NOW,
  });
  assert.equal(u.costUSD, 0);
  assert.deepEqual(u.sessions, []);
});

test('Codex Desktop/CLI sessions aggregate cumulative deltas and expose real limit windows', () => {
  const reset = NOW.getTime() / 1000 + 3600;
  const event = (timestamp, input, output, cached, reasoning, rateLimits) => ({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          cached_input_tokens: cached,
          reasoning_output_tokens: reasoning,
        },
      },
      rate_limits: rateLimits,
    },
  });
  const root = codexFixture([
    {
      type: 'session_meta',
      timestamp: yesterdayIso,
      payload: { id: 'codex-1', cwd: 'C:\\fake\\codex-project', originator: 'codex-tui' },
    },
    { type: 'event_msg', timestamp: iso, payload: { type: 'user_message', message: 'Fallback Codex prompt' } },
    { type: 'turn_context', timestamp: yesterdayIso, payload: { turn_id: 'old', model: 'gpt-5.6-sol' } },
    event(yesterdayIso, 100, 20, 60, 5),
    { type: 'turn_context', timestamp: iso, payload: { turn_id: 'a', model: 'gpt-5.6-sol' } },
    event(iso, 160, 30, 100, 7),
    event(iso, 160, 30, 100, 7), // repeated snapshot must add zero
    { type: 'turn_context', timestamp: iso, payload: { turn_id: 'b', model: 'gpt-5.6-terra' } },
    event(iso, 200, 50, 120, 11, {
      primary: { used_percent: 12, window_minutes: 300, resets_at: reset },
      secondary: { used_percent: 34, window_minutes: 10080, resets_at: reset + 3600 },
      plan_type: 'pro',
    }),
  ]);

  const sessionIndexPath = path.join(os.tmpdir(), `cut-codex-index-${process.pid}.jsonl`);
  fs.writeFileSync(
    sessionIndexPath,
    JSON.stringify({ id: 'codex-1', thread_name: '真实 Codex 会话名称' }) + '\n',
  );
  const u = collectCodexUsage({ root, sessionIndexPath, now: NOW });
  assert.deepEqual(u.totals, {
    input: 100,
    output: 30,
    cacheRead: 60,
    cacheWrite: 0,
    reasoning: 6,
    requests: 2,
  });
  assert.equal(u.byModel['gpt-5.6-sol'].input, 60);
  assert.equal(u.byModel['gpt-5.6-terra'].output, 20);
  assert.ok(Math.abs(u.costUSD - 0.000775) < 1e-12, `got ${u.costUSD}`);
  assert.equal(
    codexCostOf('gpt-5.6-sol', {
      input: 300000,
      output: 10000,
      cacheRead: 100000,
      cacheWrite: 0,
    }),
    2.55,
    'long-context requests use 2x input and 1.5x output pricing',
  );
  assert.equal(u.sessions[0].client, 'CLI');
  assert.equal(u.sessions[0].project, 'codex-project');
  assert.equal(u.sessions[0].title, '真实 Codex 会话名称');
  assert.equal(
    collectCodexUsage({ root, sessionIndexPath: path.join(root, 'missing.jsonl'), now: NOW }).sessions[0].title,
    'Fallback Codex prompt',
  );
  assert.deepEqual(
    u.rateLimits.windows.map((window) => [window.windowMinutes, window.usedPercentage]),
    [
      [300, 12],
      [10080, 34],
    ],
  );
  assert.equal(u.rateLimits.stale, false);
});

test('Codex subagents count only their own usage and stay under the parent session', () => {
  const usage = (input, output, cached, reasoning) => ({
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  });
  const tokenEvent = (timestamp, total, last) => ({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: { total_token_usage: total, last_token_usage: last },
    },
  });
  const parentMeta = {
    type: 'session_meta',
    timestamp: iso,
    payload: {
      id: 'parent',
      cwd: 'C:\\fake\\codex-project',
      originator: 'Codex Desktop',
      thread_source: 'user',
    },
  };
  const parentTurn = {
    type: 'turn_context',
    timestamp: iso,
    payload: { turn_id: 'parent-turn', model: 'gpt-5.6-sol' },
  };
  const parentToken = tokenEvent(iso, usage(100, 10, 60, 1), usage(100, 10, 60, 1));
  const root = codexFixture([parentMeta, parentTurn, parentToken]);
  const archivedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-codex-archived-'));
  const childToken = tokenEvent(iso, usage(300, 30, 180, 3), usage(200, 20, 120, 2));
  const repeatedChildToken = { ...childToken, timestamp: new Date(NOW.getTime() + 1).toISOString() };
  const childFile = path.join(archivedRoot, 'rollout-child.jsonl');
  fs.writeFileSync(
    childFile,
    [
      {
        type: 'session_meta',
        timestamp: iso,
        payload: {
          id: 'child',
          parent_thread_id: 'parent',
          cwd: 'C:\\fake\\codex-project',
          originator: 'Codex Desktop',
          thread_source: 'subagent',
        },
      },
      parentMeta,
      parentTurn,
      parentToken,
      { type: 'event_msg', timestamp: iso, payload: { type: 'thread_settings_applied' } },
      {
        type: 'turn_context',
        timestamp: iso,
        payload: { turn_id: 'child-turn', model: 'gpt-5.6-sol' },
      },
      childToken,
      repeatedChildToken,
    ].map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  fs.utimesSync(childFile, NOW, NOW);

  const u = collectCodexUsage({ root, archivedRoot, now: NOW });
  assert.deepEqual(u.totals, {
    input: 300,
    output: 30,
    cacheRead: 180,
    cacheWrite: 0,
    reasoning: 3,
    requests: 2,
  });
  assert.deepEqual(u.sessions.map((session) => session.sessionId), ['parent']);
});

test('Codex namespaced model ids are priced and zero-token unknown turns do not raise a warning', () => {
  const root = codexFixture([
    {
      type: 'session_meta',
      timestamp: iso,
      payload: { id: 'codex-namespaced', cwd: 'C:\fake\codex-project', originator: 'codex-desktop' },
    },
    { type: 'turn_context', timestamp: iso, payload: { turn_id: 'empty', model: '<unknown>' } },
    { type: 'turn_context', timestamp: iso, payload: { turn_id: 'billed', model: 'openai/gpt-5.6-sol' } },
    {
      type: 'event_msg',
      timestamp: iso,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            output_tokens: 100,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 10,
          },
        },
      },
    },
  ]);

  const u = collectCodexUsage({ root, now: NOW });
  assert.ok(u.costUSD > 0);
  assert.deepEqual(u.unknownModels, []);
});

test('Codex idle limit snapshots stay neutral instead of raising a refresh warning', () => {
  const updatedAt = NOW.getTime() - 2 * 60 * 60 * 1000;
  const limits = readCodexRateLimits({
    primary: { used_percent: 12, window_minutes: 300, resets_at: NOW.getTime() / 1000 + 3600 },
  }, updatedAt, NOW);
  assert.equal(limits.stale, false);
  assert.equal(limits.updatedAt, updatedAt);
});

test('Claude Desktop metadata classifies transcripts and carries its title', () => {
  const { root, statusDir, sessionId } = fixture(
    [entry('m1', 'claude-opus-5', { input_tokens: 1, output_tokens: 1 })],
    { sessionId: 'desktop-cli-id' },
  );
  const desktopSessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-desktop-sessions-'));
  const nested = path.join(desktopSessionsRoot, 'account', 'project');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(
    path.join(nested, 'local_test.json'),
    JSON.stringify({
      cliSessionId: sessionId,
      title: 'Fix the usage tray',
      lastActivityAt: NOW.getTime(),
    }),
  );

  const session = collect({ root, statusDir, desktopSessionsRoot, now: NOW }).sessions[0];
  assert.equal(session.client, 'Desktop');
  assert.equal(session.title, 'Fix the usage tray');
});

test('Desktop session links open the exact Claude or Codex session', () => {
  assert.deepEqual(
    sessionTarget({ provider: 'codex', client: 'Desktop', sessionId: 'thread-123' }),
    { uri: 'codex://threads/thread-123', exact: true },
  );
  assert.deepEqual(
    sessionTarget({
      provider: 'claude',
      client: 'Desktop',
      sessionId: 'd17faa26-c15d-4e71-b382-7ba88eac6ab9',
    }),
    { uri: 'claude://resume?session=d17faa26-c15d-4e71-b382-7ba88eac6ab9', exact: true },
  );
  assert.throws(
    () => sessionTarget({ provider: 'codex', client: 'Desktop', sessionId: '../bad' }),
    /无效/,
  );
  assert.throws(
    () => sessionTarget({ provider: 'claude', client: 'Desktop', sessionId: 'not-a-uuid' }),
    /无效/,
  );
  assert.throws(() => sessionTarget({ provider: 'claude', client: 'CLI' }), /Desktop/);
});

test('waiting hook state decays to idle after 30 minutes', () => {
  const activity = new Date(NOW.getTime() - 31 * 60 * 1000);
  const { root, statusDir, file, sessionId } = fixture(
    [entry('m1', 'claude-opus-5', { input_tokens: 1, output_tokens: 1 }, activity.toISOString())],
    { sessionId: 'stale-waiting' },
  );
  fs.utimesSync(file, activity, activity);
  fs.writeFileSync(
    path.join(statusDir, `${sessionId}.json`),
    JSON.stringify({ state: 'waiting', ts: NOW.getTime() - 30 * 60 * 1000 - 1 }),
  );

  const session = collect({ root, statusDir, now: NOW }).sessions[0];
  assert.equal(session.state, 'idle');
  assert.equal(session.fromHook, false);
});

test('hook status overrides the mtime heuristic; stale status is ignored', () => {
  const beforeHook = new Date(NOW.getTime() - 10_000);
  const { root, statusDir, file, sessionId } = fixture(
    [
      entry(
        'm1',
        'claude-opus-5',
        { input_tokens: 1, output_tokens: 1 },
        new Date(NOW.getTime() - 20_000).toISOString(),
      ),
    ],
    { sessionId: 'abc-123' },
  );
  const statusFile = path.join(statusDir, `${sessionId}.json`);
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'attention' }));
  assert.equal(collect({ root, statusDir, now: NOW }).sessions[0].fromHook, false);
  fs.utimesSync(file, beforeHook, beforeHook);
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      session_id: sessionId,
      state: 'attention',
      message: 'Claude needs your permission',
      cwd: 'C:\\fake\\my-project',
      ts: NOW.getTime() - 5000,
    }),
  );
  // stale (25h) status for some other session — must not throw or apply
  fs.writeFileSync(
    path.join(statusDir, 'other.json'),
    JSON.stringify({ state: 'working', ts: NOW.getTime() - 25 * 3600 * 1000 }),
  );
  fs.writeFileSync(path.join(statusDir, 'junk.json'), '{not json');

  const u = collect({ root, statusDir, now: NOW });
  assert.equal(u.sessions[0].state, 'attention');
  assert.equal(u.sessions[0].fromHook, true);
  assert.equal(u.sessions[0].message, 'Claude needs your permission');

  fs.appendFileSync(
    file,
    JSON.stringify(entry('m2', 'claude-opus-5', { input_tokens: 1, output_tokens: 1 })) + '\n',
  );
  fs.utimesSync(file, NOW, NOW);
  const active = collect({ root, statusDir, now: NOW }).sessions[0];
  assert.equal(active.state, 'working');
  assert.equal(active.fromHook, false);
});

test('report-status.js hook maps states, deletes on SessionEnd, survives junk', () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-hook-status-'));
  const hook = path.join(__dirname, '..', 'hooks', 'report-status.js');
  const sid = `test-hook-${process.pid}`;
  const run = (payload) =>
    spawnSync(process.execPath, [hook], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { ...process.env, CLAUDE_USAGE_TRAY_STATUS_DIR: statusDir },
      timeout: 10000,
    });

  const r1 = run({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: 'C:\\x' });
  assert.equal(r1.status, 0);
  const file = path.join(statusDir, `${sid}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'working');

  run({ session_id: sid, hook_event_name: 'Notification', notification_type: 'auth_success' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'working');

  run({
    session_id: sid,
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission',
  });
  const notification = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(notification.state, 'attention');
  assert.equal(notification.message, 'Claude needs your permission');

  run({ session_id: sid, hook_event_name: 'Stop' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'waiting');

  const r2 = run({ session_id: sid, hook_event_name: 'SessionEnd' });
  assert.equal(r2.status, 0);
  assert.equal(fs.existsSync(file), false, 'SessionEnd removes the file');

  assert.equal(run('not json at all').status, 0, 'junk input still exits 0');
  const escapeName = `cut-hook-escape-${process.pid}`;
  const escaped = path.join(statusDir, '..', `${escapeName}.json`);
  run({ session_id: `../${escapeName}`, hook_event_name: 'UserPromptSubmit' });
  assert.equal(fs.existsSync(escaped), false, 'session ids cannot escape the status directory');
  assert.equal(
    run({ session_id: sid, hook_event_name: 'PreToolUse' }).status,
    0,
    'unmapped events are ignored quietly',
  );
  assert.equal(fs.existsSync(file), false);
});

test('statusLine reporter captures official rate limits; expired windows are hidden', () => {
  const { root, statusDir } = fixture([]);
  const hook = path.join(__dirname, '..', 'hooks', 'report-rate-limits.js');
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: NOW.getTime() / 1000 + 3600 },
        seven_day: { used_percentage: 41.2, resets_at: NOW.getTime() / 1000 + 86400 },
      },
    }),
    env: { ...process.env, CLAUDE_USAGE_TRAY_STATUS_DIR: statusDir },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(collect({ root, statusDir, now: NOW }).rateLimits, {
    fiveHour: { usedPercentage: 23.5, resetsAt: NOW.getTime() / 1000 + 3600 },
    sevenDay: { usedPercentage: 41.2, resetsAt: NOW.getTime() / 1000 + 86400 },
    updatedAt: JSON.parse(fs.readFileSync(path.join(statusDir, 'rate-limits.json'))).ts,
    source: 'cli',
    stale: false,
  });

  const later = new Date(NOW.getTime() + 2 * 3600 * 1000);
  assert.equal(collect({ root, statusDir, now: later }).rateLimits.fiveHour, null);
});

test('Microsoft Store Claude Desktop data is discovered under LocalCache', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-appdata-'));
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-localappdata-'));
  const desktopRoot = path.join(
    localAppData,
    'Packages',
    'Claude_test-package',
    'LocalCache',
    'Roaming',
    'Claude',
  );
  fs.mkdirSync(desktopRoot, { recursive: true });
  fs.writeFileSync(
    path.join(desktopRoot, 'plan-usage-history.json'),
    JSON.stringify({ version: 2, samples: [{ t: NOW.getTime(), u: { fh: 12, sd: 34 } }] }),
  );

  assert.deepEqual(discoverDesktopData({ appData, localAppData }), {
    usagePath: path.join(desktopRoot, 'plan-usage-history.json'),
    sessionsRoot: path.join(desktopRoot, 'claude-code-sessions'),
  });
});

test('Desktop history is auto-detected and the freshest source wins', () => {
  const { root, statusDir } = fixture([]);
  const desktopUsagePath = path.join(statusDir, 'plan-usage-history.json');
  fs.writeFileSync(
    desktopUsagePath,
    JSON.stringify({
      version: 2,
      samples: [
        { t: NOW.getTime() - (4 * 24 * 60 + 10) * 60 * 1000, org: 'org-1', u: { fh: 20, sd: 70 } },
        { t: NOW.getTime() - (4 * 24 * 60 + 5) * 60 * 1000, org: 'org-1', u: { fh: 20, sd: 0 } },
        { t: NOW.getTime() - 4 * 24 * 60 * 60 * 1000, org: 'org-1', u: { fh: 20, sd: 1 } },
        { t: NOW.getTime() - (4 * 60 + 5) * 60 * 1000, org: 'org-1', u: { fh: 0, sd: 38 } },
        { t: NOW.getTime() - 4 * 60 * 60 * 1000, org: 'org-1', u: { fh: 2, sd: 38 } },
        { t: NOW.getTime() - 10 * 60 * 1000, org: 'other-org', u: { fh: 0, sd: 0 } },
        { t: NOW.getTime() - 9 * 60 * 1000, org: 'other-org', u: { fh: 10, sd: 10 } },
        { t: NOW.getTime() - 5 * 60 * 1000, org: 'org-1', u: { fh: 24, sd: 39 } },
      ],
    }),
  );
  assert.deepEqual(collect({ root, statusDir, desktopUsagePath, now: NOW }).rateLimits, {
    fiveHour: {
      usedPercentage: 24,
      resetsAt: (NOW.getTime() + 57.5 * 60 * 1000) / 1000,
      resetEstimated: true,
    },
    sevenDay: {
      usedPercentage: 39,
      resetsAt: (NOW.getTime() + (3 * 24 * 60 - 2.5) * 60 * 1000) / 1000,
      resetEstimated: true,
    },
    updatedAt: NOW.getTime() - 5 * 60 * 1000,
    source: 'desktop',
    stale: false,
  });

  fs.writeFileSync(
    path.join(statusDir, 'rate-limits.json'),
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 30, resets_at: NOW.getTime() / 1000 + 3600 },
      },
      ts: NOW.getTime() - 1000,
    }),
  );
  assert.equal(collect({ root, statusDir, desktopUsagePath, now: NOW }).rateLimits.source, 'cli');
});

test('priceFor matches date-suffixed and dotted ids, rejects unknown', () => {
  assert.ok(priceFor('claude-haiku-4-5-20251001'));
  assert.ok(priceFor('claude-fable-5'));
  assert.ok(priceFor('claude-opus-4.8'), 'dotted form seen in real transcripts');
  assert.ok(priceFor('anthropic/claude-opus-4.8'), 'namespaced form seen in real transcripts');
  assert.equal(priceFor('claude-opus-50'), null, 'model prefix matching stops at a hyphen boundary');
  assert.equal(priceFor('gpt-oops'), null);
});

test('floating UI crossfades states and labels inferred Desktop reset times', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'floating.html'), 'utf8');
  assert.match(html, /clip-path 400ms/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /resetEstimated/);
  assert.match(html, /重置时间为本地推算/);
  assert.doesNotMatch(html, /本地无重置时间/);
  const panel = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(panel, /\.client \{ flex: none;/);
  assert.match(panel, /<span class="name"[^>]*>\$\{esc\(label\)\}<\/span>\s*<span class="client">/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /panelWin\.on\('blur'/);
});

test('Claude OAuth uses PKCE and parses official reset timestamps', async () => {
  const authorization = createAuthorization();
  const url = new URL(authorization.url);
  assert.equal(url.origin + url.pathname, 'https://claude.com/cai/oauth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.doesNotMatch(url.searchParams.get('redirect_uri'), /localhost/);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code'), 'true');
  assert.match(url.searchParams.get('scope'), /user:profile/);
  assert.ok(authorization.verifier.length >= 43);
  assert.equal(authorization.state.length, 43);
  assert.equal(parseAuthorizationCode(`login-code#${authorization.state}`, authorization.state), 'login-code');
  assert.equal(
    parseAuthorizationCode(`https://example.test/callback?code=login-code&state=${authorization.state}`, authorization.state),
    'login-code',
  );
  assert.throws(() => parseAuthorizationCode('login-code#wrong-state', authorization.state), /无效/);

  const tokenUrls = [];
  await exchangeAuthorizationCode('login-code', authorization.verifier, authorization.state, async (requestUrl, options) => {
    tokenUrls.push(requestUrl);
    assert.equal(options.headers['User-Agent'], 'ai-code-usage-tray');
    const body = JSON.parse(options.body);
    assert.equal(body.redirect_uri, REDIRECT_URI);
    assert.equal(body.state, authorization.state);
    return tokenUrls.length === 1
      ? { ok: false, status: 429 }
      : {
          ok: true,
          json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
        };
  });
  assert.deepEqual(tokenUrls, [
    'https://platform.claude.com/v1/oauth/token',
    'https://api.anthropic.com/v1/oauth/token',
  ]);
  await assert.rejects(
    exchangeAuthorizationCode('login-code', authorization.verifier, authorization.state, async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => name === 'retry-after' ? '2' : null },
      json: async () => ({ error: { message: 'Too many requests' } }),
    })),
    (error) => error.status === 429 && error.retryAfterMs === 2000 && /Too many requests/.test(error.message),
  );

  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="account-code"/);
  assert.match(html, /window\.api\.completeClaude/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /!floatingWin \|\| floatingWin\.isDestroyed\(\)/);
  assert.match(main, /exchangeAuthorizationCode\([\s\S]*systemFetch/);
  assert.equal((main.match(/fetchClaudeOAuthUsage\(credentials\.accessToken, systemFetch\)/g) || []).length, 2);
  assert.match(main, /refreshAccessToken\(credentials\.refreshToken, systemFetch\)/);
  assert.match(main, /authorization\.retryAt = Date\.now\(\) \+ waitMs/);
  assert.doesNotMatch(main, /retryAfterMs \|\| 60_000/);
  assert.match(main, /切换网络或代理节点后重新连接/);
  assert.doesNotMatch(main, /fullscreenActive|fullscreenWatcher|startFullscreenWatcher/);
  const disconnectHandler = main.slice(
    main.indexOf("ipcMain.handle('claude-auth-disconnect'"),
    main.indexOf("ipcMain.handle('open-session'"),
  );
  assert.ok(
    disconnectHandler.indexOf('if (refreshPromise)') < disconnectHandler.indexOf('disconnectClaudeAccount()'),
    'disconnect waits for an in-flight refresh before deleting credentials',
  );

  const reset = '2026-07-27T15:30:00.000Z';
  assert.deepEqual(parseUsage({
    five_hour: { utilization: 23.5, resets_at: reset },
    seven_day: { utilization: 101, resets_at: NOW.getTime() / 1000 + 86400 },
  }, NOW.getTime()), {
    fiveHour: { usedPercentage: 23.5, resetsAt: Date.parse(reset) / 1000 },
    sevenDay: { usedPercentage: 100, resetsAt: NOW.getTime() / 1000 + 86400 },
    updatedAt: NOW.getTime(),
    source: 'oauth',
    stale: false,
  });
  assert.throws(() => parseUsage({}), /不完整/);
});

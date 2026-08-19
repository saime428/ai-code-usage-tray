'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { spawnSync } = require('child_process');
const { collectUsage, discoverDesktopData, priceFor } = require('./usage');
const {
  collectCodexUsage,
  costOf: codexCostOf,
  readRateLimits: readCodexRateLimits,
} = require('./codex-usage');
const { sessionTarget } = require('./open-session');
const { rangeBounds } = require('./range');
const { readJsonLinesSync } = require('./jsonl');
const { detectClaudeIdentity, detectCodexIdentity } = require('./account-identity');
const { createLedger, validateLedger, observeProvider, summarizeAccounts } = require('./account-ledger');
const { collectLocalUsage } = require('./usage-worker');
const { extractLatestConversation, desktopConversationSession } = require('./claude-desktop-cache');
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
const NO_DESKTOP_AGENT_SESSIONS = path.join(os.tmpdir(), `cut-no-agent-sessions-${process.pid}`);
const collect = (options) =>
  collectUsage({
    desktopUsagePath: NO_DESKTOP_USAGE,
    desktopSessionsRoot: NO_DESKTOP_SESSIONS,
    desktopAgentSessionsRoot: NO_DESKTOP_AGENT_SESSIONS,
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

test('Codex sessions use indexed titles and event timestamps for activity', () => {
  const old = new Date(NOW.getTime() - 5 * 60 * 1000);
  const root = codexFixture([
    {
      type: 'session_meta',
      timestamp: old.toISOString(),
      payload: {
        id: 'codex-titled',
        cwd: 'C:\\Users\\admin\\Documents\\Codex\\generated-folder',
        originator: 'Codex Desktop',
      },
    },
    { type: 'event_msg', timestamp: iso, payload: { type: 'agent_message' } },
  ]);
  fs.utimesSync(path.join(root, '2026', '07', '26', 'rollout-test.jsonl'), old, old);
  const sessionIndexPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cut-codex-index-')),
    'session_index.jsonl',
  );
  fs.writeFileSync(
    sessionIndexPath,
    JSON.stringify({ id: 'codex-titled', thread_name: '解释对话状态颜色', updated_at: iso }) + '\n',
  );

  const session = collectCodexUsage({ root, sessionIndexPath, now: NOW }).sessions[0];
  assert.equal(session.project, 'generated-folder');
  assert.equal(session.title, '解释对话状态颜色');
  assert.equal(session.mtime, NOW.getTime());
  assert.equal(session.state, 'working');
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

test('Claude Desktop cache recognizes the latest normal chat without inventing token usage', () => {
  const older = {
    state: {
      data: {
        uuid: '11111111-1111-4111-8111-111111111111',
        name: 'Older chat',
        model: 'claude-sonnet-5',
        created_at: '2026-07-26T09:00:00.000Z',
        updated_at: '2026-07-26T09:10:00.000Z',
        chat_messages: [{ sender: 'human' }, { sender: 'assistant' }],
      },
    },
  };
  const newer = {
    state: {
      data: {
        uuid: '22222222-2222-4222-8222-222222222222',
        name: 'Current Desktop chat',
        model: 'claude-opus-5',
        created_at: '2026-07-26T11:55:00.000Z',
        updated_at: '2026-07-26T11:59:00.000Z',
        chat_messages: [{ sender: 'human' }, { sender: 'assistant' }, { sender: 'assistant' }],
      },
    },
  };

  const conversation = extractLatestConversation([older, newer]);
  assert.equal(conversation.sessionId, newer.state.data.uuid);
  assert.equal(conversation.title, 'Current Desktop chat');
  assert.equal(conversation.model, 'claude-opus-5');
  assert.equal(conversation.messageCount, 3);
  assert.equal(conversation.assistantMessages, 2);
  const session = desktopConversationSession(conversation, Date.parse('2026-07-26T12:00:00.000Z'));
  assert.equal(session.client, 'Desktop Chat');
  assert.equal(session.state, 'working');
  assert.equal(session.source, 'desktop-cache');
});

test('Claude local-agent sessions read nested transcripts and carry Desktop metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-agent-root-'));
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-agent-status-'));
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-agent-sessions-'));
  const sessionDir = path.join(agentRoot, 'account', 'org', 'local_agent-1');
  const projectDir = path.join(sessionDir, '.claude', 'projects', 'C--web-fx-lab');
  fs.mkdirSync(projectDir, { recursive: true });
  const cliSessionId = 'agent-cli-1';
  const transcript = path.join(projectDir, `${cliSessionId}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify(entry('agent-msg', 'claude-fable-5', { input_tokens: 100, output_tokens: 20 })) + '\n');
  fs.utimesSync(transcript, NOW, NOW);
  fs.writeFileSync(
    path.join(agentRoot, 'account', 'org', 'local_agent-1.json'),
    JSON.stringify({ cliSessionId, title: 'Cowork session', cwd: 'C:\fake\cowork', lastActivityAt: NOW.getTime() }),
  );

  const u = collect({ root, statusDir, desktopAgentSessionsRoot: agentRoot, now: NOW });
  assert.equal(u.sessions.length, 1);
  assert.equal(u.sessions[0].client, 'Desktop');
  assert.equal(u.sessions[0].title, 'Cowork session');
  assert.equal(u.totals.output, 20);
  assert.ok(u.costUSD > 0);
  assert.equal(u.costCoverage, 'complete');
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
      sessionId: 'local_test',
      cliSessionId: sessionId,
      title: 'Fix the usage tray',
      lastActivityAt: NOW.getTime(),
    }),
  );
  fs.writeFileSync(
    path.join(nested, 'local_duplicate.json'),
    JSON.stringify({
      sessionId: 'local_d17faa26-c15d-4e71-b382-7ba88eac6ab9',
      cliSessionId: sessionId,
      title: null,
      lastActivityAt: NOW.getTime() + 1000,
    }),
  );

  const session = collect({ root, statusDir, desktopSessionsRoot, now: NOW }).sessions[0];
  assert.equal(session.client, 'Desktop');
  assert.equal(session.sessionId, 'local_test');
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
      sessionId: 'local_d17faa26-c15d-4e71-b382-7ba88eac6ab9',
    }),
    { uri: 'claude://code/local_d17faa26-c15d-4e71-b382-7ba88eac6ab9', exact: true },
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

test('legacy waiting hook state is treated as idle', () => {
  const activity = new Date(NOW.getTime() - 10_000);
  const { root, statusDir, file, sessionId } = fixture(
    [entry('m1', 'claude-opus-5', { input_tokens: 1, output_tokens: 1 }, activity.toISOString())],
    { sessionId: 'legacy-waiting' },
  );
  fs.utimesSync(file, activity, activity);
  fs.writeFileSync(
    path.join(statusDir, `${sessionId}.json`),
    JSON.stringify({ state: 'waiting', ts: NOW.getTime() - 5000 }),
  );

  const session = collect({ root, statusDir, now: NOW }).sessions[0];
  assert.equal(session.state, 'idle');
  assert.equal(session.fromHook, true);
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
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'idle');
  run({ session_id: sid, hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'idle');

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
    agentSessionsRoot: path.join(desktopRoot, 'local-agent-mode-sessions'),
  });
});

test('Desktop-only quota data does not pretend the cost is zero', () => {
  const { root, statusDir } = fixture([]);
  const desktopUsagePath = path.join(statusDir, 'desktop-only-plan.json');
  fs.writeFileSync(
    desktopUsagePath,
    JSON.stringify({ version: 2, samples: [{ t: NOW.getTime(), u: { fh: 45, sd: 5 } }] }),
  );

  const u = collect({ root, statusDir, desktopUsagePath, now: NOW });
  assert.equal(u.costUSD, 0);
  assert.equal(u.costCoverage, 'unavailable');
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

test('stale Desktop history does not expose old percentages as current', () => {
  const { root, statusDir } = fixture([]);
  const desktopUsagePath = path.join(statusDir, 'plan-usage-history.json');
  const updatedAt = NOW.getTime() - 16 * 60 * 1000;
  fs.writeFileSync(
    desktopUsagePath,
    JSON.stringify({ version: 2, samples: [{ t: updatedAt, u: { fh: 25, sd: 40 } }] }),
  );

  assert.deepEqual(collect({ root, statusDir, desktopUsagePath, now: NOW }).rateLimits, {
    fiveHour: null,
    sevenDay: null,
    updatedAt,
    source: 'desktop',
    stale: true,
  });
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
  assert.match(html, /sevenDayFable/);
  assert.match(html, /expanded\.position-right #surface \{ height: 364px; \}/);
  assert.match(html, /重置时间为本地推算/);
  assert.doesNotMatch(html, /本地无重置时间/);
  const panel = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(panel, /\.client \{ flex: none;/);
  assert.match(panel, /<span class="name"[^>]*>\$\{esc\(label\)\}<\/span>\s*<span class="client">/);
  assert.match(panel, /window\.api\.closePanel\(\)/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /closePanel: \(\) => ipcRenderer\.send\('close-panel'\)/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /panelWin\.on\('blur'/);
  assert.match(main, /ipcMain\.on\('close-panel'/);
});

test('full panel closes only after the pointer leaves the window', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const start = script.indexOf("window.addEventListener('mouseover'");
  const end = script.indexOf('window.api.onUsage', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const listeners = {};
  const timers = [];
  const cleared = [];
  let closed = 0;
  const window = {
    addEventListener(type, listener) { listeners[type] = listener; },
    api: { closePanel() { closed += 1; } },
  };
  const setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  };
  const clearTimeout = (timer) => cleared.push(timer);
  vm.runInNewContext(`let closeTimer = null;\n${script.slice(start, end)}`, {
    window, setTimeout, clearTimeout,
  });

  listeners.mouseout({ relatedTarget: {} });
  assert.equal(timers.length, 0);
  listeners.mouseout({ relatedTarget: null });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 300);
  listeners.mouseover();
  assert.equal(cleared.at(-1), timers[0]);
  timers[0].callback();
  assert.equal(closed, 1);
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
  assert.match(html, /sevenDayFable/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /!floatingWin \|\| floatingWin\.isDestroyed\(\)/);
  assert.match(main, /exchangeAuthorizationCode\([\s\S]*systemFetch/);
  assert.equal((main.match(/fetchClaudeOAuthUsage\(credentials\.accessToken, systemFetch\)/g) || []).length, 2);
  assert.match(main, /refreshAccessToken\(credentials\.refreshToken, systemFetch\)/);
  assert.match(main, /authorization\.retryAt = Date\.now\(\) \+ waitMs/);
  assert.doesNotMatch(main, /retryAfterMs \|\| 60_000/);
  assert.match(main, /切换网络或代理节点后重新连接/);
  assert.match(main, /windowText\('Fable', claudeWindows && claudeWindows\.sevenDayFable\)/);
  assert.match(main, /right: \{ collapsed: \[58, 246\], expanded: \[326, 368\] \}/);
  assert.doesNotMatch(main, /powershell\.exe|FullscreenProbe|fullscreenActive|fullscreenWatcher|startFullscreenWatcher/);
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
    limits: [
      {
        kind: 'weekly_scoped',
        scope: { model: { display_name: 'Opus' } },
        percent: 99,
        resets_at: NOW.getTime() / 1000 + 86400,
      },
      {
        kind: 'weekly_scoped',
        scope: { model: { display_name: 'Fable' } },
        percent: 42,
        resets_at: NOW.getTime() / 1000 + 172800,
      },
    ],
  }, NOW.getTime()), {
    fiveHour: { usedPercentage: 23.5, resetsAt: Date.parse(reset) / 1000 },
    sevenDay: { usedPercentage: 100, resetsAt: NOW.getTime() / 1000 + 86400 },
    sevenDayFable: { usedPercentage: 42, resetsAt: NOW.getTime() / 1000 + 172800 },
    updatedAt: NOW.getTime(),
    source: 'oauth',
    stale: false,
  });
  assert.equal(parseUsage({ five_hour: { utilization: 1 } }).sevenDayFable, null);
  assert.throws(() => parseUsage({}), /不完整/);
});

test('custom range includes local calendar days and reuses unchanged Claude files', () => {
  const tenDaysAgo = new Date('2026-07-17T08:00:00').toISOString();
  const outside = new Date('2026-07-16T23:59:59').toISOString();
  const { root, statusDir } = fixture([
    entry('inside', 'claude-opus-5', { input_tokens: 10, output_tokens: 2 }, tenDaysAgo),
    entry('outside', 'claude-opus-5', { input_tokens: 999, output_tokens: 999 }, outside),
  ]);
  const cache = new Map();
  const cold = {};
  const warm = {};
  const usage = collect({ root, statusDir, now: NOW, rangeDays: 10, cache, diagnostics: cold });
  assert.equal(usage.rangeDays, 10);
  assert.equal(usage.rangeStart, new Date('2026-07-17T00:00:00').getTime());
  assert.equal(usage.totals.input, 10);
  assert.equal(usage.daily['2026-07-17'].byModel['claude-opus-5'].output, 2);
  collect({ root, statusDir, now: NOW, rangeDays: 10, cache, diagnostics: warm });
  assert.equal(cold.parsedFiles, 1);
  assert.equal(warm.reusedFiles, 1);
  assert.throws(() => rangeBounds(NOW, 0), /1 to 90/);
  assert.throws(() => rangeBounds(NOW, 91), /1 to 90/);
});

test('streamed JSONL preserves split UTF-8 and a final line without newline', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cut-jsonl-')), 'split.jsonl');
  const first = 'a'.repeat(1024 * 1024 - 1) + '界';
  fs.writeFileSync(file, `${first}\nlast`);
  const lines = [];
  readJsonLinesSync(file, (line, lineNumber) => lines.push([line, lineNumber]));
  assert.deepEqual(lines, [[first, 0], ['last', 1]]);
});

test('Codex custom range keeps historical deltas and current-day default unchanged', () => {
  const tokenEvent = (timestamp, input, output) => ({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: input, output_tokens: output } },
    },
  });
  const root = codexFixture([
    { type: 'session_meta', timestamp: yesterdayIso, payload: { id: 'range-codex', cwd: 'C:\\range' } },
    { type: 'turn_context', timestamp: yesterdayIso, payload: { model: 'gpt-5.6-sol', turn_id: 'turn-y' } },
    tokenEvent(yesterdayIso, 20, 5),
  ]);
  assert.equal(collectCodexUsage({ root, archivedRoot: null, now: NOW }).totals.input, 0);
  const usage = collectCodexUsage({ root, archivedRoot: null, now: NOW, rangeDays: 2 });
  assert.equal(usage.totals.input, 20);
  assert.equal(usage.totals.output, 5);
  assert.equal(usage.totals.requests, 1);
});

test('identity detection returns stable hashes without exposing credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-identity-'));
  const claudePath = path.join(root, 'claude.json');
  const codexPath = path.join(root, 'codex.json');
  const codexConfigPath = path.join(root, 'config.toml');
  fs.writeFileSync(claudePath, JSON.stringify({
    organizationUuid: 'org-secret-value',
    claudeAiOauth: { refreshToken: 'claude-refresh-secret', subscriptionType: 'pro' },
  }));
  fs.writeFileSync(codexPath, JSON.stringify({ OPENAI_API_KEY: 'codex-api-secret', auth_mode: 'apikey' }));
  fs.writeFileSync(codexConfigPath, [
    'model_provider = "proxy"',
    '',
    '[model_providers.proxy]',
    'name = "Example Proxy"',
    'base_url = "https://gateway.example.com/v1"',
  ].join('\n'));
  const claude = detectClaudeIdentity(claudePath);
  const codex = detectCodexIdentity(codexPath, codexConfigPath);
  const serialized = JSON.stringify({ claude, codex });
  assert.match(claude.id, /^claude:[a-f0-9]{64}$/);
  assert.match(codex.id, /^codex:[a-f0-9]{64}$/);
  assert.equal(codex.authMode, 'apikey');
  assert.equal(codex.label, 'Codex gateway.example.com');
  assert.doesNotMatch(serialized, /org-secret|refresh-secret|api-secret/);
});

test('Codex ChatGPT subscriptions use the account id and show the email label', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-codex-account-'));
  const codexPath = path.join(root, 'auth.json');
  const payload = Buffer.from(JSON.stringify({
    email: 'person@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-secret-value',
      chatgpt_plan_type: 'plus',
    },
  })).toString('base64url');
  fs.writeFileSync(codexPath, JSON.stringify({
    tokens: {
      account_id: 'account-secret-value',
      id_token: `header.${payload}.signature`,
    },
  }));

  const account = detectCodexIdentity(codexPath);
  assert.match(account.id, /^codex:[a-f0-9]{64}$/);
  assert.equal(account.source, 'account');
  assert.equal(account.authMode, 'chatgpt');
  assert.equal(account.label, 'Codex Plus person@example.com');
  assert.doesNotMatch(JSON.stringify(account), /account-secret-value/);
});

test('prospective ledger skips old totals and sends long-gap deltas to unknown', () => {
  const start = NOW.getTime();
  const account = { id: 'claude:a', provider: 'claude', source: 'organization', label: 'Claude #a' };
  const ledger = createLedger(start);
  const usage = (input) => ({ 'claude-opus-5': { input, output: 10, cacheRead: 5, cacheWrite: 2, requests: 1 } });
  observeProvider(ledger, 'claude', account, usage(100), start);
  assert.deepEqual(summarizeAccounts(ledger, 'claude', 1, NOW).items, []);
  observeProvider(ledger, 'claude', account, usage(150), start + 30_000);
  observeProvider(ledger, 'claude', account, usage(170), start + 5 * 60_000);
  const summary = summarizeAccounts(ledger, 'claude', 1, new Date(start + 5 * 60_000));
  assert.equal(summary.items.find((item) => item.id === account.id).totalTokens, 50);
  assert.equal(summary.items.find((item) => item.id === 'claude:unknown').totalTokens, 20);
  assert.throws(() => validateLedger({ ...ledger, accounts: [] }), /格式无效/);
  assert.throws(() => validateLedger({ ...ledger, days: { invalid: {} } }), /格式无效/);
});

test('prospective ledger keeps switches, resets, and missing identities conservative', () => {
  const start = NOW.getTime();
  const accountA = { id: 'codex:a', provider: 'codex', source: 'credential', label: 'Codex #a' };
  const accountB = { id: 'codex:b', provider: 'codex', source: 'credential', label: 'Codex #b' };
  const usage = (input) => ({ 'gpt-5.6-sol': { input, output: 0, requests: 1 } });
  const ledger = createLedger(start);

  observeProvider(ledger, 'codex', accountA, usage(100), start);
  observeProvider(ledger, 'codex', accountA, usage(150), start + 30_000);
  observeProvider(ledger, 'codex', accountB, usage(170), start + 60_000);
  observeProvider(ledger, 'codex', accountB, usage(180), start + 90_000);
  observeProvider(ledger, 'codex', accountB, usage(180), start + 100_000);
  observeProvider(ledger, 'codex', accountB, usage(50), start + 120_000);
  observeProvider(ledger, 'codex', accountB, usage(70), start + 150_000);
  observeProvider(ledger, 'codex', null, usage(80), start + 180_000);

  const items = summarizeAccounts(ledger, 'codex', 1, new Date(start + 180_000)).items;
  assert.equal(items.find((item) => item.id === accountA.id).totalTokens, 50);
  assert.equal(items.find((item) => item.id === accountB.id).totalTokens, 30);
  assert.equal(items.find((item) => item.id === 'codex:unknown').totalTokens, 30);
});

test('usage worker shares cache and returns both provider ranges', () => {
  const { root, statusDir } = fixture([
    entry('worker', 'claude-opus-5', { input_tokens: 12, output_tokens: 3 }),
  ]);
  const codexRoot = codexFixture([]);
  const caches = { claude: new Map(), codex: new Map() };
  const options = {
    claude: {
      root,
      statusDir,
      desktopUsagePath: NO_DESKTOP_USAGE,
      desktopSessionsRoot: NO_DESKTOP_SESSIONS,
      desktopAgentSessionsRoot: NO_DESKTOP_AGENT_SESSIONS,
    },
    codex: { root: codexRoot, archivedRoot: null, sessionIndexPath: null },
  };
  const cold = collectLocalUsage({ ranges: { claude: 10, codex: 2 }, now: NOW, caches, options });
  const warm = collectLocalUsage({ ranges: { claude: 10, codex: 2 }, now: NOW, caches, options });
  assert.equal(cold.claude.totals.input, 12);
  assert.equal(cold.claude.rangeDays, 10);
  assert.equal(cold.codex.rangeDays, 2);
  assert.ok(warm.diagnostics.claude.reusedFiles >= 1);
});

test('floating renderer prefers quota, otherwise renders provider-aware range tokens', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'floating.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  const classList = { toggle() {} };
  const element = () => ({ innerHTML: '', addEventListener() {}, classList });
  const document = {
    body: { classList },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  };
  let publish;
  const window = {
    matchMedia: () => ({ matches: false }),
    api: {
      onUsage(callback) { publish = callback; },
      getUsage: () => ({ then() {} }),
      getFloatingState: () => ({ then() {} }),
      onFloatingState() {},
      setFloatingExpanded() {},
      openPanel() {},
    },
  };
  vm.runInNewContext(script, { window, document, setTimeout, clearTimeout, Date });
  const provider = (totals) => ({
    totals,
    rangeDays: 10,
    rateLimits: null,
    costUSD: 0,
    costCoverage: 'complete',
    sessions: [],
    dataStatus: { state: 'ok' },
  });
  publish({
    claude: provider({ input: 1000, output: 100, cacheRead: 400, cacheWrite: 50 }),
    codex: provider({ input: 1000, output: 100, cacheRead: 400, reasoning: 50 }),
  });
  assert.match(elements.get('compact').innerHTML, /10d<\/b>1\.6K/);
  assert.match(elements.get('compact').innerHTML, /10d<\/b>1\.1K/);
  assert.match(elements.get('details').innerHTML, /输入 1\.4K · 输出 100/);
  assert.doesNotMatch(elements.get('details').innerHTML, /provider-status bad/);

  const quotaClaude = provider({ input: 1000, output: 100 });
  quotaClaude.rateLimits = { fiveHour: { usedPercentage: 25 } };
  publish({ claude: quotaClaude, codex: provider({}) });
  assert.match(elements.get('details').innerHTML, /25% 已用/);
  assert.match(elements.get('details').innerHTML, /额度 —/);

  const apiCodex = provider({ input: 1000, output: 100, reasoning: 50 });
  apiCodex.authMode = 'apikey';
  apiCodex.rateLimits = { windows: [{ windowMinutes: 300, usedPercentage: 67 }] };
  publish({ claude: provider({}), codex: apiCodex });
  assert.match(elements.get('compact').innerHTML, /10d<\/b>1\.1K/);
  assert.match(elements.get('details').innerHTML, /输入 1\.0K · 输出 100/);
  assert.doesNotMatch(elements.get('details').innerHTML, /67%/);
});

test('main and preload keep range and ledger operations narrowly scoped', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'usage-ledger-v1\.bin'\)/);
  assert.match(main, /safeStorage\.encryptString\(JSON\.stringify\(accountLedger\)\)/);
  assert.match(main, /ipcMain\.handle\('usage-range'/);
  assert.match(main, /ipcMain\.handle\('account-ledger-clear'/);
  assert.match(main, /fallback\.rateLimits = previous\.rateLimits \|\| null/);
  assert.match(main, /fallback\.sessions = previous\.sessions \|\| \[\]/);
  assert.match(main, /settings\[`\$\{provider\}RangeDays`\] = rangeDays/);
  assert.match(main, /claudeRangeDays = normalizeRangeDays\(saved\.claudeRangeDays, legacyRangeDays\)/);
  assert.match(main, /codexRangeDays = normalizeRangeDays\(saved\.codexRangeDays, legacyRangeDays\)/);
  assert.match(preload, /setUsageRange: \(provider, rangeDays\) => ipcRenderer\.invoke\('usage-range', provider, rangeDays\)/);
  assert.match(panel, /const provider = selected/);
  assert.match(panel, /rangeDays === latest\[provider\]\.rangeDays/);
  assert.match(panel, /setUsageRange\(provider, rangeDays\)/);
  assert.match(preload, /clearAccountLedger: \(\) => ipcRenderer\.invoke\('account-ledger-clear'\)/);
  assert.deepEqual(packageJson.build.asarUnpack, ['lib/**/*']);

  const loadLedger = main.slice(main.indexOf('function loadAccountLedger()'), main.indexOf('function flushAccountLedger()'));
  const clearLedger = main.slice(main.indexOf('function clearAccountLedger()'), main.indexOf('function rejectWorkerRequests('));
  assert.match(loadLedger, /accountLedger = null/);
  assert.doesNotMatch(loadLedger, /unlinkSync|writeFileSync|renameSync/);
  assert.match(clearLedger, /fs\.unlinkSync\(file\)/);
  assert.doesNotMatch(clearLedger, /DEFAULT_ROOT|DEFAULT_CODEX_ROOT/);
  assert.match(main, /if \(!quitting\) rejectWorkerRequests\(new Error\(`本地用量 Worker 已退出/);
});

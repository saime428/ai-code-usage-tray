'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { spawnSync } = require('child_process');
const { collectUsage, discoverDesktopData, priceFor, costOf } = require('./usage');
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
const { BUNDLED: BUNDLED_PRICES, validatePrices, acceptPrices } = require('./prices');
const { savedPick, shownProviders, toggledPick } = require('./floating-providers');
const { createAntigravityQuota, parseQuota, csrfOf, groupLabel, request: antigravityRequest } = require('./antigravity-quota');
const {
  startActivityWatch,
  providerStates,
  hasFreshWrite,
  SOURCES: ACTIVITY_SOURCES,
  antigravityTurnOpen,
  OPEN_TURN_MS,
  WRITE_ACTIVE_MS,
  HOOK_WORKING_MS,
} = require('./activity');
const { extractLatestConversation, desktopConversationSession } = require('./claude-desktop-cache');
const {
  createAuthorization,
  parseAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  parseUsage,
  nextUsageAttemptAt,
  usageThrottled,
  MAX_RETRY_AFTER_MS,
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
// Keeps worker tests off this machine's real Antigravity and OpenCode data.
const NO_NEW_TOOLS = {
  antigravity: { home: path.join(os.tmpdir(), `cut-no-antigravity-${process.pid}`) },
  opencode: { dbPath: path.join(os.tmpdir(), `cut-no-opencode-${process.pid}.db`) },
};
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
    entry('geo', 'claude-sonnet-5', {
      input_tokens: 1000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      inference_geo: 'us',
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
  // 1000 input on Sonnet 5 is $0.002; US-only inference makes it $0.0022.
  assert.ok(
    Math.abs(u.byModel['claude-sonnet-5'].costUSD - 0.0022) < 1e-12,
    `inference_geo read from transcript: got ${u.byModel['claude-sonnet-5'].costUSD}`,
  );
  assert.ok(Math.abs(u.costUSD - 0.0272) < 1e-12);
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
  assert.ok(Math.abs(u.costUSD - 0.00058) < 1e-12, `got ${u.costUSD}`);
  assert.equal(
    codexCostOf('gpt-5.6-sol', {
      input: 300000,
      output: 10000,
      cacheRead: 100000,
      cacheWrite: 0,
    }),
    1.98,
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

test('Codex subagents skip the history copied in at creation and stay under the parent session', () => {
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
  // The copied parent lines carry the child's creation time (iso); its own work comes
  // seconds later, as a model call takes, and its counter continues the copied total.
  const later = (ms) => new Date(NOW.getTime() + ms).toISOString();
  const childToken = tokenEvent(later(5000), usage(300, 30, 180, 3), usage(200, 20, 120, 2));
  const repeatedChildToken = { ...childToken, timestamp: later(5001) };
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
        timestamp: later(1500),
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

test('a Desktop conversation continued in new transcripts is one Desktop session', () => {
  const { root, statusDir, proj } = fixture(
    [entry('m1', 'claude-opus-5', { input_tokens: 1, output_tokens: 1 })],
    { sessionId: 'first-part' },
  );
  const current = path.join(proj, 'current-part.jsonl');
  const continued = { type: 'user', timestamp: iso, message: { role: 'user', content: 'This session is being continued from a previous conversation' } };
  fs.writeFileSync(current, [continued, entry('m2', 'claude-opus-5', { input_tokens: 2, output_tokens: 2 })].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(current, NOW, NOW);
  const desktopSessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-desktop-sessions-'));
  fs.writeFileSync(
    path.join(desktopSessionsRoot, 'local_conv.json'),
    JSON.stringify({
      sessionId: 'local_conv',
      cliSessionId: 'current-part',
      priorCliSessionIds: ['first-part', 7, 'current-part'],
      title: 'Review TokenMe',
      lastActivityAt: NOW.getTime(),
    }),
  );
  const usage = collect({ root, statusDir, desktopSessionsRoot, now: NOW });
  assert.deepEqual(usage.sessions.map((s) => [s.sessionId, s.client, s.file]), [['local_conv', 'Desktop', 'current-part.jsonl']]);
  assert.equal(usage.sessions[0].title, 'Review TokenMe', "Desktop's title, not the continuation summary");
  assert.equal(usage.sessionMeta.get('current-part').title, 'Review TokenMe', 'the report names it the same way');
  assert.deepEqual([...new Set(usage.rows.map((row) => row.session))], ['current-part'], 'both parts bill to the conversation');
  assert.equal(usage.totals.output, 3);
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
  // The bar measures itself (see the floating renderer test); no fixed surface size left over.
  assert.doesNotMatch(html, /#surface \{[^}]*height: \d+px/);
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
  // 额度查询的下次尝试时间:成功失败都至少隔 5 分钟;响应带 Retry-After 时照它等,
  // 但封顶 1 小时,异常的响应头不能让刷新一直停着。
  assert.equal(nextUsageAttemptAt(0), 300_000);
  assert.equal(nextUsageAttemptAt(0, { status: 429 }), 300_000);
  assert.equal(nextUsageAttemptAt(0, { status: 429, retryAfterMs: 2_000 }), 300_000);
  assert.equal(nextUsageAttemptAt(1_000, { status: 503, retryAfterMs: 1_800_000 }), 1_801_000);
  // 封顶只防荒谬值:封 1 小时时服务端要求等更久就会每小时主动撞一次,限流永远续着
  assert.equal(MAX_RETRY_AFTER_MS, 86_400_000);
  assert.equal(nextUsageAttemptAt(0, { status: 429, retryAfterMs: 7_200_000 }), 7_200_000);
  assert.equal(nextUsageAttemptAt(0, { status: 429, retryAfterMs: 1e12 }), 86_400_000);
  // Retry-After 解析不出来时 httpError 会把字段设成 null
  assert.equal(nextUsageAttemptAt(0, { status: 429, retryAfterMs: null }), 300_000);
  // 等待期内才节流;系统时间被往回调会让剩余时间超过封顶,当成已过期,不会卡死
  assert.equal(usageThrottled(1_000, 0), false, 'past deadline');
  assert.equal(usageThrottled(0, 0), false, 'no deadline');
  assert.equal(usageThrottled(0, 60_000), true, 'inside the wait');
  assert.equal(usageThrottled(0, MAX_RETRY_AFTER_MS + 1), false, 'clock moved back');
  // 刷新令牌本身失效(2026-09-16 实测:服务端 400 "Refresh token expired")只能重新登录:
  // 标记 loginExpired,自动重试直接等到封顶,别再每 5 分钟撞两次接口。5xx 不算,那是暂时的。
  const tokenResponse = (status, payload) => async () => ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => payload,
  });
  await assert.rejects(
    refreshAccessToken('dead-refresh-token', tokenResponse(400, { error: 'invalid_grant', error_description: 'Refresh token expired' })),
    (error) => error.status === 400 && error.loginExpired === true && /Refresh token expired/.test(error.message),
  );
  await assert.rejects(
    refreshAccessToken('refresh-token', tokenResponse(503, {})),
    (error) => error.status === 503 && error.loginExpired === undefined,
  );
  assert.equal(nextUsageAttemptAt(0, { status: 400, loginExpired: true }), MAX_RETRY_AFTER_MS);

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
  // 节流看「下次允许尝试时间」:成功和失败后都要重新定时,不能每 30 秒刷新都去请求;
  // 用墙上时钟并写到磁盘,冷启动也遵守服务端的 Retry-After——"重启试试"不能再撞一次限流。
  assert.match(main, /!force && usageThrottled\(Date\.now\(\), claudeOAuthNextAttemptAt\)/);
  assert.match(main, /claudeOAuthNextAttemptAt = nextUsageAttemptAt\(Date\.now\(\)\);/);
  assert.match(main, /claudeOAuthNextAttemptAt = nextUsageAttemptAt\(Date\.now\(\), error\)/);
  assert.match(main, /claudeOAuthNextAttemptAt = readClaudeOAuthThrottle\(\)/);
  assert.match(main, /'claude-oauth-throttle\.json'/);
  // 状态码分不清"令牌过期"和"请求有问题",服务端的错误说明也要记下来
  assert.match(main, /lastError: error\.message/);
  // 刷新令牌失效时,面板要说"登录已过期"而不是登录码阶段的"授权码无效"
  assert.match(main, /error\.loginExpired\) return 'Claude 登录已过期，请断开后重新连接'/);
  assert.match(main, /切换网络或代理节点后重新连接/);
  assert.match(main, /windowText\('Fable', claudeWindows && claudeWindows\.sevenDayFable\)/);
  assert.match(main, /right: \{ collapsed: \[58, 324\], expanded: \[326, 480\] \}/);
  // 全屏探测只能住在 lib/fullscreen-watch.js,main.js 不得内嵌 PowerShell
  assert.doesNotMatch(main, /powershell\.exe|FullscreenProbe|Add-Type/);
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

test('streamed JSONL preserves split UTF-8 and holds back a final line still being written', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cut-jsonl-')), 'split.jsonl');
  const first = 'a'.repeat(1024 * 1024 - 1) + '界';
  fs.writeFileSync(file, `${first}\n{"torn":`);
  const lines = [];
  const end = readJsonLinesSync(file, (line, lineNumber, offset) => lines.push([line, lineNumber, offset]));
  assert.deepEqual(lines, [[first, 0, 0]]);
  assert.equal(end, Buffer.byteLength(first) + 1, 'the next read starts at the torn line');
  // A final line that is already complete JSON is taken even without its newline.
  fs.writeFileSync(file, `${first}\n{"done":1}`);
  lines.length = 0;
  assert.equal(readJsonLinesSync(file, (line) => lines.push(line)), fs.statSync(file).size);
  assert.deepEqual(lines, [first, '{"done":1}']);
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
  const caches = { claude: new Map(), codex: new Map(), grok: new Map() };
  const options = {
    claude: {
      root,
      statusDir,
      desktopUsagePath: NO_DESKTOP_USAGE,
      desktopSessionsRoot: NO_DESKTOP_SESSIONS,
      desktopAgentSessionsRoot: NO_DESKTOP_AGENT_SESSIONS,
    },
    codex: { root: codexRoot, archivedRoot: null, sessionIndexPath: null },
    grok: { root: fs.mkdtempSync(path.join(os.tmpdir(), 'cut-grok-empty-')) },
    ...NO_NEW_TOOLS,
  };
  const cold = collectLocalUsage({ ranges: { claude: 10, codex: 2, grok: 3 }, now: NOW, caches, options });
  const warm = collectLocalUsage({ ranges: { claude: 10, codex: 2, grok: 3 }, now: NOW, caches, options });
  assert.equal(cold.claude.totals.input, 12);
  assert.equal(cold.claude.rangeDays, 10);
  assert.equal(cold.codex.rangeDays, 2);
  assert.equal(cold.grok.rangeDays, 3);
  assert.deepEqual(cold.grok.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 });
  assert.ok(warm.diagnostics.claude.reusedFiles >= 1);
});

test('a downloaded price table reaches both providers and re-prices cached Codex files', () => {
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: got ${actual}, want ${expected}`);
  const { root, statusDir } = fixture([entry('priced', 'claude-opus-5', { input_tokens: 1e5, output_tokens: 0 })]);
  const codexRoot = codexFixture([
    { type: 'session_meta', timestamp: iso, payload: { id: 'codex-priced', cwd: 'C:\\fake\\codex' } },
    { type: 'turn_context', timestamp: iso, payload: { turn_id: 't1', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: iso,
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1e5, output_tokens: 0 } } },
    },
  ]);
  const caches = { claude: new Map(), codex: new Map(), grok: new Map() };
  const options = {
    claude: {
      root,
      statusDir,
      desktopUsagePath: NO_DESKTOP_USAGE,
      desktopSessionsRoot: NO_DESKTOP_SESSIONS,
      desktopAgentSessionsRoot: NO_DESKTOP_AGENT_SESSIONS,
    },
    codex: { root: codexRoot, archivedRoot: null, sessionIndexPath: null },
    grok: { root: fs.mkdtempSync(path.join(os.tmpdir(), 'cut-grok-empty-')) },
    ...NO_NEW_TOOLS,
  };
  const doubled = structuredClone(BUNDLED_PRICES);
  doubled.snapshot = '2099-01-01';
  doubled.claude['claude-opus-5'].input *= 2;
  doubled.codex['gpt-6-sol'].input *= 2;
  const run = (prices) => collectLocalUsage({ ranges: { claude: 1, codex: 1, grok: 1 }, now: NOW, prices, caches, options });

  const bundled = run(undefined);
  const downloaded = run(doubled);
  near(bundled.claude.costUSD, 0.5, 'claude, bundled table');
  near(downloaded.claude.costUSD, 1, 'claude, downloaded table');
  near(bundled.codex.costUSD, 0.2, 'codex, bundled table');
  // Codex caches parsed files with their cost already in them.
  near(downloaded.codex.costUSD, 0.4, 'codex file cached under the old table is re-priced');
  assert.equal(downloaded.claude.priceSnapshot, '2099-01-01');
  assert.equal(downloaded.codex.priceSnapshot, '2099-01-01');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('postMessage({ id, ranges, now, prices })'), 'main hands the table in use to the worker');
});

test('price table downloads are validated before they can move a number', () => {
  assert.equal(validatePrices(BUNDLED_PRICES), BUNDLED_PRICES, 'the shipped table passes its own check');
  const text = (change) => {
    const table = structuredClone(BUNDLED_PRICES);
    change(table);
    return JSON.stringify(table);
  };
  // `rejected` is what makes main.js wait a day before asking again instead of an hour.
  const refused = (change, what) =>
    assert.throws(() => acceptPrices(text(change), BUNDLED_PRICES), (error) => error.rejected === true, what);
  refused((t) => { t.schema = 2; }, 'a schema this version does not understand');
  refused((t) => { t.snapshot = 'soon'; }, 'snapshot must be a date');
  refused((t) => { t.snapshot = '2099-01-01'; }, 'a future date would outrank every later fix');
  refused((t) => { t.codexAliases['gpt-6-sol'] = 'gpt-6-luna'; }, 'an alias may not shadow a real row');
  refused((t) => { t.claude['claude-opus-5'].input = -5; }, 'negative rate');
  refused((t) => { t.codex['gpt-6-sol'].output = '10'; }, 'rate as a string');
  refused((t) => { t.claude['claude-opus-5'].output = 1e9; }, 'absurd rate');
  refused((t) => { t.claude['claude-fable-5-1'].cacheRead = 2.5; }, 'cache read dearer than input');
  refused((t) => { t.claude['claude-opus-4'].legacy = 'yes'; }, 'legacy must be a boolean');
  refused((t) => { delete t.claude['claude-3-5-haiku']; }, 'a missing row means a truncated table');
  refused((t) => { t.codexAliases['gpt-daybreak-red-latest'] = 'gpt-9'; }, 'alias to a row that does not exist');
  refused((t) => { delete t.gemini; }, 'a table cached before the gemini section existed');
  refused((t) => { t.gemini['gemini-3.1-pro'].longContext.above = '200k'; }, 'long-context threshold must be a number');
  refused((t) => { t.gemini['gemini-2.5-pro'].longContext.output = -1; }, 'long-context rate');
  // A cut-off download or a captive-portal page is not a refused table: retry within the hour.
  assert.throws(() => acceptPrices('{"schema": 1', BUNDLED_PRICES), (error) => error instanceof SyntaxError && !error.rejected);
  assert.throws(() => acceptPrices(' '.repeat(300 * 1024), BUNDLED_PRICES), /rejected/, 'oversized body');

  const later = Date.parse('2099-06-01'); // a clock by which the 2099 table is no longer future
  const newer = acceptPrices(
    text((t) => {
      t.snapshot = '2099-01-01';
      t.codex['gpt-7'] = { input: 1, cachedInput: 0.1, output: 5 };
      t.claude['claude-opus-5'].longContext = 2;
      t.qwen = {};
    }),
    BUNDLED_PRICES,
    BUNDLED_PRICES,
    later,
  );
  assert.equal(newer.codex['gpt-7'].input, 1, 'new rows arrive; unknown fields and sections are ignored');
  assert.deepEqual(acceptPrices(JSON.stringify(BUNDLED_PRICES), BUNDLED_PRICES), BUNDLED_PRICES, 'same date: a same-day fix');
  assert.equal(acceptPrices(JSON.stringify(BUNDLED_PRICES), newer), null, 'older than the table in use: a lagging mirror');
});

test('floating renderer prefers quota, otherwise renders provider-aware range tokens', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'floating.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  let right = false;
  const toggled = {};
  const classList = { toggle(name, on) { toggled[name] = on; }, remove() {}, contains: (name) => right && name === 'position-right' };
  const element = () => ({ innerHTML: '', addEventListener() {}, classList, children: [], offsetWidth: 0, offsetHeight: 0, style: {} });
  const vars = new Map();
  const document = {
    body: { classList },
    documentElement: { style: { setProperty: (name, value) => vars.set(name, value), getPropertyValue: (name) => vars.get(name) || '' } },
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  };
  let publish;
  let setState;
  const sizes = [];
  const screen = { availWidth: 1920, availHeight: 1040 };
  const window = {
    matchMedia: () => ({ matches: false }),
    api: {
      onUsage(callback) { publish = callback; },
      getUsage: () => ({ then() {} }),
      getFloatingState: () => ({ then() {} }),
      onFloatingState(callback) { setState = callback; },
      setFloatingExpanded() {},
      setFloatingSize(size) { sizes.push(size); },
      openPanel() {},
    },
  };
  vm.runInNewContext(script, { window, document, screen, setTimeout, clearTimeout, Date });
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

  const quotaGrok = provider({ input: 1000, output: 100, reasoning: 50 });
  quotaGrok.rateLimits = {
    windows: [{ windowMinutes: 10080, usedPercentage: 14, resetsAt: Date.now() / 1000 + 3600 }],
    updatedAt: Date.now(),
    planType: 'X Premium',
    stale: false,
  };
  publish({ claude: provider({}), codex: provider({}), grok: quotaGrok });
  assert.ok(elements.get('compact').innerHTML.includes('7d</b>14%'), 'grok weekly quota shown');
  assert.match(elements.get('details').innerHTML, /Grok/);

  // Only the tools the main process asks for; the two without a logo or a quota window.
  setState({ position: 'top', providers: ['antigravity', 'opencode'] });
  const antigravity = provider({ input: 1000, output: 100, cacheRead: 400 });
  Object.assign(antigravity, { costUSD: 0.46, unknownModels: ['gemini-pro-default'] });
  publish({ claude: quotaClaude, antigravity, opencode: provider({}) });
  assert.match(elements.get('details').innerHTML, /≈\$0\.46\+/, 'an unpriced model marks the amount incomplete, as in the panel');
  const compact = elements.get('compact').innerHTML;
  assert.doesNotMatch(compact, /data-provider="claude"/);
  assert.match(compact, /<img class="brand" src="antigravity\.png"/);
  assert.match(compact, /provider-logos\.svg#opencode/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'antigravity.png')));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'provider-logos.svg'), 'utf8'), /<symbol id="opencode"/);
  assert.match(compact, /10d<\/b>1\.5K/, 'cache is stored apart from input, so it is added back');
  assert.match(elements.get('details').innerHTML, /10天暂无用量/);
  assert.doesNotMatch(elements.get('details').innerHTML, /额度 —/, 'an unused OpenCode shows 0 tokens, not a missing quota');
  assert.match(elements.get('details').innerHTML, /记录金额/);
  assert.doesNotMatch(elements.get('details').innerHTML, /provider-status bad/, 'no quota window is not a fault');
  const leftover = { ...antigravity, rateLimits: {
    windows: [{ group: 'Claude/GPT', windowMinutes: 10080, usedPercentage: 12, resetsAt: Date.now() / 1000 + 3600 }],
    primaryGroup: 'Gemini', updatedAt: Date.now(), stale: true,
  } };
  publish({ antigravity: leftover, opencode: provider({}) });
  assert.doesNotMatch(elements.get('compact').innerHTML, /12%/, "Gemini's windows reset: the strip does not show Claude/GPT's in their place");
  assert.match(elements.get('details').innerHTML, /Claude\/GPT 7d/, 'the card still lists it, labelled');

  // Window sizes: on top one 206px column per tool, plus the surface's 1px borders; on the right a
  // short screen caps it and scrolls.
  Object.assign(elements.get('compact'), { children: { length: 5 }, offsetWidth: 600, offsetHeight: 38 });
  elements.get('details').offsetHeight = 210;
  setState({ position: 'top', providers: ['claude', 'codex', 'grok', 'antigravity', 'opencode'] });
  assert.deepEqual(JSON.parse(JSON.stringify(sizes.at(-1))), { position: 'top', collapsed: [604, 42], expanded: [1082, 216] });
  assert.equal(toggled.scroll, false);
  right = true;
  screen.availHeight = 768;
  Object.assign(elements.get('compact'), { offsetWidth: 54, offsetHeight: 450 });
  elements.get('details').offsetHeight = 790;
  setState({ position: 'right', providers: ['claude', 'codex', 'grok', 'antigravity', 'opencode'] });
  assert.deepEqual(JSON.parse(JSON.stringify(sizes.at(-1))), { position: 'right', collapsed: [58, 454], expanded: [326, 752] });
  assert.equal(toggled.scroll, true);
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
  // 覆盖升级会先静默卸载旧版,所以卸载钩子必须放过升级:否则每次升级都悄悄关掉开机自启
  const uninstallHook = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert.match(uninstallHook, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(uninstallHook, /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "AI Code Usage Tray"/);
  // CI 上 electron-builder 会自作主张去发布(nsis 会生成自动更新元数据),没有 token 就整个构建失败
  assert.match(packageJson.scripts.dist, /--publish never/);

  const loadLedger = main.slice(main.indexOf('function loadAccountLedger()'), main.indexOf('function flushAccountLedger()'));
  const clearLedger = main.slice(main.indexOf('function clearAccountLedger()'), main.indexOf('function rejectWorkerRequests('));
  assert.match(loadLedger, /accountLedger = null/);
  assert.doesNotMatch(loadLedger, /unlinkSync|writeFileSync|renameSync/);
  assert.match(clearLedger, /fs\.unlinkSync\(file\)/);
  assert.doesNotMatch(clearLedger, /DEFAULT_ROOT|DEFAULT_CODEX_ROOT/);
  assert.match(main, /if \(!quitting\) rejectWorkerRequests\(new Error\(`本地用量 Worker 已退出/);
});

test('fullscreen watch maps QUNS states and main.js hides the floating bar', () => {
  const { FULLSCREEN_STATES, WATCH_SCRIPT, isFullscreenQuns } = require('./fullscreen-watch');
  for (const state of FULLSCREEN_STATES) assert.equal(isFullscreenQuns(state), true);
  for (const state of [0, 1, 5, 6]) assert.equal(isFullscreenQuns(state), false);
  assert.match(WATCH_SCRIPT, /SHQueryUserNotificationState/);
  for (const state of FULLSCREEN_STATES)
    assert.ok(WATCH_SCRIPT.includes(`$s -eq ${state}`), `script checks QUNS ${state}`);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /floatingHideFullscreen = saved\.floatingHideFullscreen !== false/);
  assert.match(main, /settings\.floatingHideFullscreen && fullscreenActive/);
  assert.match(main, /全屏应用时隐藏悬浮条/);
  assert.match(main, /fullscreenWatch\.stop\(\)/);
});

test('Grok sessions aggregate per-turn usage with official cost and weekly quota', () => {
  const { collectGrokUsage, readQuota } = require('./grok-usage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-grok-'));
  const dir = path.join(root, 'sessions', 'F%3A%5Cfake%5Cgrok-project', '0199-test-session');
  fs.mkdirSync(dir, { recursive: true });
  const unix = (ms) => Math.floor(ms / 1000);
  const turn = (atMs, usage) => JSON.stringify({
    timestamp: unix(atMs),
    method: '_x.ai/session/update',
    params: { sessionId: '0199-test-session', update: { sessionUpdate: 'turn_completed', usage } },
  });
  const withModel = (tokens) => ({ ...tokens, modelUsage: { 'grok-4.6': tokens } });
  const hourAgo = NOW.getTime() - 3600e3;
  const twoHoursAgo = NOW.getTime() - 2 * 3600e3;
  const threeDaysAgo = NOW.getTime() - 72 * 3600e3;
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), [
    JSON.stringify({ timestamp: unix(hourAgo), params: { update: { sessionUpdate: 'agent_message_delta' } } }),
    turn(threeDaysAgo, withModel({ inputTokens: 9999, outputTokens: 9999, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, modelCalls: 1, costUsdTicks: 1e10 })),
    turn(twoHoursAgo, { inputTokens: 500, outputTokens: 40, cachedReadTokens: 100, cacheCreationTokens: 0, reasoningTokens: 10, modelCalls: 1, costUsdTicks: 2.5e8 }),
    turn(hourAgo, withModel({ inputTokens: 1000, outputTokens: 200, cachedReadTokens: 600, cacheCreationTokens: 0, reasoningTokens: 50, modelCalls: 2, costUsdTicks: 5e8 })),
    'turn_completed but not json',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: '0199-test-session', cwd: 'F:\\fake\\grok-project' },
    generated_title: '给托盘加 Grok 支持',
    current_model_id: 'grok-4.6',
    last_active_at: new Date(hourAgo).toISOString(),
  }));
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const period = (endMs) => ({
    type: 'USAGE_PERIOD_TYPE_WEEKLY',
    start: new Date(endMs - 7 * 24 * 3600e3).toISOString(),
    end: new Date(endMs).toISOString(),
  });
  const billing = (atMs, percent, currentPeriod) => JSON.stringify({
    ts: new Date(atMs).toISOString(),
    msg: 'billing: fetched credits config',
    ctx: {
      // percent === undefined reproduces a real record from the start of a period
      config: { ...(percent === undefined ? {} : { creditUsagePercent: percent }), currentPeriod },
      subscriptionTier: 'X Premium',
    },
  });
  const periodEnd = NOW.getTime() + 4 * 24 * 3600e3;
  fs.writeFileSync(path.join(root, 'logs', 'unified.jsonl'), [
    'junk line',
    billing(NOW.getTime() - 9e5, 9, period(periodEnd)),
    billing(NOW.getTime() - 6e4, 14, period(periodEnd)),
  ].join('\n') + '\n');

  const cache = new Map();
  const diagnostics = {};
  const u = collectGrokUsage({ root, rangeDays: 1, cache, diagnostics, now: NOW });
  assert.equal(u.totals.input, 1500);
  assert.equal(u.totals.output, 240);
  assert.equal(u.totals.cacheRead, 700);
  assert.equal(u.totals.reasoning, 60);
  assert.equal(u.totals.requests, 3);
  assert.ok(Math.abs(u.costUSD - 0.075) < 1e-9, `official ticks cost, got ${u.costUSD}`);
  assert.equal(u.byModel['grok-4.6'].input, 1000);
  assert.equal(u.byModel['<unknown>'].input, 500);
  assert.deepEqual(u.unknownModels, []);
  assert.equal(u.sessions.length, 1);
  assert.equal(u.sessions[0].title, '给托盘加 Grok 支持');
  assert.equal(u.sessions[0].project, 'grok-project');
  assert.equal(u.sessions[0].client, 'CLI');
  assert.equal(u.sessions[0].state, 'idle');
  assert.deepEqual(u.rateLimits.windows, [
    { windowMinutes: 10080, usedPercentage: 14, resetsAt: Math.round(periodEnd / 1000) },
  ]);
  assert.equal(u.rateLimits.planType, 'X Premium');

  const wide = collectGrokUsage({ root, rangeDays: 7, cache: new Map(), now: NOW });
  assert.equal(wide.totals.input, 1500 + 9999, '7-day range includes the old turn');

  const warm = collectGrokUsage({ root, rangeDays: 1, cache, diagnostics, now: NOW });
  assert.equal(warm.totals.input, 1500);
  assert.ok(diagnostics.reusedFiles >= 1, 'unchanged updates.jsonl is reused from cache');

  // A fresh billing period omits creditUsagePercent entirely; that means 0%,
  // not "unknown", so the quota must still render instead of vanishing.
  const logPath = path.join(root, 'logs', 'unified.jsonl');
  fs.writeFileSync(logPath, billing(NOW.getTime() - 6e4, undefined, period(periodEnd)) + '\n');
  const fresh = readQuota(logPath, NOW);
  assert.ok(fresh, 'missing creditUsagePercent still yields a quota');
  assert.deepEqual(fresh.windows, [
    { windowMinutes: 10080, usedPercentage: 0, resetsAt: Math.round(periodEnd / 1000) },
  ]);

  fs.writeFileSync(logPath, billing(NOW.getTime() - 6e4, 14, period(NOW.getTime() - 1000)) + '\n');
  assert.equal(readQuota(logPath, NOW), null, 'expired period hides quota');

  // A record missing the period is still unusable — absent percent is the only
  // field we infer, everything else must be present and valid.
  fs.writeFileSync(logPath, billing(NOW.getTime() - 6e4, undefined, undefined) + '\n');
  assert.equal(readQuota(logPath, NOW), null, 'missing period still hides quota');
});

test('a portable launch does not take the startup entry from an installed copy', () => {
  const { runValuePath, portableShouldYield } = require('./auto-launch');
  const installed = 'C:\\Users\\a\\AppData\\Local\\Programs\\ai-code-usage-tray\\AI Code Usage Tray.exe';
  const portable = 'D:\\Downloads\\AI-Code-Usage-Tray-1.3.1-win-x64.exe';
  // reg query 的真实输出:缩进、制表位、带空格的路径,值还带引号
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    `    AI Code Usage Tray    REG_SZ    "${installed}"`,
    '',
  ].join('\r\n');
  assert.equal(runValuePath(output), installed, '带空格的路径要完整取出,引号要去掉');
  assert.equal(runValuePath(output.replace(`"${installed}"`, installed)), installed, '没有引号也要认');
  assert.equal(runValuePath(''), '', '查不到条目');
  assert.equal(runValuePath(null), '');

  const yields = (over) =>
    portableShouldYield({ current: installed, own: portable, isPortable: true, currentExists: true, ...over });
  assert.equal(yields(), true, '便携版不抢安装版还在用的条目');
  assert.equal(yields({ currentExists: false }), false, '指向的 exe 没了就自愈');
  assert.equal(yields({ current: portable }), false, '条目本来就是自己');
  assert.equal(yields({ isPortable: false }), false, '安装版照常接管');
  assert.equal(yields({ current: '' }), false, '没有条目');
});

test('auto-launch is managed via the registry, not Electron login items', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!main.includes('setLoginItemSettings'), 'Electron login-item API removed');
  assert.ok(!main.includes('getLoginItemSettings'), 'Electron login-item API removed');
  assert.ok(main.includes("'reg.exe'"), 'uses reg.exe directly');
  assert.ok(main.includes('electron.app.AI Code Usage Tray'), 'migrates the legacy entry');
  assert.ok(main.includes('syncAutoLaunch();'), 'self-heals the path on startup');
  const setBlock = main.slice(main.indexOf('function setAutoLaunch('), main.indexOf('function syncAutoLaunch('));
  assert.ok(setBlock.includes('LOGIN_ITEM_PATH'), 'writes the portable exe path');
});

test('pricing handles per-model multipliers, vendor id shapes, and prefix collisions', () => {
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: got ${actual}, want ${expected}`);
  const oneM = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Fable/Mythos 5.1 read cache at 0.025x input, Opus 5.5 at 0.05x; every other
  // model stays 0.1x. Opus 5.5 also prefix-matches claude-opus-5: without its own
  // row a cache read bills 2.5x the official price.
  near(costOf('claude-fable-5-1', { ...oneM, cacheRead: 1e6 }), 0.25, 'fable 5.1 cache read');
  near(costOf('claude-mythos-5-1', { ...oneM, cacheRead: 1e6 }), 0.25, 'mythos 5.1 cache read');
  near(costOf('claude-fable-5', { ...oneM, cacheRead: 1e6 }), 1, 'fable 5 cache read');
  near(costOf('claude-opus-5-5', { ...oneM, cacheRead: 1e6 }), 0.2, 'opus 5.5 cache read');
  // Longest-match, proven independently of how PRICES happens to be ordered:
  // written short-first, a first-match resolver returns the 15/75 row.
  const shortFirst = { 'claude-opus-4': { input: 15, output: 75 }, 'claude-opus-4-5': { input: 5, output: 25 } };
  assert.equal(priceFor('claude-opus-4-5-20251101', shortFirst).input, 5, 'longest key wins');
  assert.equal(priceFor('claude-opus-4-20250514', shortFirst).input, 15, 'shorter key still reachable');

  // Same collision with real money at stake: Opus 4 is 15/75, Opus 4.5 is 5/25.
  near(costOf('claude-opus-4-5-20250929', { ...oneM, input: 1e6 }), 5, 'opus 4.5 input');
  near(costOf('claude-opus-4-20250514', { ...oneM, input: 1e6 }), 15, 'opus 4 input');
  near(costOf('claude-3-5-haiku-20241022', { ...oneM, input: 1e6 }), 0.8, 'haiku 3.5 input');

  // Fast mode doubles Opus 5.5 / 5 / 4.8 only. Opus 4.6 accepts the flag but bills standard.
  near(costOf('claude-opus-5-5', { ...oneM, input: 1e6, speed: 'fast' }), 8, 'opus 5.5 fast');
  near(costOf('claude-opus-5', { ...oneM, input: 1e6, speed: 'fast' }), 10, 'opus 5 fast');
  near(costOf('claude-opus-4-8', { ...oneM, input: 1e6, speed: 'fast' }), 10, 'opus 4.8 fast');
  near(costOf('claude-opus-4-6', { ...oneM, input: 1e6, speed: 'fast' }), 5, 'opus 4.6 ignores fast');

  // US-only inference is 1.1x, and stacks on top of fast mode.
  near(costOf('claude-opus-5', { ...oneM, input: 1e6, inferenceGeo: 'us' }), 5.5, 'us residency');
  near(
    costOf('claude-opus-5', { ...oneM, input: 1e6, speed: 'fast', inferenceGeo: 'us' }),
    11,
    'fast + us residency stack',
  );

  // Bedrock and Vertex spell the same model differently.
  near(
    costOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0', { ...oneM, input: 1e6 }),
    3.3,
    'bedrock regional profile adds the documented 10% premium',
  );
  near(
    costOf('global.anthropic.claude-sonnet-4-5-20250929-v1:0', { ...oneM, input: 1e6 }),
    3,
    'global profile carries no premium',
  );
  near(
    costOf('us.anthropic.claude-sonnet-4-20250514', { ...oneM, input: 1e6 }),
    3,
    'legacy models predate the regional premium',
  );
  assert.ok(priceFor('eu.anthropic.claude-fable-5-1'), 'bedrock fable 5.1 resolves');
  near(costOf('claude-opus-4-5@20250929', { ...oneM, input: 1e6 }), 5, 'vertex opus 4.5');
  near(costOf('anthropic/claude-sonnet-5', { ...oneM, input: 1e6 }), 2, 'openrouter-style id');

  // gpt-6-astra showed up in real Codex logs priced at zero before it was added.
  assert.ok(codexCostOf('gpt-6-astra', { input: 1e5, output: 0, cacheRead: 0, cacheWrite: 0 }) > 0);
  // gpt-5.5-pro is 6x gpt-5.5 and prefix-matches it; without its own row it bills 6x under.
  near(codexCostOf('gpt-5.5-pro', { input: 1e5, output: 0, cacheRead: 0, cacheWrite: 0 }), 3, 'gpt-5.5-pro input');
  near(codexCostOf('gpt-5.5', { input: 1e5, output: 0, cacheRead: 0, cacheWrite: 0 }), 0.5, 'gpt-5.5 input');
  // 两个 cyber 都是 gpt-5.5 的 2.5 倍,而 gpt-5.5-cyber 又正好前缀命中 gpt-5.5;
  // daybreak 是官方别名,不认识就整单算成 0。
  const codexInput = (model) => codexCostOf(model, { input: 1e5, output: 0, cacheRead: 0, cacheWrite: 0 });
  near(codexInput('gpt-5.5-cyber'), 1.25, 'gpt-5.5-cyber input');
  near(codexInput('gpt-5.6-cyber'), 1.25, 'gpt-5.6-cyber input');
  near(codexInput('gpt-daybreak-red-latest'), 1.25, 'daybreak-red is gpt-5.6-cyber');
  near(codexInput('gpt-daybreak-blue-latest'), 0.4, 'daybreak-blue is gpt-5.6-sol');
  // gpt-6-sol also showed up in real logs priced at zero; gpt-5.4-nano / -pro
  // prefix-match gpt-5.4 at 1/12 and 12x its price.
  near(codexInput('gpt-6-sol'), 0.2, 'gpt-6-sol input');
  near(codexInput('gpt-5.4-nano-2026-03-17'), 0.02, 'gpt-5.4-nano input');
  near(codexInput('gpt-5.4-pro'), 3, 'gpt-5.4-pro input');
  assert.equal(priceFor('totally-made-up-model'), null);
});

test('hang guard finds hung instances in tasklist output and flags stall/recovery once', () => {
  const {
    parseTasklistPids,
    hangTransition,
    snapshotError,
    HANG_AFTER_MS,
    CHECK_MS,
    SNAPSHOT_TIMEOUT_MS,
  } = require('./hang-guard');
  const csv = '"AI Code Usage Tray.exe","27452","Console","1","82,040 K"\r\n"AI Code Usage Tray.exe","4696","Console","1","0 K"\r\n';
  assert.deepEqual(parseTasklistPids(csv), [27452, 4696]);
  // tasklist prints a localized notice, not CSV, when nothing is hung.
  assert.deepEqual(parseTasklistPids('信息: 没有运行的任务匹配指定标准。\r\n'), []);
  assert.deepEqual(parseTasklistPids('INFO: No tasks are running which match the specified criteria.\r\n'), []);
  assert.deepEqual(parseTasklistPids(undefined), []);

  const beat = 1_000_000;
  const onTime = (now) => now - CHECK_MS; // the previous check fired on schedule
  const at = (now, lastBeat, hung = false) => hangTransition(hung, now, lastBeat, onTime(now));
  assert.deepEqual(at(beat + HANG_AFTER_MS, beat), { hung: false, event: null }, 'at threshold: not yet');
  assert.deepEqual(at(beat + HANG_AFTER_MS + 1, beat), { hung: true, event: 'hang' });
  assert.deepEqual(at(beat + 600_000, beat, true), { hung: true, event: null }, 'still hung: log once');
  assert.deepEqual(at(beat + 600_000, beat + 599_000, true), { hung: false, event: 'recovered' });
  // Waking from an hour of sleep: the beat is an hour old, but so is the last check.
  assert.deepEqual(hangTransition(false, beat + 3_600_000, beat, beat), { hung: false, event: null }, 'sleep is not a hang');

  // 2026-09-15 真卡死那次快照失败,记录里只有回显的命令;要能看出是超时还是退出码。
  assert.equal(snapshotError(null), null);
  assert.equal(snapshotError({ killed: true }, ''), 'timed out after ' + SNAPSHOT_TIMEOUT_MS + ' ms');
  assert.equal(snapshotError({ code: 1 }, 'access denied\r\nsecond line'), 'exit 1: access denied');
  assert.equal(snapshotError({ code: 'ENOENT' }, ''), 'exit ENOENT');

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // 只结束主进程:子进程自己会退出,/T 会连坐 shell.openExternal 打开的浏览器和 Claude Desktop
  assert.match(main, /'taskkill\.exe', \['\/F', '\/PID', String\(pid\)\]/);
  // 接管卡死实例要留下记录,否则用户报"打不开"时没有凭据
  assert.match(main, /event: 'ended-hung-instance'/);
  // 强杀跳过 finally,上一次的临时文件要在启动时清掉,但不能误删别的文件
  assert.match(main, /function cleanStaleTempFiles/);
  assert.match(main, /name\.startsWith\(prefix\) && name\.endsWith\('\.tmp'\)/);
  assert.match(main, /\[accountLedgerPath\(\), claudeAuthPath\(\), pricesPath\(\)\]\.forEach\(cleanStaleTempFiles\)/);
  // 便携版不抢安装版的开机自启:便携版身份来自 PORTABLE_EXECUTABLE_FILE,判断在 lib 里
  assert.match(main, /portableShouldYield\(\{[\s\S]*?isPortable: Boolean\(process\.env\.PORTABLE_EXECUTABLE_FILE\)/);
  // 抢不到单实例锁就得立刻 return,否则看门狗会轮转掉正在运行那个实例的挂起记录
  assert.match(main, /requestSingleInstanceLock\(\)\) \{\r?\n\s+app\.quit\(\);\r?\n\s+return;/);
});

test('activity: 流光环的快车道 — hook 状态优先,没有 hook 就看刚写过盘', async () => {
  const now = Date.now();
  const hook = (state, ageMs = 0) => new Map([[state, { state, ts: now - ageMs }]]);
  const empty = new Map();

  assert.deepEqual(
    providerStates({ statuses: hook('working'), writes: {}, now }),
    { claude: 'working', codex: '', grok: '', antigravity: '', opencode: '' },
  );
  // 需处理比工作中更该看见:两个都在时环要变成警示色
  assert.equal(
    providerStates({
      statuses: new Map([['a', { state: 'working', ts: now }], ['b', { state: 'attention', ts: now }]]),
      writes: {},
      now,
    }).claude,
    'attention',
  );
  // 崩溃的会话不会补 Stop:超过 HOOK_WORKING_MS 又没有新写入就得熄灭
  assert.equal(providerStates({ statuses: hook('working', HOOK_WORKING_MS + 1), writes: {}, now }).claude, '');
  assert.equal(
    providerStates({ statuses: hook('working', HOOK_WORKING_MS + 1), writes: { claude: now }, now }).claude,
    'working',
    '还在写盘就还在跑',
  );
  // 没有 hook 的 Codex/Grok 只有写入时间可用
  assert.deepEqual(
    providerStates({ statuses: empty, writes: { codex: now - WRITE_ACTIVE_MS + 500, grok: now - WRITE_ACTIVE_MS }, now }),
    { claude: '', codex: 'working', grok: '', antigravity: '', opencode: '' },
  );
  assert.deepEqual(providerStates({ statuses: empty, writes: {}, now }), { claude: '', codex: '', grok: '', antigravity: '', opencode: '' });
  assert.equal(providerStates({ statuses: empty, writes: { antigravity: now }, now }).antigravity, 'working');

  // watch 事件不等于有新内容:2026-09-21 Codex 重命名/迁移老会话让环平白转了 20 秒
  const stale = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-stale-')), 'rollout.jsonl');
  fs.writeFileSync(stale, '{}\n');
  assert.equal(hasFreshWrite(stale, Date.now()), true, '刚写的算');
  const old = (Date.now() - WRITE_ACTIVE_MS - 60_000) / 1000;
  fs.utimesSync(stale, old, old);
  assert.equal(hasFreshWrite(stale, Date.now()), false, 'mtime 是旧的就不算在跑');
  assert.equal(hasFreshWrite(stale + '.missing', Date.now()), false, '事件到达时文件没了也不算');

  // 真的挂 watch:往会话目录写一行,不重读快照就要亮起来
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-status-'));
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-codex-'));
  fs.mkdirSync(path.join(codexRoot, '2026', '09', '21'), { recursive: true });
  const changes = [];
  let notify = () => {};
  const watch = startActivityWatch({
    statusDir,
    roots: { claude: statusDir, codex: codexRoot, grok: codexRoot },
    sources: {},
    onChange: (next) => {
      changes.push(next);
      notify();
    },
  });
  try {
    const settled = new Promise((resolve) => {
      notify = () => changes.some((c) => c.codex === 'working') && resolve();
      setTimeout(resolve, 5000).unref();
    });
    fs.writeFileSync(path.join(codexRoot, '2026', '09', '21', 'rollout-x.jsonl'), '{}\n');
    await settled;
    assert.ok(
      changes.some((change) => change.codex === 'working'),
      'watch 到写入就该推一次活动状态',
    );
  } finally {
    watch.stop();
  }
});

test('流光环的接线:环活在 body 的动画上,活动状态单独推给悬浮条', () => {
  const floating = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'floating.html'), 'utf8');
  // render() 每 30 秒重写 innerHTML;动画挂 body + 变量 inherits 才不会每次重新开始转
  assert.match(floating, /@property --sweep \{ syntax: '<angle>'; inherits: true;/);
  assert.match(floating, /body\.busy-any \{ animation: ring-sweep/);
  assert.match(floating, /data-provider="\$\{provider\}"/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /send\('floating-activity', activity\)/);
  assert.match(main, /ringStyle: settings\.floatingRingStyle/);
});

test('floating bar shows the picked tools, else the detected ones, and never none', () => {
  assert.equal(savedPick(undefined), null, 'an old settings.json follows detection');
  assert.equal(savedPick('claude'), null);
  assert.equal(savedPick(['bogus']), null);
  assert.deepEqual(savedPick(['opencode', 'bogus', 'claude']), ['claude', 'opencode'], 'known ids, canonical order');
  assert.deepEqual(shownProviders(null, new Set()), ['claude', 'codex', 'grok'], 'nothing detected: the original three');
  assert.deepEqual(shownProviders(null, new Set(['opencode', 'codex'])), ['codex', 'opencode']);
  assert.deepEqual(shownProviders(['grok'], new Set(['claude'])), ['grok'], 'a pick beats detection');
  assert.deepEqual(toggledPick(['codex'], 'antigravity', true), ['codex', 'antigravity']);
  assert.deepEqual(toggledPick(['codex'], 'codex', false), [], 'unticking the last tool leaves nothing: main refuses it');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /if \(next\.length\) setFloatingProviders\(next\);\s*else updateTrayMenu\(\);/);
});

// The language server's answer, as measured on this machine 2026-10-04 (descriptions trimmed).
const antigravitySummary = (gemini5h = 0.9753005) => ({
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9632317, resetTime: '2026-10-06T08:09:23Z' },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: gemini5h, resetTime: '2026-10-05T11:27:04Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-12T09:15:43Z' },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-05T14:15:43Z' },
        ],
      },
    ],
  },
});

test('Antigravity quota parses the language server answer into labelled windows', () => {
  const now = Date.parse('2026-10-05T09:16:00Z');
  const windows = parseQuota(antigravitySummary(), now);
  assert.deepEqual(windows.map((w) => [w.group, w.windowMinutes, Math.round(w.usedPercentage * 10) / 10]), [
    ['Gemini', 300, 2.5], ['Gemini', 10080, 3.7], ['Claude/GPT', 300, 0], ['Claude/GPT', 10080, 0],
  ]);
  assert.equal(windows[0].resetsAt, Date.parse('2026-10-05T11:27:04Z') / 1000);
  const used = antigravitySummary();
  delete used.response.groups[0].buckets[1].remainingFraction; // proto3 leaves a zero out
  used.response.groups[1].buckets[0].disabled = true;
  used.response.groups[1].buckets[1].resetTime = '2026-10-05T09:00:00Z'; // already reset
  assert.deepEqual(parseQuota(used, now).map((w) => [w.group, w.windowMinutes, w.usedPercentage]), [['Gemini', 300, 100], ['Gemini', 10080, (1 - 0.9632317) * 100]]);
  assert.deepEqual(parseQuota({}, now), []);
  assert.equal(groupLabel('<img src=x onerror=alert(1)> models'), 'img srcx onerroralert1');
  assert.equal(csrfOf('language_server.exe --standalone --csrf_token abc-123 --app_data_dir antigravity'), 'abc-123');
  assert.equal(csrfOf('language_server.exe --csrf_token="q w"'), 'q w');
});

test('Antigravity quota is forced only on new usage, a passed reset or every 10 minutes', async () => {
  let t = Date.parse('2026-10-05T09:16:00Z');
  let finds = 0;
  const calls = [];
  let alive = true;
  let gemini5h = 0.9753005;
  const quota = createAntigravityQuota({
    now: () => t,
    find: async () => {
      finds += 1;
      return alive ? [{ csrf: 'token', ports: [59678, 59677] }] : [];
    },
    call: async (endpoint, force) => {
      calls.push(`${endpoint.scheme}:${endpoint.port}:${force}`);
      return alive && endpoint.port === 59677 && endpoint.scheme === 'https' ? antigravitySummary(gemini5h) : null;
    },
  });
  const first = await quota.read({ usageMark: 'a' });
  assert.equal(finds, 1);
  assert.deepEqual(calls, ['https:59678:true', 'http:59678:true', 'https:59677:true'], 'tries each port and scheme');
  assert.equal(first.windows.length, 4);
  assert.equal(first.stale, false);

  calls.length = 0;
  t += 30_000;
  await quota.read({ usageMark: 'a' });
  assert.deepEqual(calls, [], 'no new usage: the last answer stands');
  gemini5h = 0.9647582;
  t += 30_000;
  const after = await quota.read({ usageMark: 'b' });
  assert.deepEqual(calls, ['https:59677:true'], 'new usage forces a refresh on the known endpoint');
  assert.equal(Math.round(after.windows[0].usedPercentage * 10) / 10, 3.5);
  calls.length = 0;
  t += 10 * 60_000;
  await quota.read({ usageMark: 'b' });
  assert.deepEqual(calls, ['https:59677:true'], 'every 10 minutes regardless');

  alive = false; // Antigravity quits
  calls.length = 0;
  t += 10 * 60_000;
  const closed = await quota.read({ usageMark: 'b' });
  assert.equal(finds, 2, 'a failed call drops the endpoint and looks again');
  assert.equal(closed.windows.length, 4, 'the last numbers stay');
  t += 30_000;
  await quota.read({ usageMark: 'b' });
  assert.equal(finds, 2, 'not found: looks again only after 2 minutes');
  t += 6 * 60_000;
  const old = await quota.read({ usageMark: 'b' });
  assert.equal(finds, 3);
  assert.equal(old.stale, true, 'over 15 minutes old with no server: stale');
  t = Date.parse('2026-10-06T09:00:00Z'); // past every reset but Claude/GPT weekly
  const late = await quota.read({ usageMark: 'b' });
  assert.deepEqual(late.windows.map((w) => `${w.group} ${w.windowMinutes}`), ['Claude/GPT 10080']);
  assert.equal(late.primaryGroup, 'Gemini', 'the bar keeps to Gemini rather than show Claude/GPT in its place');
});

test('an Antigravity quota call always settles, even when the server stalls mid-response', async () => {
  const http = require('http');
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.headers['x-codeium-csrf-token'] !== 'token') return res.writeHead(401).end();
    if (req.url.endsWith('RetrieveUserQuotaSummary') && req.headers['connect-protocol-version'] === '1') {
      if (server.stall) return res.writeHead(200, { 'Content-Type': 'application/json' }) && res.flushHeaders();
      return res.end(JSON.stringify(antigravitySummary()));
    }
    res.writeHead(404).end();
  });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = { port: server.address().port, scheme: 'http', csrf: 'token' };
  try {
    assert.equal((await antigravityRequest(endpoint, true, 2000)).response.groups.length, 2);
    assert.equal(await antigravityRequest({ ...endpoint, csrf: 'wrong' }, true, 2000), null);
    assert.equal(await antigravityRequest({ ...endpoint, scheme: 'https' }, true, 2000), null, 'https against an http port');
    server.stall = true; // headers, then nothing: once froze the whole 30 s refresh
    let timer;
    const outcome = await Promise.race([
      antigravityRequest(endpoint, true, 300),
      new Promise((resolve) => (timer = setTimeout(() => resolve('still pending'), 2000))),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, null);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

test('activity: Antigravity lights on its step transcript, OpenCode on a WAL change, never on database housekeeping', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-agy-'));
  const logs = path.join(home, 'antigravity', 'brain', 'conv-1', '.system_generated', 'logs');
  const backupLogs = path.join(home, 'antigravity-backup', 'brain', 'conv-1', '.system_generated', 'logs');
  const conversations = path.join(home, 'antigravity', 'conversations');
  const openCode = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-opencode-'));
  for (const dir of [logs, backupLogs, conversations]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(openCode, 'opencode.db-wal'), 'x');
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), '{}\n');

  // the rules themselves, on the names fs.watch reports on Windows
  const { antigravity, opencode } = ACTIVITY_SOURCES;
  const win = (...parts) => parts.join('\\');
  assert.equal(antigravity.accept(win('antigravity', 'brain', 'c', '.system_generated', 'logs', 'transcript.jsonl')), true);
  assert.equal(antigravity.accept(win('antigravity-cli', 'brain', 'c', '.system_generated', 'logs', 'transcript.jsonl')), true);
  assert.equal(antigravity.accept(win('antigravity-backup', 'brain', 'c', '.system_generated', 'logs', 'transcript.jsonl')), false, 'a copy, synced while idle');
  assert.equal(antigravity.accept(win('antigravity', 'conversations', 'c.db-wal')), false, 'created and deleted while idle');
  assert.equal(antigravity.accept(win('antigravity', 'conversation_summaries.db-wal')), false);
  assert.equal(opencode.accept('opencode.db-wal', 'change'), true);
  assert.equal(opencode.accept('opencode.db-wal', 'rename'), false, 'WAL created or removed: not a write');
  assert.equal(opencode.accept('opencode.db-shm', 'change'), false, 'our own read-only opens touch -shm');

  const changes = [];
  let notify = () => {};
  const watch = startActivityWatch({
    statusDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-status-')),
    roots: {},
    sources: {
      antigravity: { dir: home, accept: antigravity.accept },
      opencode: { dir: openCode, accept: opencode.accept },
    },
    onChange: (next) => {
      changes.push(next);
      notify();
    },
  });
  const until = (check) => new Promise((resolve) => {
    notify = () => changes.some(check) && resolve();
    setTimeout(resolve, 5000).unref();
  });
  try {
    fs.writeFileSync(path.join(conversations, 'c.db-wal'), 'x');
    fs.appendFileSync(path.join(backupLogs, 'transcript.jsonl'), '{}\n');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(!changes.some((c) => c.antigravity), 'housekeeping and the backup copy stay dark');
    let lit = until((c) => c.antigravity === 'working');
    fs.appendFileSync(path.join(logs, 'transcript.jsonl'), '{}\n');
    await lit;
    assert.ok(changes.some((c) => c.antigravity === 'working'), 'a step appended to the transcript lights it');
    lit = until((c) => c.opencode === 'working');
    fs.appendFileSync(path.join(openCode, 'opencode.db-wal'), 'y');
    await lit;
    assert.ok(changes.some((c) => c.opencode === 'working'), 'OpenCode writing its WAL lights it');
  } finally {
    watch.stop();
  }
});

test('activity: an Antigravity turn stays lit until its final answer, through long thinking and tool runs', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-turn-')), 'transcript.jsonl');
  const step = (type, fields = {}) => JSON.stringify({ step_index: 1, source: 'MODEL', type, status: 'DONE', created_at: '2026-10-05T10:21:41Z', ...fields });
  const lastIs = (...lines) => {
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return antigravityTurnOpen(file);
  };
  const answer = step('PLANNER_RESPONSE', { content: 'done', thinking: 'x' });
  const toolCall = step('PLANNER_RESPONSE', { tool_calls: [{ name: 'run_command', args: {} }] });
  // Every type seen in 29 real transcripts (1672 steps): only a final answer is ever followed by a
  // new user message or the end of the file; everything else is followed by the same turn's next step.
  assert.equal(lastIs(step('GENERIC'), answer), false, 'a final answer ends the turn (a stop writes one too)');
  assert.equal(lastIs(answer, toolCall), true, 'waiting on a tool');
  for (const type of ['USER_INPUT', 'GENERIC', 'RUN_COMMAND', 'VIEW_FILE', 'LIST_DIRECTORY', 'SEARCH_WEB', 'READ_URL_CONTENT',
    'CODE_ACTION', 'SYSTEM_MESSAGE', 'EPHEMERAL_MESSAGE', 'CONVERSATION_HISTORY', 'ERROR_MESSAGE', 'SOMETHING_NEW']) {
    assert.equal(lastIs(answer, step(type)), true, `${type}: the model or a tool is still due`);
  }
  // CHECKPOINT is judged by the step before it
  assert.equal(lastIs(step('USER_INPUT'), step('CHECKPOINT')), true, 'just sent, first long think');
  assert.equal(lastIs(step('GENERIC'), answer, step('CHECKPOINT')), false, 'saved after the answer');
  assert.equal(lastIs(step('CHECKPOINT')), false);
  assert.equal(lastIs(step('GENERIC', { content: 'x'.repeat(300_000) })), true, 'a last line far longer than one 64 KB read');
  assert.equal(lastIs(answer, step('CHECKPOINT', { content: 'y'.repeat(200_000) })), false, 'the step before a huge checkpoint is still found');
  fs.writeFileSync(file, `${answer}\r\n${toolCall}\r\n`);
  assert.equal(antigravityTurnOpen(file), true, 'CRLF line ends');
  fs.writeFileSync(file, `${answer}\n{"step_index":2,"type":"GENER`);
  assert.equal(antigravityTurnOpen(file), true, 'a step being written right now');
  fs.writeFileSync(file, `${toolCall}\nnull\n`);
  assert.equal(antigravityTurnOpen(file), false, 'a line that parses but is not a step must not throw on the main process');
  fs.writeFileSync(file, '');
  assert.equal(antigravityTurnOpen(file), false);
  assert.equal(antigravityTurnOpen(`${file}.missing`), false);

  const now = Date.now();
  const empty = new Map();
  assert.equal(providerStates({ statuses: empty, writes: { antigravity: now - 60_000 }, openTurns: { antigravity: now - 60_000 }, now }).antigravity, 'working', 'a minute of thinking keeps it lit');
  assert.equal(providerStates({ statuses: empty, writes: { antigravity: now - 60_000 }, openTurns: { antigravity: 0 }, now }).antigravity, '', 'an ended turn goes dark after the 20 s window');
  assert.equal(providerStates({ statuses: empty, writes: {}, openTurns: { antigravity: now - OPEN_TURN_MS - 1 }, now }).antigravity, '', 'a crashed turn goes dark after the cap');
});

test('activity: a turn already running at launch lights without waiting for its next write', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-seed-'));
  const transcript = (root, id, type, ageMs) => {
    const dir = path.join(home, root, 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, JSON.stringify({ step_index: 1, type, status: 'DONE' }) + '\n');
    const at = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, at, at);
  };
  const start = () => startActivityWatch({
    statusDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-status-')),
    roots: {},
    sources: { antigravity: { ...ACTIVITY_SOURCES.antigravity, dir: home } },
    onChange: () => {},
  });
  transcript('antigravity', 'done', 'PLANNER_RESPONSE', 30_000); // answered
  transcript('antigravity-backup', 'copy', 'GENERIC', 30_000); // a copy: not one of the live roots
  transcript('antigravity', 'old', 'GENERIC', OPEN_TURN_MS + 60_000); // past the cap
  let watch = start();
  try {
    assert.equal(watch.current().antigravity, '');
  } finally {
    watch.stop();
  }
  transcript('antigravity-cli', 'thinking', 'GENERIC', 90_000); // a tool returned 90 s ago, the model is still thinking
  watch = start();
  try {
    assert.equal(watch.current().antigravity, 'working');
  } finally {
    watch.stop();
  }
});

test('activity: one Antigravity conversation ending does not put out another that is still thinking', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-two-'));
  const logs = (id) => {
    const dir = path.join(home, 'antigravity', 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'transcript.jsonl');
  };
  const thinking = logs('a');
  const answered = logs('b');
  fs.writeFileSync(thinking, JSON.stringify({ type: 'GENERIC' }) + '\n'); // a tool returned 90 s ago
  const earlier = (Date.now() - 90_000) / 1000;
  fs.utimesSync(thinking, earlier, earlier);
  fs.writeFileSync(answered, JSON.stringify({ type: 'USER_INPUT' }) + '\n');
  const realNow = Date.now;
  const watch = startActivityWatch({
    statusDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cut-activity-status-')),
    roots: {},
    sources: { antigravity: { ...ACTIVITY_SOURCES.antigravity, dir: home } },
    onChange: () => {},
  });
  try {
    fs.appendFileSync(answered, JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'done' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 1000)); // the write is seen
    Date.now = () => realNow() + WRITE_ACTIVE_MS + 10_000; // past the 20 s write window
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the 1 s expiry check runs
    assert.equal(watch.current().antigravity, 'working', 'conversation a is still due its next step');
  } finally {
    Date.now = realNow;
    watch.stop();
  }
});

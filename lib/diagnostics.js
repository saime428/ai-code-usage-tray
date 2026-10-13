'use strict';
// The text behind the tray menu's 复制诊断信息: what an issue needs in order to be answered
// without a second round of questions. States, counts, quota figures and paths only — no
// session titles, project names, account labels or tokens — and the home directory is
// written as ~. Keys are English so the same text reads the same in any issue.

const { PROVIDERS, PROVIDER_IDS } = require('./report');
const { IME_PROCESS } = require('./hang-guard');

const HANG_TAIL = 8;
const MAX_FIELD = 300;

// C:\Users\me, c:/users/me and the JSON-escaped C:\\Users\\me are all the same directory.
// ponytail: no boundary after the match, so a sibling profile (C:\Users\me2) comes out as
// ~2. Deliberate: a boundary that demands a separator next would leave 'C:\Users\me' inside
// quotes or at the end of a sentence unredacted, and a name is worse to leak than to mangle.
function redactHome(text, home) {
  const parts = String(home || '').split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return text; // "" or a bare drive: nothing safe to match on
  const pattern = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
  return text.replace(new RegExp(pattern, 'gi'), '~');
}

const clip = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…` : text;
};
const onOff = (value) => (value ? 'on' : 'off');
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'never');

function ago(ms, now) {
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function quotaText(limits, now) {
  if (!limits) return 'none';
  const windows = limits.windows
    ? limits.windows.map((w) => [`${w.group ? `${w.group} ` : ''}${w.windowMinutes}m`, w])
    : [['5h', limits.fiveHour], ['7d', limits.sevenDay], ['fable', limits.sevenDayFable]];
  const parts = windows.filter(([, w]) => w).map(([label, w]) => `${label} ${Math.round(w.usedPercentage)}%`);
  const { credits } = limits;
  if (credits) {
    parts.push(`credits ${credits.unlimited ? 'unlimited' : credits.balance ? Math.round(credits.balance) : 'available'}`);
  }
  if (limits.source) parts.unshift(`source ${limits.source}`);
  if (limits.planType) parts.push(`plan ${limits.planType}`);
  if (limits.stale) parts.push('STALE');
  parts.push(`updated ${ago(limits.updatedAt, now)}`);
  return parts.join(', ');
}

function providerLines(id, usage, read, sources, now) {
  const lines = [];
  if (!usage) return [`${id}: no snapshot`];
  const status = usage.dataStatus || {};
  lines.push(
    `${id}: ${usage.detected ? 'detected' : 'not detected'}, data ${status.state || 'unknown'}` +
      `${status.message ? ` (${clip(status.message)})` : ''}, read ${ago(status.updatedAt, now)}` +
      `${usage.appRunning ? ', Claude Desktop running' : ''}`,
  );
  for (const source of sources || []) lines.push(`  source: ${source.path} (${source.exists ? 'exists' : 'missing'})`);
  // What the last 30-second refresh did: all "reused" once the app has been up a while.
  if (read && Object.keys(read).length) {
    lines.push(`  last read: ${Object.entries(read).map(([key, value]) => `${key} ${value}`).join(', ')}`);
  }
  const totals = usage.totals || {};
  const unpriced = usage.unknownModels || [];
  lines.push(
    `  range ${usage.rangeDays || 1}d: ${totals.requests || 0} requests, $${(usage.costUSD || 0).toFixed(2)} ` +
      `(${PROVIDERS[id].costBasis}${usage.costCoverage && usage.costCoverage !== 'complete' ? `, coverage ${usage.costCoverage}` : ''})` +
      `, models ${Object.keys(usage.byModel || {}).length}, unpriced: ${unpriced.length ? unpriced.map(clip).join(' ') : 'none'}`,
  );
  const sessions = usage.sessions || [];
  const states = {};
  for (const session of sessions) states[session.state || 'idle'] = (states[session.state || 'idle'] || 0) + 1;
  lines.push(`  sessions 24h: ${sessions.length}${sessions.length ? ` (${Object.entries(states).map(([key, value]) => `${key} ${value}`).join(', ')})` : ''}`);
  lines.push(`  quota: ${quotaText(usage.rateLimits, now)}`);
  if (usage.authMode) lines.push(`  auth mode: ${clip(usage.authMode)}`);
  if (usage.accounts && usage.accounts.error) lines.push(`  account ledger: ${clip(usage.accounts.error)}`);
  return lines;
}

// The last records of hang-log.jsonl. A `processes` record lists everything started in the
// 15 minutes before a freeze; only the count and the input-method entries are worth pasting.
function hangLines(records) {
  if (!records || !records.length) return ['hang log: empty'];
  const lines = [`hang log: ${records.length} record${records.length > 1 ? 's' : ''}, last ${Math.min(HANG_TAIL, records.length)}:`];
  for (const record of records.slice(-HANG_TAIL)) {
    if (!record || typeof record !== 'object') continue;
    const { event, processes, ...rest } = record;
    const fields = Object.entries(rest).map(([key, value]) => `${key}=${clip(value)}`);
    if (Array.isArray(processes)) {
      const ime = processes.filter((p) => p && IME_PROCESS.test(String(p.name)));
      fields.push(`started ${processes.length - ime.length}`, `ime ${ime.map((p) => `${clip(p.name)}@${clip(p.startedAt)}`).join(' ') || 'none'}`);
    }
    lines.push(`  ${clip(event || 'unknown')} ${fields.join(' ')}`);
  }
  return lines;
}

function formatDiagnostics(info) {
  const now = info.now;
  const { app, settings, prices, snapshot, activity = {} } = info;
  const shown = info.floatingProviders || [];
  const lines = [
    `AI Code Usage Tray ${app.version} (${app.kind}) — Electron ${app.electron}, Node ${app.node}, Windows ${app.os} ${app.arch}, ${app.locale}`,
    `generated ${iso(now)}, up ${Math.round(app.uptimeSeconds / 60)}m, last refresh ${ago(snapshot && snapshot.collectedAt, now)}`,
    `exe: ${app.exe}`,
    `userData: ${app.userData}`,
    `display: ${app.display}`,
    `settings: floating ${onOff(settings.floatingEnabled)}/${settings.floatingPosition}, hide in fullscreen ${onOff(settings.floatingHideFullscreen)}, ` +
      `ring ${settings.floatingRingStyle}, tools ${settings.floatingProviders ? 'picked' : 'auto'} (${shown.join(' ') || 'none'}), ` +
      `auto-launch ${info.autoLaunch === null ? 'n/a (dev)' : onOff(info.autoLaunch)}`,
    `prices: snapshot ${prices.snapshot} (${prices.source}), auto-update ${onOff(settings.autoUpdatePrices)}, last fetched ${iso(prices.checkedAt)}`,
    `worker: ${info.workerRunning ? 'running' : 'not running'}`,
    '',
  ];
  for (const id of PROVIDER_IDS) {
    lines.push(...providerLines(id, snapshot && snapshot[id], snapshot && snapshot.diagnostics && snapshot.diagnostics[id], info.sources && info.sources[id], now));
    if (id === 'claude' && info.claudeAccount) {
      const { connected, error, throttle } = info.claudeAccount;
      lines.push(
        `  account: ${connected ? 'connected' : 'not connected'}${error ? `, ${clip(error)}` : ''}` +
          `${throttle ? `, last request ${Object.entries(throttle).map(([key, value]) => `${key}=${clip(value)}`).join(' ')}` : ''}`,
      );
    }
    lines.push(`  activity: ${activity[id] || 'idle'}`);
  }
  lines.push('', ...hangLines(info.hangLog));
  // `home` may be a list: Node and Electron can disagree on where it is (see copyDiagnostics).
  return [].concat(info.home).reduce(redactHome, lines.join('\n'));
}

module.exports = { formatDiagnostics, redactHome };

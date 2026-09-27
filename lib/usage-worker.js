'use strict';

const { parentPort } = require('worker_threads');
const { collectUsage } = require('./usage');
const { collectCodexUsage } = require('./codex-usage');
const { collectGrokUsage } = require('./grok-usage');

const workerCaches = { claude: new Map(), codex: new Map(), grok: new Map() };

// `prices` is the table main.js has in use (bundled or downloaded); undefined means bundled.
function collectLocalUsage({ ranges = { claude: 1, codex: 1, grok: 1 }, now = Date.now(), prices, caches = workerCaches, options = {} } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const claudeDiagnostics = {};
  const codexDiagnostics = {};
  const grokDiagnostics = {};
  const claude = collectUsage({
    ...options.claude,
    prices,
    rangeDays: ranges.claude,
    now: date,
    cache: caches.claude,
    diagnostics: claudeDiagnostics,
  });
  const codex = collectCodexUsage({
    ...options.codex,
    prices,
    rangeDays: ranges.codex,
    now: date,
    cache: caches.codex,
    diagnostics: codexDiagnostics,
  });
  const grok = collectGrokUsage({
    ...options.grok,
    rangeDays: ranges.grok,
    now: date,
    cache: caches.grok,
    diagnostics: grokDiagnostics,
  });
  return {
    claude,
    codex,
    grok,
    diagnostics: { claude: claudeDiagnostics, codex: codexDiagnostics, grok: grokDiagnostics },
  };
}

if (parentPort) {
  parentPort.on('message', ({ id, ranges, now, prices }) => {
    try {
      parentPort.postMessage({ id, ok: true, value: collectLocalUsage({ ranges, now, prices }) });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: String(error.stack || error) });
    }
  });
}

module.exports = { collectLocalUsage };

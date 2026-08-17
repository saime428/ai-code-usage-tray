'use strict';

const { parentPort } = require('worker_threads');
const { collectUsage } = require('./usage');
const { collectCodexUsage } = require('./codex-usage');

const workerCaches = { claude: new Map(), codex: new Map() };

function collectLocalUsage({ ranges = { claude: 1, codex: 1 }, now = Date.now(), caches = workerCaches, options = {} } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const claudeDiagnostics = {};
  const codexDiagnostics = {};
  const claude = collectUsage({
    ...options.claude,
    rangeDays: ranges.claude,
    now: date,
    cache: caches.claude,
    diagnostics: claudeDiagnostics,
  });
  const codex = collectCodexUsage({
    ...options.codex,
    rangeDays: ranges.codex,
    now: date,
    cache: caches.codex,
    diagnostics: codexDiagnostics,
  });
  return { claude, codex, diagnostics: { claude: claudeDiagnostics, codex: codexDiagnostics } };
}

if (parentPort) {
  parentPort.on('message', ({ id, ranges, now }) => {
    try {
      parentPort.postMessage({ id, ok: true, value: collectLocalUsage({ ranges, now }) });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: String(error.stack || error) });
    }
  });
}

module.exports = { collectLocalUsage };

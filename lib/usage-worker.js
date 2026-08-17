'use strict';

const { parentPort } = require('worker_threads');
const { collectUsage } = require('./usage');
const { collectCodexUsage } = require('./codex-usage');

const workerCaches = { claude: new Map(), codex: new Map() };

function collectLocalUsage({ rangeDays = 1, now = Date.now(), caches = workerCaches, options = {} } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const claudeDiagnostics = {};
  const codexDiagnostics = {};
  const claude = collectUsage({
    ...options.claude,
    rangeDays,
    now: date,
    cache: caches.claude,
    diagnostics: claudeDiagnostics,
  });
  const codex = collectCodexUsage({
    ...options.codex,
    rangeDays,
    now: date,
    cache: caches.codex,
    diagnostics: codexDiagnostics,
  });
  return { claude, codex, diagnostics: { claude: claudeDiagnostics, codex: codexDiagnostics } };
}

if (parentPort) {
  parentPort.on('message', ({ id, rangeDays, now }) => {
    try {
      parentPort.postMessage({ id, ok: true, value: collectLocalUsage({ rangeDays, now }) });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: String(error.stack || error) });
    }
  });
}

module.exports = { collectLocalUsage };

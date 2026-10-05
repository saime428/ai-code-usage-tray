'use strict';

const { parentPort } = require('worker_threads');
const { collectUsage } = require('./usage');
const { collectCodexUsage } = require('./codex-usage');
const { collectGrokUsage } = require('./grok-usage');
const { collectAntigravityUsage } = require('./antigravity-usage');
const { collectOpenCodeUsage } = require('./opencode-usage');
const { MAX_RANGE_DAYS, normalizeRangeDays, rangeBounds } = require('./range');
const { PROVIDER_IDS, buildReport } = require('./report');

const COLLECTORS = {
  claude: collectUsage,
  codex: collectCodexUsage,
  grok: collectGrokUsage,
  antigravity: collectAntigravityUsage,
  opencode: collectOpenCodeUsage,
};

// One cache per provider, shared by the panel snapshot and the report: a file read
// for one is resumed, not re-read, by the other.
const workerCaches = Object.fromEntries(PROVIDER_IDS.map((id) => [id, new Map()]));

// `prices` is the table main.js has in use (bundled or downloaded); undefined means bundled.
// Each provider result keeps `rows` and `sessionMeta` for the report; panelView drops
// them before anything crosses to the main process.
function collectLocalUsage({ ranges = {}, now = Date.now(), prices, since = null, caches = workerCaches, options = {} } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const result = { diagnostics: {} };
  for (const id of PROVIDER_IDS) {
    const diagnostics = {};
    result[id] = COLLECTORS[id]({
      ...options[id],
      prices,
      rangeDays: ranges[id] || 1,
      since,
      now: date,
      cache: (caches[id] ||= new Map()),
      diagnostics,
    });
    result.diagnostics[id] = diagnostics;
  }
  return result;
}

function panelView(local) {
  const view = { diagnostics: local.diagnostics };
  for (const id of PROVIDER_IDS) {
    const { rows, sessionMeta, ...rest } = local[id];
    view[id] = rest;
  }
  return view;
}

// The previous period is compared only while both periods fit in the 90 days a
// range may span, so a 90-day report doesn't read half a year of history.
function collectReport({ days, now = Date.now(), prices, caches = workerCaches, options = {} } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const rangeDays = normalizeRangeDays(days, null);
  if (!rangeDays) throw new RangeError(`report days must be an integer from 1 to ${MAX_RANGE_DAYS}`);
  const range = rangeBounds(date, rangeDays);
  const covered = rangeDays * 2 <= MAX_RANGE_DAYS;
  const since = new Date(range.rangeStart);
  if (covered) since.setDate(since.getDate() - rangeDays);
  const ranges = Object.fromEntries(PROVIDER_IDS.map((id) => [id, rangeDays]));
  const local = collectLocalUsage({ ranges, now: date, prices, since: since.getTime(), caches, options });
  const scans = {};
  const status = {};
  for (const id of PROVIDER_IDS) {
    scans[id] = { rows: local[id].rows, sessions: local[id].sessionMeta };
    status[id] = {
      detected: Boolean(local[id].detected),
      priceSnapshot: local[id].priceSnapshot || null,
      costCoverage: local[id].costCoverage || 'complete',
    };
  }
  const report = buildReport(scans, { days: rangeDays, now: date, previousCovered: covered });
  report.status = status;
  report.diagnostics = local.diagnostics;
  return report;
}

if (parentPort) {
  parentPort.on('message', ({ id, kind, ranges, days, now, prices }) => {
    try {
      const value = kind === 'report'
        ? collectReport({ days, now, prices })
        : panelView(collectLocalUsage({ ranges, now, prices }));
      parentPort.postMessage({ id, ok: true, value });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: String(error.stack || error) });
    }
  });
}

module.exports = { collectLocalUsage, collectReport, panelView, COLLECTORS };

'use strict';
// Claude, Codex and Gemini (Antigravity) price tables. Grok's cost is the billed value
// in its own logs and OpenCode's the value OpenCode recorded per message.
// The data is lib/prices.json: bundled with the app and, because main.js downloads
// that same file from GitHub main, updated on installed copies without a release.
// Every table read from disk or the network is validated here first — a bad one
// would put wrong money on every panel, silently.

const BUNDLED = require('./prices.json');

// ponytail: installed apps fetch exactly this path. Moving or renaming
// lib/prices.json on main strands every copy on the table it shipped with.
const PRICES_URLS = [
  'https://raw.githubusercontent.com/saime428/ai-code-usage-tray/main/lib/prices.json',
  // For networks that can't reach raw.githubusercontent.com. It can lag main by
  // hours, which acceptPrices tolerates: an older table is never taken.
  'https://cdn.jsdelivr.net/gh/saime428/ai-code-usage-tray@main/lib/prices.json',
];
const MAX_BYTES = 256 * 1024;
const MAX_RATE = 10000; // USD per 1M tokens; the priciest real rate is 600
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// The maintainer's "today" can run a day ahead of a user's clock, across time zones.
const CLOCK_SKEW_MS = 2 * 24 * 3600 * 1000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (value, min, max) => typeof value === 'number' && value >= min && value <= max;

// `rejected` tells a table we received but can't use (retry tomorrow) from a network
// failure or a captive-portal page (retry within the hour).
function reject(problem) {
  throw Object.assign(new Error(`price table rejected: ${problem}`), { rejected: true });
}

function checkRows(table, baseline, section, rates, multipliers) {
  if (!isObject(table[section])) reject(`no ${section} section`);
  for (const [id, row] of Object.entries(table[section])) {
    if (!MODEL_ID.test(id) || !isObject(row)) reject(`${section} row ${id}`);
    for (const field of rates) if (!within(row[field], 0, MAX_RATE)) reject(`${section} ${id} ${field}`);
    for (const [field, [min, max]] of Object.entries(multipliers)) {
      if (Object.hasOwn(row, field) && !within(row[field], min, max)) reject(`${section} ${id} ${field}`);
    }
    if (Object.hasOwn(row, 'legacy') && typeof row.legacy !== 'boolean') reject(`${section} ${id} legacy`);
  }
  // Retired models stay listed for old transcripts, so a table missing a row is truncated.
  for (const id of Object.keys(baseline[section])) {
    if (!Object.hasOwn(table[section], id)) reject(`${section} is missing ${id}`);
  }
}

// An optional longContext tier { above, ...rates } prices a whole request at its own rates
// once the prompt exceeds `above` tokens (Gemini Pro over 200k, Claude Haiku 5.5 over 100k).
function checkTiers(table, section, rates) {
  for (const [id, row] of Object.entries(table[section])) {
    if (!Object.hasOwn(row, 'longContext')) continue;
    const tier = row.longContext;
    if (
      !isObject(tier) ||
      !Number.isInteger(tier.above) ||
      tier.above <= 0 ||
      !rates.every((field) => within(tier[field], 0, MAX_RATE))
    ) {
      reject(`${section} ${id} longContext`);
    }
  }
}

// Returns the table when it is usable and throws the first problem otherwise.
// Unknown fields and sections are ignored so older apps keep taking updates; if an
// existing field changes meaning, the schema number must change, which older apps
// refuse — they then keep the table they have instead of misreading the new one.
function validatePrices(table, baseline = BUNDLED, now = Date.now()) {
  if (!isObject(table) || table.schema !== 1) reject('unsupported schema');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(table.snapshot) || Number.isNaN(Date.parse(table.snapshot))) {
    reject('bad snapshot date');
  }
  // A mistyped future date would outrank every later fix in acceptPrices and lock every
  // copy onto this table; not even a release could displace its cached copy.
  if (Date.parse(table.snapshot) > now + CLOCK_SKEW_MS) reject('snapshot is in the future');
  checkRows(table, baseline, 'claude', ['input', 'output'], { cacheRead: [0, 1], fast: [1, 10] });
  // Added in 1.7.2. Older apps ignore it and price Haiku 5.5 at its short-prompt rates throughout.
  checkTiers(table, 'claude', ['input', 'output']);
  checkRows(table, baseline, 'codex', ['input', 'cachedInput', 'output'], {});
  if (!isObject(table.codexAliases)) reject('no codexAliases section');
  for (const [alias, target] of Object.entries(table.codexAliases)) {
    // An alias that is also a row would shadow it: priceFor looks aliases up first.
    if (
      !MODEL_ID.test(alias) ||
      typeof target !== 'string' ||
      !Object.hasOwn(table.codex, target) ||
      Object.hasOwn(table.codex, alias)
    ) {
      reject(`alias ${alias}`);
    }
  }
  for (const alias of Object.keys(baseline.codexAliases)) {
    if (!Object.hasOwn(table.codexAliases, alias)) reject(`codexAliases is missing ${alias}`);
  }
  // Added in 1.6.0. 1.5.0 ignores the section; a table cached before it existed fails
  // here and the app keeps its bundled one until main serves the section.
  checkRows(table, baseline, 'gemini', ['input', 'cachedInput', 'output'], {});
  checkTiers(table, 'gemini', ['input', 'cachedInput', 'output']);
  return table;
}

// The table to switch to, or null to keep `current`. A download (or the cached copy
// of one) must validate and be at least as new, so a mirror lagging behind main
// can't roll prices back. Throws on anything malformed.
function acceptPrices(text, current, baseline = BUNDLED, now = Date.now()) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) reject('empty or oversized');
  const table = validatePrices(JSON.parse(text), baseline, now);
  return table.snapshot >= current.snapshot ? table : null;
}

module.exports = { BUNDLED, PRICES_URLS, validatePrices, acceptPrices };

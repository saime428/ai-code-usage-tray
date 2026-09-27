'use strict';
// Checks lib/prices.json two ways, because each catches what the other can't:
//
//   official  Anthropic's and OpenAI's own pricing pages, read from their markdown
//             (.md) versions, every cell priced through the real costOf(), plus the
//             Codex model page: whatever Codex offers must have a row. Only this
//             notices a model with no row at all — gpt-6-sol priced at zero for weeks
//             because nothing asked the Codex model page what Codex offers.
//   LiteLLM   the community cost map, in two passes: every row we have, and every
//             upstream id our priceFor() resolves — which catches a longer sibling
//             with no row of its own (gpt-5.5-pro billing as gpt-5.5, 6x under).
//
// Both vendors refuse some regions (Anthropic redirects to app-unavailable-in-region,
// OpenAI answers 403), and Node's fetch ignores the system proxy. Behind a proxy:
//   NODE_USE_ENV_PROXY=1 npm run check-prices   (Node 24+, reads HTTPS_PROXY)
//
// Reports drift, never rewrites: the table moves money on every installed copy
// (they download it from main), so a human looks first. Not part of `npm test` —
// tests stay hermetic and offline.
//
// ponytail: report-only. Add --write if hand-editing a few lines a year ever stings.

const fs = require('fs');
const claude = require('../lib/usage');
const codex = require('../lib/codex-usage');
const { BUNDLED } = require('../lib/prices');

// Pass a local path to check LiteLLM offline or behind a proxy that mangles large bodies:
//   curl -sSL <url> -o prices.json && node scripts/check-prices.js prices.json
const SOURCE =
  process.argv[2] ||
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OFFICIAL = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
  openai: 'https://developers.openai.com/api/docs/pricing.md',
  codexModels: 'https://developers.openai.com/codex/models.md',
};
const FETCH_TIMEOUT_MS = 30_000;
// Stay under Codex's 272k long-context tier so costOf() doesn't apply that 2x.
const N = 100_000;
const M = 1_000_000;
const LONG = 300_000; // over 272k: the long-context rates apply to the whole request
const REGIONAL = /^(?!global\.)[a-z][a-z-]*\.anthropic[./]/;

const rate = (entry, field) => (typeof entry[field] === 'number' ? entry[field] * N : null);
// Float noise is ~1e-15 here; the cheapest real rate is 0.01/MTok.
const differs = (a, b) => a === null || Math.abs(a - b) > 1e-9;

// What each token kind should cost upstream, and the call that produces ours.
const CLAUDE_KINDS = [
  ['input', 'input_cost_per_token', { input: N }],
  ['output', 'output_cost_per_token', { output: N }],
  ['cache read', 'cache_read_input_token_cost', { cacheRead: N }],
  ['cache write 5m', 'cache_creation_input_token_cost', { cacheWrite: N }],
  ['cache write 1h', 'cache_creation_input_token_cost_above_1hr', { cacheWrite: N, cacheWrite1h: N }],
];
const CODEX_KINDS = [
  ['input', 'input_cost_per_token', { input: N }],
  ['output', 'output_cost_per_token', { output: N }],
  ['cached input', 'cache_read_input_token_cost', { input: N, cacheRead: N }],
];

const REGION_HINT = 'blocked region? behind a proxy, rerun with NODE_USE_ENV_PROXY=1';

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} (${REGION_HINT})`);
  return response.text();
}

// A region block answers 200 with an HTML page elsewhere, so insist on markdown.
async function officialPage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.startsWith('text/markdown')) {
    throw new Error(`${url} → HTTP ${response.status} ${type} from ${response.url} (${REGION_HINT})`);
  }
  return response.text();
}

async function load() {
  if (!/^https?:/.test(SOURCE)) return JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  return JSON.parse(await fetchText(SOURCE));
}

// The first markdown table after `marker`, one object per row keyed by header text.
function tableAfter(md, marker) {
  const start = md.indexOf(marker);
  if (start < 0) return [];
  const lines = md.slice(start).split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  if (first < 0) return [];
  const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());
  const header = cells(lines[first]);
  const rows = [];
  for (let i = first + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    rows.push(Object.fromEntries(cells(lines[i]).map((cell, j) => [header[j], cell])));
  }
  return rows;
}

const column = (row, pattern) => row[Object.keys(row).find((key) => pattern.test(key))];
const dollars = (cell) => {
  const match = /\$([\d.]+)/.exec(cell || '');
  return match ? Number(match[1]) : null;
};

// "Claude Opus 4.1 ([retired…])" → claude-opus-4-1; the 3.x generation put the
// version first (claude-3-5-haiku). One cell can name several: "Claude Opus 5 / Claude Opus 4.8".
function claudeIds(cell) {
  return [...String(cell).matchAll(/Claude (\w+) (\d+(?:\.\d+)*)/g)].map(([, family, version]) => {
    const [name, v] = [family.toLowerCase(), version.replace(/\./g, '-')];
    return Number(version.split('.')[0]) < 4 ? `claude-${v}-${name}` : `claude-${name}-${v}`;
  });
}

async function checkOfficial() {
  const drift = [];
  const notes = [];
  const blind = [];
  let verified = 0;
  const compare = (label, ours, official) => {
    verified += 1;
    if (Math.abs(ours - official) > 1e-9) drift.push(`official  ${label}  ${ours} → ${official}  (per 1M tokens)`);
  };

  const anthropic = await officialPage(OFFICIAL.anthropic);
  const claudeRows = tableAfter(anthropic, '## Model pricing');
  if (!claudeRows.length) blind.push(`${OFFICIAL.anthropic}: no "Model pricing" table`);
  const claudeSeen = new Set();
  const claudeCells = [
    ['input', /base input/i, { input: M }],
    ['cache write 5m', /5m cache/i, { cacheWrite: M }],
    ['cache write 1h', /1h cache/i, { cacheWrite: M, cacheWrite1h: M }],
    ['cache read', /cache hits/i, { cacheRead: M }],
    ['output', /output/i, { output: M }],
  ];
  for (const row of claudeRows) {
    const ids = claudeIds(row.Model);
    if (!ids.length) drift.push(`official  unrecognized Claude row "${row.Model}" — map it by hand`);
    for (const id of ids) {
      claudeSeen.add(id);
      if (!claude.priceFor(id)) {
        drift.push(`official  ${id}  has no row in lib/prices.json`);
        continue;
      }
      for (const [label, pattern, tokens] of claudeCells) {
        const official = dollars(column(row, pattern));
        if (official === null) blind.push(`${OFFICIAL.anthropic}: ${id} has no readable "${label}" cell`);
        else compare(`${id}  ${label}`, claude.costOf(id, tokens), official);
      }
    }
  }
  for (const row of tableAfter(anthropic, '### Fast mode pricing')) {
    for (const id of claudeIds(row.Model)) {
      compare(`${id}  fast input`, claude.costOf(id, { input: M, speed: 'fast' }), dollars(row.Input));
      compare(`${id}  fast output`, claude.costOf(id, { output: M, speed: 'fast' }), dollars(row.Output));
    }
  }
  for (const id of Object.keys(claude.PRICES)) {
    if (claudeRows.length && !claudeSeen.has(id)) notes.push(`official  ${id}  is no longer on the pricing page`);
  }

  const openai = await officialPage(OFFICIAL.openai);
  const standard = tableAfter(openai, '### Standard pricing data');
  const cyber = tableAfter(openai, 'Cyber models');
  if (!standard.length) blind.push(`${OFFICIAL.openai}: no "Standard pricing data" table`);
  if (!cyber.length) blind.push(`${OFFICIAL.openai}: no "Cyber models" table`);
  const codexSeen = new Set();
  for (const row of [...standard, ...cyber]) {
    const id = String(row.Model).replace(/\s*\(.*\)$/, '');
    // Whatever our priceFor resolves — aliases and longer siblings included — must price as
    // the page says; the rest are models Codex doesn't offer (coverage is checked below).
    if (!codex.priceFor(id)) continue;
    codexSeen.add(id);
    const cost = (tokens) => codex.costOf(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens });
    const input = dollars(column(row, /^short context input$/i));
    const output = dollars(column(row, /^short context output$/i));
    if (input === null || output === null) {
      blind.push(`${OFFICIAL.openai}: ${id} has no readable short-context input/output`);
      continue;
    }
    compare(`${id}  input`, (cost({ input: N }) * M) / N, input);
    compare(`${id}  output`, cost({ output: M }), output);
    // "-" means no cached-input rate: cached tokens bill at the input rate.
    compare(`${id}  cached input`, (cost({ input: N, cacheRead: N }) * M) / N,
      dollars(column(row, /^short context cached input$/i)) ?? input);
    const longInput = dollars(column(row, /^long context input$/i));
    const longOutput = dollars(column(row, /^long context output$/i));
    if (longInput !== null) compare(`${id}  long input`, (cost({ input: LONG }) * M) / LONG, longInput);
    if (longOutput !== null) compare(`${id}  long output`, cost({ input: LONG, output: M }) - cost({ input: LONG }), longOutput);
  }
  // Nothing matched at all means the Model cells changed shape, not that every row left.
  if (standard.length && !codexSeen.size) blind.push(`${OFFICIAL.openai}: no row matched the codex table`);
  for (const id of Object.keys(codex.PRICES)) {
    if (codexSeen.size && !codexSeen.has(id)) notes.push(`official  ${id}  is no longer on the pricing page`);
  }

  // Coverage: whatever the Codex model page offers must price, or it shows as $0.
  const codexModels = await officialPage(OFFICIAL.codexModels);
  const offered = [...new Set([...codexModels.matchAll(/slug="([^"]+)"/g)].map((m) => m[1]))];
  if (!offered.length) blind.push(`${OFFICIAL.codexModels}: no model slugs`);
  for (const id of offered) {
    verified += 1;
    if (!codex.priceFor(id)) drift.push(`official  ${id}  is offered in Codex but has no row in lib/prices.json`);
  }
  return { drift, notes, blind, verified };
}

async function checkLiteLLM() {
  const upstream = await load();
  const drift = [];
  const missing = [];
  const resolved = [];
  const notes = [];
  let verified = 0;

  // Our keys are undated prefixes (priceFor matches by prefix); retired models
  // only exist upstream under a dated id. Anchor to \d{8} or claude-opus-4
  // would happily "resolve" to claude-opus-4-8.
  const lookup = (key) => {
    if (upstream[key]) return upstream[key];
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dated = Object.keys(upstream).find((k) => new RegExp(`^${escaped}-\\d{8}$`).test(k));
    if (!dated) return null;
    resolved.push(`${key} → ${dated}`);
    return upstream[dated];
  };

  const comparePriced = (section, model, kinds, costOf, flatContextTiers) => {
    const entry = lookup(model);
    if (!entry) {
      missing.push(`${section}  ${model}`);
      return;
    }
    verified += 1;
    for (const [label, field, tokens] of kinds) {
      const theirs = rate(entry, field);
      if (theirs === null) continue; // upstream doesn't publish this kind for this model
      const ours = costOf(model, tokens);
      if (differs(theirs, ours)) {
        drift.push(`${section}  ${model}  ${label}  ${ours} → ${theirs}  (per ${N.toLocaleString()} tokens)`);
      }
    }
    // Long-context tiers we deliberately price flat (1h cache writes ARE modeled
    // and verified above) — flag so they are not rediscovered every few months.
    if (!flatContextTiers) return;
    const tier = Object.keys(entry).find((f) => /^input_cost_per_token_above_\d+k_tokens$/.test(f));
    if (tier) {
      const threshold = tier.match(/above_(\d+k)_tokens/)[1];
      notes.push(`${section}  ${model}  upstream has a >${threshold} tier (input ${entry[tier] * 1e6}/MTok)`);
    }
  };

  for (const model of Object.keys(claude.PRICES)) {
    // Claude long-context tiers are unmodeled; Codex's 272k tier is (2x/1.5x in costOf).
    comparePriced('claude', model, CLAUDE_KINDS, claude.costOf, true);
  }
  for (const model of Object.keys(codex.PRICES)) {
    comparePriced('codex', model, CODEX_KINDS, codex.costOf, false);
  }

  // Pass 2: any upstream id we resolve but price differently is a missing row.
  for (const [id, entry] of Object.entries(upstream)) {
    if (!entry || typeof entry !== 'object' || typeof entry.input_cost_per_token !== 'number') continue;
    const claudePrice = claude.priceFor(id);
    const price = claudePrice || codex.priceFor(id);
    if (!price) continue;
    // Cloud inference profiles carry platform pricing we only approximate: we
    // apply Anthropic's documented 1.1x regional premium, but upstream also has
    // us-gov at 1.2x, retired models on Bedrock's own scale (Haiku 3.5 is
    // $0.25/MTok there, not $0.80), and at least one entry that contradicts its
    // own sibling. Pass 2 hunts missing model rows, not platform variance.
    if (REGIONAL.test(id)) continue;
    const costOf = claudePrice ? claude.costOf : codex.costOf;
    const theirs = rate(entry, 'input_cost_per_token');
    const ours = costOf(id, { input: N });
    if (differs(theirs, ours) && !Object.hasOwn(claude.PRICES, id) && !Object.hasOwn(codex.PRICES, id)) {
      drift.push(`unlisted id  ${id}  resolves to ${ours} → upstream ${theirs}  (per ${N.toLocaleString()} tokens)`);
    }
  }
  return { drift, missing, resolved, notes, verified };
}

const section = (title, lines) => {
  if (!lines.length) return;
  console.log(`${title}:`);
  for (const line of lines) console.log(`  ${line}`);
  console.log('');
};

async function main() {
  const official = await checkOfficial();
  const litellm = await checkLiteLLM();

  console.log(`lib/prices.json snapshot: ${BUNDLED.snapshot}`);
  console.log(`official pages: ${official.verified} value(s) checked`);
  console.log(`LiteLLM (${SOURCE}): ${litellm.verified} model(s) checked\n`);
  section('LiteLLM matched via dated upstream id', litellm.resolved);
  section('not listed on LiteLLM (check by hand — the model may be real)', litellm.missing);
  section('known, unmodeled upstream fields', [...new Set(litellm.notes)]);
  section('notes', official.notes);

  if (official.blind.length || !official.verified) {
    section('OFFICIAL PAGES UNREADABLE — their format probably changed; fix tableAfter() or the column patterns', official.blind);
    process.exitCode = 1;
  }
  if (!litellm.verified) {
    console.log('LITELLM CHECK IS BLIND — upstream key names probably changed.\n');
    process.exitCode = 1;
  }
  const drift = [...official.drift, ...litellm.drift];
  if (!drift.length) {
    if (!process.exitCode) console.log('no drift.');
    return;
  }

  console.log('DRIFT — ours → theirs:');
  for (const line of drift) console.log(`  ${line}`);
  console.log(`
${drift.length} difference(s). To fix:
  1. "official" lines come from the vendors' pages; confirm LiteLLM lines there too:
       https://platform.claude.com/docs/en/about-claude/pricing
       https://developers.openai.com/api/docs/pricing
  2. Edit lib/prices.json: the claude or codex section, one row per model.
       Add a row if the model has none ("has no row" and "unlisted id" lines mean exactly that).
       Key = model id without date suffix; the longest matching key wins.
  3. Set "snapshot" in lib/prices.json to today's date.
  4. npm test, commit, push to main: installed apps (1.5.0+) pick it up within a day.
     Full write-up: README, "Updating the price table".`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`price check failed: ${error.message}`);
  process.exitCode = 2;
});

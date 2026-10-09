'use strict';
// Checks lib/prices.json two ways, because each catches what the other can't:
//
//   official  Anthropic's, OpenAI's and Google's (Gemini, for Antigravity) own pricing
//             pages, read from their markdown versions, every cell priced through the
//             real costOf(), plus the
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
const antigravity = require('../lib/antigravity-usage');
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
  // Google serves the markdown at .md.txt (plain .md answers with the HTML page).
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing.md.txt',
};
// Gemini sections that aren't chat models: their prices are per image, second or song,
// and an id like gemini-2.5-flash-image would prefix-match a text row.
const GEMINI_NOT_TEXT = /image|tts|live|audio|transcribe|embedding|robotics|omni|veo|lyria|gemma/i;
const FETCH_TIMEOUT_MS = 30_000;
// Stay under Codex's 272k long-context tier so costOf() doesn't apply that 2x. This also sits
// exactly on Claude Haiku 5.5's 100,000 boundary, which is not over: raising N would compare
// LiteLLM's short-prompt rates against Haiku's long tier.
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
// Antigravity's input excludes its cache reads, unlike Codex's.
const GEMINI_KINDS = [
  ['input', 'input_cost_per_token', { input: N }],
  ['output', 'output_cost_per_token', { output: N }],
  ['cached input', 'cache_read_input_token_cost', { cacheRead: N }],
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
  // Haiku 5.5 is priced by prompt length, one row per tier: "(for prompts up to 100,000
  // tokens)" and "(for prompts over 100,000 tokens)". Each row is checked inside its tier:
  // under it with a request of exactly the official threshold (so a table threshold below the
  // page's shows up as drift, and "exactly N is not over" is checked live), over it by padding
  // the prompt past the threshold and taking the padding's cost back out.
  const tierCost = (id, tokens, tier) => {
    if (!tier) return claude.costOf(id, tokens);
    const above = Number(tier[2].replace(/,/g, ''));
    if (/up to/i.test(tier[1])) {
      const k = above / M;
      return claude.costOf(id, Object.fromEntries(Object.entries(tokens).map(([kind, n]) => [kind, n * k]))) / k;
    }
    const pad = above + 1;
    return claude.costOf(id, { ...tokens, input: (tokens.input || 0) + pad }) - claude.costOf(id, { input: pad });
  };
  for (const row of claudeRows) {
    const ids = claudeIds(row.Model);
    if (!ids.length) drift.push(`official  unrecognized Claude row "${row.Model}" — map it by hand`);
    const tier = /prompts (up to|over) ([\d,]+) tokens/i.exec(row.Model);
    for (const id of ids) {
      claudeSeen.add(id);
      if (!claude.priceFor(id)) {
        drift.push(`official  ${id}  has no row in lib/prices.json`);
        continue;
      }
      for (const [label, pattern, tokens] of claudeCells) {
        const official = dollars(column(row, pattern));
        const where = tier ? `${label} (prompts ${tier[1]} ${tier[2]})` : label;
        if (official === null) blind.push(`${OFFICIAL.anthropic}: ${id} has no readable "${where}" cell`);
        else compare(`${id}  ${where}`, tierCost(id, tokens, tier), official);
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

  // Gemini: one "## Model" section per model, its ids in `code` spans, a "### Standard"
  // table whose paid-tier cell reads "$2.00, prompts <= 200k tokens $4.00, prompts > 200k".
  const gemini = await officialPage(OFFICIAL.gemini);
  const geminiSeen = new Set();
  const keyOf = (row) => Object.keys(BUNDLED.gemini).find((key) => BUNDLED.gemini[key] === row);
  for (const section of gemini.split('\n## ').slice(1)) {
    const title = section.split('\n')[0];
    if (GEMINI_NOT_TEXT.test(title)) continue;
    const ids = [...section.matchAll(/\[`([a-z0-9][a-z0-9.-]*)`\]/g)].map((m) => m[1]);
    const standard = section.split('\n### Standard')[1];
    if (!ids.length || !standard) continue;
    const cell = (label) => {
      const line = standard.split('\n').find((l) => l.startsWith(`| ${label}`));
      return line ? line.split('|').slice(1, -1).pop().trim() : null;
    };
    const rates = (label) => {
      const text = cell(label);
      const amounts = [...String(text || '').matchAll(/\$([\d.]+)/g)].map((m) => Number(m[1]));
      return { base: amounts[0] ?? null, long: /\\?>\s*200k/i.test(text || '') ? amounts[1] ?? null : null, text };
    };
    const input = rates('Input price');
    const output = rates('Output price');
    const cached = rates('Context caching price');
    for (const id of ids) {
      const row = antigravity.geminiPriceFor(id);
      if (!row) continue; // a model Antigravity hasn't sent; nothing to price yet
      geminiSeen.add(keyOf(row));
      if (input.base === null || output.base === null) {
        blind.push(`${OFFICIAL.gemini}: ${id} has no readable Standard input/output`);
        continue;
      }
      const cost = (tokens) => antigravity.costOf(id, { input: 0, cacheRead: 0, output: 0, ...tokens });
      // 100k tokens: a million would cross the 200k long-context line on the Pro rows.
      compare(`${id}  input`, (cost({ input: N }) * M) / N, input.base);
      compare(`${id}  output`, cost({ output: M }), output.base);
      if (cached.base !== null) compare(`${id}  cached input`, cost({ cacheRead: M / 10 }) * 10, cached.base);
      const LONG_PROMPT = 300_000; // over 200k: the long-tier rates apply to the whole call
      if (input.long !== null) compare(`${id}  long input`, (cost({ input: LONG_PROMPT }) * M) / LONG_PROMPT, input.long);
      if (output.long !== null) compare(`${id}  long output`, cost({ input: LONG_PROMPT, output: M }) - cost({ input: LONG_PROMPT }), output.long);
      if (/starting [A-Z][a-z]+ \d+, \d{4}/.test(input.text || '')) notes.push(`official  ${id}  has a dated price change: ${input.text}`);
    }
  }
  if (!geminiSeen.size) blind.push(`${OFFICIAL.gemini}: no section matched the gemini table`);
  for (const id of Object.keys(BUNDLED.gemini)) {
    if (geminiSeen.size && !geminiSeen.has(id)) notes.push(`official  ${id}  is no longer on the pricing page`);
  }
  return { drift, notes, blind, verified };
}

async function checkLiteLLM() {
  const upstream = await load();
  const drift = [];
  const missing = [];
  const resolved = [];
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

  const comparePriced = (section, model, kinds, costOf) => {
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
  };

  for (const model of Object.keys(claude.PRICES)) comparePriced('claude', model, CLAUDE_KINDS, claude.costOf);
  for (const model of Object.keys(codex.PRICES)) comparePriced('codex', model, CODEX_KINDS, codex.costOf);
  // LiteLLM files Gemini API rows as gemini/<id>, often only under a -preview id.
  for (const model of Object.keys(BUNDLED.gemini)) {
    const key = [`gemini/${model}`, model, `gemini/${model}-preview`].find((k) => upstream[k]) || `gemini/${model}`;
    const cost = (_id, tokens) => antigravity.costOf(model, { input: 0, cacheRead: 0, output: 0, ...tokens });
    const before = missing.length;
    comparePriced('gemini', key, GEMINI_KINDS, cost);
    if (missing.length > before) missing[missing.length - 1] = `gemini  ${model}`;
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
  // The same hunt for Gemini text models (gemini/<id>), e.g. a -lite sibling with no row.
  for (const [id, entry] of Object.entries(upstream)) {
    const bare = id.replace(/^gemini\//, '');
    if (bare === id || GEMINI_NOT_TEXT.test(bare) || !entry || typeof entry.input_cost_per_token !== 'number') continue;
    if (!antigravity.geminiPriceFor(bare) || Object.hasOwn(BUNDLED.gemini, bare)) continue;
    const ours = antigravity.costOf(bare, { input: N, cacheRead: 0, output: 0 });
    if (differs(rate(entry, 'input_cost_per_token'), ours)) {
      drift.push(`unlisted id  ${id}  resolves to ${ours} → upstream ${rate(entry, 'input_cost_per_token')}  (per ${N.toLocaleString()} tokens)`);
    }
  }
  return { drift, missing, resolved, verified };
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
       https://ai.google.dev/gemini-api/docs/pricing
  2. Edit lib/prices.json: the claude, codex or gemini section, one row per model.
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

'use strict';
// Compares the hardcoded price tables against LiteLLM's model cost map — the only
// machine-readable source for these numbers (Anthropic and OpenAI both publish
// pricing as HTML docs only; /v1/models carries no price field).
//
// Reports drift, never rewrites: the tables change a few times a year, and a
// community-maintained feed deserves a human glance before it moves a money
// display. Not part of `npm test` — tests stay hermetic and offline.
//
// Two passes, because they fail differently:
//   1. every table key, priced through the real costOf() — catches a rate or
//      multiplier that moved under us.
//   2. every upstream id our priceFor() resolves — catches a model we have NO
//      row for that silently prefix-matches a cheaper sibling. That is how
//      gpt-5.5-pro billed as gpt-5.5 (6x under) went unnoticed.
//
// ponytail: report-only. Add --write if hand-editing 2 lines a year ever stings.

const fs = require('fs');
const claude = require('../lib/usage');
const codex = require('../lib/codex-usage');

// Pass a local path to check offline or behind a proxy that mangles large bodies:
//   curl -sSL <url> -o prices.json && node scripts/check-prices.js prices.json
const SOURCE =
  process.argv[2] ||
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FETCH_TIMEOUT_MS = 30_000;
// Stay under Codex's 272k long-context tier so costOf() doesn't apply that 2x.
const N = 100_000;
const REGIONAL = /^(?!global\.)[a-z][a-z-]*\.anthropic[./]/;

const rate = (entry, field) => (typeof entry[field] === 'number' ? entry[field] * N : null);
// Float noise is ~1e-15 here; the cheapest real rate is 0.02/MTok.
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

async function load() {
  if (!/^https?:/.test(SOURCE)) return JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const response = await fetch(SOURCE, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${SOURCE} → HTTP ${response.status}`);
  return response.json();
}

async function main() {
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

  const comparePriced = (file, model, kinds, costOf, flatContextTiers) => {
    const entry = lookup(model);
    if (!entry) {
      missing.push(`${file}  ${model}`);
      return;
    }
    verified += 1;
    for (const [label, field, tokens] of kinds) {
      const theirs = rate(entry, field);
      if (theirs === null) continue; // upstream doesn't publish this kind for this model
      const ours = costOf(model, tokens);
      if (differs(theirs, ours)) {
        drift.push(`${file}  ${model}  ${label}  ${ours} → ${theirs}  (per ${N.toLocaleString()} tokens)`);
      }
    }
    // Long-context tiers we deliberately price flat (1h cache writes ARE modeled
    // and verified above) — flag so they are not rediscovered every few months.
    if (!flatContextTiers) return;
    const tier = Object.keys(entry).find((f) => /^input_cost_per_token_above_\d+k_tokens$/.test(f));
    if (tier) {
      const threshold = tier.match(/above_(\d+k)_tokens/)[1];
      notes.push(`${file}  ${model}  upstream has a >${threshold} tier (input ${entry[tier] * 1e6}/MTok)`);
    }
  };

  for (const model of Object.keys(claude.PRICES)) {
    // Claude long-context tiers are unmodeled; Codex's 272k tier is (2x/1.5x in costOf).
    comparePriced('lib/usage.js', model, CLAUDE_KINDS, claude.costOf, true);
  }
  for (const model of Object.keys(codex.PRICES)) {
    comparePriced('lib/codex-usage.js', model, CODEX_KINDS, codex.costOf, false);
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
    if (differs(theirs, ours) && !Object.keys(claude.PRICES).includes(id) && !Object.keys(codex.PRICES).includes(id)) {
      drift.push(`unlisted id  ${id}  resolves to ${ours} → upstream ${theirs}  (per ${N.toLocaleString()} tokens)`);
    }
  }

  console.log(`source: ${SOURCE}`);
  console.log(`snapshot in code: ${claude.PRICE_SNAPSHOT} (claude) / ${codex.PRICE_SNAPSHOT} (codex)`);
  console.log(`verified ${verified} model(s) against upstream rates\n`);

  const section = (title, lines) => {
    if (!lines.length) return;
    console.log(`${title}:`);
    for (const line of lines) console.log(`  ${line}`);
    console.log('');
  };
  section('matched via dated upstream id', resolved);
  section('not listed upstream (check by hand — the model may be real)', missing);
  section('known, unmodeled upstream fields', [...new Set(notes)]);

  if (!verified) {
    console.log('NOTHING VERIFIED — upstream key names probably changed. This check is blind.');
    process.exitCode = 1;
    return;
  }
  if (!drift.length) {
    console.log('no drift.');
    return;
  }

  console.log('DRIFT — ours → upstream:');
  for (const line of drift) console.log(`  ${line}`);
  console.log(`
${drift.length} difference(s). To fix:
  1. Confirm each line against the official pages (LiteLLM is community data):
       https://platform.claude.com/docs/en/about-claude/pricing
       https://developers.openai.com/api/docs/pricing
  2. Edit that model's row in the PRICES object of the file named above:
       lib/usage.js for claude-*, lib/codex-usage.js for gpt-*.
       Add a row if the model has none (an "unlisted id" line means exactly that).
       Key = model id without date suffix; the longest matching key wins.
  3. Set PRICE_SNAPSHOT to today's date in BOTH lib/usage.js and lib/codex-usage.js.
  4. npm test, then commit. Full write-up: README, "How the cost is computed".`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`price check failed: ${error.message}`);
  process.exitCode = 2;
});

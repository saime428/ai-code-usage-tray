'use strict';
// CLI sanity check: prints today's Claude and Codex usage from local sessions.
// Run with: npm run usage
const { collectUsage } = require('../lib/usage');
const { collectCodexUsage } = require('../lib/codex-usage');

const u = collectUsage();
console.log(`\nClaude Code usage — ${u.date}\n`);

const rows = Object.entries(u.byModel).map(([model, b]) => ({
  model,
  requests: b.requests,
  input: b.input,
  output: b.output,
  cacheRead: b.cacheRead,
  cacheWrite: b.cacheWrite,
  'est.$': +b.costUSD.toFixed(4),
}));
if (u.costCoverage === 'unavailable') {
  console.log('Claude Desktop quota is available, but local token detail is unavailable; cost cannot be calculated.');
} else if (rows.length === 0) {
  console.log('No usage recorded today.');
} else {
  console.table(rows);
  const incomplete = u.costCoverage === 'partial' || u.unknownModels.length > 0;
  console.log(
    `TOTAL  in=${u.totals.input}  out=${u.totals.output}  cacheR=${u.totals.cacheRead}  cacheW=${u.totals.cacheWrite}  ≈$${u.costUSD.toFixed(2)}${incomplete ? '+' : ''} (API-equivalent)`,
  );
}
if (u.unknownModels.length) {
  console.log(`Unpriced models (tokens counted, cost=0): ${u.unknownModels.join(', ')}`);
}
const limits = [
  ['5h', u.rateLimits && u.rateLimits.fiveHour],
  ['7d', u.rateLimits && u.rateLimits.sevenDay],
].filter(([, value]) => value);
if (limits.length) {
  console.log(`Limits  ${limits.map(([label, value]) => `${label}=${Math.round(value.usedPercentage)}%`).join('  ')}`);
}
console.log(`\nSessions in last 24h: ${u.sessions.length}`);
for (const s of u.sessions.slice(0, 10)) {
  const mins = Math.round((Date.now() - s.mtime) / 60000);
  const state = {
    working: ['●', 'working'],
    waiting: ['◐', 'waiting'],
    attention: ['!', 'attention'],
    idle: ['○', 'idle'],
  }[s.state] || ['○', 'idle'];
  console.log(`  ${state[0]} ${s.project}  (${state[1]}, ${mins}m ago)`);
}

const c = collectCodexUsage();
console.log(`\nCodex usage — ${c.date}\n`);
const codexRows = Object.entries(c.byModel).map(([model, b]) => ({
  model,
  turns: b.requests,
  input: b.input,
  output: b.output,
  cacheRead: b.cacheRead,
  reasoning: b.reasoning,
  'est.$': +b.costUSD.toFixed(4),
}));
if (codexRows.length) {
  console.table(codexRows);
  console.log(`TOTAL  ≈$${c.costUSD.toFixed(2)} (API-equivalent)`);
} else console.log('No usage recorded today.');
if (c.unknownModels.length) {
  console.log(`Unpriced models (tokens counted, cost=0): ${c.unknownModels.join(', ')}`);
}
const codexLimits = (c.rateLimits && c.rateLimits.windows) || [];
if (codexLimits.length) {
  console.log(
    `Limits  ${codexLimits
      .map((limit) => `${limit.windowMinutes}m=${Math.round(limit.usedPercentage)}%`)
      .join('  ')}`,
  );
}
console.log(`\nSessions in last 24h: ${c.sessions.length}`);
for (const s of c.sessions.slice(0, 10)) {
  const mins = Math.round((Date.now() - s.mtime) / 60000);
  console.log(`  ${s.state === 'working' ? '●' : '○'} ${s.project}  (${s.client}, ${s.state}, ${mins}m ago)`);
}

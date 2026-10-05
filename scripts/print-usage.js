'use strict';
// Command-line view of the same numbers the tray shows, read straight from local data.
//
//   npm run usage                                  today, per tool: models, limits, sessions
//   npm run usage -- --days 30                     30-day report: per tool and per day
//   npm run usage -- --days 7 --by project         …or broken down by tool|day|hour|model|project|session
//
// Report mode is lib/report.js buildReport, the same builder as the report window.
const { collectLocalUsage, collectReport } = require('../lib/usage-worker');
const { PROVIDERS, PROVIDER_IDS } = require('../lib/report');
const { MAX_RANGE_DAYS } = require('../lib/range');

const BY = ['tool', 'day', 'hour', 'model', 'project', 'session'];

function parseArgs(argv) {
  const args = { days: null, by: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (flag === '--days' || flag === '--by') {
      if (inline === undefined) i += 1;
      args[flag.slice(2)] = value;
    } else if (flag === '--help' || flag === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (args.days !== null) {
    args.days = Number(args.days);
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > MAX_RANGE_DAYS) {
      throw new Error(`--days must be an integer from 1 to ${MAX_RANGE_DAYS}`);
    }
  }
  if (args.by !== null && !BY.includes(args.by)) throw new Error(`--by must be one of ${BY.join(', ')}`);
  return args;
}

const tokens = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const money = (n) => +n.toFixed(n >= 100 ? 0 : 2);
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const BASIS = { api: 'API-equivalent', billed: 'official billed value', recorded: 'value OpenCode recorded' };

function printToday() {
  const local = collectLocalUsage({ ranges: Object.fromEntries(PROVIDER_IDS.map((id) => [id, 1])) });
  for (const id of PROVIDER_IDS) {
    const u = local[id];
    const { name, costBasis } = PROVIDERS[id];
    if (id !== 'claude' && !u.detected) continue;
    console.log(`\n${name} usage — ${u.date}\n`);
    const rows = Object.entries(u.byModel).map(([model, b]) => ({
      model,
      requests: b.requests,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      [id === 'claude' ? 'cacheWrite' : 'reasoning']: id === 'claude' ? b.cacheWrite : b.reasoning,
      $: u.unknownModels.includes(model) ? 'n/a' : +b.costUSD.toFixed(4),
    }));
    if (id === 'claude' && u.costCoverage === 'unavailable') {
      console.log('Claude Desktop quota is available, but local token detail is unavailable; cost cannot be calculated.');
    } else if (!rows.length) {
      console.log('No usage recorded today.');
    } else {
      console.table(rows);
      const incomplete = u.costCoverage === 'partial' || u.unknownModels.length > 0;
      console.log(`TOTAL  ≈$${u.costUSD.toFixed(2)}${incomplete ? '+' : ''} (${BASIS[costBasis]})`);
    }
    if (u.unknownModels.length) console.log(`Unpriced models (tokens counted, cost=0): ${u.unknownModels.join(', ')}`);
    const limits = id === 'claude'
      ? [['5h', u.rateLimits && u.rateLimits.fiveHour], ['7d', u.rateLimits && u.rateLimits.sevenDay]].filter(([, v]) => v)
      : ((u.rateLimits && u.rateLimits.windows) || []).map((w) => [`${w.windowMinutes}m`, w]);
    if (limits.length) {
      console.log(`Limits  ${limits.map(([label, v]) => `${label}=${Math.round(v.usedPercentage)}%`).join('  ')}${u.rateLimits.planType ? `  (${u.rateLimits.planType})` : ''}`);
    }
    console.log(`\nSessions in last 24h: ${u.sessions.length}`);
    for (const s of u.sessions.slice(0, 10)) {
      const mins = Math.round((Date.now() - s.mtime) / 60000);
      const mark = { working: '●', attention: '!' }[s.state] || '○';
      console.log(`  ${mark} ${s.title || s.project}  (${s.client}, ${s.state}, ${mins}m ago)`);
    }
  }
}

function printReport(days, by) {
  const report = collectReport({ days });
  const present = PROVIDER_IDS.filter((id) => report.status[id].detected || report.providers[id].total > 0);
  const totalCost = present.reduce((sum, id) => sum + report.providers[id].costUSD, 0);
  console.log(`\nUsage report — ${report.range.date} (${days} day${days > 1 ? 's' : ''})\n`);
  if (!by || by === 'tool') {
    console.table(present.map((id) => {
      const s = report.providers[id];
      return {
        tool: PROVIDERS[id].name,
        $: money(s.costUSD),
        share: pct(s.costUSD, totalCost),
        ...(report.previous.covered ? { 'prev $': money(s.previousCostUSD) } : {}),
        tokens: tokens(s.total),
        cacheHit: pct(s.cacheRead, s.prompt),
        requests: s.requests,
        sessions: s.sessions,
        basis: BASIS[PROVIDERS[id].costBasis],
      };
    }));
  }
  const sumOf = (providers, key) => present.reduce((sum, id) => sum + ((providers[id] || {})[key] || 0), 0);
  if (by === 'day' || (!by && days > 1)) {
    console.table(report.daily.map((d) => ({
      day: d.day,
      $: money(sumOf(d.providers, 'costUSD')),
      tokens: tokens(sumOf(d.providers, 'total')),
      ...Object.fromEntries(present.map((id) => [PROVIDERS[id].name, money((d.providers[id] || {}).costUSD || 0)])),
    })));
  }
  if (by === 'hour') {
    console.table(report.hourly.map((h) => ({ hour: `${h.hour}:00`, $: money(sumOf(h.providers, 'costUSD')), tokens: tokens(sumOf(h.providers, 'total')) })));
  }
  if (by === 'model') {
    console.table(report.models.map((m) => ({
      model: m.model,
      tool: PROVIDERS[m.provider].name,
      requests: m.requests,
      input: tokens(m.prompt),
      cacheRead: tokens(m.cacheRead),
      output: tokens(m.output),
      $: m.priced ? money(m.costUSD) : 'n/a',
    })));
  }
  if (by === 'project') {
    console.table(report.projects.slice(0, 30).map((p) => ({
      project: p.name,
      tools: Object.keys(p.providers).map((id) => PROVIDERS[id].name).join(' '),
      $: money(p.costUSD),
      tokens: tokens(p.total),
      sessions: p.sessions,
      path: p.cwd,
    })));
  }
  if (by === 'session') {
    console.table(report.sessions.slice(0, 30).map((s) => ({
      session: String(s.title || s.project || s.sessionId).slice(0, 48),
      tool: PROVIDERS[s.provider].name,
      project: s.project,
      $: money(s.costUSD),
      tokens: tokens(s.total),
      requests: s.requests,
      last: new Date(s.lastAt).toLocaleString(),
    })));
  }
  const unpriced = present.flatMap((id) => report.providers[id].unknownModels.map((m) => `${PROVIDERS[id].name} ${m}`));
  console.log(`TOTAL  ≈$${totalCost.toFixed(2)}${unpriced.length ? '+' : ''}  — mixes API-equivalent, billed and recorded values; see the basis column.`);
  if (unpriced.length) console.log(`Unpriced models (tokens counted, cost=0): ${unpriced.join(', ')}`);
  if (!report.previous.covered) console.log('No previous-period comparison past 45 days (it would read twice the range).');
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: npm run usage [-- --days N] [--by tool|day|hour|model|project|session]');
  } else if (args.days === null && args.by === null) {
    printToday();
  } else {
    printReport(args.days || 1, args.by);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

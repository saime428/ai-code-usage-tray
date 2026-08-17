'use strict';

const { dayKey, rangeBounds } = require('./range');

const VERSION = 1;
const MAX_ATTRIBUTION_GAP_MS = 120_000;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'requests'];

const count = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);
const empty = () => Object.fromEntries(FIELDS.map((field) => [field, 0]));
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function validModels(byModel) {
  return isRecord(byModel) && Object.values(byModel).every((bucket) =>
    isRecord(bucket) && FIELDS.every((field) => Number.isFinite(bucket[field]) && bucket[field] >= 0),
  );
}

function createLedger(now = Date.now()) {
  return {
    version: VERSION,
    trackingStartedAt: now,
    accounts: {},
    days: {},
    observations: {},
  };
}

function validateLedger(value) {
  if (
    !isRecord(value) ||
    value.version !== VERSION ||
    !Number.isFinite(value.trackingStartedAt) ||
    value.trackingStartedAt < 0 ||
    !isRecord(value.accounts) ||
    !isRecord(value.days) ||
    !isRecord(value.observations)
  ) {
    throw new Error('账号用量账本格式无效');
  }
  const provider = (name) => name === 'claude' || name === 'codex';
  const validAccounts = Object.values(value.accounts).every((account) =>
    isRecord(account) &&
    provider(account.provider) &&
    typeof account.label === 'string' &&
    typeof account.source === 'string' &&
    Number.isFinite(account.firstSeenAt) &&
    Number.isFinite(account.lastSeenAt),
  );
  const validDays = Object.entries(value.days).every(([day, accounts]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    isRecord(accounts) &&
    Object.values(accounts).every((account) =>
      isRecord(account) && provider(account.provider) && validModels(account.byModel),
    ),
  );
  const validObservations = Object.values(value.observations).every((observation) =>
    isRecord(observation) &&
    Number.isFinite(observation.observedAt) &&
    /^\d{4}-\d{2}-\d{2}$/.test(observation.day) &&
    (observation.accountId === null || typeof observation.accountId === 'string') &&
    validModels(observation.byModel),
  );
  if (!validAccounts || !validDays || !validObservations) {
    throw new Error('账号用量账本格式无效');
  }
  return value;
}

function cleanModels(byModel) {
  const cleaned = {};
  for (const [model, bucket] of Object.entries(byModel || {})) {
    cleaned[String(model)] = Object.fromEntries(FIELDS.map((field) => [field, count(bucket && bucket[field])]));
  }
  return cleaned;
}

function deltaModels(current, previous, resetDay) {
  const delta = {};
  for (const [model, bucket] of Object.entries(current)) {
    const before = resetDay ? empty() : previous[model] || empty();
    const next = empty();
    for (const field of FIELDS) next[field] = bucket[field] >= before[field] ? bucket[field] - before[field] : 0;
    if (FIELDS.some((field) => next[field] > 0)) delta[model] = next;
  }
  return delta;
}

function registerAccount(ledger, account, observedAt) {
  const previous = ledger.accounts[account.id];
  ledger.accounts[account.id] = {
    provider: account.provider,
    label: account.label,
    source: account.source,
    firstSeenAt: previous?.firstSeenAt || observedAt,
    lastSeenAt: observedAt,
  };
}

function unknownAccount(provider) {
  return {
    id: `${provider}:unknown`,
    provider,
    source: 'unknown',
    label: `${provider === 'claude' ? 'Claude' : 'Codex'} 未归属`,
  };
}

function addDelta(ledger, day, account, delta, observedAt) {
  if (!Object.keys(delta).length) return false;
  registerAccount(ledger, account, observedAt);
  const accountDay = (((ledger.days[day] ||= {})[account.id] ||= { provider: account.provider, byModel: {} })).byModel;
  for (const [model, bucket] of Object.entries(delta)) {
    const target = (accountDay[model] ||= empty());
    for (const field of FIELDS) target[field] += bucket[field];
  }
  return true;
}

function observeProvider(ledger, provider, account, byModel, observedAt = Date.now()) {
  validateLedger(ledger);
  const current = cleanModels(byModel);
  const day = dayKey(new Date(observedAt));
  const previous = ledger.observations[provider];
  if (account) registerAccount(ledger, account, observedAt);
  if (!previous) {
    ledger.observations[provider] = { observedAt, day, accountId: account?.id || null, byModel: current };
    return true;
  }

  const gap = observedAt - previous.observedAt;
  const stable =
    gap >= 0 &&
    gap <= MAX_ATTRIBUTION_GAP_MS &&
    account &&
    account.id === previous.accountId;
  const delta = deltaModels(current, previous.byModel || {}, previous.day !== day);
  const target = stable ? account : unknownAccount(provider);
  const changed = addDelta(ledger, day, target, delta, observedAt);
  ledger.observations[provider] = { observedAt, day, accountId: account?.id || null, byModel: current };
  return changed || previous.accountId !== (account?.id || null) || previous.day !== day;
}

function summarizeAccounts(ledger, provider, rangeDays, now = new Date()) {
  validateLedger(ledger);
  const bounds = rangeBounds(now, rangeDays);
  const totals = {};
  for (const [day, accounts] of Object.entries(ledger.days)) {
    if (day < bounds.startDay || day > bounds.endDay) continue;
    for (const [accountId, value] of Object.entries(accounts || {})) {
      if (value.provider !== provider) continue;
      const total = (totals[accountId] ||= empty());
      for (const bucket of Object.values(value.byModel || {})) {
        for (const field of FIELDS) total[field] += count(bucket[field]);
      }
    }
  }
  const items = Object.entries(totals).map(([id, total]) => {
    const meta = ledger.accounts[id] || unknownAccount(provider);
    const input = provider === 'claude'
      ? total.input + total.cacheRead + total.cacheWrite
      : total.input;
    return { id, label: meta.label, source: meta.source, ...total, inputTokens: input, totalTokens: input + total.output };
  });
  items.sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));
  return { trackingStartedAt: ledger.trackingStartedAt, items };
}

module.exports = {
  VERSION,
  MAX_ATTRIBUTION_GAP_MS,
  createLedger,
  validateLedger,
  observeProvider,
  summarizeAccounts,
};

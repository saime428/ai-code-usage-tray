'use strict';
// Which tools the floating bar shows. Pure, so the rules are testable outside Electron.
const { PROVIDER_IDS } = require('./report');

const ORIGINAL = ['claude', 'codex', 'grok'];

// A saved pick: known ids in the canonical order. Missing, garbage or empty = follow detection (null).
function savedPick(value) {
  const ids = Array.isArray(value) ? PROVIDER_IDS.filter((id) => value.includes(id)) : [];
  return ids.length ? ids : null;
}

// The user's pick, else the tools found on this machine, else the original three.
function shownProviders(pick, detected) {
  if (pick) return pick;
  const found = PROVIDER_IDS.filter((id) => detected.has(id));
  return found.length ? found : ORIGINAL;
}

// Ticking one tool on or off. Empty means the caller must refuse: the bar keeps at least one.
function toggledPick(shown, id, on) {
  return PROVIDER_IDS.filter((item) => (item === id ? on : shown.includes(item)));
}

module.exports = { savedPick, shownProviders, toggledPick };

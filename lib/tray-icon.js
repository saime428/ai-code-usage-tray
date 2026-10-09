'use strict';
// The tray icon: one cell per tool the floating bar shows, in the bar's order, colored by what that
// tool is doing right now. Pure, so the rules are testable outside Electron; main.js feeds it the
// activity watch (lib/activity.js) and draws the result.
const { PROVIDERS } = require('./report');

// A finished turn stays green until the panel is opened, the tool runs again, or this much time passes.
const DONE_MS = 10 * 60 * 1000;

// RGB. Gray = idle, blue = running, green = finished and not looked at yet, red = needs you.
const COLORS = {
  idle: [0x5c, 0x60, 0x68],
  working: [0x3b, 0x9c, 0xff],
  done: [0x4c, 0xaf, 0x6e],
  attention: [0xe4, 0x58, 0x58],
};
const LABELS = { idle: '空闲', working: '在跑', done: '跑完待看', attention: '需要你' };

// [x, y, width, height] inside the 16 px icon, left to right, then top to bottom.
const LAYOUTS = [
  null,
  [[1, 1, 14, 14]],
  [[1, 1, 6, 14], [9, 1, 6, 14]],
  [[1, 1, 4, 14], [6, 1, 4, 14], [11, 1, 4, 14]],
  [[1, 1, 6, 6], [9, 1, 6, 6], [1, 9, 6, 6], [9, 9, 6, 6]],
  [[1, 1, 4, 6], [6, 1, 4, 6], [11, 1, 4, 6], [1, 9, 6, 6], [9, 9, 6, 6]],
];

// activity: lib/activity.js states ('' | 'working' | 'attention'); ended / since: when each tool's
// last turn was seen to end and when it last started running; seenAt: when the panel was last opened.
// Only tools whose turn ends are exact (Claude with hooks, Codex, Grok, Antigravity) ever have `ended`.
function trayCells({ providers, activity, ended = {}, since = {}, seenAt = 0, now = Date.now() }) {
  let expiresAt = Infinity;
  const cells = providers.map((id) => {
    if (activity[id] === 'attention' || activity[id] === 'working') return activity[id];
    const end = ended[id] || 0;
    if (end <= Math.max(seenAt, since[id] || 0) || now - end >= DONE_MS) return 'idle';
    expiresAt = Math.min(expiresAt, end + DONE_MS);
    return 'done';
  });
  return { cells, expiresAt };
}

// 16x16 BGRA for nativeImage.createFromBitmap, transparent around the cells.
// ponytail: 16 px only; at 125–150% scaling Windows stretches it and the gaps go soft. Draw at
// SM_CXSMICON size if that ever matters.
function trayBitmap(cells) {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  (LAYOUTS[cells.length] || LAYOUTS[1]).forEach(([left, top, width, height], i) => {
    const [r, g, b] = COLORS[cells[i]] || COLORS.idle;
    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        if ((x === left || x === left + width - 1) && (y === top || y === top + height - 1)) continue; // rounded
        const p = (y * size + x) * 4;
        buffer[p] = b;
        buffer[p + 1] = g;
        buffer[p + 2] = r;
        buffer[p + 3] = 0xff;
      }
    }
  });
  return buffer;
}

// The windows the floating bar's collapsed strip shows (renderer/floating.html windowsFor).
function quotaText(id, usage) {
  const limits = usage && usage.rateLimits;
  if (!limits || (id === 'codex' && ['api', 'apikey'].includes(usage.authMode))) return '';
  let windows;
  if (id === 'claude') {
    windows = [['5h', limits.fiveHour], ['7d', limits.sevenDay], ['Fable', limits.sevenDayFable]];
  } else {
    const all = limits.windows || [];
    const group = limits.primaryGroup || (all[0] && all[0].group);
    const own = all.filter((value) => value.group === group);
    windows = [['5h', own.find((value) => value.windowMinutes === 300)], ['7d', own.find((value) => value.windowMinutes === 10080)]];
  }
  return windows.filter(([, value]) => value).map(([label, value]) => ` ${label} ${Math.round(value.usedPercentage)}%`).join('');
}

// Windows cuts a tray tooltip at 127 characters (NOTIFYICONDATA.szTip), dropping whatever comes last.
const TOOLTIP_MAX = 127;

// One line per cell, in the cells' order, so hovering says which cell is which. Amounts and tokens
// stay in the panel. With every window a tool can show, all cells green and every window at 100%:
// four tools take 116 characters, five take 130 (122 at two-digit percentages).
function trayToolTip(providers, cells, snapshot) {
  const lines = (withQuota) => providers
    .map((id, i) => `${PROVIDERS[id].name} ${LABELS[cells[i]] || LABELS.idle}${withQuota ? quotaText(id, snapshot && snapshot[id]) : ''}`)
    .join('\n');
  const full = lines(true);
  // ponytail: past the limit all quota goes rather than the last cell's line; the states are what explain the icon
  return full.length <= TOOLTIP_MAX ? full : lines(false);
}

module.exports = { trayCells, trayBitmap, trayToolTip, DONE_MS, COLORS, LAYOUTS };

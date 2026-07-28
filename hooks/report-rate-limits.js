#!/usr/bin/env node
'use strict';
// Claude Code statusLine sink: captures official subscription rate limits for
// the tray without adding a visible terminal status line.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATUS_DIR =
  process.env.CLAUDE_USAGE_TRAY_STATUS_DIR ||
  path.join(os.homedir(), '.claude', 'usage-tray-status');

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    if (!data.rate_limits) process.exit(0);
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    // ponytail: statusLine has one command slot; detect and chain an existing
    // user command when a public installer is added
    fs.writeFileSync(
      path.join(STATUS_DIR, 'rate-limits.json'),
      JSON.stringify({ rate_limits: data.rate_limits, ts: Date.now() }),
    );
  } catch {
    // a status line must never disturb Claude Code
  }
  process.exit(0);
});

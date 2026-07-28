#!/usr/bin/env node
'use strict';
// Claude Code hook: records per-session state for claude-usage-tray.
// Wired in ~/.claude/settings.json for SessionStart / UserPromptSubmit /
// Stop / Notification / SessionEnd. Reads the hook payload from stdin, writes
// ~/.claude/usage-tray-status/<session_id>.json. Always exits 0 fast —
// this must never slow down or block Claude Code itself.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATUS_DIR =
  process.env.CLAUDE_USAGE_TRAY_STATUS_DIR ||
  path.join(os.homedir(), '.claude', 'usage-tray-status');
const SAFE_SESSION_ID = /^[a-zA-Z0-9._-]{1,200}$/;

const STATE_BY_EVENT = {
  UserPromptSubmit: 'working', // user sent a prompt -> Claude is busy
  Stop: 'waiting', // turn finished -> waiting for the user
  Notification: 'attention', // permission ask / idle reminder -> needs the user
  SessionStart: 'waiting',
  SessionEnd: 'ended',
};

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const evt = JSON.parse(raw);
    if (
      evt.hook_event_name === 'Notification' &&
      !['permission_prompt', 'idle_prompt'].includes(evt.notification_type)
    ) {
      process.exit(0);
    }
    const state = STATE_BY_EVENT[evt.hook_event_name];
    if (!SAFE_SESSION_ID.test(String(evt.session_id || '')) || !state) process.exit(0);
    const file = path.join(STATUS_DIR, evt.session_id + '.json');
    if (state === 'ended') {
      try {
        fs.unlinkSync(file);
      } catch {}
      process.exit(0);
    }
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    // ponytail: writeFileSync isn't atomic; the reader tolerates a rare
    // torn read by ignoring unparseable files until the next refresh
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_id: evt.session_id,
        state,
        event: evt.hook_event_name,
        message: evt.message || null,
        cwd: evt.cwd || null,
        ts: Date.now(),
      }),
    );
  } catch {
    // never propagate errors into Claude Code
  }
  process.exit(0);
});

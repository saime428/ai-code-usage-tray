'use strict';
// Antigravity's quota (the 5-hour and weekly windows its Settings → Models page shows) is
// never written to disk: only the running language server holds it. That server serves it
// to its own UI over a local Connect RPC, which is what this module calls — the protocol
// TokenMe and CodexBar use on macOS (TokenMe's Windows build skips it and spawns `agy`,
// which can pop a browser login). Measured on Windows, 2026-10-04:
// - `language_server.exe` runs from the Antigravity install with `--csrf_token <t>` on its
//   command line and `--https_server_port 0`, so the port comes from the socket table.
//   It listens on two loopback ports, one https (self-signed) and one http.
// - `{"forceRefresh": false}` answers in ~2 ms from a cache that does NOT follow usage:
//   after two Gemini messages it still showed the old numbers until a forced read
//   (270–880 ms, the server asks Google with its own login) moved them.
// So: force when this machine's Antigravity usage grew, when a window's reset time has
// passed, and every 10 minutes (other devices); otherwise reuse the last answer. The token
// is read for the call and kept in memory only; nothing leaves 127.0.0.1 from here.
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');

const SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const WINDOW_MINUTES = { '5h': 300, weekly: 10080 };
const FORCE_EVERY_MS = 10 * 60 * 1000;
const DISCOVER_EVERY_MS = 2 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;

// Other apps ship a language_server.exe too (Windsurf, Codeium), so the path or the
// app-data flag has to say Antigravity.
const DISCOVER_SCRIPT = `
$out = foreach ($p in Get-CimInstance Win32_Process -Filter "Name = 'language_server.exe'") {
  if ($p.ExecutablePath -notmatch '\\\\antigravity\\\\' -and $p.CommandLine -notmatch '--app_data_dir[ =]antigravity') { continue }
  $ports = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in '127.0.0.1','::1' } | Select-Object -ExpandProperty LocalPort -Unique)
  [pscustomobject]@{ cmd = $p.CommandLine; ports = $ports }
}
ConvertTo-Json -Depth 3 -Compress @($out)
`;

function csrfOf(commandLine) {
  const match = /--csrf_token[ =]("[^"]*"|\S+)/.exec(commandLine || '');
  return match ? match[1].replace(/^"|"$/g, '') : null;
}

// Is any language_server.exe running at all? tasklist answers in ~450 ms here and starts no
// PowerShell; the CIM query below takes ~1.3 s, and Antigravity being closed is the usual state.
function serverRunning() {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq language_server.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      (error, stdout) => resolve(!error && /language_server\.exe/i.test(stdout || '')),
    );
  });
}

// Every running Antigravity server that carries a token, with its loopback ports.
async function discover() {
  if (!(await serverRunning())) return [];
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', DISCOVER_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (error, stdout) => {
        if (error) return resolve([]);
        try {
          const found = JSON.parse(stdout || '[]');
          resolve((Array.isArray(found) ? found : [found])
            .filter(Boolean)
            .map((server) => ({ csrf: csrfOf(server.cmd), ports: (server.ports || []).filter(Number.isInteger) }))
            .filter((server) => server.csrf && server.ports.length));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

// One call on one port and scheme; null unless it answered 200 with JSON. The certificate
// is the server's own self-signed one: the loopback address is the trust anchor here.
function request({ port, scheme, csrf }, force, timeout = 5000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ forceRefresh: force });
    const req = (scheme === 'https' ? https : http).request(
      {
        host: '127.0.0.1',
        port,
        path: SUMMARY_PATH,
        method: 'POST',
        rejectUnauthorized: false,
        timeout,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Content-Length': Buffer.byteLength(body),
          'X-Codeium-Csrf-Token': csrf,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    // A server that sends its headers and then stalls: the timeout destroys the request, but
    // with a response already started Node emits no 'error' and no 'end', only 'close'. Without
    // this the promise never settles and the 30 s refresh awaiting it stops for good.
    req.on('close', () => resolve(null));
    req.end(body);
  });
}

// "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude/GPT". The name comes from
// another program and ends up in innerHTML, so only plain name characters survive.
const groupLabel = (name) =>
  String(name || '')
    .replace(/\s+models?$/i, '')
    .replace(/\s+and\s+/gi, '/')
    .replace(/[^\p{L}\p{N} ./+-]/gu, '')
    .trim()
    .slice(0, 24) || 'Antigravity';

// The RPC answer as rate-limit windows, grouped in the vendor's order (Gemini first),
// shortest window first inside a group. Windows whose reset has passed are dropped, as
// Codex does: their numbers no longer apply.
function parseQuota(value, now = Date.now()) {
  const groups = value && value.response && Array.isArray(value.response.groups) ? value.response.groups : [];
  const windows = [];
  for (const group of groups) {
    const rows = [];
    for (const bucket of Array.isArray(group && group.buckets) ? group.buckets : []) {
      const windowMinutes = WINDOW_MINUTES[bucket && bucket.window];
      if (!windowMinutes || bucket.disabled) continue;
      // ponytail: proto3 JSON leaves out a zero, so a bucket with no remainingFraction is
      // read as used up, like Grok's creditUsagePercent. Not seen yet: no bucket here has run out.
      const remaining = bucket.remainingFraction === undefined ? 0 : bucket.remainingFraction;
      const resetsAt = Date.parse(bucket.resetTime) / 1000;
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      if (!Number.isFinite(resetsAt) || resetsAt * 1000 <= now) continue;
      rows.push({ windowMinutes, usedPercentage: (1 - remaining) * 100, resetsAt, group: groupLabel(group.displayName) });
    }
    windows.push(...rows.sort((a, b) => a.windowMinutes - b.windowMinutes));
  }
  return windows;
}

// The refresh policy above, with discovery, the RPC and the clock injectable for tests.
// `read({ usageMark })` resolves to rate limits or null; usageMark is anything that
// changes when this machine's Antigravity usage grows.
function createAntigravityQuota({ find = discover, call = request, now = Date.now } = {}) {
  let endpoint = null; // { port, scheme, csrf } that answered last
  let discoveredAt = 0;
  let forcedAt = 0;
  let mark;
  let last = null; // { windows, updatedAt }

  async function connect() {
    discoveredAt = now();
    for (const server of await find()) {
      for (const port of server.ports) {
        for (const scheme of ['https', 'http']) {
          const candidate = { port, scheme, csrf: server.csrf };
          const value = await call(candidate, true);
          if (value && value.response) {
            endpoint = candidate;
            return value;
          }
        }
      }
    }
    return null;
  }

  function current(t) {
    if (!last) return null;
    const windows = last.windows.filter((window) => window.resetsAt * 1000 > t);
    if (!windows.length) return null;
    // primaryGroup outlives its windows: once Gemini's have all reset, the bar must not show
    // Claude/GPT's numbers in Gemini's place.
    return {
      windows,
      primaryGroup: last.windows[0] && last.windows[0].group,
      updatedAt: last.updatedAt,
      stale: !endpoint && t - last.updatedAt > STALE_AFTER_MS,
    };
  }

  async function read({ usageMark } = {}) {
    const t = now();
    const used = usageMark !== mark;
    mark = usageMark;
    const resetPassed = Boolean(last) && last.windows.some((window) => window.resetsAt * 1000 <= t);
    let value = null;
    if (endpoint && (used || resetPassed || t - forcedAt >= FORCE_EVERY_MS)) {
      value = await call(endpoint, true);
      if (!value) endpoint = null; // Antigravity quit or restarted: new port and token
    }
    if (!endpoint && !value && (used || t - discoveredAt >= DISCOVER_EVERY_MS)) value = await connect();
    if (value && value.response) {
      forcedAt = t;
      last = { windows: parseQuota(value, t), updatedAt: t };
    }
    return current(t);
  }

  return { read };
}

module.exports = { createAntigravityQuota, parseQuota, csrfOf, groupLabel, request };

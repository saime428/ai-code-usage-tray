'use strict';
// Hang diagnostics for the Electron main process, plus lookup of hung instances.
//
// A worker thread watches a heartbeat the main thread writes every 2 s into shared
// memory. If it stalls past 15 s, the worker logs when it stopped and which of our
// synchronous cross-process calls was in progress. "idle" means none was: the thread
// froze while pumping window messages, where code injected from outside runs
// (input-method TIPs, for one). The worker keeps running while the main thread is
// blocked, so the record is written even if the process is killed afterwards.

const fs = require('fs');
const { execFile } = require('child_process');
const { Worker, isMainThread, workerData } = require('worker_threads');

const STEPS = ['idle', 'tasklist', 'registry', 'tray', 'window', 'safe-storage'];
const HANG_AFTER_MS = 15_000;
const BEAT_MS = 2_000;
const CHECK_MS = 5_000;
// A check that itself fires this late means the whole process was suspended.
const SUSPEND_GAP_MS = 3 * CHECK_MS;
const LOG_ROTATE_BYTES = 512 * 1024;
// Text-services / input-method processes are listed even if they started long ago.
const IME_PROCESS = /^(ctfmon|TextInputHost|ChsIME)\.exe$|wetype|sogou|baidupinyin|qqpinyin|ifly/i;

// tasklist /FO CSV /NH prints one quoted record per process, or a localized
// "no tasks" notice when nothing matches.
function parseTasklistPids(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => Number(line.split('","')[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function hangTransition(hung, now, lastBeat, lastCheck) {
  // Waking from sleep fires every timer late at once, so the last beat looks ancient.
  // That is a suspended process, not a hung thread: skip judging until beats resume.
  if (now - lastCheck > SUSPEND_GAP_MS) return { hung, event: null };
  const stalled = now - lastBeat > HANG_AFTER_MS;
  if (stalled && !hung) return { hung: true, event: 'hang' };
  if (!stalled && hung) return { hung: false, event: 'recovered' };
  return { hung, event: null };
}

const iso = (ms) => new Date(ms).toISOString();

function append(logPath, record) {
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must never take the app down.
  }
}

// What started shortly before the stall, and every input-method process with its
// start time — enough to tell "an IME restarted right then" from "nothing changed".
function snapshotProcesses(logPath, lastBeat) {
  if (process.platform !== 'win32') return;
  const script = [
    // PowerShell 5.1 writes stdout in the OEM code page, which garbles non-ASCII process
    // names, and [datetime]::Parse follows the current culture while a cast does not.
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
    `$since = ([datetime]'${iso(lastBeat - 15 * 60_000)}').ToUniversalTime()`,
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime() } else { [datetime]::MinValue }',
    `  if ($started -gt $since -or $_.Name -match '${IME_PROCESS.source}') { '{0}|{1}|{2}' -f $_.Name, $_.ProcessId, $started.ToString('o') }`,
    '}',
  ].join('\n');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    (error, stdout) => {
      const processes = String(stdout || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name, pid, startedAt] = line.split('|');
          return { name, pid: Number(pid), startedAt };
        });
      append(logPath, {
        event: 'processes',
        around: iso(lastBeat),
        processes,
        ...(error ? { error: String(error.message || error) } : {}),
      });
    },
  );
}

function runWatchdog({ shared, steps, logPath }) {
  try {
    if (fs.statSync(logPath).size > LOG_ROTATE_BYTES) fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // No log yet.
  }
  const beat = new Float64Array(shared, 0, 1);
  const step = new Int32Array(shared, 8, 1);
  let hung = false;
  let stalledSince = 0;
  let lastCheck = Date.now();
  setInterval(() => {
    const now = Date.now();
    const next = hangTransition(hung, now, beat[0], lastCheck);
    lastCheck = now;
    hung = next.hung;
    if (next.event === 'hang') {
      stalledSince = beat[0];
      append(logPath, {
        event: 'hang',
        lastBeatAt: iso(stalledSince),
        detectedAt: iso(now),
        step: steps[step[0]] || 'unknown',
        pid: process.pid,
      });
      snapshotProcesses(logPath, stalledSince);
    } else if (next.event === 'recovered') {
      append(logPath, {
        event: 'recovered',
        at: iso(now),
        stalledSeconds: Math.round((now - stalledSince) / 1000),
      });
    }
  }, CHECK_MS);
}

// Returns guard(step, fn): wraps a synchronous function so the log can name it.
function startHangWatch(logPath) {
  const shared = new SharedArrayBuffer(16);
  const beat = new Float64Array(shared, 0, 1);
  const step = new Int32Array(shared, 8, 1);
  beat[0] = Date.now();
  // Worker threads cannot load files from inside app.asar; lib/** is asarUnpack'ed.
  const file = __filename.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const worker = new Worker(file, { workerData: { hangWatch: { shared, steps: STEPS, logPath } } });
  // A watchdog that never started and one that never saw a hang both leave no records,
  // so a dead watchdog has to say so itself.
  worker.on('error', (error) =>
    append(logPath, { event: 'watchdog-error', at: iso(Date.now()), error: String((error && error.message) || error) }));
  worker.on('exit', (code) => {
    if (code) append(logPath, { event: 'watchdog-exit', at: iso(Date.now()), code });
  });
  worker.unref();
  setInterval(() => {
    beat[0] = Date.now();
  }, BEAT_MS).unref();
  const stack = [];
  return function guard(name, fn) {
    const index = Math.max(0, STEPS.indexOf(name));
    return function guarded(...args) {
      stack.push(index);
      step[0] = index;
      try {
        return fn.apply(this, args);
      } finally {
        stack.pop();
        step[0] = stack.length ? stack[stack.length - 1] : 0;
      }
    };
  };
}

if (!isMainThread && workerData && workerData.hangWatch) runWatchdog(workerData.hangWatch);

module.exports = { STEPS, HANG_AFTER_MS, CHECK_MS, parseTasklistPids, hangTransition, startHangWatch };

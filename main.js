'use strict';
const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  nativeImage,
  Notification,
  screen,
  shell,
  safeStorage,
  net,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { Worker } = require('worker_threads');
const { DEFAULT_ROOT } = require('./lib/usage');
const { DEFAULT_CODEX_ROOT } = require('./lib/codex-usage');
const { DEFAULT_GROK_ROOT } = require('./lib/grok-usage');
const { dayKey, normalizeRangeDays, rangeBounds } = require('./lib/range');
const { detectIdentities } = require('./lib/account-identity');
const {
  createLedger,
  validateLedger,
  observeProvider,
  summarizeAccounts,
} = require('./lib/account-ledger');
const { sessionTarget } = require('./lib/open-session');
const { startFullscreenWatch } = require('./lib/fullscreen-watch');
const {
  createAuthorization,
  parseAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchUsage: fetchClaudeOAuthUsage,
} = require('./lib/claude-oauth');
const {
  DEFAULT_INDEXED_DB_ROOT,
  cacheSignature,
  createSnapshot,
  removeSnapshot,
  desktopConversationSession,
  runProbe: runClaudeDesktopCacheProbe,
} = require('./lib/claude-desktop-cache');

const probeProfile = process.env.CLAUDE_USAGE_CACHE_PROBE;
if (probeProfile) {
  runClaudeDesktopCacheProbe(probeProfile)
    .then((conversation) => process.stdout.write(JSON.stringify(conversation)))
    .then(() => app.quit())
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      app.exit(1);
    });
  return;
}

if (process.env.AI_CODE_USAGE_WORKER_SMOKE === '1') {
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'lib', 'usage-worker.js')
    : path.join(__dirname, 'lib', 'usage-worker.js');
  const worker = new Worker(workerPath);
  const timer = setTimeout(() => {
    process.stderr.write('WORKER_TIMEOUT\n');
    worker.terminate().finally(() => app.exit(1));
  }, 120_000);
  worker.once('message', (message) => {
    clearTimeout(timer);
    process.stdout.write(message.ok ? 'WORKER_OK\n' : `WORKER_ERROR ${message.error}\n`);
    worker.terminate().finally(() => app.exit(message.ok ? 0 : 1));
  });
  worker.once('error', (error) => {
    clearTimeout(timer);
    process.stderr.write(`WORKER_ERROR ${String(error.stack || error)}\n`);
    app.exit(1);
  });
  worker.postMessage({ id: 1, ranges: { claude: 1, codex: 1, grok: 1 }, now: Date.now() });
  return;
}

const systemFetch = (...args) => net.fetch(...args);

const PANEL = { width: 380, height: 544 };
const FLOATING_SIZE = {
  top: { collapsed: [444, 42], expanded: [652, 224] },
  right: { collapsed: [58, 324], expanded: [326, 480] },
};
const FLOATING_COLLAPSE_MS = 300;
const CLAUDE_OAUTH_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS = {
  floatingEnabled: true,
  floatingPosition: 'top',
  floatingHideFullscreen: true,
  claudeRangeDays: 1,
  codexRangeDays: 1,
  grokRangeDays: 1,
};
const LOGIN_ITEM_PATH = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
let tray = null;
let panelWin = null;
let floatingWin = null;
let quitting = false;
let panelAnchor = 'tray';
let floatingExpanded = false;
let floatingCollapseTimer = null;
let fullscreenActive = false;
let fullscreenWatch = null;
let settings = { ...DEFAULT_SETTINGS };
let usageSnapshot = null;
let refreshPromise = null;
let attentionSessions = new Set();
let pendingClaudeAuthorization = null;
let claudeLoginPromise = null;
let claudeOAuthPromise = null;
let claudeOAuthCache = null;
let claudeAuthError = null;
let claudeDesktopCache = { signature: null, conversation: null };
let usageWorker = null;
let usageWorkerRequestId = 0;
const usageWorkerRequests = new Map();
let accountLedger = null;
let accountLedgerError = null;
let accountLedgerDirty = false;
let accountLedgerWriteTimer = null;

if (!app.requestSingleInstanceLock()) app.quit();

const fmtTokens = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

function isClaudeDesktopRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const output = execFileSync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
    );
    return /\"claude\.exe\"/i.test(output);
  } catch {
    return false;
  }
}

function runDesktopCacheProbe(snapshotRoot) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_USAGE_CACHE_PROBE: snapshotRoot };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(
      process.execPath,
      app.isPackaged ? [] : [app.getAppPath()],
      { env, encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else {
          try {
            resolve(JSON.parse(stdout.trim() || 'null'));
          } catch (parseError) {
            reject(parseError);
          }
        }
      },
    );
  });
}

function cleanupDesktopSnapshot(snapshotRoot, tempRoot, retries = 15) {
  if (removeSnapshot(snapshotRoot, tempRoot) || retries <= 0) return;
  const timer = setTimeout(() => cleanupDesktopSnapshot(snapshotRoot, tempRoot, retries - 1), 1000);
  timer.unref();
}

async function readClaudeDesktopConversation() {
  const signature = cacheSignature(DEFAULT_INDEXED_DB_ROOT);
  if (!signature) return null;
  if (signature === claudeDesktopCache.signature) return claudeDesktopCache.conversation;
  const tempRoot = app.getPath('temp');
  let snapshotRoot;
  try {
    snapshotRoot = createSnapshot(DEFAULT_INDEXED_DB_ROOT, tempRoot);
    const conversation = await runDesktopCacheProbe(snapshotRoot);
    claudeDesktopCache = { signature, conversation };
    return conversation;
  } catch {
    return claudeDesktopCache.conversation;
  } finally {
    cleanupDesktopSnapshot(snapshotRoot, tempRoot);
  }
}

function costText(usage) {
  if (usage.costCoverage === 'unavailable') return '\u91d1\u989d\u4e0d\u53ef\u7528';
  const incomplete = usage.costCoverage === 'partial' || (usage.unknownModels || []).length > 0;
  return `\u2248$${usage.costUSD.toFixed(2)}${incomplete ? '+' : ''}`;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function accountLedgerPath() {
  return path.join(app.getPath('userData'), 'usage-ledger-v1.bin');
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings.floatingEnabled = saved.floatingEnabled !== false;
    settings.floatingPosition = saved.floatingPosition === 'right' ? 'right' : 'top';
    settings.floatingHideFullscreen = saved.floatingHideFullscreen !== false;
    const legacyRangeDays = normalizeRangeDays(saved.rangeDays);
    settings.claudeRangeDays = normalizeRangeDays(saved.claudeRangeDays, legacyRangeDays);
    settings.codexRangeDays = normalizeRangeDays(saved.codexRangeDays, legacyRangeDays);
    settings.grokRangeDays = normalizeRangeDays(saved.grokRangeDays, 1);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    // A read-only profile should not stop the monitor from running.
  }
}

function loadAccountLedger() {
  const file = accountLedgerPath();
  accountLedgerError = null;
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 加密存储不可用');
    accountLedger = fs.existsSync(file)
      ? validateLedger(JSON.parse(safeStorage.decryptString(fs.readFileSync(file))))
      : createLedger();
  } catch (error) {
    accountLedger = null;
    accountLedgerError = `账号统计账本无法读取：${String(error.message || error)} (${file})`;
  }
}

function flushAccountLedger() {
  if (!accountLedgerDirty || !accountLedger) return;
  const file = accountLedgerPath();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 加密存储不可用');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, safeStorage.encryptString(JSON.stringify(accountLedger)), { mode: 0o600 });
    fs.renameSync(temp, file);
    accountLedgerDirty = false;
    accountLedgerError = null;
  } catch (error) {
    accountLedgerError = `账号统计账本无法保存：${String(error.message || error)} (${file})`;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // A successful rename already removed the temporary file.
    }
  }
}

function scheduleAccountLedgerWrite() {
  accountLedgerDirty = true;
  clearTimeout(accountLedgerWriteTimer);
  accountLedgerWriteTimer = setTimeout(() => {
    accountLedgerWriteTimer = null;
    flushAccountLedger();
  }, 1000);
}

function clearAccountLedger() {
  clearTimeout(accountLedgerWriteTimer);
  accountLedgerWriteTimer = null;
  const file = accountLedgerPath();
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  accountLedger = createLedger();
  accountLedgerError = null;
  accountLedgerDirty = false;
}

function rejectWorkerRequests(error) {
  for (const { reject } of usageWorkerRequests.values()) reject(error);
  usageWorkerRequests.clear();
}

function ensureUsageWorker() {
  if (usageWorker) return usageWorker;
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'lib', 'usage-worker.js')
    : path.join(__dirname, 'lib', 'usage-worker.js');
  const worker = new Worker(workerPath);
  usageWorker = worker;
  worker.on('message', (message) => {
    const pending = usageWorkerRequests.get(message.id);
    if (!pending) return;
    usageWorkerRequests.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error || '本地用量 Worker 失败'));
  });
  worker.on('error', (error) => rejectWorkerRequests(error));
  worker.on('exit', (code) => {
    if (usageWorker === worker) usageWorker = null;
    if (!quitting) rejectWorkerRequests(new Error(`本地用量 Worker 已退出 (${code})`));
  });
  return worker;
}

function collectLocalUsage(ranges, now) {
  const id = ++usageWorkerRequestId;
  return new Promise((resolve, reject) => {
    usageWorkerRequests.set(id, { resolve, reject });
    ensureUsageWorker().postMessage({ id, ranges, now });
  });
}

function claudeAuthPath() {
  return path.join(app.getPath('userData'), 'claude-oauth.bin');
}

function readClaudeCredentials() {
  const file = claudeAuthPath();
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用');
  const credentials = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  if (
    typeof credentials.accessToken !== 'string' ||
    typeof credentials.refreshToken !== 'string' ||
    !credentials.accessToken ||
    !credentials.refreshToken
  ) {
    throw new Error('Claude 登录状态已损坏');
  }
  return credentials;
}

function writeClaudeCredentials(credentials) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用');
  const file = claudeAuthPath();
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temp, safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The successful rename already removed the temporary path.
    }
  }
}

function claudeAuthStatus() {
  if (pendingClaudeAuthorization && pendingClaudeAuthorization.expiresAt <= Date.now()) {
    pendingClaudeAuthorization = null;
    claudeAuthError ||= 'Claude 授权已过期，请重新连接';
  }
  try {
    return {
      connected: Boolean(readClaudeCredentials()),
      connecting: Boolean(claudeLoginPromise),
      awaitingCode: Boolean(pendingClaudeAuthorization),
      error: claudeAuthError,
    };
  } catch {
    return {
      connected: false,
      connecting: Boolean(claudeLoginPromise),
      awaitingCode: Boolean(pendingClaudeAuthorization),
      error: '已保存的 Claude 登录状态无法读取，请重新连接',
    };
  }
}

function claudeAuthErrorMessage(error) {
  if (error && error.status === 400) return 'Claude 授权码无效或已过期，请重新连接';
  if (error && error.status === 401) return 'Claude 登录已过期，请断开后重新连接';
  if (error && error.status === 403) return 'Claude 授权范围不足，请断开后重新连接';
  if (error && error.status === 429) return 'Claude 暂时限制了额度查询，请稍后刷新';
  if (error && error.name === 'TimeoutError') return 'Claude 额度查询超时，请检查网络';
  return error && error.message ? error.message : 'Claude 额度读取失败';
}

async function beginClaudeAccountConnection() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 加密存储不可用，无法安全保存 Claude 登录');
  }
  const authorization = createAuthorization();
  pendingClaudeAuthorization = {
    ...authorization,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  claudeAuthError = null;
  try {
    await shell.openExternal(authorization.url);
  } catch {
    pendingClaudeAuthorization = null;
    throw new Error('无法打开 Claude 登录页面');
  }
  return claudeAuthStatus();
}

function completeClaudeAccountConnection(value) {
  if (claudeLoginPromise) return claudeLoginPromise;
  const authorization = pendingClaudeAuthorization;
  if (!authorization || authorization.expiresAt <= Date.now()) {
    pendingClaudeAuthorization = null;
    return Promise.reject(new Error('Claude 授权已过期，请重新连接'));
  }
  if (authorization.retryAt > Date.now()) {
    const seconds = Math.ceil((authorization.retryAt - Date.now()) / 1000);
    return Promise.reject(new Error(`Claude 登录请求受限，请 ${seconds} 秒后再次点“验证”`));
  }
  let code;
  try {
    code = parseAuthorizationCode(value, authorization.state);
  } catch (error) {
    return Promise.reject(error);
  }
  claudeLoginPromise = exchangeAuthorizationCode(
    code,
    authorization.verifier,
    authorization.state,
    systemFetch,
  )
    .then(async (credentials) => {
      writeClaudeCredentials(credentials);
      pendingClaudeAuthorization = null;
      claudeOAuthCache = null;
      await getClaudeOAuthRateLimits(true);
    })
    .catch((error) => {
      const retryAfterMs = error.status === 429 && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : null;
      const retryable = !error.status || error.status >= 500 || retryAfterMs !== null;
      if (retryable) {
        const waitMs = retryAfterMs ?? 5_000;
        authorization.retryAt = Date.now() + waitMs;
        claudeAuthError = error.status === 429
          ? `Claude 登录请求受限，请 ${Math.ceil(waitMs / 1000)} 秒后再次点“验证”`
          : claudeAuthErrorMessage(error);
      } else {
        pendingClaudeAuthorization = null;
        claudeAuthError = error.status === 429
          ? 'Claude 令牌接口限制了当前网络出口，请切换网络或代理节点后重新连接'
          : claudeAuthErrorMessage(error);
      }
      throw new Error(claudeAuthError);
    })
    .finally(() => {
      claudeLoginPromise = null;
    });
  return claudeLoginPromise;
}

function cancelClaudeAccountConnection() {
  if (claudeLoginPromise) return;
  pendingClaudeAuthorization = null;
  claudeAuthError = null;
}

function disconnectClaudeAccount() {
  try {
    fs.unlinkSync(claudeAuthPath());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  claudeOAuthCache = null;
  pendingClaudeAuthorization = null;
  claudeAuthError = null;
}

async function getClaudeOAuthRateLimits(force = false) {
  let credentials;
  try {
    credentials = readClaudeCredentials();
  } catch (error) {
    claudeAuthError = claudeAuthErrorMessage(error);
    return null;
  }
  if (!credentials) return null;
  if (
    !force &&
    claudeOAuthCache &&
    Date.now() - claudeOAuthCache.updatedAt < CLAUDE_OAUTH_REFRESH_MS
  ) {
    return claudeOAuthCache;
  }
  if (claudeOAuthPromise) return claudeOAuthPromise;
  claudeOAuthPromise = (async () => {
    try {
      let limits;
      try {
        limits = await fetchClaudeOAuthUsage(credentials.accessToken, systemFetch);
      } catch (error) {
        if (error.status !== 401) throw error;
        credentials = await refreshAccessToken(credentials.refreshToken, systemFetch);
        writeClaudeCredentials(credentials);
        limits = await fetchClaudeOAuthUsage(credentials.accessToken, systemFetch);
      }
      claudeOAuthCache = limits;
      claudeAuthError = null;
      return limits;
    } catch (error) {
      claudeAuthError = claudeAuthErrorMessage(error);
      return claudeOAuthCache
        ? { ...claudeOAuthCache, stale: Date.now() - claudeOAuthCache.updatedAt > 15 * 60 * 1000 }
        : null;
    } finally {
      claudeOAuthPromise = null;
    }
  })();
  return claudeOAuthPromise;
}

function emptyUsage(error, collectedAt, rangeDays = 1) {
  const range = rangeBounds(new Date(collectedAt), rangeDays);
  return {
    date: range.date,
    rangeDays: range.rangeDays,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    byModel: {},
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 },
    costUSD: 0,
    costCoverage: 'unavailable',
    unknownModels: [],
    sessions: [],
    rateLimits: null,
    dataStatus: { state: 'error', updatedAt: collectedAt, message: error },
  };
}

function collectedProvider(name, value, error, collectedAt, rangeDays) {
  if (value) return { ...value, dataStatus: { state: 'ok', updatedAt: collectedAt } };
  const message = error && error.code === 'EACCES' ? '本地数据无读取权限' : '本地数据读取失败';
  const previous = usageSnapshot && usageSnapshot[name];
  if (previous && previous.rangeDays === rangeDays) {
    return {
      ...previous,
      dataStatus: {
        state: 'stale',
        updatedAt: previous.dataStatus?.updatedAt || collectedAt,
        message,
      },
    };
  }
  const fallback = emptyUsage(message, collectedAt, rangeDays);
  if (previous) {
    fallback.rateLimits = previous.rateLimits || null;
    fallback.sessions = previous.sessions || [];
  }
  return fallback;
}

async function collectAllUsage() {
  const collectedAt = Date.now();
  const ranges = {
    claude: settings.claudeRangeDays,
    codex: settings.codexRangeDays,
    grok: settings.grokRangeDays,
  };
  const identitiesBefore = detectIdentities();
  const appRunning = isClaudeDesktopRunning();
  const oauthPromise = getClaudeOAuthRateLimits();
  const desktopPromise = appRunning ? readClaudeDesktopConversation() : Promise.resolve(null);
  let local = null;
  let localError = null;
  try {
    local = await collectLocalUsage(ranges, collectedAt);
  } catch (error) {
    localError = error;
  }
  const identitiesAfter = detectIdentities();
  const [oauthRateLimits, desktopConversation] = await Promise.all([oauthPromise, desktopPromise]);
  const snapshot = {
    collectedAt,
    ranges,
    claude: collectedProvider('claude', local && local.claude, localError, collectedAt, ranges.claude),
    codex: collectedProvider('codex', local && local.codex, localError, collectedAt, ranges.codex),
    grok: collectedProvider('grok', local && local.grok, localError, collectedAt, ranges.grok),
  };
  snapshot.codex.authMode = identitiesAfter.codex?.authMode || identitiesBefore.codex?.authMode || '';
  if (local && accountLedger) {
    const today = dayKey(new Date(collectedAt));
    let changed = false;
    for (const provider of ['claude', 'codex']) {
      const before = identitiesBefore[provider];
      const after = identitiesAfter[provider];
      const account = before && after && before.id === after.id ? after : null;
      changed = observeProvider(
        accountLedger,
        provider,
        account,
        local[provider].daily[today]?.byModel || {},
        collectedAt,
      ) || changed;
    }
    if (changed) scheduleAccountLedgerWrite();
  }
  // ponytail: Grok 暂不接分账号账本(缺身份识别),accounts 为空时面板自动隐藏该区
  for (const provider of ['claude', 'codex', 'grok']) {
    delete snapshot[provider].daily;
    snapshot[provider].accounts = accountLedger
      ? { ...summarizeAccounts(accountLedger, provider, ranges[provider], new Date(collectedAt)), error: accountLedgerError }
      : { trackingStartedAt: null, items: [], error: accountLedgerError };
  }
  if (local) snapshot.diagnostics = local.diagnostics;
  if (oauthRateLimits) snapshot.claude.rateLimits = oauthRateLimits;
  const desktopSession = desktopConversationSession(desktopConversation, collectedAt);
  if (desktopSession && !snapshot.claude.sessions.some((session) => session.sessionId === desktopSession.sessionId)) {
    snapshot.claude.sessions.push(desktopSession);
    snapshot.claude.sessions.sort((a, b) => b.mtime - a.mtime);
  }
  snapshot.claude.appRunning = appRunning;
  snapshot.claude.desktopConversation = desktopConversation;
  snapshot.claude.auth = claudeAuthStatus();
  return snapshot;
}

// 16x16 clay-colored square drawn as raw BGRA — no binary icon asset needed.
function trayIcon(state = 'idle') {
  const [b, g, r] =
    {
      working: [0x6e, 0xaf, 0x4c],
      attention: [0x58, 0x58, 0xe4],
      idle: [0x57, 0x77, 0xd9],
    }[state] || [0x57, 0x77, 0xd9];
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= 1 && x <= 14 && y >= 1 && y <= 14;
      const corner =
        (x <= 2 || x >= 13) &&
        (y <= 2 || y >= 13) &&
        ((x <= 1 || x >= 14) || (y <= 1 || y >= 14));
      const i = (y * size + x) * 4;
      if (inside && !corner) {
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createPanelWindow() {
  panelWin = new BrowserWindow({
    width: PANEL.width,
    height: PANEL.height,
    show: false,
    frame: false,
    resizable: false,
    type: 'toolbar',
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#16161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      spellcheck: false,
    },
  });
  panelWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  panelWin.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      panelWin.hide();
    }
  });
}

function floatingBounds(expanded = floatingExpanded) {
  const { workArea } = screen.getPrimaryDisplay();
  const [width, height] = FLOATING_SIZE[settings.floatingPosition][expanded ? 'expanded' : 'collapsed'];
  return settings.floatingPosition === 'top'
    ? {
        x: Math.round(workArea.x + (workArea.width - width) / 2),
        y: workArea.y + 8,
        width,
        height,
      }
    : {
        x: workArea.x + workArea.width - width - 8,
        y: Math.round(workArea.y + (workArea.height - height) / 2),
        width,
        height,
      };
}

function keepWindowOnTop(win) {
  win.setAlwaysOnTop(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
}

function updateFloatingVisibility() {
  if (!floatingWin || floatingWin.isDestroyed()) return;
  const hiddenByFullscreen = settings.floatingHideFullscreen && fullscreenActive;
  if (settings.floatingEnabled && !hiddenByFullscreen) {
    floatingWin.showInactive();
    keepWindowOnTop(floatingWin);
  } else floatingWin.hide();
}

function syncFullscreenWatch() {
  const wanted =
    process.platform === 'win32' && settings.floatingEnabled && settings.floatingHideFullscreen;
  if (wanted && !fullscreenWatch) {
    fullscreenWatch = startFullscreenWatch((active) => {
      if (fullscreenActive === active) return;
      fullscreenActive = active;
      updateFloatingVisibility();
    });
  } else if (!wanted && fullscreenWatch) {
    fullscreenWatch.stop();
    fullscreenWatch = null;
    fullscreenActive = false;
  }
}

function setFloatingExpanded(expanded, reduceMotion = false) {
  if (!floatingWin || floatingExpanded === expanded) return;
  clearTimeout(floatingCollapseTimer);
  floatingCollapseTimer = null;
  floatingExpanded = expanded;
  if (expanded || reduceMotion) floatingWin.setBounds(floatingBounds(expanded), false);
  floatingWin.webContents.send('floating-state', {
    position: settings.floatingPosition,
    expanded,
  });
  keepWindowOnTop(floatingWin);
  if (!expanded && !reduceMotion) {
    floatingCollapseTimer = setTimeout(() => {
      floatingCollapseTimer = null;
      if (floatingWin && !floatingWin.isDestroyed() && !floatingExpanded) {
        floatingWin.setBounds(floatingBounds(false), false);
        keepWindowOnTop(floatingWin);
      }
    }, FLOATING_COLLAPSE_MS);
  }
}

function createFloatingWindow() {
  const bounds = floatingBounds(false);
  floatingWin = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    // ponytail: type toolbar = WS_EX_TOOLWINDOW，系统级不给任务栏按钮;
    // 单靠 skipTaskbar 会被反复 showInactive/setAlwaysOnTop 弄失效(Electron 已知问题)
    type: 'toolbar',
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      spellcheck: false,
    },
  });
  floatingWin.loadFile(path.join(__dirname, 'renderer', 'floating.html'));
  floatingWin.webContents.once('did-finish-load', () => {
    floatingWin.webContents.send('floating-state', {
      position: settings.floatingPosition,
      expanded: false,
    });
    if (usageSnapshot) floatingWin.webContents.send('usage-updated', usageSnapshot);
    updateFloatingVisibility();
  });
  floatingWin.webContents.on('context-menu', () => {
    Menu.buildFromTemplate(quickMenuTemplate(false)).popup({ window: floatingWin });
  });
  floatingWin.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      floatingWin.hide();
    }
  });
}

function positionPanel(anchor) {
  const { workArea } = screen.getPrimaryDisplay();
  let x = workArea.x + workArea.width - PANEL.width - 12;
  let y = workArea.y + workArea.height - PANEL.height - 12;
  if (anchor === 'top') {
    const bar = floatingBounds(false);
    x = bar.x + Math.round((bar.width - PANEL.width) / 2);
    y = bar.y + bar.height + 8;
  } else if (anchor === 'right') {
    const bar = floatingBounds(false);
    x = bar.x - PANEL.width - 8;
    y = bar.y + Math.round((bar.height - PANEL.height) / 2);
  }
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - PANEL.width - 8));
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - PANEL.height - 8));
  panelWin.setPosition(Math.round(x), Math.round(y));
}

function togglePanel(anchor = 'tray') {
  if (panelWin.isVisible()) {
    panelWin.hide();
    return;
  }
  panelAnchor = anchor;
  setFloatingExpanded(false);
  positionPanel(anchor);
  panelWin.show();
  keepWindowOnTop(panelWin);
  panelWin.focus();
}

function updateTray(snapshot) {
  if (!tray) return;
  const { claude, codex, grok } = snapshot;
  const working = [...claude.sessions, ...codex.sessions, ...grok.sessions].filter((session) => session.state === 'working').length;
  const attention = claude.sessions.filter((session) => session.state === 'attention');
  const nextAttention = new Set(attention.map((session) => session.sessionId));
  if (Notification.isSupported()) {
    for (const session of attention) {
      if (!attentionSessions.has(session.sessionId)) {
        new Notification({
          title: 'Claude Code 需要处理',
          body: session.message || `${session.project} 正在等待你的操作`,
        }).show();
      }
    }
  }
  attentionSessions = nextAttention;
  tray.setImage(trayIcon(attention.length ? 'attention' : working ? 'working' : 'idle'));
  const claudeActive = claude.sessions.some((session) =>
    ['working', 'attention'].includes(session.state),
  );
  const states = [
    attention.length && `${attention.length} \u4e2a\u9700\u5904\u7406`,
    working && `${working} \u4e2a\u5de5\u4f5c\u4e2d`,
    claude.appRunning && !claudeActive && 'Claude Desktop \u5df2\u6253\u5f00',
  ]
    .filter(Boolean)
    .join(' · ');
  const claudeWindows = claude.rateLimits;
  const codexWindows = (codex.rateLimits && codex.rateLimits.windows) || [];
  const grokWindows = (grok.rateLimits && grok.rateLimits.windows) || [];
  const rangeLabel = (usage) => usage.rangeDays === 1 ? '今日' : `${usage.rangeDays}天`;
  const windowText = (label, value) => (value ? ` · ${label} ${Math.round(value.usedPercentage)}%` : '');
  tray.setToolTip(
    `Claude (${rangeLabel(claude)}): ${fmtTokens(claude.totals.output)} out \u00b7 ${costText(claude)}` +
      windowText('5h', claudeWindows && claudeWindows.fiveHour) +
      windowText('7d', claudeWindows && claudeWindows.sevenDay) +
      windowText('Fable', claudeWindows && claudeWindows.sevenDayFable) +
      `\nCodex (${rangeLabel(codex)}): ${fmtTokens(codex.totals.output)} out · ≈$${codex.costUSD.toFixed(2)}` +
      windowText('5h', codexWindows.find((value) => value.windowMinutes === 300)) +
      windowText('7d', codexWindows.find((value) => value.windowMinutes === 10080)) +
      `
Grok (${rangeLabel(grok)}): ${fmtTokens(grok.totals.output)} out · ≈$${grok.costUSD.toFixed(2)}` +
      windowText('7d', grokWindows.find((value) => value.windowMinutes === 10080)) +
      (states ? ` · ${states}` : ''),
  );
}

function publishUsage(snapshot) {
  usageSnapshot = snapshot;
  updateTray(snapshot);
  for (const window of [panelWin, floatingWin]) {
    if (window && !window.isDestroyed()) window.webContents.send('usage-updated', snapshot);
  }
}

function refreshUsage() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = Promise.resolve()
    .then(collectAllUsage)
    .then((snapshot) => {
      publishUsage(snapshot);
      return snapshot;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function setUsageRange(provider, value) {
  if (!['claude', 'codex', 'grok'].includes(provider)) throw new RangeError('未知的用量来源');
  const rangeDays = normalizeRangeDays(value, null);
  if (!rangeDays) throw new RangeError('统计天数必须是 1 到 90 的整数');
  settings[`${provider}RangeDays`] = rangeDays;
  saveSettings();
  if (refreshPromise) await refreshPromise.catch(() => {});
  return refreshUsage();
}

function setFloatingEnabled(enabled) {
  settings.floatingEnabled = Boolean(enabled);
  saveSettings();
  syncFullscreenWatch();
  updateFloatingVisibility();
  updateTrayMenu();
}

function setFloatingHideFullscreen(enabled) {
  settings.floatingHideFullscreen = Boolean(enabled);
  saveSettings();
  syncFullscreenWatch();
  updateFloatingVisibility();
  updateTrayMenu();
}

function setFloatingPosition(position) {
  if (!['top', 'right'].includes(position)) return;
  clearTimeout(floatingCollapseTimer);
  floatingCollapseTimer = null;
  settings.floatingPosition = position;
  floatingExpanded = false;
  saveSettings();
  if (floatingWin) {
    floatingWin.setBounds(floatingBounds(false), false);
    floatingWin.webContents.send('floating-state', { position, expanded: false });
  }
  updateTrayMenu();
}

function quickMenuTemplate(includePaths) {
  const items = [
    { label: '打开完整面板', click: () => togglePanel(includePaths ? 'tray' : settings.floatingPosition) },
    { label: '刷新', click: refreshUsage },
    {
      label: '开机自启',
      type: 'checkbox',
      checked:
        app.isPackaged &&
        app.getLoginItemSettings({ path: LOGIN_ITEM_PATH }).executableWillLaunchAtLogin,
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: LOGIN_ITEM_PATH });
        updateTrayMenu();
      },
    },
    {
      label: '显示悬浮条',
      type: 'checkbox',
      checked: settings.floatingEnabled,
      click: (item) => setFloatingEnabled(item.checked),
    },
    {
      label: '全屏应用时隐藏悬浮条',
      type: 'checkbox',
      checked: settings.floatingHideFullscreen,
      enabled: settings.floatingEnabled,
      click: (item) => setFloatingHideFullscreen(item.checked),
    },
    {
      label: '悬浮条位置',
      submenu: [
        {
          label: '顶部',
          type: 'radio',
          checked: settings.floatingPosition === 'top',
          click: () => setFloatingPosition('top'),
        },
        {
          label: '右侧',
          type: 'radio',
          checked: settings.floatingPosition === 'right',
          click: () => setFloatingPosition('right'),
        },
      ],
    },
  ];
  if (includePaths) {
    items.push(
      { type: 'separator' },
      { label: '打开 Claude 会话目录', click: () => shell.openPath(DEFAULT_ROOT) },
      { label: '打开 Codex 会话目录', click: () => shell.openPath(DEFAULT_CODEX_ROOT) },
      { label: '打开 Grok 会话目录', click: () => shell.openPath(path.join(DEFAULT_GROK_ROOT, 'sessions')) },
    );
  }
  items.push(
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  );
  return items;
}

function updateTrayMenu() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(quickMenuTemplate(true)));
}

app.whenReady().then(() => {
  loadSettings();
  loadAccountLedger();
  createPanelWindow();
  createFloatingWindow();
  syncFullscreenWatch();
  tray = new Tray(trayIcon());
  updateTrayMenu();
  tray.on('click', () => togglePanel('tray'));
  screen.on('display-metrics-changed', () => {
    if (floatingWin) {
      floatingWin.setBounds(floatingBounds(), false);
      keepWindowOnTop(floatingWin);
    }
    if (panelWin && panelWin.isVisible()) positionPanel(panelAnchor);
  });
  refreshUsage();
  setInterval(refreshUsage, 30_000);
});

app.on('second-instance', () => {
  if (panelWin) togglePanel('tray');
});

ipcMain.handle('usage', () => usageSnapshot || refreshUsage());
ipcMain.handle('usage-range', (event, provider, rangeDays) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的统计范围请求');
  return setUsageRange(provider, rangeDays);
});
ipcMain.handle('account-ledger-clear', async (event) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账号统计请求');
  if (refreshPromise) await refreshPromise.catch(() => {});
  clearAccountLedger();
  return refreshUsage();
});
ipcMain.handle('floating-state', () => ({
  position: settings.floatingPosition,
  expanded: floatingExpanded,
}));
ipcMain.on('floating-expanded', (event, state) => {
  if (floatingWin && event.sender === floatingWin.webContents) {
    setFloatingExpanded(Boolean(state && state.expanded), Boolean(state && state.reduceMotion));
  }
});
ipcMain.on('open-panel', (event) => {
  if (floatingWin && event.sender === floatingWin.webContents) togglePanel(settings.floatingPosition);
});
ipcMain.on('close-panel', (event) => {
  if (panelWin && event.sender === panelWin.webContents) panelWin.hide();
});
ipcMain.handle('claude-auth-status', (event) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账户请求');
  return claudeAuthStatus();
});
ipcMain.handle('claude-auth-connect', (event) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账户请求');
  return beginClaudeAccountConnection();
});
ipcMain.handle('claude-auth-complete', async (event, code) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账户请求');
  await completeClaudeAccountConnection(code);
  if (refreshPromise) await refreshPromise.catch(() => {});
  await refreshUsage();
  return claudeAuthStatus();
});
ipcMain.handle('claude-auth-cancel', (event) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账户请求');
  cancelClaudeAccountConnection();
  return claudeAuthStatus();
});
ipcMain.handle('claude-auth-disconnect', async (event) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账户请求');
  if (refreshPromise) await refreshPromise.catch(() => {});
  disconnectClaudeAccount();
  await refreshUsage();
  return claudeAuthStatus();
});
ipcMain.handle('open-session', async (event, session) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的会话请求');
  const target = sessionTarget(session);
  try {
    await shell.openExternal(target.uri);
  } catch {
    throw new Error('无法打开桌面客户端');
  }
  panelWin.hide();
  return { exact: true };
});

app.on('before-quit', () => {
  quitting = true;
  if (fullscreenWatch) {
    fullscreenWatch.stop();
    fullscreenWatch = null;
  }
  clearTimeout(accountLedgerWriteTimer);
  accountLedgerWriteTimer = null;
  flushAccountLedger();
  if (usageWorker) usageWorker.terminate();
  usageWorker = null;
});

// tray app: closing the panel must not quit
app.on('window-all-closed', () => {});

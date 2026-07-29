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
const { spawn } = require('child_process');
const { collectUsage, DEFAULT_ROOT } = require('./lib/usage');
const { collectCodexUsage, DEFAULT_CODEX_ROOT } = require('./lib/codex-usage');
const { sessionTarget } = require('./lib/open-session');
const {
  createAuthorization,
  parseAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchUsage: fetchClaudeOAuthUsage,
} = require('./lib/claude-oauth');

const systemFetch = (...args) => net.fetch(...args);

const PANEL = { width: 380, height: 544 };
const FLOATING_SIZE = {
  top: { collapsed: [360, 42], expanded: [440, 224] },
  right: { collapsed: [58, 246], expanded: [326, 328] },
};
const FLOATING_COLLAPSE_MS = 300;
const CLAUDE_OAUTH_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS = { floatingEnabled: true, floatingPosition: 'top' };
let tray = null;
let panelWin = null;
let floatingWin = null;
let quitting = false;
let suppressPanelBlur = false;
let panelAnchor = 'tray';
let floatingExpanded = false;
let floatingCollapseTimer = null;
let fullscreenActive = false;
let fullscreenWatcher = null;
let settings = { ...DEFAULT_SETTINGS };
let usageSnapshot = null;
let refreshPromise = null;
let attentionSessions = new Set();
let pendingClaudeAuthorization = null;
let claudeLoginPromise = null;
let claudeOAuthPromise = null;
let claudeOAuthCache = null;
let claudeAuthError = null;

if (!app.requestSingleInstanceLock()) app.quit();

const fmtTokens = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings.floatingEnabled = saved.floatingEnabled !== false;
    settings.floatingPosition = saved.floatingPosition === 'right' ? 'right' : 'top';
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

function emptyUsage(error, collectedAt) {
  const date = new Date(collectedAt).toLocaleDateString('sv-SE');
  return {
    date,
    byModel: {},
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 },
    costUSD: 0,
    unknownModels: [],
    sessions: [],
    rateLimits: null,
    dataStatus: { state: 'error', updatedAt: collectedAt, message: error },
  };
}

function collectProvider(name, collect, collectedAt) {
  try {
    return { ...collect(), dataStatus: { state: 'ok', updatedAt: collectedAt } };
  } catch (error) {
    const message = error && error.code === 'EACCES' ? '本地数据无读取权限' : '本地数据读取失败';
    const previous = usageSnapshot && usageSnapshot[name];
    return previous
      ? {
          ...previous,
          dataStatus: {
            state: 'stale',
            updatedAt: previous.dataStatus?.updatedAt || collectedAt,
            message,
          },
        }
      : emptyUsage(message, collectedAt);
  }
}

async function collectAllUsage() {
  const collectedAt = Date.now();
  const snapshot = {
    collectedAt,
    claude: collectProvider('claude', collectUsage, collectedAt),
    codex: collectProvider('codex', collectCodexUsage, collectedAt),
  };
  const oauthRateLimits = await getClaudeOAuthRateLimits();
  if (oauthRateLimits) snapshot.claude.rateLimits = oauthRateLimits;
  snapshot.claude.auth = claudeAuthStatus();
  return snapshot;
}

// 16x16 clay-colored square drawn as raw BGRA — no binary icon asset needed.
function trayIcon(state = 'idle') {
  const [b, g, r] =
    {
      working: [0x6e, 0xaf, 0x4c],
      waiting: [0x41, 0xa4, 0xd9],
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
  panelWin.on('blur', () => {
    if (!suppressPanelBlur) panelWin.hide();
  });
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

function updateFloatingVisibility() {
  if (!floatingWin || floatingWin.isDestroyed()) return;
  if (settings.floatingEnabled && !fullscreenActive) floatingWin.showInactive();
  else floatingWin.hide();
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
  if (!expanded && !reduceMotion) {
    floatingCollapseTimer = setTimeout(() => {
      floatingCollapseTimer = null;
      if (floatingWin && !floatingWin.isDestroyed() && !floatingExpanded) {
        floatingWin.setBounds(floatingBounds(false), false);
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
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      spellcheck: false,
    },
  });
  floatingWin.setAlwaysOnTop(true, 'floating');
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
  panelWin.focus();
}

function updateTray(snapshot) {
  if (!tray) return;
  const { claude, codex } = snapshot;
  const working = [...claude.sessions, ...codex.sessions].filter((session) => session.state === 'working').length;
  const waiting = claude.sessions.filter((session) => session.state === 'waiting').length;
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
  tray.setImage(trayIcon(attention.length ? 'attention' : waiting ? 'waiting' : working ? 'working' : 'idle'));
  const states = [
    attention.length && `${attention.length} 个需处理`,
    working && `${working} 个工作中`,
    waiting && `${waiting} 个等你`,
  ]
    .filter(Boolean)
    .join(' · ');
  const claudeWindows = claude.rateLimits;
  const codexWindows = (codex.rateLimits && codex.rateLimits.windows) || [];
  const windowText = (label, value) => (value ? ` · ${label} ${Math.round(value.usedPercentage)}%` : '');
  tray.setToolTip(
    `Claude: ${fmtTokens(claude.totals.output)} out · ≈$${claude.costUSD.toFixed(2)}` +
      windowText('5h', claudeWindows && claudeWindows.fiveHour) +
      windowText('7d', claudeWindows && claudeWindows.sevenDay) +
      `\nCodex: ${fmtTokens(codex.totals.output)} out · ≈$${codex.costUSD.toFixed(2)}` +
      windowText('5h', codexWindows.find((value) => value.windowMinutes === 300)) +
      windowText('7d', codexWindows.find((value) => value.windowMinutes === 10080)) +
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

function setFloatingEnabled(enabled) {
  settings.floatingEnabled = Boolean(enabled);
  saveSettings();
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
      label: '显示悬浮条',
      type: 'checkbox',
      checked: settings.floatingEnabled,
      click: (item) => setFloatingEnabled(item.checked),
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

function startFullscreenWatcher() {
  if (process.platform !== 'win32') return;
  const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FullscreenProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static bool IsPrimaryFullscreen(int ownPid) {
    var window = GetForegroundWindow();
    if (window == IntPtr.Zero || window == GetShellWindow() || window == GetDesktopWindow() || IsIconic(window)) return false;
    uint pid; GetWindowThreadProcessId(window, out pid);
    if (pid == ownPid) return false;
    RECT rect; if (!GetWindowRect(window, out rect)) return false;
    var monitor = MonitorFromWindow(window, 2);
    var info = new MONITORINFO(); info.cbSize = Marshal.SizeOf(info);
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info) || (info.dwFlags & 1) == 0) return false;
    const int tolerance = 2;
    return Math.Abs(rect.Left - info.rcMonitor.Left) <= tolerance
      && Math.Abs(rect.Top - info.rcMonitor.Top) <= tolerance
      && Math.Abs(rect.Right - info.rcMonitor.Right) <= tolerance
      && Math.Abs(rect.Bottom - info.rcMonitor.Bottom) <= tolerance;
  }
}
'@
$last = $null
while ($true) {
  try { $next = [FullscreenProbe]::IsPrimaryFullscreen(${process.pid}) } catch { $next = $false }
  if ($next -ne $last) {
    if ($next) { [Console]::Out.WriteLine('1') } else { [Console]::Out.WriteLine('0') }
    [Console]::Out.Flush()
    $last = $next
  }
  Start-Sleep -Milliseconds 750
}`;
  fullscreenWatcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let buffer = '';
  fullscreenWatcher.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line !== '0' && line !== '1') continue;
      fullscreenActive = line === '1';
      updateFloatingVisibility();
    }
  });
  const resetFullscreenState = () => {
    fullscreenWatcher = null;
    fullscreenActive = false;
    updateFloatingVisibility();
  };
  fullscreenWatcher.once('error', resetFullscreenState);
  fullscreenWatcher.once('exit', resetFullscreenState);
}

app.whenReady().then(() => {
  loadSettings();
  createPanelWindow();
  createFloatingWindow();
  tray = new Tray(trayIcon());
  updateTrayMenu();
  tray.on('click', () => togglePanel('tray'));
  screen.on('display-metrics-changed', () => {
    if (floatingWin) floatingWin.setBounds(floatingBounds(), false);
    if (panelWin && panelWin.isVisible()) positionPanel(panelAnchor);
  });
  startFullscreenWatcher();
  refreshUsage();
  setInterval(refreshUsage, 30_000);
});

app.on('second-instance', () => {
  if (panelWin) togglePanel('tray');
});

ipcMain.handle('usage', () => usageSnapshot || refreshUsage());
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
ipcMain.handle('claude-auth-status', (event) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账户请求');
  return claudeAuthStatus();
});
ipcMain.handle('claude-auth-connect', async (event) => {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('无效的账户请求');
  suppressPanelBlur = true;
  try {
    return await beginClaudeAccountConnection();
  } finally {
    suppressPanelBlur = false;
  }
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
  if (fullscreenWatcher) fullscreenWatcher.kill();
});

// tray app: closing the panel must not quit
app.on('window-all-closed', () => {});

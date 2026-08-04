'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_INDEXED_DB_ROOT = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Claude',
  'IndexedDB',
);
const SNAPSHOT_PREFIX = 'claude-usage-tray-indexeddb-';

function cacheSignature(root = DEFAULT_INDEXED_DB_ROOT) {
  let newest = 0;
  let bytes = 0;
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(filePath);
      else {
        const stat = fs.statSync(filePath);
        newest = Math.max(newest, stat.mtimeMs);
        bytes += stat.size;
      }
    }
  };
  try {
    scan(root);
    return newest ? `${newest}:${bytes}` : null;
  } catch {
    return null;
  }
}

function createSnapshot(sourceRoot = DEFAULT_INDEXED_DB_ROOT, tempRoot = os.tmpdir()) {
  const snapshotRoot = fs.mkdtempSync(path.join(tempRoot, SNAPSHOT_PREFIX));
  try {
    fs.cpSync(sourceRoot, path.join(snapshotRoot, 'IndexedDB'), { recursive: true });
    return snapshotRoot;
  } catch (error) {
    removeSnapshot(snapshotRoot, tempRoot);
    throw error;
  }
}

function removeSnapshot(snapshotRoot, tempRoot = os.tmpdir()) {
  if (!snapshotRoot) return true;
  const resolved = path.resolve(snapshotRoot);
  const allowedRoot = path.resolve(tempRoot) + path.sep;
  if (!resolved.startsWith(allowedRoot) || path.basename(resolved).indexOf(SNAPSHOT_PREFIX) !== 0) return false;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return !fs.existsSync(resolved);
  } catch {
    // The probe process may still be releasing Chromium's LevelDB handles.
    return false;
  }
}

function extractLatestConversation(queries) {
  const conversations = (Array.isArray(queries) ? queries : [])
    .map((query) => query && query.state && query.state.data)
    .filter((data) => data && typeof data.uuid === 'string' && Array.isArray(data.chat_messages))
    .map((data) => ({
      sessionId: data.uuid,
      title: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Claude Desktop 聊天',
      model: typeof data.model === 'string' ? data.model : null,
      createdAt: Date.parse(data.created_at),
      updatedAt: Date.parse(data.updated_at),
      messageCount: data.chat_messages.length,
      assistantMessages: data.chat_messages.filter((message) => message && message.sender === 'assistant').length,
    }))
    .filter((conversation) => Number.isFinite(conversation.updatedAt))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return conversations[0] || null;
}

function desktopConversationSession(conversation, now = Date.now()) {
  if (!conversation || !Number.isFinite(conversation.updatedAt)) return null;
  if (conversation.updatedAt < now - 24 * 60 * 60 * 1000) return null;
  return {
    sessionId: conversation.sessionId,
    project: conversation.model || 'Claude Desktop',
    cwd: null,
    client: 'Desktop Chat',
    title: conversation.title,
    file: null,
    mtime: conversation.updatedAt,
    state: now - conversation.updatedAt < 2 * 60 * 1000 ? 'working' : 'idle',
    fromHook: false,
    message: conversation.model || null,
    source: 'desktop-cache',
  };
}

async function runProbe(profilePath) {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', path.join(profilePath, 'ProbeUserData'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const probeSession = session.fromPath(path.resolve(profilePath));
  probeSession.protocol.handle('https', (request) =>
    new URL(request.url).origin === 'https://claude.ai'
      ? new Response('<!doctype html><meta charset="utf-8">', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      : new Response('', { status: 404 }),
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: probeSession,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await window.loadURL('https://claude.ai/__usage_tray_probe__');
    const queries = await window.webContents.executeJavaScript(`(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const cache = await new Promise((resolve, reject) => {
          const request = database.transaction('keyval', 'readonly').objectStore('keyval').get('react-query-cache');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const queries = (cache && cache.clientState && cache.clientState.queries) || [];
        return queries.map((query) => {
          const data = query && query.state && query.state.data;
          if (!data || !Array.isArray(data.chat_messages)) return null;
          return { state: { data: {
            uuid: data.uuid,
            name: data.name,
            model: data.model,
            created_at: data.created_at,
            updated_at: data.updated_at,
            chat_messages: data.chat_messages.map((message) => ({ sender: message && message.sender })),
          } } };
        }).filter(Boolean);
      } finally {
        database.close();
      }
    })()`);
    return extractLatestConversation(queries);
  } finally {
    window.destroy();
    probeSession.protocol.unhandle('https');
  }
}

module.exports = {
  DEFAULT_INDEXED_DB_ROOT,
  cacheSignature,
  createSnapshot,
  removeSnapshot,
  extractLatestConversation,
  desktopConversationSession,
  runProbe,
};

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getUsage: () => ipcRenderer.invoke('usage'),
  onUsage: (callback) => {
    const listener = (_event, usage) => callback(usage);
    ipcRenderer.on('usage-updated', listener);
    return () => ipcRenderer.removeListener('usage-updated', listener);
  },
  openSession: (session) => ipcRenderer.invoke('open-session', session),
  getClaudeAuth: () => ipcRenderer.invoke('claude-auth-status'),
  connectClaude: () => ipcRenderer.invoke('claude-auth-connect'),
  completeClaude: (code) => ipcRenderer.invoke('claude-auth-complete', code),
  cancelClaude: () => ipcRenderer.invoke('claude-auth-cancel'),
  disconnectClaude: () => ipcRenderer.invoke('claude-auth-disconnect'),
  getFloatingState: () => ipcRenderer.invoke('floating-state'),
  onFloatingState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('floating-state', listener);
    return () => ipcRenderer.removeListener('floating-state', listener);
  },
  setFloatingExpanded: (expanded, reduceMotion = false) =>
    ipcRenderer.send('floating-expanded', { expanded, reduceMotion }),
  openPanel: () => ipcRenderer.send('open-panel'),
  closePanel: () => ipcRenderer.send('close-panel'),
});

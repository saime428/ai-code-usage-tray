'use strict';
// 悬浮条流光环的快车道:30 秒的完整快照太慢,一轮对话常常跑不满 30 秒,
// 环会在任务结束后才亮。这里不解析 transcript,只回答「这家现在在不在跑」,
// 靠两个信号:Claude hook 写的状态文件(准),以及会话目录刚刚有没有写入
// (所有客户端通用,不需要 hook)。

const fs = require('fs');
const path = require('path');
const { readStatuses, DEFAULT_ROOT, DEFAULT_STATUS_DIR } = require('./usage');
const { DEFAULT_CODEX_ROOT } = require('./codex-usage');
const { DEFAULT_GROK_ROOT } = require('./grok-usage');

// 没有 hook 的会话只能看「刚写过盘」。模型长时间思考时不落盘,窗口太短环会闪。
// ponytail: 要精确熄灭就得在 watch 事件里读改动文件的尾行(Grok 的 turn_completed /
// Codex 的 token_count),先用时间窗,闪得厉害再上。
const WRITE_ACTIVE_MS = 20_000;
// hook 说 working 但一直没有新写入:崩溃的会话不会补 Stop,环不能一直转下去。
const HOOK_WORKING_MS = 15 * 60 * 1000;
// watch 事件在一轮对话里非常密集,合并一下再算。
const COALESCE_MS = 400;

const IDLE = { claude: '', codex: '', grok: '' };

// statuses: readStatuses() 的 Map;writes: 每家最后一次写入的时间戳
function providerStates({ statuses, writes, now }) {
  const hooks = [...statuses.values()];
  const wroteRecently = (provider) => now - (writes[provider] || 0) < WRITE_ACTIVE_MS;
  const claudeWorking =
    hooks.some((s) => s.state === 'working' && now - s.ts < HOOK_WORKING_MS) ||
    wroteRecently('claude');
  return {
    claude: hooks.some((s) => s.state === 'attention') ? 'attention' : claudeWorking ? 'working' : '',
    codex: wroteRecently('codex') ? 'working' : '',
    grok: wroteRecently('grok') ? 'working' : '',
  };
}

const same = (a, b) => a.claude === b.claude && a.codex === b.codex && a.grok === b.grok;

// watch 事件不等于有新内容:重命名、属性变更、客户端自己的会话迁移都会触发。
// 2026-09-21 Codex Desktop 就这么让环平白转了 20 秒(那一小时里 sessions 树下
// 没有任何 .jsonl 被写过)。实测真正的追加写 mtime 是同步更新的(年龄 0–2ms),
// 所以拿 mtime 复核一遍:文件本身不新就不算在跑。
function hasFreshWrite(file, now) {
  try {
    return now - fs.statSync(file).mtimeMs < WRITE_ACTIVE_MS;
  } catch {
    return false; // 事件到达时文件已被删掉/改名:当没写过
  }
}

function startActivityWatch({
  onChange,
  statusDir = DEFAULT_STATUS_DIR,
  roots = {
    claude: DEFAULT_ROOT,
    codex: DEFAULT_CODEX_ROOT,
    grok: path.join(DEFAULT_GROK_ROOT, 'sessions'),
  },
} = {}) {
  const writes = {};
  const watchers = [];
  let current = { ...IDLE };
  let coalesceTimer = null;
  let expiryTimer = null;
  let stopped = false;

  const evaluate = () => {
    if (stopped) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
    const now = Date.now();
    let statuses = new Map();
    try {
      statuses = readStatuses(statusDir, new Date(now));
    } catch {
      // 状态目录读不到就只靠写入时间,不能让看门狗式的读取拖垮主进程
    }
    const next = providerStates({ statuses, writes, now });
    if (!same(current, next)) {
      current = next;
      onChange({ ...current });
    }
    // 只在还亮着的时候轮询到期:全灭之后完全靠 watch 事件唤醒,闲时零开销
    if (Object.values(current).some(Boolean)) expiryTimer = setTimeout(evaluate, 1000);
  };

  const schedule = () => {
    if (stopped || coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      evaluate();
    }, COALESCE_MS);
  };

  const watch = (dir, accept, onEvent) => {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        const name = filename && String(filename);
        if (!name || !accept(name)) return;
        onEvent(path.join(dir, name));
        schedule();
      });
      // 目录被删掉/换盘时 watcher 会报错,托盘不能因此崩掉
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // 没装这家客户端,目录不存在:安静跳过,30 秒快照仍然会兜底
    }
  };

  // rate-limits.json 是 statusLine 每次渲染都重写的,跟「在不在跑」无关,别让它刷屏
  watch(statusDir, (name) => name.endsWith('.json') && !name.endsWith('rate-limits.json'), () => {});
  for (const [provider, dir] of Object.entries(roots)) {
    watch(dir, (name) => name.endsWith('.jsonl'), (file) => {
      const now = Date.now();
      if (hasFreshWrite(file, now)) writes[provider] = now;
    });
  }
  evaluate();

  return {
    current: () => ({ ...current }),
    stop() {
      stopped = true;
      clearTimeout(coalesceTimer);
      clearTimeout(expiryTimer);
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}

module.exports = { startActivityWatch, providerStates, hasFreshWrite, WRITE_ACTIVE_MS, HOOK_WORKING_MS };

'use strict';
// 悬浮条流光环和托盘图标的快车道:30 秒的完整快照太慢,一轮对话常常跑不满 30 秒,
// 环会在任务结束后才亮。这里只回答「这家现在在不在跑、最近一轮什么时候结束的」,靠三个信号:
// Claude hook 写的状态文件(准);会话目录刚刚有没有写入(所有客户端通用,不需要 hook);以及
// Codex、Grok、Antigravity 日志的最后几行(看得出这一轮结束没有)。Claude 的 transcript 和
// OpenCode 不解析。

const fs = require('fs');
const path = require('path');
const { readStatuses, DEFAULT_ROOT, DEFAULT_STATUS_DIR } = require('./usage');
const { DEFAULT_CODEX_ROOT } = require('./codex-usage');
const { DEFAULT_GROK_ROOT } = require('./grok-usage');
const { DEFAULT_ANTIGRAVITY_HOME } = require('./antigravity-usage');
const { defaultDbPath: openCodeDbPath } = require('./opencode-usage');

// 没有 hook 的 Claude 会话和 OpenCode 只能看「刚写过盘」。模型长时间思考时不落盘,窗口太短环会闪。
// ponytail: Claude 的 transcript 也有 stop_reason: end_turn,但后面跟着一串 stop_hook_summary、
// queue-operation、last-prompt 之类的记录(2026-10-08 本机 101 份统计),规则不如 hook 干净,先不做。
const WRITE_ACTIVE_MS = 20_000;
// hook 说 working 但一直没有新写入:崩溃的会话不会补 Stop,环不能一直转下去。
const HOOK_WORKING_MS = 15 * 60 * 1000;
// watch 事件在一轮对话里非常密集,合并一下再算。
const COALESCE_MS = 400;
// 能从文件看出「这一轮还没完」的家(Codex、Grok、Antigravity):模型长时间思考、工具长时间运行时
// 不落盘,但轮次没结束,环要一直亮。崩溃时不会写出收尾,所以最后一次写入后最多再亮这么久。
const OPEN_TURN_MS = 10 * 60 * 1000;
const TAIL_CHUNK = 64 * 1024;
const TAIL_LIMIT = 4 * 1024 * 1024;

const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'opencode'];
const IDLE = Object.fromEntries(PROVIDERS.map((provider) => [provider, '']));

// 文件末尾最多 `count` 个完整行,以及最后一段是不是还在写的半行。一行可能很大(Antigravity 的
// 工具输出 7KB,Codex 的图片或工具输出能有 5MB),所以从尾部按 64KB 往回读,只在新读的块里找换行,
// 最多看 4MB。块先攒着最后拼一次:每块都拼的话,读满 4MB 要来回复制约 130MB,主线程一次 43ms
// (Fable 审查实测,读到 5MB 的那一行之后每个事件都这样)。
function tailLines(file, count) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const chunks = [];
    let position = size;
    let newlines = 0;
    // count 行完整的要 count+1 个换行(第一行前面那个),除非读到了文件开头
    while (position > 0 && size - position < TAIL_LIMIT && newlines <= count) {
      const length = Math.min(TAIL_CHUNK, position);
      position -= length;
      // 只用真正读到的字节:文件在 fstat 和读之间被截短时,allocUnsafe 的剩余部分是旧内存
      const buffer = Buffer.allocUnsafe(length);
      const chunk = buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
      for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) newlines += 1;
      chunks.unshift(chunk);
    }
    const bytes = Buffer.concat(chunks);
    // 没读到文件头时,第一个换行之前多半是半行:连字节一起跳过,不用把几 MB 的半行解码成字符串
    const segments = bytes.subarray(position > 0 ? bytes.indexOf(0x0a) + 1 : 0).toString('utf8').split('\n');
    const partial = segments.pop().trim() !== ''; // 不以换行结尾:最后一行还在写
    // whole:读到了文件头。没读到头又凑不够行数,是撞上了 4MB 上限(Codex 一行图片或工具输出能有 5MB)
    return { lines: segments.map((line) => line.trim()).filter(Boolean).slice(-count), partial, whole: position === 0 };
  } catch {
    return null; // 事件到达时文件已被删掉/改名
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Antigravity 的步骤转录看得出这一轮结束没有(2026-10-05 用本机 29 份转录、1672 步统计):
// 不带 tool_calls 的 PLANNER_RESPONSE(最终回答)后面接用户的新消息或文件结尾,点停止也会补写
// 这样一步;其余所有类型——USER_INPUT、GENERIC(工具结果)、带 tool_calls 的 PLANNER_RESPONSE、
// RUN_COMMAND、VIEW_FILE、SYSTEM_MESSAGE、EPHEMERAL_MESSAGE、ERROR_MESSAGE 等十几种——后面
// 100% 接同一轮的下一步。CHECKPOINT 两种都有,看它前一步:前一步是最终回答就结束了(7 次),
// 否则还在跑(18 次)。所以只有「跳过末尾的 CHECKPOINT 后是最终回答」才算结束,认不出的新类型
// 也算没结束,靠 OPEN_TURN_MS 兜底——第一版反过来只认三种,本机 10% 的步骤被误判成结束,恰好是
// 命令跑完、模型长考的时刻(Fable 审查指出)。
//
// Codex 和 Grok 的日志里也有现成的回合标记(2026-10-08 用本机数据统计):
// - Codex:一轮从 task_started 到 task_complete,点停止是 turn_aborted。21 天 59 个文件 408 轮里,
//   task_complete 之后、下一轮之前只出现过 thread_settings_applied、thread_goal_updated、item_completed
//   (8 月的版本还有 world_state)。
// - Grok:updates.jsonl 里一轮以 turn_completed 结束,之后只跟 session_recap、stop / session_end /
//   session_start 这几种 hook、memory_dream_*,或者下一轮的 user_prompt_submit、用户消息。
// 三家用同一条规则:跳过末尾的收尾事件,剩下最后一条是结束标记才算这一轮完了,其余都算还在跑。
// 末尾 8 行全是收尾事件时往前多读:7 月的 Codex 一轮里会连写十几条 item_completed,只看 8 行
// 会把还在跑的一轮当成结束(本机回放 1405 处误判,全是这种)。末尾的行大到读不全(超过 4MB)时
// 算还在跑:结束标记都是短行,大行是一轮中间的图片或工具输出(本机回放 6 处,一行 4.3–5.2MB)。
const turnRule = (kindOf, after, ends) => (file) => {
  for (let count = 8; count <= 4096; count *= 8) {
    const tail = tailLines(file, count);
    if (!tail) return false;
    if (tail.partial) return true; // 一行正在写
    for (let i = tail.lines.length - 1; i >= 0; i -= 1) {
      let entry;
      try {
        entry = JSON.parse(tail.lines[i]);
      } catch {
        return false; // 写坏的行:宁可灭
      }
      // 另一个程序写的文件:一行可能是合法 JSON 却不是对象(比如 null),和写坏的行一样当结束,
      // 而且不能在主进程里抛出去(启动时抛出会让后面的初始化都不跑)
      if (entry === null || typeof entry !== 'object') return false;
      const kind = kindOf(entry);
      if (after.has(kind)) continue;
      return !ends.has(kind);
    }
    if (tail.lines.length < count) return !tail.whole; // 读到文件头:空文件,或只有收尾事件
  }
  return false;
};
const antigravityTurnOpen = turnRule(
  (step) => (step.type === 'PLANNER_RESPONSE' && !(Array.isArray(step.tool_calls) && step.tool_calls.length > 0) ? 'PLANNER_RESPONSE:answer' : step.type),
  new Set(['CHECKPOINT']),
  new Set(['PLANNER_RESPONSE:answer']),
);
const codexTurnOpen = turnRule(
  (entry) => (entry.type === 'event_msg' ? entry.payload && entry.payload.type : entry.type),
  new Set(['thread_settings_applied', 'thread_goal_updated', 'item_completed', 'world_state']),
  new Set(['task_complete', 'turn_aborted']),
);
const grokTurnOpen = turnRule(
  (entry) => {
    const update = (entry.params && entry.params.update) || {};
    return update.sessionUpdate === 'hook_execution' ? `hook:${update.event_name}` : update.sessionUpdate;
  },
  new Set(['session_recap', 'memory_dream_queued', 'memory_dream_started', 'memory_dream_completed',
    'task_backgrounded', 'task_completed', 'hook:stop', 'hook:session_end', 'hook:session_start']),
  new Set(['turn_completed']),
);

// sessions/<年>/<月>/<日>/rollout-*.jsonl,整棵树走一遍(本机 244 个文件 13ms)
function codexRollouts(dir) {
  const files = [];
  const walk = (folder, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  walk(dir, 0);
  return files;
}

// Antigravity 和 OpenCode 的会话在 SQLite 里,不是 .jsonl,各自要认别的文件(2026-10-05 实测)。
// - Antigravity:库旁边的 -wal 闲着时也会被新建、删除(开关连接、checkpoint,修改时间都是刚刚),
//   拿它当信号环会在没人用时闪;brain/<会话>/.system_generated/logs/transcript.jsonl 只在跑一轮时追加,
//   闲置 4 分钟一次没写、两段生成里一直在写。只认 antigravity(IDE)和 antigravity-cli(CLI):
//   antigravity-ide / antigravity-backup 是副本,同步时也会写。
// - OpenCode:全在一个 opencode.db 里,只认它 -wal 的 change。我们自己只读打开时只碰 -shm,
//   -wal 的新建/删除来的是 rename。只看顶层,不递归(旁边的 log/ 会刷屏)。
//   ponytail: 作者本机不用 OpenCode,这条没实测过;闪或不亮再改。
// Codex 和 Grok 是普通 .jsonl,但也看回合标记(见上面 turnRule)。Grok 的会话目录里还有 chat_history、
// events 等文件,只有 updates.jsonl 带标记,也只有它在一轮里一直写。
const SOURCES = {
  codex: {
    dir: DEFAULT_CODEX_ROOT,
    accept: (name) => name.endsWith('.jsonl'),
    turnOpen: codexTurnOpen,
    transcripts: codexRollouts,
  },
  grok: {
    dir: path.join(DEFAULT_GROK_ROOT, 'sessions'),
    accept: (name) => /(^|[\\/])updates\.jsonl$/.test(name),
    turnOpen: grokTurnOpen,
    transcripts: (dir) => {
      try {
        return fs.readdirSync(dir).flatMap((cwd) => {
          try {
            return fs.readdirSync(path.join(dir, cwd)).map((id) => path.join(dir, cwd, id, 'updates.jsonl'));
          } catch {
            return []; // session_search.sqlite 之类的文件
          }
        });
      } catch {
        return [];
      }
    },
  },
  antigravity: {
    dir: DEFAULT_ANTIGRAVITY_HOME,
    accept: (name) => /^antigravity(-cli)?[\\/]brain[\\/][^\\/]+[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i.test(name),
    turnOpen: antigravityTurnOpen,
    // 启动时、以及 watch 缓冲溢出丢了事件时,把这些转录过一遍
    transcripts: (dir) => ['antigravity', 'antigravity-cli'].flatMap((root) => {
      try {
        return fs.readdirSync(path.join(dir, root, 'brain'))
          .map((id) => path.join(dir, root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'));
      } catch {
        return [];
      }
    }),
  },
  opencode: {
    dir: path.dirname(openCodeDbPath()),
    recursive: false,
    accept: (name, event) => event === 'change' && name === 'opencode.db-wal',
  },
};

// statuses: readStatuses() 的 Map;writes: 每家最后一次写入的时间戳;
// openTurns: 还没结束的那些轮里最近一次写入的时间(没有就是 0)
function providerStates({ statuses, writes, openTurns = {}, now }) {
  const hooks = [...statuses.values()];
  const wroteRecently = (provider) =>
    now - (writes[provider] || 0) < WRITE_ACTIVE_MS || now - (openTurns[provider] || 0) < OPEN_TURN_MS;
  const claudeWorking =
    hooks.some((s) => s.state === 'working' && now - s.ts < HOOK_WORKING_MS) ||
    wroteRecently('claude');
  return {
    ...Object.fromEntries(PROVIDERS.map((provider) => [provider, wroteRecently(provider) ? 'working' : ''])),
    claude: hooks.some((s) => s.state === 'attention') ? 'attention' : claudeWorking ? 'working' : '',
  };
}

const same = (a, b) => PROVIDERS.every((provider) => a[provider] === b[provider]);

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
  roots = { claude: DEFAULT_ROOT },
  sources = SOURCES,
} = {}) {
  const writes = {};
  const openTurns = {};
  // 按文件记:两个会话并行时,一个结束不能把另一个也熄掉
  const openFiles = {};
  // 托盘的「跑完待看」要用:每家最近一次看到一轮结束(结束标记,或 Claude 的 Stop hook)的时间,
  // 以及最近一次开始跑的时间。只认真正的结束标记,只靠写盘时间判断的(没装 hook 的 Claude、OpenCode)没有
  const ended = {};
  const since = {};
  const overflowed = new Set();
  const watchers = [];
  let current = { ...IDLE };
  let coalesceTimer = null;
  let expiryTimer = null;
  let stopped = false;

  const setTurn = (provider, file, open, at) => {
    const files = (openFiles[provider] ||= new Map());
    if (open) files.set(file, at);
    // 从没结束变成结束才算「跑完了」。过了 OPEN_TURN_MS 的那一轮也留在表里不删:工具一口气跑了
    // 十几分钟才收尾时环早灭了,但这一轮确实跑完了。启动时就已经结束的转录不算(表里没有它)。
    else if (files.delete(file)) ended[provider] = Math.max(ended[provider] || 0, at);
    let latest = 0;
    for (const time of files.values()) if (Date.now() - time < OPEN_TURN_MS) latest = Math.max(latest, time);
    openTurns[provider] = latest;
  };

  // 把这家最近写过的转录都判一遍。时间记成文件最后一次写入的时刻,上限从那里算起。
  const rescan = (provider) => {
    const { dir, turnOpen, transcripts } = sources[provider];
    const now = Date.now();
    for (const file of transcripts(dir)) {
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime >= OPEN_TURN_MS) continue;
      setTurn(provider, file, turnOpen(file), mtime);
      writes[provider] = Math.max(writes[provider] || 0, mtime);
    }
  };

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
    for (const status of statuses.values()) {
      if (status.event === 'Stop') ended.claude = Math.max(ended.claude || 0, status.ts);
    }
    const next = providerStates({ statuses, writes, openTurns, now });
    for (const provider of PROVIDERS) {
      if (next[provider] === 'working' && current[provider] !== 'working') since[provider] = now;
    }
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
      for (const provider of overflowed) rescan(provider);
      overflowed.clear();
      evaluate();
    }, COALESCE_MS);
  };

  // Windows 上 fs.watch 的缓冲(约 20 条通知)装不下时,会来一条没有文件名的事件,其余的丢了。
  // Antigravity 每走一步要写十来个文件,实测这种溢出会吃掉转录的事件(Fable 审查用外部进程复现);
  // 丢的若是最终回答,环会一直亮到上限。所以溢出时把这家的转录整个重判一遍(onOverflow)。
  const watch = (dir, accept, onEvent, { recursive = true, onOverflow } = {}) => {
    try {
      const watcher = fs.watch(dir, { recursive }, (event, filename) => {
        const name = filename && String(filename);
        if (!name) {
          if (onOverflow) {
            onOverflow();
            schedule();
          }
          return;
        }
        if (!accept(name, event)) return;
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
  const markWrite = (provider, turnOpen) => (file) => {
    const now = Date.now();
    if (!hasFreshWrite(file, now)) return;
    writes[provider] = now;
    if (turnOpen) setTurn(provider, file, turnOpen(file), now);
  };
  for (const [provider, dir] of Object.entries(roots)) watch(dir, (name) => name.endsWith('.jsonl'), markWrite(provider));
  for (const [provider, source] of Object.entries(sources)) {
    watch(source.dir, source.accept, markWrite(provider, source.turnOpen), {
      recursive: source.recursive !== false,
      onOverflow: source.transcripts ? () => overflowed.add(provider) : null,
    });
    // 启动时就在跑、又一直不落盘的一轮(长时间思考),等不到下一次写入事件
    if (source.transcripts) rescan(provider);
  }
  evaluate();

  return {
    current: () => ({ ...current }),
    turns: () => ({ ended: { ...ended }, since: { ...since } }),
    stop() {
      stopped = true;
      clearTimeout(coalesceTimer);
      clearTimeout(expiryTimer);
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}

module.exports = {
  startActivityWatch,
  providerStates,
  hasFreshWrite,
  antigravityTurnOpen,
  codexTurnOpen,
  grokTurnOpen,
  IDLE,
  SOURCES,
  WRITE_ACTIVE_MS,
  HOOK_WORKING_MS,
  OPEN_TURN_MS,
};

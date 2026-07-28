# AI Code Usage Tray — 项目上下文

Windows 系统托盘工具:实时显示 Claude Code 与 Codex Desktop/CLI 的今日 token 用量、额度和活跃会话。这个生态位的现有产品(usage、Agent Island、Paste It 等)几乎都是 macOS 优先,**Windows 是空位**——而作者自己每天在 Windows 上使用这些工具,吃自己的狗粮。

## 为什么做这个(2026-07 决策记录)

来自对 [chinese-independent-developer](https://github.com/1c7/chinese-independent-developer) 的分析:
- AI coding 周边工具是 2026 年新爆点(Claude Code/Codex/Cursor 相关条目 21 处,几乎全在 2026 年)。
- 参照:[usage](https://github.com/aqua5230/usage)(菜单栏额度,macOS)、[Agent Island](https://agent-island.dev/)(会话状态提醒)。
- 分发策略:GitHub 开源 + 给 chinese-independent-developer 提 PR + 即刻/V2EX/X 发帖。开源仓库本身就是获客渠道。

## 数据源(核心知识)

Claude Code 把每个会话的转录写在 `~/.claude/projects/<目录名>/<session>.jsonl`:
- 每行一个 JSON。`type: "assistant"` 的行带 `message.model`、`message.usage`、`timestamp`(UTC ISO)、`cwd`。
- `usage` 字段:`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`。
- 流式输出会用同一个 `message.id` 重写多行,**必须按 id 去重取最后一条**(lib/usage.js 已处理)。
- 定价表在 `lib/usage.js` 的 `PRICES`(2026-07-26 官方标准 API 价快照,5 分钟 cache 写 1.25x、1 小时写 2x、cache 读 0.1x)。订阅用户不按 token 计费,所以 UI 上标注为「等价 API 价值」。
- Codex Desktop 与 CLI 都把会话写在 `~/.codex/sessions/**/*.jsonl`;`turn_context` 给出模型,`token_count` 给出累计 token 和真实额度窗口。`lib/codex-usage.js` 按相邻累计值做差,同时覆盖两种客户端,并按 GPT-5.6 官方 API 价格计算等价价值。
- Claude Desktop 会话元数据位于 `%APPDATA%/Claude/claude-code-sessions/**/*.json`;用 `cliSessionId` 关联 transcript,有 `bridgeSessionIds` 时可精确深链,否则唤起 Claude 并复制标题。

## 架构

- `lib/usage.js` / `lib/codex-usage.js` — 纯 Node 数据层,无 Electron 依赖,分别返回今日按模型聚合 + 24h 会话列表。
- `main.js` — Electron 主进程:托盘图标、原生注意提醒、完整面板、顶部/右侧悬浮条、共享 30s 快照、全屏检测、安全桌面深链和 Claude OAuth 加密存储。
- `lib/claude-oauth.js` — Claude 浏览器 PKCE 授权（固定网页回调 + 手动粘贴登录码）、令牌刷新和官方额度响应解析；令牌本身由主进程通过 Electron `safeStorage` 保存。
- `preload.js` + `renderer/index.html` / `floating.html` — contextBridge 暴露最小 IPC,两套无框架 UI 共用同一份用量快照。

## 命令

```bash
npm test          # lib/usage.js 单元测试(node --test)
npm run usage     # 命令行打印今日用量(不启动 Electron,最快的验证方式)
npm start         # 启动托盘应用
npm run dist      # 测试后生成 Windows x64 便携版到 dist/
```

## 路线图

- [x] **会话真实状态**:Claude Code hooks 写状态文件,面板/CLI/托盘显示 working、waiting、attention、idle,attention 首次出现时发 Windows 通知。
- [x] **官方额度**:自动读取 Claude Desktop `plan-usage-history.json` 和 Claude Code statusLine,校验后取最新来源;字段缺失时隐藏,不按 token 猜额度。
- [x] **Claude 账户连接**:可选浏览器 OAuth,使用 Claude Code 当前固定网页回调并粘贴登录码,令牌仅由本应用加密保存,每 5 分钟读取官方重置时间并自动刷新过期令牌。
- [x] **Codex 支持**:读取 Desktop/CLI 共用的 `~/.codex/sessions`,展示 token、模型、真实额度窗口和会话来源。
- [x] **贴边悬浮条**:主屏顶部/右侧可选,5h/7d 收起态、悬停详情、全屏自动隐藏,与托盘面板共享刷新。
- [x] **Desktop 会话跳转**:Codex 精确打开 task;Claude 有 bridge id 时精确打开,否则复制标题并唤起客户端;CLI 不启动终端。
- [x] **打包准备**:electron-builder 生成带自定义图标的 Windows x64 便携版,中英 README 已完成。
- [x] **公开发布**:MIT + GitHub 公开仓库 + v1.0.0 Release 已完成；后续再做干净 Windows 验证和社区收录。
- [ ] 自动更新:首个 GitHub Release 稳定后接入版本检查与下载安装。
- [ ] 增量读取:按文件记 byte offset,只读新增部分(目前每 30s 全量重读,转录很大时再做)。

## 已知取舍(ponytail 标记在代码里)

- 未安装 hooks 或没有状态文件的会话仍用 2 分钟 mtime 启发式回退为 working/idle。
- Claude Code 的 `statusLine` 只有一个命令槽;当前本机没有旧配置所以直接占用,发布安装器需检测并串联用户已有命令。
- Desktop 用量历史是内部 v2 格式;超过 15 分钟后保留最后数据但降低透明度并明确标记过期。
- Codex 金额是标准 API 等价价值,包含缓存读写和 >272K 长上下文倍率;订阅用户不会按该金额扣费。
- 定价表是硬编码快照,新模型出来要手动加一行(`priceFor` 用前缀匹配,带日期后缀的 id 自动兼容)。
- 用 Electron 而不是 Tauri:纯 JS 栈好维护,体积大但这是开发者工具,无所谓。

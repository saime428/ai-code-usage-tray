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
- Claude Desktop 会话元数据位于 `%APPDATA%/Claude/claude-code-sessions/**/*.json`;用 `cliSessionId` 关联 transcript,并通过 `claude://resume?session=<cliSessionId>` 直接打开对应会话。
- Grok CLI 把会话写在 `~/.grok/sessions/<url编码cwd>/<会话id>/`:`updates.jsonl` 的 `turn_completed` 事件带**逐轮** token(`modelUsage` 按模型细分)和官方结算费用 `costUsdTicks`(1 USD = 10^10 ticks,含缓存折扣,不需要本地价格表);`summary.json` 带标题/模型/cwd/活动时间。`~/.grok/logs/unified.jsonl` 里 CLI 自己记录 `billing: fetched credits config`,含订阅周额度百分比、周期起止和套餐名。**`creditUsagePercent` 为 0 时该字段整个不出现**(proto3 丢默认值),所以字段缺失要当 0 读,不能当"未知"隐藏——本机 122 条记录里它从来不是字面 0,而 17 次缺失全落在计费周期头几天。2026-09-09 新周期开始时额度整块消失就是这个原因——这是 2026-08-17 调研文档认为"没有公开 API"的 SuperGrok 额度,CLI 落了本地盘就能直接读。

## 架构

- `lib/usage.js` / `lib/codex-usage.js` / `lib/grok-usage.js` — 纯 Node 数据层,无 Electron 依赖,分别返回今日按模型聚合 + 24h 会话列表。
- `main.js` — Electron 主进程:托盘图标、原生注意提醒、完整面板、顶部/右侧悬浮条、共享 30s 快照、安全桌面深链和 Claude OAuth 加密存储。
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

- [x] **会话真实状态**:Claude Code hooks 写状态文件,面板/CLI/托盘显示 working、attention、idle,attention 首次出现时发 Windows 通知。
- [x] **官方额度**:自动读取 Claude Desktop `plan-usage-history.json` 和 Claude Code statusLine,校验后取最新来源;字段缺失时隐藏,不按 token 猜额度。
- [x] **Claude 账户连接**:可选浏览器 OAuth,使用 Claude Code 当前固定网页回调并粘贴登录码,令牌仅由本应用加密保存,每 5 分钟读取官方重置时间并自动刷新过期令牌。
- [x] **Codex 支持**:读取 Desktop/CLI 共用的 `~/.codex/sessions`,展示 token、模型、真实额度窗口和会话来源。
- [x] **Grok 支持**:读取 `~/.grok/sessions` 的逐轮用量和官方结算费用,以及本地日志里的订阅周额度;暂不接分账号账本(缺身份识别)和会话跳转(CLI 无深链)。
- [x] **贴边悬浮条**:主屏顶部/右侧可选,5h/7d 收起态、悬停详情,与托盘面板共享刷新。全屏应用时默认自动隐藏(托盘菜单可关):`lib/fullscreen-watch.js` 常驻 PowerShell 轮询 `SHQueryUserNotificationState`,它复用资源管理器的 rude-app 判定:独占全屏、演示模式、以及盖满整个显示器的无边框窗口(游戏的无边框窗口化)都算全屏,普通最大化窗口(任务栏仍可见)不算——实测返回值分别为 2 和 5。v1.0 曾用前台窗口矩形自判,在 f07254a 被移除,原因未记录。
- [x] **Desktop 会话跳转**:Codex 精确打开 task;Claude 有 bridge id 时精确打开,否则复制标题并唤起客户端;CLI 不启动终端。
- [x] **打包准备**:electron-builder 生成带自定义图标的 Windows x64 便携版;README.md 为英文主页,README.zh-CN.md 为中文版,顶部互挂切换链接。
- [x] **公开发布**:MIT + GitHub 公开仓库 + v1.0.0 Release 已完成；后续再做干净 Windows 验证和社区收录。
- [ ] 自动更新:首个 GitHub Release 稳定后接入版本检查与下载安装。
- [ ] 增量读取:按文件记 byte offset,只读新增部分(目前每 30s 全量重读,转录很大时再做)。

## 已知取舍(ponytail 标记在代码里)

- 未安装 hooks 或没有状态文件的会话仍用 2 分钟 mtime 启发式回退为 working/idle。
- Claude Code 的 `statusLine` 只有一个命令槽;当前本机没有旧配置所以直接占用,发布安装器需检测并串联用户已有命令。
- Desktop 用量历史是内部 v2 格式;超过 15 分钟后保留最后数据但降低透明度并明确标记过期。
- Codex 金额是标准 API 等价价值,包含缓存读写和 >272K 长上下文倍率;订阅用户不会按该金额扣费。
- 定价表是硬编码快照,新模型出来要手动加一行(`priceFor` 用前缀匹配,带日期后缀的 id 自动兼容)。两家厂商都只把价格发在 HTML 文档页,`/v1/models` 不带价格字段,所以没有官方接口可抓。`npm run check-prices` 拿 LiteLLM 的 `model_prices_and_context_window.json` 比对现有表并报告偏差(只报告不改写:社区维护的数据改金额显示前要人看一眼),CI 每周一跑一次。2026-09-06 那次核对发现 07-26 的快照抄成了 Sonnet 5「将来会涨到」的价,gpt-5.6-luna 更是高估 5 倍——这类错 `unknownModels` 抓不到,因为模型认识、只是价格错。
  倍率现在都是表里的数据而不是散在代码里的 if:`cacheRead` 覆盖默认 0.1x(Fable/Mythos 5.1 是 0.025x),`fast` 是快速模式倍率(只有 Opus 5 / 4.8 有,4.7 直接报错、4.6 按标准价跑),`inference_geo: "us"` 再叠 1.1x。`priceFor` **取最长匹配**:`claude-opus-4`(15/75)是 `claude-opus-4-5`(5/25)的前缀,`claude-fable-5` 是 `claude-fable-5-1` 的前缀,先匹配会静默算错 3 倍。表的书写顺序因此不再影响结果——`lib/usage.test.js` 里那条 pricing 测试就是钉这个的。
  `normalizeModel` 认四种写法:裸 id、`anthropic/xxx`、云推理配置(`us|eu|apac|au|jp|global|us-gov.anthropic.xxx`,注意 `global` 6 个字母、`us-gov` 带连字符,正则别写成 `[a-z]{2,4}`)、Vertex 的 `xxx@20250929`。退役型号(Opus 4.1/4、Sonnet 4、Haiku 3.5)保留在表里,因为旧转录和 Bedrock/Vertex 还会出现。
  **区域推理配置加价 10%**(官方文档口径,`global.` 不加),`costOf` 按前缀判断;退役型号标 `legacy` 不吃这个加价,因为它们早于该计费方案、而且 Bedrock 对它们是另一套价(Haiku 3.5 在 Bedrock 是 $0.25 不是 $0.80,没建模)。上游数据里 `us-gov` 实测是 1.2x、还有个 `eu.…opus-4-5` 条目跟自己的 `us.` 兄弟自相矛盾——所以 checker 的第二遍**整体跳过区域 id**,它的职责是找缺失的型号行,不是追平台差价。
  checker 两遍:第一遍把每种 token 各 10 万个喂进真正的 `costOf` 跟上游费率对,这样 cache 读写倍率也一起验了(重新声明常量去比会漏);第二遍扫上游所有 id,凡是 `priceFor` 能解析但价格对不上的就报——`gpt-5.5-pro` 前缀命中 `gpt-5.5` 少算 6 倍就是这么抓出来的,`unknownModels` 和第一遍都看不见这类。上游 key 全改名导致一个都没验到时会直接 exit 1,避免绿灯空跑。
  已知不建模:Claude 的 >200K 长上下文档位(只有 Sonnet 4.5/4 有,2x/1.5x),checker 会持续把它列在"unmodeled"一栏免得反复重新发现;Codex 的 272K 档位**是**建模了的。
  真实转录里 checker 覆盖不到的:`<synthetic>` token 全 0(已被现有零值判断跳过)、Codex 的 `codex-auto-review` 和 `gpt-5.3-codex-spark` 上游无 API 价。注意 `opus`/`fable` 这类裸别名只出现在 Task 工具调用参数里,**不是** `message.model`——查的时候别用整行 grep `"model":"..."`,会把嵌套参数一起捞进来。
- **`npm start` 有个能吞掉一整天的坑**:Electron 启动时若发现 `node_modules/electron/dist/resources/app.asar`,会直接运行它并**忽略 `.` 参数**——正常安装那里只有 `default_app.asar`。2026-07-28 某次打包把 v1.0.1 的 `app.asar`(和 `elevate.exe`)写进了那个目录,之后每次 `npm start` 跑的都是 v1.0.1 而不是工作区,直到 2026-09-06 才因为「改了价格但面板没变、Grok 和天数框都不见了」被发现。`package.json` 的 `prestart` 现在会检查这个文件并拒绝启动;确认 dev 跑的是工作区,看渲染进程命令行里的 `--app-path` 是不是仓库目录。同理:**用 `npm start` 验证过的结论,都要先确认 app-path**,否则冒烟测试可能只是撞了单实例锁退出。
- 用 Electron 而不是 Tauri:纯 JS 栈好维护,体积大但这是开发者工具,无所谓。

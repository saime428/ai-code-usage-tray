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
- Grok CLI 把会话写在 `~/.grok/sessions/<url编码cwd>/<会话id>/`:`updates.jsonl` 的 `turn_completed` 事件带**逐轮** token(`modelUsage` 按模型细分)和官方结算费用 `costUsdTicks`(1 USD = 10^10 ticks,含缓存折扣,不需要本地价格表);`summary.json` 带标题/模型/cwd/活动时间。`~/.grok/logs/unified.jsonl` 里 CLI 自己记录 `billing: fetched credits config`,含订阅周额度百分比、周期起止和套餐名。**`creditUsagePercent` 为 0 时该字段整个不出现**(proto3 丢默认值),所以字段缺失要当 0 读,不能当"未知"隐藏——本机 122 条记录里它从来不是字面 0,而 17 次缺失全落在计费周期头几天。2026-09-09 新周期开始时额度整块消失就是这个原因。这份额度正是 2026-08-17 调研文档认为"没有公开 API"的 SuperGrok 周额度,CLI 落了本地盘就能直接读。

## 架构

- `lib/usage.js` / `lib/codex-usage.js` / `lib/grok-usage.js` — 纯 Node 数据层,无 Electron 依赖,分别返回今日按模型聚合 + 24h 会话列表。
- `main.js` — Electron 主进程:托盘图标、原生注意提醒、完整面板、顶部/右侧悬浮条、共享 30s 快照、安全桌面深链和 Claude OAuth 加密存储。
- `lib/claude-oauth.js` — Claude 浏览器 PKCE 授权（固定网页回调 + 手动粘贴登录码）、令牌刷新和官方额度响应解析；令牌本身由主进程通过 Electron `safeStorage` 保存。
- `lib/hang-guard.js` — 主线程挂起看门狗(worker 线程读共享内存心跳,停跳超 15 秒写 `userData/hang-log.jsonl`)和「未响应」同名实例查找;`main.js` 用它在抢单实例锁之前结束卡死实例,并给同步跨进程调用打步骤标记。
- `preload.js` + `renderer/index.html` / `floating.html` — contextBridge 暴露最小 IPC,两套无框架 UI 共用同一份用量快照。

## 命令

```bash
npm test          # lib/usage.js 单元测试(node --test)
npm run usage     # 命令行打印今日用量(不启动 Electron,最快的验证方式)
npm start         # 启动托盘应用
npm run dist      # 测试后生成 Windows x64 一键安装包(Setup)和便携版到 dist/
```

## 路线图

- [x] **会话真实状态**:Claude Code hooks 写状态文件,面板/CLI/托盘显示 working、attention、idle,attention 首次出现时发 Windows 通知。
- [x] **官方额度**:自动读取 Claude Desktop `plan-usage-history.json` 和 Claude Code statusLine,校验后取最新来源;字段缺失时隐藏,不按 token 猜额度。
- [x] **Claude 账户连接**:可选浏览器 OAuth,使用 Claude Code 当前固定网页回调并粘贴登录码,令牌仅由本应用加密保存,每 5 分钟读取官方重置时间并自动刷新过期令牌。
- [x] **Codex 支持**:读取 Desktop/CLI 共用的 `~/.codex/sessions`,展示 token、模型、真实额度窗口和会话来源。
- [x] **Grok 支持**:读取 `~/.grok/sessions` 的逐轮用量和官方结算费用,以及本地日志里的订阅周额度;暂不接分账号账本(缺身份识别)和会话跳转(CLI 无深链)。
- [x] **贴边悬浮条**:主屏顶部/右侧可选,5h/7d 收起态、悬停详情,与托盘面板共享刷新。全屏应用时默认自动隐藏(托盘菜单可关):`lib/fullscreen-watch.js` 常驻 PowerShell 轮询 `SHQueryUserNotificationState`,它复用资源管理器的 rude-app 判定:独占全屏、演示模式、以及盖满整个显示器的无边框窗口(游戏的无边框窗口化)都算全屏,普通最大化窗口(任务栏仍可见)不算——实测返回值分别为 2 和 5。v1.0 曾用前台窗口矩形自判,在 f07254a 被移除,原因未记录。
- [x] **Desktop 会话跳转**:Codex 精确打开 task;Claude 有 bridge id 时精确打开,否则复制标题并唤起客户端;CLI 不启动终端。
- [x] **打包准备**:electron-builder 生成带自定义图标的 Windows x64 一键安装包(按用户安装,主推)和便携版;README.md 为英文主页,README.zh-CN.md 为中文版,顶部互挂切换链接。
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
- **2026-09-14 卡死排查**(也是改分发方式的原因):
  - 用户以为"开机不自启、快捷方式卡住",实际是开机自启成功、应用夜里**跨进程挂起**(WER `AppHangXProcB1`,报告在 `C:\ProgramData\Microsoft\Windows\WER\ReportArchive\AppHang_AI Code Usage Tr_*`,可靠性监视器里只有这一次)。卡死进程里唯一的第三方模块是微信输入法的 TIP `wetype_tip_core.dll`,当晚 WeType 的更新进程和渲染进程都重启过——高度可疑但**未证实**,WER 的阻塞方签名解不出。挂起记录就是为了下次拿证据:`step` 为 `idle` 且卡住前刚有输入法进程启动,即可确认。排查时的教训:Schannel 36871 不是本应用的启动指纹,是 WeType 等进程联网的背景噪音;`Get-Process` 的 `.Modules` 对卡死进程可能返回空。
  - 卡死后怎么打开都没用:卡死的主实例占着单实例锁,Electron 把新实例转交给它无响应的窗口,**不会杀掉它**,新实例静默退出。`main.js` 的 `endHungInstances` 在抢锁前用 `tasklist /FI "STATUS eq NOT RESPONDING"` 找同名进程并结束(仅打包版)。**不加 `/T`**:实测主进程一没,渲染/GPU 子进程和 fullscreen-watch 的 PowerShell 五秒内全部自行退出,而 `shell.openExternal` 打开的浏览器和 Claude Desktop 也挂在这棵树上,连坐会关掉用户正开着的窗口。杀完等 500ms 再抢锁,因为 taskkill 返回时锁可能还没释放。**抢不到锁的实例必须立刻 `return`**:否则它照样往下起看门狗 worker,而 worker 开头的日志轮转会把运行中实例的 `hang-log.jsonl` 改名。
  - 便携壳的 NSIS 流程:`RMDir /r` 解压目录 → 解压 → `ExecWait` 应用 → 退出后再 `RMDir /r`。electron-builder 26 默认 `unpackDirName` 是**每个构建固定**的 ksuid 目录,同版本第二次启动会删掉运行中实例目录里没被锁的文件(`lib/*.js`、未加载的语言包)。它的文档说 `unpackDirName: false` 会每次独立目录,**源码里 `false` 和不填效果相同,必须写 `true`**。遇到被锁文件不是死循环:静默模式重试 5 次后自动覆盖解压。
  - 因此主推 NSIS 一键安装版(按用户装到 `%LOCALAPPDATA%\Programs`,路径固定)。安装程序检测应用在运行时,有 PowerShell 就**只看安装目录下的进程**,察觉不到 `%TEMP%` 里的便携版——换装前要先退出便携版。`LOGIN_ITEM_PATH` 无需改动(安装版取 `process.execPath`,便携版取 `PORTABLE_EXECUTABLE_FILE`),开机自启的自愈逻辑在首次启动时自动迁移路径——反过来,装完再跑一次便携版会把 Run 键抢回临时目录。开机自启的 Run 键是应用自己用 `reg.exe` 写的,NSIS 卸载只清它自己建的东西,所以 `build/installer.nsh` 的 `customUnInstall` 要手动删掉新旧两个值名(electron-builder 默认就会带上这个文件)。
  - 挂起记录的 worker 不能从 `app.asar` 里加载,`hang-guard.js` 自己把路径换成 `app.asar.unpacked`。睡眠唤醒时所有计时器会一起迟到,看门狗靠「检查本身也迟到了」判断是整机睡眠而不是卡死,否则每次唤醒都会误报。
  - 2026-09-15 抓到第一次真卡死:`step: idle`、停跳 18.7 秒、**没有 `recovered`**(一直没回来),正好是"卡在消息循环里"的指纹。但 `processes` 快照失败,记录里只有 `Command failed: powershell.exe ...`——`execFile` 的 message 只是把命令回显一遍,看不出是超时还是退出码,等于白记。现在改记 `exit <code>` / `timed out after <ms>` 加 stderr 首行,超时也从 30 秒放宽到 60 秒(卡死当时 WMI 多半也被拖住了)。事后在同一台机器复测:`[datetime]::Parse` 和强制转换两种写法都正常(本机 en-US + Gregorian),worker 线程里跑 PowerShell 也正常(0.3 秒),所以那次失败是当时的系统状态,不是代码路径写错。接管卡死实例时还会写一条 `ended-hung-instance`,用户报"打不开"时有凭据。
  - 同一天发现的老问题:`getClaudeOAuthRateLimits` 以前只在**成功**后缓存 5 分钟,失败(429)后每次 30 秒刷新都会重试,被限流时会一直续上限流,Fable 额度一直不显示(面板显示「Claude 暂时限制了额度查询」,额度来源退回 `desktop`)。现在按「下次允许尝试时间」节流(`lib/claude-oauth.js` 的 `nextUsageAttemptAt`):成功失败都至少隔 5 分钟,响应带 `Retry-After` 时照它等、封顶 1 小时(异常响应头不能让刷新一直停着),面板的限流提示也相应改成「稍后会自动重试」;登录完成时的 `force` 请求不受影响。测试时反复重启应用会丢掉内存缓存、每次启动都请求一次,是那次触发限流的直接原因——**验证时别频繁重启已连接 Claude 账户的实例**。排查方法:带 `--remote-debugging-port` 启动,通过 CDP 读面板渲染进程里的 `latest.claude.auth` 和 `latest.claude.rateLimits`(不含令牌);要数请求次数再加 `--log-net-log=<文件>`,主进程的 `net.fetch` 走 Chromium 网络栈,每次请求都会记成一条带 URL 的 `URL_REQUEST_START_JOB` 事件。
  - 本地打包前先退出正在运行的**同版本**便携版:它的壳进程锁着 `dist` 里同名 exe,`npm run dist` 会卡住且不报错。
- 用 Electron 而不是 Tauri:纯 JS 栈好维护,体积大但这是开发者工具,无所谓。

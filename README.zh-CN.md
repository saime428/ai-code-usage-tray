<p align="center">
  <img src="docs/hero.svg" width="100%" alt="AI Code Usage Tray — Claude、Codex 与 Grok 本地用量监视器">
</p>

<h1 align="center">AI Code Usage Tray</h1>

<p align="center">
  本地优先的 Windows 托盘监视器，用来查看 Claude Code / Desktop、Codex CLI / Desktop 和 Grok CLI 的用量、额度、账号和会话状态。
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

<p align="center">
  <a href="https://github.com/saime428/ai-code-usage-tray/releases/latest"><strong>下载最新 Windows 便携版</strong></a>
  · <a href="#快速开始">快速开始</a>
  · <a href="#本地开发">开发指南</a>
</p>

<p align="center">
  <img src="docs/dashboard.png" alt="完整面板：Claude / Codex / Grok 切换、额度、分账号用量和会话">
</p>

> [!NOTE]
> 面板里 Claude / Codex 的金额是按官方标准 API 价格计算的**等价值**，用来对照消耗快慢，订阅不会按这个金额扣费。Grok 的金额来自 Grok CLI 记录的官方结算值，订阅额度内同样不会另外扣费。
>
> Claude Desktop 的普通 Home 聊天，本机只有会话元数据和额度百分比，没有精确 token 明细，所以算不出金额。金额只统计本地有 transcript 的 Claude Code / Cowork 会话。连接 Claude 账户只会让额度和重置时间更准，补不齐 Home 聊天的 token。

## 亮点

| | |
| --- | --- |
| **Claude + Codex + Grok 一处查看** | Claude Code、Claude Desktop、Codex CLI/Desktop 和 Grok CLI 放在同一面板。 |
| **独立日期范围** | 每个来源可以各自选最近 1–90 天，互不影响。 |
| **额度窗口** | 显示 5h / 7d 使用比例、重置时间和数据更新时间。连上 Claude 账户后，有数据也会显示 Fable 窗口。 |
| **分账号用量** | 从本机启用分账号统计后，按当前账号累计 Token，更早的记录不计在内。账本由 Windows 加密保存在本地。 |
| **会话状态** | 区分工作中、需处理和空闲。Desktop 会话可以从面板打开。 |
| **贴边悬浮条** | 可贴在屏幕顶部或右侧，悬停展开；全屏应用（独占或无边框全屏的游戏、视频、演示）时自动隐藏，可在托盘菜单关闭该行为。 |
| **本地优先** | 默认只读本机客户端已经写下的数据，不上传提示词或会话内容。 |
| **零 API Key** | 本地模式不需要 API Key。Claude OAuth 是可选项，用来读更准的额度。 |

## 快速开始

1. 打开 [GitHub Releases](https://github.com/saime428/ai-code-usage-tray/releases/latest)。
2. 下载 `AI-Code-Usage-Tray-*-win-x64.exe`。
3. 双击运行，无需安装。单击悬浮条或托盘图标打开完整面板。
4. 右键悬浮条或托盘图标，可以刷新、开机自启、切换顶部/右侧、隐藏悬浮条、切换全屏时自动隐藏或退出。

> [!WARNING]
> 当前便携版还没有 Windows 代码签名，SmartScreen 可能会弹出提醒。请只从本仓库的 Releases 下载，并核对 Release 里的 SHA-256。之后的签名版本会按下面的 [Code signing policy](#code-signing-policy) 发布。

## 数据从哪里来

| 客户端 | 本地来源 | 可提供的数据 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | token、模型、项目、会话活动 |
| Claude Desktop | `%APPDATA%/Claude/plan-usage-history.json` | 5h / 7d 百分比 |
| Claude Desktop | `%APPDATA%/Claude/claude-code-sessions/**/*.json` | Claude Code / Cowork 标题、客户端类型、最近活动 |
| Claude Desktop Home | `%APPDATA%/Claude/IndexedDB/` | 普通聊天的标题、模型、消息数、最近活动（无 token 明细） |
| Claude 账户（可选） | Anthropic OAuth 用量接口 | 官方百分比与精确重置时间 |
| Codex CLI / Desktop | `~/.codex/sessions/**/*.jsonl` | token、额度窗口、模型、会话活动 |
| Grok CLI | `~/.grok/sessions/**/updates.jsonl` + `~/.grok/logs/unified.jsonl` | 逐轮 token、官方结算金额、订阅周额度、会话活动 |

Microsoft Store 版 Claude Desktop 会自动读取 `%LOCALAPPDATA%/Packages/Claude_*/LocalCache/Roaming/Claude/` 下的同名数据文件。

### 重置时间与刷新频率

- 应用每 **30 秒**重读一次本地数据。
- Claude Desktop 通常大约每 **5 分钟**写一次额度采样，所以界面会显示“Desktop N 分钟前采样”。
- Claude Desktop 本地历史不保存 `resets_at`。应用会根据最近一次归零和下一次采样推算重置时间，并标上 **`≈`**，一般有大约 5 分钟误差。
- 连上 Claude 账户后，会改用官方的精确重置时间。凭证用 Windows `safeStorage` 加密存在本应用数据目录，点“断开”就会删掉。

### 会话状态

| 颜色 | 状态 | 含义 |
| --- | --- | --- |
| 🟢 | 工作中 | 最近还在输出，或会话文件仍在更新 |
| 🔴 | 需处理 | 在等权限确认，或需要你在客户端里操作 |
| ⚫ | 空闲 | 最近没有活动 |

给 Claude CLI 配上 hooks 后，工作中 / 需处理 / 空闲会更准；没配时按会话文件的写入时间判断。新写入的 transcript 会覆盖过期 hook，避免会话还在跑却显示旧状态。hook 超过 30 分钟没更新，会改回空闲。

## 隐私与安全

- 不上传 transcript、提示词、项目路径或会话标题。
- 不读浏览器 Cookie，也不需要 Anthropic / OpenAI / xAI API Key。
- 本地文件损坏、被锁或权限不够时，会留下上一份快照，并标成过期。
- OAuth 登录是可选项。网络不通或碰到 Anthropic 限流时，本地用量监控照常工作。
- 完整说明见 [Privacy Policy](PRIVACY.md)。

## Code signing policy

- Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).
- SignPath-signed releases will be built from this repository by [GitHub Actions](.github/workflows/ci.yml) and manually approved before signing. v1.0.1 and earlier remain unsigned.
- Committer, reviewer, and approver: [@saime428](https://github.com/saime428).
- Privacy policy: [PRIVACY.md](PRIVACY.md).

## 本地开发

需要 **Windows 10/11、Node.js 22+ 和 npm**：

```powershell
git clone https://github.com/saime428/ai-code-usage-tray.git
cd ai-code-usage-tray
npm ci
npm test
npm start
```

生成 Windows x64 便携版：

```powershell
npm run dist
```

产物位于 `dist/AI-Code-Usage-Tray-<version>-win-x64.exe`。

### 项目结构

```text
main.js                 Electron 主进程、托盘、窗口与刷新调度
preload.js              受限 IPC bridge
lib/usage.js            Claude 本地用量与会话解析
lib/codex-usage.js      Codex 本地用量与额度解析
lib/grok-usage.js       Grok 本地用量、官方金额与周额度解析
lib/claude-oauth.js     可选 Claude OAuth / PKCE
renderer/index.html     完整面板
renderer/floating.html  贴边悬浮条
hooks/                   可选 Claude Code 状态 hooks
```

### 发布检查

```powershell
npm test
npm run dist
git status --short
```

更新 `package.json` 版本，在干净的 Windows 环境里启动便携版，再创建 GitHub Release，上传 `.exe` 和 SHA-256。

## 当前限制

- 仅支持 Windows x64。
- 还没有自动更新。
- 当前便携版还没做代码签名。SignPath Foundation 的申请和自动签名都还在进行中。
- Claude OAuth 可能被 Anthropic 限流，也可能受当前网络出口影响。本地推算不受影响。
- Claude Desktop 普通 Home 聊天读不到精确 token 明细，只能显示会话状态和额度百分比，算不出金额。
- Grok 会话仅有 CLI 一种来源：暂不支持分账号统计（缺身份识别），也没有点击跳转的深链。

## 贡献

Issue 和 Pull Request 都欢迎。提交前请运行：

```powershell
npm test
```

如果新增了不好一眼看懂的解析逻辑，请补一个覆盖真实格式的小测试。不要提交 transcript、凭证或个人项目路径。

## License

[MIT](LICENSE) © 2026 saixin

---

<p align="center">
  Not affiliated with or endorsed by Anthropic, OpenAI, or xAI.
</p>

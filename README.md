<p align="center">
  <img src="docs/hero.svg" width="100%" alt="AI Code Usage Tray — local usage monitor for Claude, Codex and Grok">
</p>

<h1 align="center">AI Code Usage Tray</h1>

<p align="center">
  A local-first Windows tray monitor for the usage, quotas, accounts and session activity of Claude Code / Desktop, Codex CLI / Desktop, and Grok CLI.
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/saime428/ai-code-usage-tray/releases/latest"><strong>Download the latest Windows portable build</strong></a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#development">Development</a>
</p>

<p align="center">
  <img src="docs/dashboard.png" alt="Full panel: Claude / Codex / Grok switcher, quotas, per-account usage and sessions">
</p>

> [!NOTE]
> For Claude and Codex, the cost shown is an **API-equivalent value** computed from official standard API prices — a way to compare burn rates. Subscriptions are not billed by this amount. Grok's cost comes from the official billed value recorded by Grok CLI; within your subscription quota it does not cost extra either.
>
> Regular Claude Desktop Home chats only leave session metadata and quota percentages on disk, with no token detail, so no cost can be computed for them. Cost only covers Claude Code / Cowork sessions that have a local transcript. Connecting a Claude account improves quota and reset accuracy but cannot fill in Home-chat tokens.

## Highlights

| | |
| --- | --- |
| **Claude + Codex + Grok in one place** | Claude Code, Claude Desktop, Codex CLI/Desktop and Grok CLI share one panel. |
| **Independent date ranges** | Each provider gets its own 1–90 day range. |
| **Quota windows** | 5h / 7d usage percentages, reset times and data freshness. With a Claude account connected, the Fable window appears when available. |
| **Per-account usage** | Once enabled on this machine, tokens accumulate under the current account; older records stay out. The ledger is encrypted locally by Windows. |
| **Session states** | Working, needs attention, and idle. Desktop sessions open straight from the panel. |
| **Edge-docked floating bar** | Docks to the top or right edge, expands on hover; auto-hides over fullscreen apps (exclusive or borderless-fullscreen games, videos, presentations), and the tray menu can turn that off. |
| **Local-first** | By default it only reads data the clients already wrote on this machine. No prompts or session content are uploaded. |
| **Zero API keys** | Local mode needs no API key. Claude OAuth is optional, for more accurate quotas. |

<a id="quick-start"></a>
## Quick start

1. Open [GitHub Releases](https://github.com/saime428/ai-code-usage-tray/releases/latest).
2. Download `AI-Code-Usage-Tray-*-win-x64.exe`.
3. Double-click to run — no install needed. Click the floating bar or tray icon to open the full panel.
4. Right-click the floating bar or tray icon to refresh, toggle launch-at-login, switch top/right docking, hide the floating bar, toggle fullscreen auto-hide, or quit.

> [!WARNING]
> The portable build is not code-signed yet, so SmartScreen may warn you. Download only from this repository's Releases and verify the SHA-256 published with each release. Signed builds will follow the [Code signing policy](#code-signing-policy) below.

## Where the data comes from

| Client | Local source | Data provided |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | tokens, models, projects, session activity |
| Claude Desktop | `%APPDATA%/Claude/plan-usage-history.json` | 5h / 7d percentages |
| Claude Desktop | `%APPDATA%/Claude/claude-code-sessions/**/*.json` | Claude Code / Cowork titles, client type, recent activity |
| Claude Desktop Home | `%APPDATA%/Claude/IndexedDB/` | regular-chat titles, model, message counts, recent activity (no token detail) |
| Claude account (optional) | Anthropic OAuth usage endpoint | official percentages and exact reset times |
| Codex CLI / Desktop | `~/.codex/sessions/**/*.jsonl` | tokens, quota windows, models, session activity |
| Grok CLI | `~/.grok/sessions/**/updates.jsonl` + `~/.grok/logs/unified.jsonl` | per-turn tokens, official billed cost, subscription weekly quota, session activity |

The Microsoft Store build of Claude Desktop is detected automatically under `%LOCALAPPDATA%/Packages/Claude_*/LocalCache/Roaming/Claude/`.

### Reset times and refresh cadence

- The app re-reads local data every **30 seconds**.
- Claude Desktop samples its quota roughly every **5 minutes**, so the UI shows "sampled N minutes ago by Desktop".
- Claude Desktop's local history has no `resets_at`. The app infers reset times from the last reset-to-zero and the next sample, marks them with **`≈`**, and they are typically within about 5 minutes.
- With a Claude account connected, official exact reset times take over. Credentials are encrypted with Windows `safeStorage` in the app's data directory and deleted when you disconnect.

### Session states

| Color | State | Meaning |
| --- | --- | --- |
| 🟢 | Working | recently producing output, or the session file is still being written |
| 🔴 | Needs attention | waiting for a permission prompt or your action in the client |
| ⚫ | Idle | no recent activity |

With the optional Claude CLI hooks installed, working / attention / idle become precise; without them the state falls back to transcript write times. A freshly written transcript overrides a stale hook so a running session never shows an old state. A hook silent for more than 30 minutes falls back to idle.

## Privacy and security

- No transcripts, prompts, project paths or session titles are uploaded.
- No browser cookies are read, and no Anthropic / OpenAI / xAI API key is needed.
- If a local file is corrupt, locked or unreadable, the last snapshot is kept and marked stale.
- OAuth login is optional. Local monitoring keeps working offline or when Anthropic rate-limits.
- Full details in the [Privacy Policy](PRIVACY.md).

## Code signing policy

- Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).
- SignPath-signed releases will be built from this repository by [GitHub Actions](.github/workflows/ci.yml) and manually approved before signing. v1.0.1 and earlier remain unsigned.
- Committer, reviewer, and approver: [@saime428](https://github.com/saime428).
- Privacy policy: [PRIVACY.md](PRIVACY.md).

<a id="development"></a>
## Development

Requires **Windows 10/11, Node.js 22+ and npm**:

```powershell
git clone https://github.com/saime428/ai-code-usage-tray.git
cd ai-code-usage-tray
npm ci
npm test
npm start
```

Build the Windows x64 portable executable:

```powershell
npm run dist
```

The artifact lands in `dist/AI-Code-Usage-Tray-<version>-win-x64.exe`.

### Project layout

```text
main.js                 Electron main process, tray, windows, refresh scheduling
preload.js              restricted IPC bridge
lib/usage.js            Claude local usage and session parsing
lib/codex-usage.js      Codex local usage and quota parsing
lib/grok-usage.js       Grok local usage, official cost and weekly quota
lib/claude-oauth.js     optional Claude OAuth / PKCE
renderer/index.html     full panel
renderer/floating.html  edge-docked floating bar
hooks/                  optional Claude Code state hooks
```

### Release checklist

```powershell
npm test
npm run dist
git status --short
```

Bump the version in `package.json`, launch the portable build on a clean Windows machine, then create a GitHub Release with the `.exe` and its SHA-256.

## Current limitations

- Windows x64 only.
- No auto-update yet.
- The portable build is not code-signed yet. The SignPath Foundation application and signing automation are in progress.
- Claude OAuth may be rate-limited by Anthropic or affected by your network egress. Local inference is unaffected.
- Regular Claude Desktop Home chats expose no token detail, so only session state and quota percentages can be shown — no cost.
- Grok sessions are CLI-only: no per-account tracking (no identity detection yet) and no click-to-open deep link.

## Contributing

Issues and pull requests are welcome. Before submitting, run:

```powershell
npm test
```

If you add parsing logic that is not obvious at a glance, include a small test covering the real format. Never commit transcripts, credentials or personal project paths.

## License

[MIT](LICENSE) © 2026 saixin

---

<p align="center">
  Not affiliated with or endorsed by Anthropic, OpenAI, or xAI.
</p>

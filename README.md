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
> For Claude and Codex, the cost shown is an **API-equivalent value** computed from official standard API prices (the table's verification date is shown at the bottom of the panel) — a way to compare burn rates. Subscriptions are not billed by this amount. Grok's cost comes from the official billed value recorded by Grok CLI; within your subscription quota it does not cost extra either.
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
## What's new

### v1.2.2

- **Fixed the Grok weekly quota disappearing at the start of a billing period.** xAI omits `creditUsagePercent` when usage is 0, which was read as "no data" and hid the whole quota block until usage crossed 1%. An absent field now means 0%.

### v1.2.1

- **The price table was re-verified end to end.** Sonnet 5 and the whole GPT-5.6 family now use current official rates, and Claude Fable 5.1 / Mythos 5.1 read cache at 0.025x instead of a flat 0.1x. **If you use Fable 5.1 heavily the cost shown drops noticeably — that is the correction, not lost data.**
- **Model resolution fixes.** Longest-prefix matching, so `claude-opus-4` no longer shadows `claude-opus-4-5` and `gpt-5.5` no longer shadows `gpt-5.5-pro` (which had been billing 6x under). Bedrock and Vertex model ids are recognised; those sessions previously showed a cost of zero.
- **Missing multipliers added**: Opus 5 fast mode (2x), `inference_geo: "us"` (1.1x), and the Bedrock regional profile premium (10%).
- **New `npm run check-prices`**, run weekly by GitHub Actions so a stale table gets reported instead of quietly drifting. See [Updating the price table](#updating-the-price-table).

Older versions are listed under [Releases](https://github.com/saime428/ai-code-usage-tray/releases).

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

### How the cost is computed

Claude and Codex costs come from a hand-maintained table of official standard API list prices (`lib/usage.js`, `lib/codex-usage.js`), stamped with the date it was last verified — the "price snapshot" date at the bottom of the panel. Neither vendor publishes pricing in a machine-readable form, so the table cannot update itself. What it models:

- Prompt caching: cache write 1.25x (5-minute) / 2x (1-hour), cache read 0.1x — 0.025x on Claude Fable 5.1 and Mythos 5.1.
- Fast mode (2x) on Opus 5 / 4.8, and `inference_geo: "us"` (1.1x), read from each transcript row.
- Codex long context (input over 272K: 2x input, 1.5x output).
- Bedrock and Vertex model ids (`us.anthropic.…`, `name@date`), with the documented 10% regional premium; `global.` profiles at base price.
- Retired models stay listed so older transcripts still price.

Models without a public list price (for example Codex's internal `codex-auto-review` label) show as "unavailable", are left out of the total, and the total is marked incomplete rather than guessed.

`npm run check-prices` diffs the table against LiteLLM's community-maintained cost map and reports drift; CI runs it weekly. It only reports: confirm any change against the official pricing pages, edit the table, then bump `PRICE_SNAPSHOT`.

#### Updating the price table

Everything is in two files; nothing else needs to change.

| What | Where |
| --- | --- |
| Claude prices | `lib/usage.js` → the `PRICES` object. One row per model, USD per million tokens: `'claude-opus-5': { input: 5, output: 25 }`. Optional fields: `cacheRead` (cache-hit multiplier, default 0.1), `fast` (fast-mode multiplier), `legacy: true` (retired model, exempt from the Bedrock regional premium). |
| Codex prices | `lib/codex-usage.js` → the `PRICES` object: `'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 }`. |
| Snapshot date | The `PRICE_SNAPSHOT` constant near the top of **both** files. The panel footer shows this date. |

Row keys are the model id **without** a date suffix (`claude-opus-5`, not `claude-opus-5-20260514`). `priceFor` matches by prefix and the longest key wins, so `claude-opus-4` and `claude-opus-4-5` coexist. A model that only exists as a longer sibling of an existing key (`gpt-5.5-pro` next to `gpt-5.5`) needs its own row, or it silently takes the shorter key's price — `npm run check-prices` reports that as an `unlisted id` line.

1. `npm run check-prices` — each difference prints as `file  model  field  ours → upstream`.
2. Confirm against the official pages: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing). LiteLLM is community data and occasionally contradicts itself.
3. Edit the row(s), set `PRICE_SNAPSHOT` in both files to today's date, run `npm test`, commit.

**How you find out.** The `prices` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs every Monday 06:17 UTC and fails on drift. GitHub sends the failure notification to the account whose commit last changed the `cron:` line of that file — by email and/or on the web, per [Settings → Notifications → Actions](https://github.com/settings/notifications) (make sure Actions notifications are on there; "failed workflows only" is enough). You can also run it any time from the Actions tab with **Run workflow**. GitHub pauses scheduled workflows after 60 days without repository activity; re-enable it from the Actions tab if that happens.

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

### Enabling hooks (optional)

The portable build does not include the hook scripts — get the `hooks/` directory from this repository (clone it, or download the two files). Then wire them into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/ai-code-usage-tray/hooks/report-status.js" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/ai-code-usage-tray/hooks/report-status.js" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/ai-code-usage-tray/hooks/report-status.js" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/ai-code-usage-tray/hooks/report-status.js" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/ai-code-usage-tray/hooks/report-status.js" }] }]
  },
  "statusLine": { "type": "command", "command": "node C:/path/to/ai-code-usage-tray/hooks/report-rate-limits.js" }
}
```

`report-status.js` writes per-session states to `~/.claude/usage-tray-status/` and always exits fast, so it never slows Claude Code down. `report-rate-limits.js` uses the statusLine slot to capture official rate limits and prints nothing. Claude Code has a single statusLine slot — if you already use one, keep yours and skip that part; session states work without it. New sessions pick the hooks up automatically.

## Privacy and security

- No transcripts, prompts, project paths or session titles are uploaded.
- No browser cookies are read, and no Anthropic / OpenAI / xAI API key is needed.
- If a local file is corrupt, locked or unreadable, the last snapshot is kept and marked stale.
- OAuth login is optional. Local monitoring keeps working offline or when Anthropic rate-limits.
- Full details in the [Privacy Policy](PRIVACY.md).

## Code signing policy

- Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).
- SignPath-signed releases will be built from this repository by [GitHub Actions](.github/workflows/ci.yml) and manually approved before signing. All releases to date remain unsigned; signing starts once the SignPath Foundation approval completes.
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
npm run usage   # print today's usage in the terminal, no Electron needed
npm run check-prices   # diff the price table against LiteLLM's cost map
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
npm run check-prices
npm run dist
git status --short
```

If `check-prices` reports drift, confirm it against the official pricing pages and update the table and `PRICE_SNAPSHOT` first. Bump the version in `package.json`, refresh the "What's new" section at the top of both READMEs, launch the portable build on a clean Windows machine, then create a GitHub Release with the `.exe` and its SHA-256.

## Current limitations

- Windows x64 only.
- No auto-update yet.
- The app UI is currently Chinese-only.
- The portable build is not code-signed yet. The SignPath Foundation application and signing automation are in progress.
- Claude OAuth may be rate-limited by Anthropic or affected by your network egress. Local inference is unaffected.
- Regular Claude Desktop Home chats expose no token detail, so only session state and quota percentages can be shown — no cost.
- Grok sessions are CLI-only: no per-account tracking (no identity detection yet) and no click-to-open deep link.
- The Grok weekly quota comes from what Grok CLI writes to disk: after a billing period rolls over it only reappears the next time you run Grok CLI (2–57 hours in local measurements). It stays hidden during that window — the weekly quota is account-wide, so you may have spent part of it on the web, and a guess would be worse than nothing.
- Claude's >200K long-context tier (Sonnet 4.5 / 4 only) is priced flat, and Bedrock's own pricing for retired models is not modeled.
- Models without a public list price (such as `codex-auto-review`) are excluded from the total and flagged, not estimated.

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

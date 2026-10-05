<p align="center">
  <img src="docs/hero.svg" width="100%" alt="AI Code Usage Tray — local usage monitor for Claude, Codex and Grok">
</p>

<h1 align="center">AI Code Usage Tray</h1>

<p align="center">
  A local-first Windows tray monitor for the usage, quotas, accounts and session activity of Claude Code / Desktop, Codex CLI / Desktop, Grok CLI, Antigravity and OpenCode — with a usage report across all of them.
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/saime428/ai-code-usage-tray/releases/latest"><strong>Download the latest Windows build</strong></a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#development">Development</a>
</p>

<p align="center">
  <img src="docs/dashboard.png" alt="Full panel: Claude / Codex / Grok switcher, quotas, per-account usage and sessions">
</p>

> [!NOTE]
> For Claude, Codex and Antigravity, the cost shown is an **API-equivalent value** computed from official standard API prices (the price table updates itself from this repository; its date is shown at the bottom of the panel) — a way to compare burn rates. Subscriptions are not billed by this amount. Grok's cost comes from the official billed value recorded by Grok CLI; within your subscription quota it does not cost extra either. OpenCode's is the value OpenCode itself recorded for each message.
>
> Regular Claude Desktop Home chats only leave session metadata and quota percentages on disk, with no token detail, so no cost can be computed for them. Cost only covers Claude Code / Cowork sessions that have a local transcript. Connecting a Claude account improves quota and reset accuracy but cannot fill in Home-chat tokens.

## Highlights

| | |
| --- | --- |
| **Five tools in one place** | Claude Code, Claude Desktop, Codex CLI/Desktop, Grok CLI, Antigravity (IDE and CLI) and OpenCode share one panel. Antigravity and OpenCode tabs appear once their data exists on this machine. |
| **Usage report** | A resizable report window across every tool: daily trend, hour of day, per tool, per project, the costliest sessions and per model, against the previous period. Also on the command line. |
| **Independent date ranges** | Each provider gets its own 1–90 day range. |
| **Quota windows** | 5h / 7d usage percentages, reset times and data freshness. With a Claude account connected, the Fable window appears when available; while Antigravity runs, its Gemini and Claude/GPT windows too. |
| **Per-account usage** | Once enabled on this machine, tokens accumulate under the current account; older records stay out. The ledger is encrypted locally by Windows. |
| **Session states** | Working, needs attention, and idle. Desktop sessions open straight from the panel. |
| **Live activity ring** | While a session is running, that provider lights up with a ring of travelling light on the floating bar. It watches session directories for writes instead of waiting for the 30s refresh. Switch it to rainbow or turn it off. |
| **Edge-docked floating bar** | Docks to the top or right edge, expands on hover, and shows the tools you pick (by default the ones found on this machine); auto-hides over fullscreen apps (exclusive or borderless-fullscreen games, videos, presentations), and the tray menu can turn that off. |
| **Local-first** | It reads what the clients already wrote on this machine and uploads nothing about you. Unless you connect a Claude account, the one automatic request downloads the public price table from this repository. |
| **Prices stay current** | New models and price changes arrive within a day of being fixed here, without a new version. Turn it off in the tray menu. |
| **Zero API keys** | Local mode needs no API key. Claude OAuth is optional, for more accurate quotas. |

## What's new

### v1.7.1

- **Activity ring for Antigravity and OpenCode.** Both now light up on the floating bar while they work: pink for Antigravity, violet for OpenCode. Antigravity's ring follows its step transcript, so it stays on through long thinking and long tool runs until the final answer, goes out about 20 seconds after it or after you press stop, and picks up a turn already running when the app starts. OpenCode's follows writes to its database; that rule has not been tried on a real OpenCode session yet. See [The activity ring](#the-activity-ring).

### v1.7.0

- **Antigravity quota.** While Antigravity is running, the panel and the floating bar show the 5-hour and weekly windows its Settings → Models page shows, for Gemini and for Claude/GPT, with reset times. Antigravity keeps them only in its running language server, never on disk, so the app asks that server on 127.0.0.1. Its cached figures do not follow usage, so the app has it refresh them whenever this machine's Antigravity usage grows, when a window resets, and every 10 minutes: after a message the bar updates within one 30-second refresh. With Antigravity closed, the last figures stay, marked with their age. See [Where the data comes from](#where-the-data-comes-from).
- **Pick which tools the floating bar shows.** Tray or bar menu → 悬浮条显示: by default the tools found on this machine, or any of the five you tick. Antigravity and OpenCode can now sit on the bar, with their official marks. The bar sizes itself to the tools and numbers it shows, and when the screen is too short for the expanded cards they scroll.
- **Fixed: earlier parts of a Claude Desktop conversation appeared as separate CLI sessions.** When a conversation runs out of context or is rewound, Claude Desktop carries on in a new transcript and lists the earlier ones in `priorCliSessionIds`. Those earlier transcripts matched no Desktop session, so the session list showed them as CLI sessions with the same title — 3 of 6 entries on the author's machine. They now belong to the conversation: one row in the session list, one session in the report, with Desktop's title. Amounts are unchanged to the cent.

### v1.6.0

- **Usage report.** Tray menu → 打开用量报表, or the 报表 button on the panel, opens a report window covering every tool at once: amount, tokens, requests, sessions and cache hit rate against the previous period; a daily trend stacked by tool (by hour for today); hour of day; per tool; per project, merging the tools that worked in the same directory and folding Claude Code worktrees into their repository; the costliest sessions, with subagents and resumed history credited back to the session that ran them; and per model. Filter by tool, switch the charts between amount and tokens. See [Usage report](#usage-report).
- **Antigravity and OpenCode.** Antigravity's IDE and `agy` CLI conversations are read from their local databases and valued at Gemini API prices (Claude models inside Antigravity at Claude prices); OpenCode shows the amount it recorded per message. Both get a panel tab, sessions and report rows. See [Where the data comes from](#where-the-data-comes-from).
- **Only new data is read.** Each refresh reads just the bytes appended to a session file since the last one, and keeps every day it has read, so changing a range or opening the report does not read files again. Measured on a 38 MB transcript: one appended line takes 1–2 ms instead of a 75 ms full read. The first read after launch is still a full one.
- **Fixed: resumed Claude sessions could undercount.** A resumed or forked transcript can carry a copy of earlier messages with the usage zeroed, and when that copy was read last it replaced the real one — $0.24 over 30 days on the author's machine. Each message now counts at its full size and belongs to the transcript created first.
- **Fixed: Codex subagents and forked conversations were counted wrong, both ways.** A forked rollout — a subagent forked with its parent's context, a conversation forked in Codex Desktop, an auto-review agent — starts with a copy of history already billed where it came from. The app used to take the subagent's last `thread_settings_applied` event as the end of that copy; in Codex 0.153 and later that event is usually a mid-task model switch, so the subagent's own work before it was dropped, while copies in Desktop forks, or past a copied settings event, were billed a second time. Neither timestamps nor settings events mark a copy reliably (some older forks were written in one go, every line stamped with the creation time), but its content does: a copied call has exactly the token counts of a call in the rollout it came from. Calls in forked rollouts are now matched against their source, and the source's sources; `thread_settings_applied` only sets the model, which subagents often name nowhere else.
- **Fixed: Codex work after a thread moved to a new file was missing.** Since late September Codex continues a long thread in `rollout-<time>-<thread id>_<uuid>.jsonl`. The app kept only the first file of each thread, so everything written to the later ones was left out — on the author's machine about 30% of the last 7 days. All of a thread's files now count, checked by content against the earlier ones, because a continuation sometimes replays calls from before; the session list also takes its last activity from the newest file. Together with the fix above, the Codex amount on the author's machine goes from $294 to $418 over 7 days, $519 to $676 over 30 days, and $3,533 to $3,465 over 90 days (July's double-counted forks come out).
- **Fixed: `gpt-6.1-sol` showed as $0.** Codex added it after the last price check; it now has its official row. `npm run check-prices` also checks the new Gemini rows against Google's pricing page.

### v1.5.0

- **The price table updates itself.** It now lives in [`lib/prices.json`](lib/prices.json) in this repository, and the app downloads it about 10 seconds after launch and then once a day, retrying hourly after a failure (at login the network is often not up yet). A price change or a new model reaches every installed copy within a day, with no new version to install. A download is used only if it validates and is at least as new as the table in use; offline, the last good download or the built-in copy keeps working. The request sends nothing about you, and the tray menu can turn it off (自动更新价格表). See [How the cost is computed](#how-the-cost-is-computed).
- **The weekly price check reads the vendors' own pages.** `npm run check-prices` now compares every price on Anthropic's and OpenAI's pricing pages and flags any model the Codex model page offers that has no row. GPT-6 Sol and Luna showed as $0 until 1.4.0 because the old check only verified rows the table already had.

### v1.4.0

- **Live activity ring.** While a session runs, that provider's segment of the floating bar is wrapped in a ring of travelling light: orange for Claude, mint for Codex, blue for Grok, and the warning colour when a session needs you. "Activity ring style" in the tray menu offers brand colours, rainbow or off; with "reduce motion" enabled system-wide it becomes a still glow.
- **The ring does not wait for the 30s refresh.** The main process watches all three session directories and the hook status directory, and lights up within 0.4s of a write. A turn often finishes in well under 30 seconds, so a ring driven by the snapshot would mostly appear after the work was done.
- **File events are re-checked against mtime.** A client renaming or migrating old session files fires the watch too, but the file itself is not new, so it does not count as running — Codex Desktop's session migration at startup used to spin the ring for 20 seconds on its own.
- **The installer asks where to install.** The one-click build went to the per-user location without asking. It is now an assisted install with a directory page, still defaulting to per-user and still needing no admin rights.
- **Prices re-checked against all three vendors' official pages.** Claude Opus 5.5 was being priced as Opus 5, cache reads at 2.5x the official rate, so **if you use Opus 5.5 the cost shown drops noticeably — that is the correction, not lost data.** GPT-6 Sol and GPT-6 Luna were not recognized and cost nothing; they now use official rates, as do GPT-5.4 and GPT-5.4 mini, which Codex still lists. Grok needs no table: its cost is the billed value Grok CLI records.

### v1.3.2

- **Upgrading no longer turns launch-at-login off.** v1.3.1 taught the uninstaller to clear the startup entry, but a one-click install runs the previous uninstaller first, so every update silently switched the setting off. The uninstall hook now skips that when it is part of an update; a real uninstall still clears it.
- **Running the portable build no longer takes the startup entry from an installed copy.** Installing is a deliberate act and still takes it over; being double-clicked once is not. A portable launch now claims the entry only when the exe it points at is gone.
- **Leftover temporary files are cleared at startup.** Writes go through a temp file, and a forced kill — which recovering a hung instance does — skipped the cleanup. Only this app's own `.tmp` files are removed.

### v1.3.1

- **Rate-limit waits are honored in full and survive restarts.** v1.3.0 capped the wait Anthropic asked for at one hour, so when the server wanted longer the app knocked again every hour and stayed rate-limited — and every restart made a fresh request straight away. The cap is now 24 hours, and the wait is written to `%APPDATA%\ai-code-usage-tray\claude-oauth-throttle.json` (status code and timestamps only, no tokens), so a restart respects it too. That file also tells you why the last request failed.
- **An expired login says so and stops retrying.** When the refresh token has expired (Anthropic answers `400 Refresh token expired`), the panel now says the login has expired instead of talking about an authorization code, and the app stops knocking on the API every 5 minutes until you reconnect the account.
- **Codex pricing covers the cyber models and the daybreak aliases.** `gpt-5.5-cyber` was billed as `gpt-5.5` (2.5× under); `gpt-5.6-cyber`, `gpt-daybreak-blue-latest` and `gpt-daybreak-red-latest` were not recognized at all and cost nothing. Confirmed against OpenAI's pricing page.

### v1.3.0

- **Installer build.** The one-click installer `AI-Code-Usage-Tray-Setup-*-win-x64.exe` is now the recommended download. It installs for the current user under `%LOCALAPPDATA%\Programs` without admin rights, starts without unpacking ~350 MB on every launch, and keeps the tray icon and launch-at-login entry on a stable path. The portable build is still published.
- **Opening the app again recovers a frozen instance.** Before, once the app stopped responding, relaunching it did nothing: the frozen copy kept the single-instance lock and every new launch quit silently. A new launch now ends any copy Windows reports as not responding, then takes over.
- **The portable build no longer damages a running copy.** Every launch used to unpack into the same temporary folder and delete it on exit, including files that a copy still running from that folder needed. Each launch now gets its own folder.
- **Hang log.** If the main thread stops responding for more than 15 seconds, `%APPDATA%\ai-code-usage-tray\hang-log.jsonl` records when it happened, which step was running and which processes had just started. Nothing is uploaded. See [If the app stops responding](#if-the-app-stops-responding).
- **The Claude account quota recovers from rate limiting.** When Anthropic rate-limited the quota request, the app retried it on every 30-second refresh, which could keep the account rate-limited indefinitely and hide the Fable window. It now makes at most one attempt every 5 minutes, whether the last one succeeded or failed, and waits longer when Anthropic's response asks it to (up to an hour).

### v1.2.2

- **Fixed the Grok weekly quota disappearing at the start of a billing period.** xAI omits `creditUsagePercent` when usage is 0, which was read as "no data" and hid the whole quota block until usage crossed 1%. An absent field now means 0%.

### v1.2.1

- **The price table was re-verified end to end.** Sonnet 5 and the whole GPT-5.6 family now use current official rates, and Claude Fable 5.1 / Mythos 5.1 read cache at 0.025x instead of a flat 0.1x. **If you use Fable 5.1 heavily the cost shown drops noticeably — that is the correction, not lost data.**
- **Model resolution fixes.** Longest-prefix matching, so `claude-opus-4` no longer shadows `claude-opus-4-5` and `gpt-5.5` no longer shadows `gpt-5.5-pro` (which had been billing 6x under). Bedrock and Vertex model ids are recognised; those sessions previously showed a cost of zero.
- **Missing multipliers added**: Opus 5 fast mode (2x), `inference_geo: "us"` (1.1x), and the Bedrock regional profile premium (10%).
- **New `npm run check-prices`**, run weekly by GitHub Actions so a stale table gets reported instead of quietly drifting. See [Updating the price table](#updating-the-price-table).

Older versions are listed under [Releases](https://github.com/saime428/ai-code-usage-tray/releases).

<a id="quick-start"></a>
## Quick start

1. Open [GitHub Releases](https://github.com/saime428/ai-code-usage-tray/releases/latest).
2. Download the installer `AI-Code-Usage-Tray-Setup-*-win-x64.exe` and run it. It asks where to install, defaulting to the current user under `%LOCALAPPDATA%\Programs` (no admin rights; choosing all users needs them). It adds desktop and Start menu shortcuts and starts the app. Uninstall it from Windows Settings → Apps; settings and the account ledger in `%APPDATA%\ai-code-usage-tray` are kept.
3. Click the floating bar or tray icon to open the full panel; its 报表 button opens the usage report.
4. Right-click the floating bar or tray icon to open the usage report, refresh, toggle launch-at-login, toggle price-table updates, pick which tools the floating bar shows, change the activity ring style, switch top/right docking, hide the floating bar, toggle fullscreen auto-hide, or quit.

Prefer not to install? `AI-Code-Usage-Tray-*-win-x64.exe` (no `Setup` in the name) is the portable build: double-click to run. It unpacks itself to a new temporary folder on every launch, so it starts slower, and Windows may treat its tray icon as a new program each time.

Moving from the portable build to the installer: quit the portable app first (right-click → quit), because the installer may not notice a copy running from a temporary folder. If launch-at-login was on, the installed app takes the entry over the first time it starts, and running the portable build afterwards leaves that entry alone — it only claims it when the exe the entry points at is gone.

> [!WARNING]
> The builds are not code-signed yet, so SmartScreen may warn you. Download only from this repository's Releases and verify the SHA-256 published with each release. Signed builds will follow the [Code signing policy](#code-signing-policy) below.

<a id="usage-report"></a>
## Usage report

Open it from the tray menu (打开用量报表) or the panel's 报表 button. It is an ordinary window: resize it, keep it open — it refreshes with the panel every 30 seconds.

| Part | What it shows |
| --- | --- |
| Filters | Range (today / 7 / 30 / 90 days), whether the charts plot amount or tokens, and which tools to include. The range and chart choice are remembered. |
| Tiles | Amount, tokens, requests, sessions and cache hit rate (cache reads ÷ all input), with the change against the previous period of the same length — "yesterday" for today. |
| Trend | One column per day, stacked by tool; by hour for today. Hover for the per-tool numbers; 表格视图 under the chart lists them all. |
| Per tool / hour of day | Each tool's amount, share, tokens, cache hit rate, requests and sessions; and when in the day the usage happens. |
| Per project | Sessions grouped by working directory across tools (`C:\x` and `c:/x/` are one project), with Claude Code worktrees (`<repo>\.claude\worktrees\<name>`) folded into their repository. |
| Costliest sessions | Title, project, client, amount, tokens, requests, last activity. Subagent work and history copied by resume or fork count toward the session that ran them. |
| Per model | Requests, input, cache reads, output and amount per model; models without a price say so. |

The amounts add up values of different kinds — API-equivalent for Claude, Codex and Antigravity, billed for Grok, recorded for OpenCode — and the report says so at the bottom. Token totals are put on one scale first: Codex and Grok count cache reads inside their input, the other three report them separately. The 90-day view has no comparison, because it would mean reading 180 days of history.

The same report is on the command line, without Electron:

```powershell
npm run usage -- --days 30                  # per tool and per day
npm run usage -- --days 7 --by project      # or: tool, day, hour, model, project, session
```

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
| Antigravity (IDE and `agy` CLI) | `~/.gemini/antigravity*/conversations/*.db` + `conversation_summaries.db` | per-turn tokens and models, titles, workspaces, session activity |
| Antigravity quota | the running Antigravity language server, over its local endpoint on 127.0.0.1 | 5-hour and weekly windows for Gemini and for Claude/GPT, with reset times |
| OpenCode | `~/.local/share/opencode/opencode.db` (`$XDG_DATA_HOME/opencode` when set) | per-message tokens, models and the amount OpenCode recorded, titles, directories |

The Microsoft Store build of Claude Desktop is detected automatically under `%LOCALAPPDATA%/Packages/Claude_*/LocalCache/Roaming/Claude/`.

Antigravity and OpenCode keep SQLite databases; the app opens them read-only and only when they changed, so it never blocks the tool writing them. Antigravity's token counts sit in protobuf records whose field numbers were reverse-engineered by [TokenMe](https://github.com/Bencibr/tokenme) (MIT) and re-checked here against real databases; the older `antigravity-ide` and `antigravity-backup` folders hold copies of the same conversations, so turns merge by conversation and response id instead of adding up.

Antigravity never writes its quota to disk; only its running language server holds it, and it serves the figures its Settings → Models page shows over a local endpoint. While Antigravity is running, the app finds that server (`language_server.exe` in the Antigravity install), takes the access token from its command line and the port from the system's socket table, and asks it on 127.0.0.1 — the same call [TokenMe](https://github.com/Bencibr/tokenme) and [CodexBar](https://github.com/steipete/CodexBar) make on macOS. The server's cached figures do not follow usage (two messages later they had not moved), so the app asks it to refresh from Google when this machine's Antigravity usage grows, when a window's reset time has passed, and every 10 minutes; in between the last answer stands. When Antigravity is closed the last figures stay, marked with their age and dimmed after 15 minutes. The `agy` CLI alone is not read: asking it would need its own sign-in and can open a browser.

### How the cost is computed

Claude, Codex and Antigravity costs come from a hand-maintained table of official standard API list prices, [`lib/prices.json`](lib/prices.json), stamped with the date it was last verified — the "price snapshot" date at the bottom of the panel. None of the three vendors publishes pricing in a machine-readable form, so the table is kept here and the app fetches it: about 10 seconds after launch and then once a day (hourly after a failed attempt), from `raw.githubusercontent.com`, falling back to `cdn.jsdelivr.net` where GitHub is unreachable. A downloaded table is used only if it passes validation (known schema, sane numbers, every model still present) and is at least as new as the table in use. Otherwise, or offline, the app keeps the last good download (`%APPDATA%\ai-code-usage-tray\prices.json`) or the copy built into the app. The tray menu item 自动更新价格表 turns the download off; the table already in use stays. What the table models:

- Prompt caching: cache write 1.25x (5-minute) / 2x (1-hour), cache read 0.1x — 0.05x on Claude Opus 5.5, 0.025x on Claude Fable 5.1 and Mythos 5.1.
- Fast mode (2x) on Opus 5.5 / 5 / 4.8, and `inference_geo: "us"` (1.1x), read from each transcript row.
- Codex long context (input over 272K: 2x input, 1.5x output).
- Gemini context caching rates, and the Pro models' tier for prompts over 200K. Antigravity sends experiment ids such as `gemini-3.7-flash-control` or `gemini-3-flash-a`; they price as their model by the longest-prefix rule. Claude models used inside Antigravity price from the `claude` section.
- Bedrock and Vertex model ids (`us.anthropic.…`, `name@date`), with the documented 10% regional premium; `global.` profiles at base price.
- Retired models stay listed so older transcripts still price.

Models without a public list price (for example Codex's internal `codex-auto-review` label, or Antigravity's `gemini-pro-default`, which names a router rather than a model) show as "unavailable", are left out of the total, and the total is marked incomplete rather than guessed.

Grok and OpenCode need no table: Grok's amount is what Grok CLI recorded as billed, and OpenCode's is what OpenCode recorded per message from its own models.dev prices — an estimate for API keys, 0 for subscriptions and local models.

`npm run check-prices` checks the table against Anthropic's, OpenAI's and Google's own pricing pages — every price, plus a row for every model the Codex model page offers — and against LiteLLM's community-maintained cost map; CI runs it weekly. It only reports: a person edits the table.

#### Updating the price table

Everything is in one file, [`lib/prices.json`](lib/prices.json). Pushing it to `main` updates every installed copy (1.5.0 and later) within a day; no release is needed.

| What | Where |
| --- | --- |
| Claude prices | The `claude` section. One row per model, USD per million tokens: `"claude-opus-5": { "input": 5, "output": 25 }`. Optional fields: `cacheRead` (cache-hit multiplier, default 0.1), `fast` (fast-mode multiplier), `legacy: true` (retired model, exempt from the Bedrock regional premium). |
| Codex prices | The `codex` section: `"gpt-5.6-sol": { "input": 4, "cachedInput": 0.4, "output": 20 }`. Which models get a row is written at the top of `lib/codex-usage.js`. `codexAliases` points ids the pricing page documents as aliases at a row. |
| Gemini prices (Antigravity) | The `gemini` section: `"gemini-3.8-flash": { "input": 0.75, "cachedInput": 0.075, "output": 3.75 }`. Optional `longContext: { "above": 200000, "input": 4, "cachedInput": 0.4, "output": 18 }` replaces all three rates for a call whose prompt (input plus cache reads) exceeds `above`. Copies older than 1.6.0 ignore this section. |
| Snapshot date | `snapshot`. The panel footer shows it. |

Row keys are the model id **without** a date suffix (`claude-opus-5`, not `claude-opus-5-20260514`). `priceFor` matches by prefix and the longest key wins, so `claude-opus-4` and `claude-opus-4-5` coexist. A model that only exists as a longer sibling of an existing key (`gpt-5.5-pro` next to `gpt-5.5`) needs its own row, or it silently takes the shorter key's price — `npm run check-prices` reports that as an `unlisted id` line.

1. `npm run check-prices` — each difference prints as `official  model  field  ours → official`, or with `claude` / `codex` / `gemini` in front for LiteLLM. A `notes` line about a dated price change (the Gemini 3.6–3.8 Flash rates rise on 2027-01-01) is a reminder to edit the row on that day: the table has no dates of its own. Both vendors refuse some regions and Node's `fetch` ignores the system proxy; behind a proxy, run `NODE_USE_ENV_PROXY=1 npm run check-prices` (Node 24+, reads `HTTPS_PROXY`).
2. `official` lines come straight from the vendors' pages. Confirm LiteLLM lines there too: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). LiteLLM is community data and occasionally contradicts itself.
3. Edit the row(s), set `snapshot` to today's date, run `npm test`, commit, and push to `main`.

Installed copies depend on this file, so four rules:

- Keep the path. `lib/prices.json` on `main` is the exact file they download.
- Set `snapshot` to the day of the change, a rollback included — a table older than the one in use is ignored. Never a future date: copies refuse one, because it would outrank every later fix.
- Never delete a row. Retired models still price old transcripts, and a table missing a row is rejected as truncated.
- New optional fields are fine (older copies ignore them). If an existing field changes meaning, raise `schema`: older copies then keep the table they have instead of misreading the new one.

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

### The activity ring

While a session runs, its segment of the floating bar is wrapped in a ring of travelling light: orange for Claude, mint for Codex, blue for Grok, pink for Antigravity, violet for OpenCode, and the warning colour when a session needs you. "Activity ring style" in the tray menu switches it to rainbow or turns it off; with "reduce motion" enabled system-wide it becomes a still glow.

The ring does not wait for the 30s snapshot. The main process watches `~/.claude/projects`, `~/.codex/sessions`, `~/.grok/sessions`, Antigravity's step transcripts, OpenCode's database and the hook status directory, and lights up within 0.4s of a write (`lib/activity.js`):

- Claude sessions with hooks installed follow the hook's working / needs-attention state, which is exact.
- Antigravity's step transcript says whether a turn is still open: only a reply without tool calls ends the turn (pressing stop writes one too), and a checkpoint is judged by the step before it; after any other step — your message, a tool call or its result, a command, a system message — the model or a tool is still due. Checked against every step in the author's 29 transcripts: the rule never called a finished turn open. So its ring stays on through long thinking and long tool runs until the final answer, then goes out 20 seconds later; a turn already running when the app starts is picked up at launch. If Antigravity dies mid-turn and writes nothing more, the ring goes out 10 minutes after its last write (`OPEN_TURN_MS`).
- Sessions without hooks, plus Codex, Grok and OpenCode, fall back to "wrote to disk in the last 20 seconds" — so the ring can blink during a long think with no disk writes, and stays lit for up to 20s after a turn ends. Tune `WRITE_ACTIVE_MS` in `lib/activity.js`.
- Every file event is re-checked against the file's mtime: a client renaming or migrating old session files also fires the watch, but the file itself is not new, so it does not count as running.
- Antigravity and OpenCode keep their sessions in SQLite, and Antigravity creates and deletes its database's write-ahead files even while idle (opening and closing connections), which would blink the ring. So for Antigravity the ring follows the per-step transcript it appends only while a turn runs (`brain/<conversation>/.system_generated/logs/transcript.jsonl` under the IDE and CLI folders), and for OpenCode a change to `opencode.db-wal` — the app's own read-only opens never write that file. The OpenCode rule has not been measured on a real OpenCode session yet.

Switching styles while nothing is running would show no difference, so a style change lights every ring for two seconds as a preview.

### Enabling hooks (optional)

Neither the installer nor the portable build includes the hook scripts — get the `hooks/` directory from this repository (clone it, or download the two files). Then wire them into `~/.claude/settings.json`:

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

## If the app stops responding

Open it again. A new launch ends any copy that Windows reports as not responding and takes over. If that still does not help, end the process from Task Manager.

To see why it froze, open `%APPDATA%\ai-code-usage-tray\hang-log.jsonl`. A freeze longer than 15 seconds adds these lines:

- `hang` — `lastBeatAt` is when the main thread stopped. `step` names the synchronous call into another process that was running (`tasklist`, `registry`, `tray`, `window`, `safe-storage`), or is `idle` if none was: the thread froze while handling window messages, which is where code injected from outside the app runs.
- `processes` — processes started in the 15 minutes before the freeze, plus input-method and text-services processes with their start times.
- `recovered` — written if the thread comes back, with how long it was stuck.
- `ended-hung-instance` — written by the launch that took over, naming the process it ended.
- `watchdog-error` / `watchdog-exit` — the watchdog itself could not start, or stopped early. Without these an empty log would be ambiguous.

Input methods that load a text-service DLL into every program (Tencent WeType, for example) are a known cause of this kind of cross-process freeze in other software, and the one freeze analysed so far had that DLL loaded. That is a lead, not a verdict: an `idle` step together with an input-method process that started just before the freeze would confirm it. Please attach the log when you [report a hang](https://github.com/saime428/ai-code-usage-tray/issues).

## Privacy and security

- No transcripts, prompts, project paths or session titles are uploaded.
- Antigravity's and OpenCode's databases are opened read-only; nothing is written next to them.
- Antigravity's quota is asked of its own language server on 127.0.0.1. The access token for those calls is read from the server's command line and kept in memory until a refresh finds that server gone (at most about ten minutes after it exits); to answer, Antigravity may refresh the figures from Google with its own sign-in.
- Apart from the optional Claude account (which asks Anthropic for your quota), the only automatic network request downloads the public price table (`lib/prices.json`) from this repository, at launch and once a day (hourly after a failed attempt). It sends nothing about you; the server sees an ordinary download. Turn it off with the tray menu item 自动更新价格表.
- No browser cookies are read, and no Anthropic / OpenAI / xAI API key is needed.
- If a local file is corrupt, locked or unreadable, the last snapshot is kept and marked stale.
- OAuth login is optional. Local monitoring keeps working offline or when Anthropic rate-limits.
- The hang log (`hang-log.jsonl`) stays on this machine. It holds timestamps, a step name, and process names with their start times — no usage data or session content.
- `claude-oauth-throttle.json` records the last account quota request's status code and timestamps, so a rate-limit wait survives a restart. No tokens.
- Full details in the [Privacy Policy](PRIVACY.md).

## Code signing policy

- Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).
- SignPath-signed releases will be built from this repository by [GitHub Actions](.github/workflows/ci.yml) and manually approved before signing. All releases to date remain unsigned; signing starts once the SignPath Foundation approval completes.
- Committer, reviewer, and approver: [@saime428](https://github.com/saime428).
- Privacy policy: [PRIVACY.md](PRIVACY.md).

<a id="development"></a>
## Development

Requires **Windows 10/11, Node.js 24+ and npm** (24 is what Electron 43 runs; the tests open SQLite through Node's built-in `node:sqlite`):

```powershell
git clone https://github.com/saime428/ai-code-usage-tray.git
cd ai-code-usage-tray
npm ci
npm test
npm start
npm run usage   # print today's usage in the terminal, no Electron needed (add -- --days 30 for a report)
npm run check-prices   # check the price table against the vendors' pages and LiteLLM
```

Build the Windows x64 installer and portable executable:

```powershell
npm run dist
```

Both land in `dist/`: `AI-Code-Usage-Tray-Setup-<version>-win-x64.exe` (installer) and `AI-Code-Usage-Tray-<version>-win-x64.exe` (portable). To update your own install, quit the running app and run the new Setup file.

### Project layout

```text
main.js                 Electron main process, tray, windows, refresh scheduling
preload.js              restricted IPC bridge
lib/usage.js            Claude local usage and session parsing
lib/codex-usage.js      Codex local usage and quota parsing
lib/grok-usage.js       Grok local usage, official cost and weekly quota
lib/antigravity-usage.js  Antigravity conversation databases (protobuf decoding) and Gemini pricing
lib/antigravity-quota.js  Antigravity quota from its running language server
lib/opencode-usage.js   OpenCode's SQLite store
lib/jsonl.js            line reader that resumes a file from where the last read stopped
lib/report.js           shared per-hour rows, the panel summary and the cross-tool report
lib/usage-worker.js     worker thread that runs all of the above off the main process
lib/prices.json         Claude / Codex / Gemini price table (the app also downloads it from main)
lib/prices.js           price table validation, and the URLs it is downloaded from
lib/claude-oauth.js     optional Claude OAuth / PKCE
lib/hang-guard.js       hang log watchdog and not-responding instance lookup
renderer/index.html     full panel
renderer/report.html    usage report window
lib/activity.js         activity watch behind the ring (session writes + hook state)
renderer/floating.html  edge-docked floating bar
lib/floating-providers.js  which tools the floating bar shows
hooks/                  optional Claude Code state hooks
```

### Release checklist

```powershell
npm test
npm run check-prices
npm run dist
git status --short
```

Price fixes don't need a release — see [Updating the price table](#updating-the-price-table). For a release, bump the version in `package.json`, refresh the "What's new" section at the top of both READMEs, create a GitHub Release with both `.exe` files and their SHA-256, then install the Setup build from that Release on a clean Windows machine. Windows Sandbox is enough (built into Pro, Enterprise and Education; turn it on under "Turn Windows features on or off"). Download the installer with the sandbox's browser instead of copying it in: a copied file has no Mark of the Web, so SmartScreen never shows. With no AI tools installed, the panel and the report should open empty without errors, `%APPDATA%\ai-code-usage-tray\prices.json` should appear about 15 seconds after launch, and after uninstalling there should be no `AI Code Usage Tray` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

## Current limitations

- Windows x64 only.
- The app itself does not auto-update yet; only the price table does.
- The app UI is currently Chinese-only.
- The builds are not code-signed yet. The SignPath Foundation application and signing automation are in progress.
- Claude OAuth may be rate-limited by Anthropic or affected by your network egress. Local inference is unaffected.
- Regular Claude Desktop Home chats expose no token detail, so only session state and quota percentages can be shown — no cost.
- Grok sessions are CLI-only: no per-account tracking (no identity detection yet) and no click-to-open deep link.
- The Grok weekly quota comes from what Grok CLI writes to disk: after a billing period rolls over it only reappears the next time you run Grok CLI (2–57 hours in local measurements). It stays hidden during that window — the weekly quota is account-wide, so you may have spent part of it on the web, and a guess would be worse than nothing.
- Bedrock's own pricing for retired models is not modeled.
- Codex fast mode (`service_tier: "priority"`, 2x the standard price, 2.5x on gpt-5.5) is not modeled; those turns show the standard price.
- Models without a public list price (such as `codex-auto-review`) are excluded from the total and flagged, not estimated.
- Antigravity's quota shows only once Antigravity has run since the app started (it is not stored on disk), and the `agy` CLI on its own does not provide it. OpenCode has no quota display. Neither has a click-to-open link or per-account tracking, and the tray tooltip stays on Claude, Codex and Grok.
- An Antigravity turn is dated by its own timestamp or, on newer builds that stopped writing one, by the matching step; a turn with neither falls back to the conversation's start time. That never happened on the databases checked so far.
- The first refresh after launch, and the first report over a longer range, still read every file in range once (about 3 seconds for 30 days of the author's history); only later reads are incremental. Nothing is cached on disk.

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
  Not affiliated with or endorsed by Anthropic, OpenAI, xAI, Google, or the OpenCode project.
</p>

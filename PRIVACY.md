# Privacy Policy

Effective date: October 4, 2026

AI Code Usage Tray is a local-first desktop application. It reads usage and session metadata already stored on the user's computer by Claude Code, Claude Desktop, Codex CLI, Codex Desktop, Grok CLI, Antigravity, and OpenCode. Antigravity's and OpenCode's databases are opened read-only.

## Data collection

The application has no analytics, telemetry, advertising, or developer-operated backend. It does not upload transcripts, prompts, project paths, session titles, API keys, or browser cookies.

## Network transfers

The application sends no information about the user, their usage, or their sessions to any system. It makes network requests in these cases only:

- **Price table — automatic, can be turned off.** About 10 seconds after launch and then once a day (hourly after a failed attempt), the application downloads the public price table `lib/prices.json` from this project's GitHub repository (`raw.githubusercontent.com`, or `cdn.jsdelivr.net` when GitHub is unreachable). The request is an ordinary file download: it carries no usage data, identifiers, file paths, or settings, and the host sees only what any download reveals, such as the IP address. The tray menu item "自动更新价格表" (auto-update the price table) turns it off.
- **Claude account — only when the user connects one.** Connecting opens Anthropic's OAuth flow and exchanges the authorization result with Anthropic; while connected, the application retrieves the account's usage limits from Anthropic. It does not send transcript content.
- **Antigravity quota — local only, while Antigravity runs.** The application asks Antigravity's own language server for the quota figures over the loopback address 127.0.0.1; nothing is sent off the computer by this request. To answer, Antigravity may refresh the figures from Google with its own sign-in. The application reads that server's local access token from the server's command line for these requests, keeps it in memory until a refresh finds that server gone (at most about ten minutes after it exits), and never stores it or sends it anywhere other than that server.
- **External links** — when the user opens one from the application.

Anthropic's processing is governed by the [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy). The price table download is subject to the [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) or, through the fallback, the [jsDelivr Privacy Policy](https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net).

## Local storage

Optional Claude OAuth credentials are encrypted with Electron `safeStorage` and stored in the application's local user-data directory. Disconnecting the Claude account deletes those stored credentials. Other preferences, generated status files, and the last downloaded price table remain on the local computer.

If the application stops responding, a diagnostic log in the same directory records the time, the step that was running, and the names and start times of processes running at that moment. It stays on the local computer and is transferred only if the user chooses to attach it to a bug report.

Two things leave the application only when the user asks for them, and go nowhere but the place the user picks. The tray menu item "复制诊断信息" (copy diagnostics) puts a text summary on the clipboard for pasting into a bug report: versions, settings, per-tool counts, quota figures and file locations, with the home directory written as `~` and without session titles, project names, account names or credentials. The usage report's "导出 CSV" (export CSV) button writes a file to the location the user chooses, holding dates, tool and model names, token counts and amounts.

## Deletion

Installed builds are removed from Windows Settings → Apps; portable builds are removed by exiting the application and deleting the executable. Disconnect the Claude account first to remove its stored credentials; the application's local user-data directory may also be deleted to remove all preferences and cached state.

## Contact

Questions or reports can be filed through the project's [GitHub Issues](https://github.com/saime428/ai-code-usage-tray/issues).

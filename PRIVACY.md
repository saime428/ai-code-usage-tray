# Privacy Policy

Effective date: July 28, 2026

AI Code Usage Tray is a local-first desktop application. It reads usage and session metadata already stored on the user's computer by Claude Code, Claude Desktop, Codex CLI, and Codex Desktop.

## Data collection

The application has no analytics, telemetry, advertising, or developer-operated backend. It does not upload transcripts, prompts, project paths, session titles, API keys, or browser cookies.

## Network transfers

**This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.**

Network access occurs only when the user explicitly:

- connects a Claude account, which opens Anthropic's OAuth flow and exchanges the authorization result with Anthropic to retrieve account usage limits; or
- opens an external link from the application.

The optional Claude account connection does not send transcript content. Anthropic's processing is governed by the [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy).

## Local storage

Optional Claude OAuth credentials are encrypted with Electron `safeStorage` and stored in the application's local user-data directory. Disconnecting the Claude account deletes those stored credentials. Other preferences and generated status files remain on the local computer.

## Deletion

This is a portable application. Exit it and delete the executable to remove the program. Disconnect the Claude account first to remove its stored credentials; the application's local user-data directory may also be deleted to remove all preferences and cached state.

## Contact

Questions or reports can be filed through the project's [GitHub Issues](https://github.com/saime428/ai-code-usage-tray/issues).

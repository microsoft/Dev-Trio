# Changelog

All notable changes to Dev-Trio will be documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.1.0] — 2026-06-15

First public release.

### Added
- Three-agent orchestration supporting GitHub Copilot Chat (GHCP), Claude Code,
  and OpenAI Codex — any combination of the three
- Tiered prompt system: Structural (T1) for complex multi-file changes with the
  full Planner → Implementer → Critic loop; Content (T2) for guided changes;
  Mechanical (T3) for direct single-agent execution
- Setup wizard with agent detection and per-role model selection for Claude Code
  and Codex (GHCP model selection stays in the GitHub Copilot Chat panel)
- Session Log with per-phase credit tracking using embedded AIC pricing from the
  VS Code chatSessions data
- Backup log (append-only Markdown) capturing every Dev-Trio phase for context
  handoff between sessions
- Notification support via Telegram, Microsoft Teams, Slack, and Discord, with
  all credentials stored in VS Code SecretStorage
- Memory and Roadmap editors (Quill WYSIWYG) for editing project context without
  Markdown syntax
- Update Project panel with version detection, automatic upgrade-prompt
  generation, and a live file-version watcher that refreshes the panel after an
  upgrade completes
- Programmatic GHCP chat submission via the VS Code chat command (Send to Copilot
  button, with a copy-to-clipboard fallback)
- Scaffold files for Claude Code agents (claude-opus-4-8 / claude-sonnet-4-6) and
  Codex agents (gpt-5.5 / gpt-5.4-mini)
- Upgrade prompt system (upgrade-v1.0.0.md and upgrade-v1.1.0.md) for migrating a
  workspace between Dev-Trio versions
- Remove Dev-Trio command that cleans the workspace while preserving your
  memory/ files

### Architecture
- Zero runtime dependencies — nothing is bundled into the shipped extension
  beyond Dev-Trio's own code
- The extension never calls an AI model directly and collects no telemetry; it
  orchestrates the coding agent you already use
- All extension-runtime workspace file I/O goes through `vscode.workspace.fs`
- Nonce-based Content Security Policy on every webview, with no inline styles

### Notes
- The VS Code Marketplace listing is pending review. In the meantime, install
  manually from the
  [Releases page](https://github.com/microsoft/Dev-Trio/releases).

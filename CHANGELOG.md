# Changelog

All notable changes to Dev-Trio are documented here.

## [1.0.0] - 2026-06-13

### Added
- Autonomous AI coding agent scaffold (Planner, Implementer, Critic) with setup wizard
- Session Log viewer with prompt-derived entry titles
- Hybrid Copilot credit tracking (CLI-exact + VS Code token-based fallback)
- Telegram notification integration (machine-scoped)
- Automatic .gitignore configuration for per-developer state
- Backup log with sentinel validation and restore capability
- Restore Log button with format validation and auto-backup
- What I Did attribution in the Session Log viewer
- configureGitignore feature for per-developer state

## [0.1.0] — unreleased

### Added
- Project initialization command — generates 8 dev-trio config files directly into the open workspace (planner/implementer/critic agent files, dev-trio prompt file, AGENTS.md, MEMORY.md, ROADMAP.md, PROMPT_EXAMPLES.md)
- Faithful, project-agnostic agent templates based on a proven production dev-trio process: CONTEXT/ASSUMPTIONS/PLAN/KNOWN RISKS/AUDIT INSTRUCTION structured prompts, three-source critical-evidence protocol, planner-only I/O ownership
- Workspace probe (deterministic, offline) for Case A (existing project) vs Case B (greenfield) detection
- Setup walkthrough webview with step-by-step guidance, model-class recommendation card, and Autopilot instruction card
- Telegram notification setup wizard: BotFather walkthrough, auto-detect chat ID, test-before-generate flow with soft-gate confirmation, outbound-only notify script generation with resolved absolute path
- Outbound notification providers: Microsoft Teams, Slack, Discord, and custom webhook (Incoming Webhook / URL-based, outbound only)
- Chat backup log: append-only session archive with user-choice or default path, idempotent wiring into agent files via marker anchors
- SecretStorage wrapper for all credentials — nothing in settings.json, nothing in the repo
- Canonical brand assets: monochrome Activity Bar icon (currentColor SVG), full-color rounded-tile logo, auto-generated 128×128 Marketplace icon and 512×512 home-page icon with verified alpha transparency
- engines.vscode minimum set to 1.96.0 (required for sub-agent delegation)

### Architecture
- All filesystem writes via vscode.workspace.fs for remote/virtual workspace support
- No runtime dependencies — zero npm dependencies in the shipped extension
- No telemetry, no cloud callbacks, no background processes, no inbound listeners
- Notification script placed in user-profile tools directory, never committed to repo
- Marker-anchor pattern (HTML comments) for idempotent agent-file wiring

## [0.0.1] — 2026-06-01

### Added
- Initial scaffold: package.json, tsconfig.json, esbuild.js, extension activation, three command stubs

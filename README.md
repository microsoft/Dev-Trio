# Dev-Trio — Autonomous AI Coding Agents for VS Code

> **Three specialized AI agents that work as a team — with intelligent tier routing that matches AI effort to task complexity, so you never overspend on simple work or under-think the hard stuff.**

> **VS Code Marketplace listing — coming soon.** In the meantime, install manually from the [Releases page](https://github.com/microsoft/Dev-Trio/releases) (see [Getting started](#getting-started) below).

---

## The core idea

Most AI coding tools throw the same amount of effort at every request — whether you
asked for a one-line rename or a multi-file feature. Dev-Trio is smarter. It
**assigns every task a tier before any AI runs**, then routes it through exactly the
right amount of process:

- Simple changes go straight through — no wasted model calls.
- Complex changes get the full plan → build → audit loop.

You describe what you want. Dev-Trio figures out *how much AI to use*.

<img src="docs/images/sidebar-preview.png" width="320" alt="The Dev-Trio panel in VS Code" />

---

## How the tiers work

Every task is classified into one of three tiers. Dev-Trio chooses automatically —
you don't have to think about it.

### T1 — Structural · *full autonomy* (complex changes)

The complete three-agent loop:

- **Planner** reads the relevant files, checks them against your project's rules, and writes a precise implementation plan.
- **Implementer** carries out that plan exactly.
- **Critic** audits the result against the plan and your rules before it is accepted.

**Best for:** new features, architectural changes, multi-file refactors.
**Effort:** highest — three agents, full loop.

### T2 — Content · *guided* (medium changes)

A streamlined loop:

- **Planner** plans and makes the change directly.
- **Critic** reviews the result.

**Best for:** targeted fixes, documentation, single-file updates.
**Effort:** moderate.

### T3 — Mechanical · *direct* (simple changes)

- **Planner** does it directly — no delegation, no loop.

**Best for:** packaging, formatting, quick lookups, running builds and tests.
**Effort:** minimal.

> **The payoff:** Dev-Trio automatically picks the right tier for each task. Simple
> work stays cheap and fast; complex work gets full planning and review. It is not
> just throwing AI at everything — it is the right amount of AI, every time.

---

## Supported AI agents

Dev-Trio works with any combination of three popular AI coding assistants — pick
one, two, or all three:

- **GitHub Copilot Chat (GHCP)** — built into VS Code
- **Claude Code** — Anthropic, with dedicated subagent support
- **OpenAI Codex** — OpenAI, with dedicated subagent support

Each agent can use the right model for each role — a capable model for the
**Planner**, and efficient models for the **Implementer** and **Critic** — so quality
stays high while cost stays sensible. You choose the models during setup.

---

## What you get

- **Session Log with credit tracking** — a clear, readable history of every task, with an estimate of the Copilot credits each one used.
- **Backup log** — a complete on-disk archive of every phase, so context carries cleanly from one session to the next.
- **Notifications** — get a message on Telegram, Microsoft Teams, Slack, or Discord when a task finishes or needs your input.
- **Memory & Roadmap editors** — update your project's goals and rules in a simple built-in editor; the team picks up changes on the next task automatically.

---

## Getting started

**Option 1 — VS Code Marketplace (coming soon).** The Marketplace listing is pending review. Once live, you'll be able to search for **Dev-Trio** in the Extensions panel and click Install.

**Option 2 — Manual install (available now).**

1. Download `dev-trio-1.2.0-marketplace.vsix` from the [Releases page](https://github.com/microsoft/Dev-Trio/releases).
2. Install it one of two ways:
   - **VS Code:** Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → **Extensions: Install from VSIX…** → select the file.
   - **Terminal:** `code --install-extension dev-trio-1.2.0-marketplace.vsix`

Then open a project folder — the setup guide appears automatically. For a step-by-step walkthrough, see the **[Quick Start Guide](docs/QUICKSTART.md)**.

---

## Requirements

- **Visual Studio Code 1.96** or newer
- A subscription to **at least one** supported AI agent (GitHub Copilot, Claude Code, or OpenAI Codex) and its VS Code extension

---

## Your project, your control

Everything Dev-Trio sets up — your goals, your rules, and the agents' instructions —
lives in plain text files inside your workspace. No hidden prompts, no lock-in. The
extension itself never calls an AI model directly and collects no usage data; it
coordinates the assistant you already trust. Any credentials you add are stored
securely by VS Code, never in your project files.

---

## License

[MIT](LICENSE)

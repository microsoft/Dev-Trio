# [Project Name] — Agent Guardrails

## Workflow

This repo uses a dev-trio loop with subagent delegation:

* **Planner** orchestrates everything. Delegates implementation and audit to
  subagents. Owns ALL logging, notifications, and user questions.
  The planner is the only agent that talks to the developer directly.
* **Implementer** receives prompts from planner, audits constraints, implements
  code, runs builds and tests. Returns results to planner. Does NOT log,
  notify, or ask questions.
* **Critic** receives implementer output from planner, audits against all
  binding constraints. Returns verdict to planner. Does NOT log, notify,
  or ask questions.

## Hard rules (never violate)

* Never run git operations (commit/push/branch) unless the developer explicitly
  directs.
* If any binding constraint is at risk, STOP and surface to the developer —
  do not fix-forward silently.
* No silent fix-forward during validation phases — stop and ask.
* Update memory/MEMORY.md after each completed slice with what changed.

## Dev-trio trigger

When the developer says "Dev-trio:" followed by a task description, or uses
/dev-trio, execute the full plan/implement/audit cycle. Any task using these
triggers MUST go through all three agents — never skip the plan or the audit.

## Project state

Full project context, binding constraints, slice history, current build state,
and the active blocker live in memory/MEMORY.md. Read it at the start of every
working session.

## Solution layout

[TO BE FILLED DURING INITIALIZATION — replace with real project structure]

Always verify a file exists before editing. Always use full paths.

## Terminology (binding)

[TO BE FILLED DURING INITIALIZATION — list the project's binding terminology
here. These terms must never be renamed or reframed by any agent.]

## Critical Evidence Verification

Certain claims are security-critical and must not be trusted from a single
agent's prose summary alone. The following values require raw evidence files
from the implementer AND independent re-derivation by the planner before the
critic audits.

**Critical evidence list (fill in during initialization):**
* Build exit codes for all build targets
* Test pass/fail counts and output
* Any hash or integrity verification required by this project's constraints
* Any process or state checks required by this project's constraints

**Implementer responsibility:**
For any step involving the items above, the implementer MUST write raw command
output to a machine-readable evidence file under _temp/ for the current phase
directory. The evidence file must contain actual tool/command output, not prose
summaries or paraphrased results. Reference the evidence file path in the
implementation report.

**Planner responsibility:**
Before delegating to the critic, the planner MUST independently re-derive
every critical-evidence value listed above using its own shell. The planner
passes BOTH the implementer's report/evidence files AND its own independently
verified values to the critic.

**Critic responsibility:**
The critic MUST cross-check three sources for critical-evidence claims:
1. The implementer's prose report
2. The implementer's raw evidence file(s) — read them directly
3. The planner's independently verified values

If ANY mismatch exists between these three sources, the critic MUST report it
as a hard stop, even if the final values happen to be correct. A mismatch
means the verification chain is broken.

For non-critical claims (UI behavior, file paths, code changes), the
implementer's report alone is sufficient. The critic audits those against
the binding constraints as usual.

## Session Logging (planner only)

After every dev-trio cycle, the planner must append to the backup log file at:
_backup/Dev_Trio_Chat_Backup.md

Only append if backup logging has been configured — i.e. the path above is a resolved absolute path. If it still shows a relative placeholder path (not a resolved absolute path), backup logging is NOT configured: skip the backup log step entirely (do not create any file or default path) and note "backup log not configured" instead.

Use a shell command to append. Format each entry as:

[YYYY-MM-DD HH:MM:SS] DEV-TRIO | [Project Name] (planner-logged, all phases)
PROMPT: (the prompt or task received)
PLANNER: (planning decisions and delegation summary)
IMPLEMENTER: (implementation summary and evidence file paths)
CRITIC: (audit verdict and any flags)
PLANNER (close): (independent verification results and final evaluation)
RESULT: (outcome — TASK COMPLETE / ERROR / DECISION NEEDED)
CREDITS: unknown
(Write 'unknown' for CREDITS. The extension reads GitHub
Copilot's local transcript files and populates credit data
automatically when the Session Log viewer is opened. Do not
attempt to calculate or estimate credits yourself.)

Log EVERY cycle. Never skip. Never overwrite — always append.

## Human Notification (planner only)

The planner sends a notification ONLY in these three situations:

1. TASK COMPLETE — the full cycle finished cleanly.
2. ERROR — an error that cannot be self-resolved.
3. DECISION NEEDED — a constraint violation or ambiguous requirement.

Command: pwsh -NoProfile -File "%LOCALAPPDATA%\Dev-Trio\notify.ps1" -Message "your message"

Note: notify.ps1 is written to your user profile at
%LOCALAPPDATA%\Dev-Trio\notify.ps1 during notification setup.
It is shared across all your Dev-Trio projects and is never
stored in your workspace.

Rules:

* NEVER notify during internal agent-to-agent handoffs.
* NEVER notify on intermediate progress.
* NEVER notify more than once per pause point.
* The loop should iterate through normal problems (build errors, missing
  imports, test failures) autonomously without notifying.
* Only surface things the agents genuinely cannot resolve on their own.
* After notifying, STOP and wait for the developer to respond before continuing.

## Dev-Trio Multi-Agent Configuration

This workspace uses the Dev-Trio three-agent methodology. Subagent definitions
are in .codex/agents/. The Planner subagent (dt-planner) orchestrates all
development work, delegating to dt-implementer and dt-critic. Project memory is
in memory/MEMORY.md; full history is in _backup/Dev_Trio_Chat_Backup.md.

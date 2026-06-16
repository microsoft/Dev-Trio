<!-- dev-trio-claude-md -->
# Dev-Trio Agent Configuration

This workspace uses the Dev-Trio three-agent methodology.

- **dt-planner** — orchestrates all tasks, delegates to
  implementer and critic subagents
- **dt-implementer** — applies changes, runs gates
- **dt-critic** — audits changes, issues verdict

## Project memory
Project state: memory/MEMORY.md (rolling context).
Full history: _backup/Dev_Trio_Chat_Backup.md.

## Starting a session
Delegate all development tasks to dt-planner. It manages
the full Planner → Implementer → Critic loop automatically.

## Upgrading Dev-Trio
Type /dt-upgrade to upgrade this workspace.

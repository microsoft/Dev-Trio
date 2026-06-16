/dev-trio: Upgrade this workspace to Dev-Trio v1.1.0.

This workspace was set up with Dev-Trio v1.0.0. Run the steps below in order,
then report what changed. This upgrade only applies the v1.0.0 -> v1.1.0 delta
(per-role model selection for Claude Code and Codex); it does NOT re-run the
full v1.0.0 setup. Everything you need is in this prompt. Every step is
idempotent — running it twice is safe.

==================================================================
STEP A - Version check (stop early if already current)
==================================================================

Read .dev-trio/file-version.json. Parse its JSON and read the "version" field.

- If "version" is already "1.1.0": report "Already up to date — no changes
  needed." and STOP. Do not run any further steps.
- Otherwise (version is "1.0.0", missing, or anything else): continue with
  STEP B.

==================================================================
STEP B - Add the models block to .dev-trio/agent-config.json
==================================================================

Read .dev-trio/agent-config.json and parse it. v1.1.0 adds an optional "models"
block that records per-role model choices for Claude Code and Codex.

1. If the file has NO "models" field, add it with the current defaults:

```json
"models": {
  "claudeCode": {
    "planner": "claude-opus-4-8",
    "implementer": "claude-sonnet-4-6",
    "critic": "claude-sonnet-4-6"
  },
  "codex": {
    "planner": "gpt-5.5",
    "implementer": "gpt-5.4-mini",
    "critic": "gpt-5.4-mini"
  }
}
```

2. If the file ALREADY HAS a "models" field, preserve it exactly as-is — the
   developer may have customized it through the Dev-Trio UI. Do not overwrite it.
3. Update "setupVersion" to "1.1.0".
4. Preserve every other field (the "agents" block in particular) exactly as-is.
5. Write the merged JSON back.

NOTE - Model selection is normally managed through the Dev-Trio extension UI
(the Setup Wizard's agent step and the Update Project panel's Manage Agents
card). The defaults above are only applied when no models block exists yet.

==================================================================
STEP C - Claude Code agent files (only if they exist)
==================================================================

If the folder .claude/agents/ does not exist, skip this step and report skipped.

Otherwise, for each file below that exists, ensure its YAML frontmatter "model:"
line matches the value shown. If the file already has the correct value, make
no change. If the "models" block read in STEP B specified different per-role
values, use THOSE instead (the developer's choice wins).

- .claude/agents/dt-planner.md      -> model: claude-opus-4-8
- .claude/agents/dt-implementer.md  -> model: claude-sonnet-4-6
- .claude/agents/dt-critic.md       -> model: claude-sonnet-4-6

Change only the single "model:" line in the frontmatter. Do not alter any other
content in these files.

==================================================================
STEP D - Codex agent files (only if they exist)
==================================================================

If the folder .codex/agents/ does not exist, skip this step and report skipped.

Otherwise, for each file below that exists, ensure its TOML "model =" line
matches the value shown. If the file already has the correct value, make no
change. If the "models" block read in STEP B specified different per-role
values, use THOSE instead (the developer's choice wins).

- .codex/agents/dt-planner.toml      -> model = "gpt-5.5"
- .codex/agents/dt-implementer.toml  -> model = "gpt-5.4-mini"
- .codex/agents/dt-critic.toml       -> model = "gpt-5.4-mini"

Change only the single "model =" line. Do not alter any other content in these
files.

==================================================================
STEP E - Write .dev-trio/file-version.json
==================================================================

Create or overwrite .dev-trio/file-version.json with this exact content:

{"version":"1.1.0"}

This records that the workspace's scaffolded files are now at version 1.1.0.
The Dev-Trio extension compares this value to its own version to decide whether
the workspace still needs an upgrade; writing it here is what clears the
"upgrade available" indicator in the Update Project panel after this upgrade
completes.

==================================================================
STEP F - Report
==================================================================

For each step above, report what was found and what changed, or report
"already up to date" / "skipped" where applicable.

Include these explicit report lines:
- file-version.json (before): version found at STEP A
- agent-config.json: [models added | models preserved], setupVersion -> 1.1.0
- claude agent files: [updated | already current | skipped]
- codex agent files: [updated | already current | skipped]
- file-version.json (after): version 1.1.0
- upgrade-pending pill: will clear once the panel re-reads file-version.json

TASK COMPLETE

TIERS: T2[agent-config models block, Claude/Codex model lines]
T3[file-version.json version check + write, gated apply/skip decisions, final report]

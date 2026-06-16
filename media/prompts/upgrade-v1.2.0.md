/dev-trio: Upgrade this workspace to Dev-Trio v1.2.0.

This workspace was set up with Dev-Trio v1.1.0. Run the steps below in order,
then report what changed. This upgrade only applies the v1.1.0 -> v1.2.0 delta
(Refresh project files is now a direct extension action); it does NOT re-run the
full setup. Everything you need is in this prompt. Every step is idempotent —
running it twice is safe.

==================================================================
STEP A - Version check (stop early if already current)
==================================================================

Read .dev-trio/file-version.json. Parse its JSON and read the "version" field.

- If "version" is already "1.2.0": report "Already up to date — no changes
  needed." and STOP. Do not run any further steps.
- Otherwise (version is "1.1.0", missing, or anything else): continue with
  STEP B.

==================================================================
STEP B - Confirm the Dev-Trio extension is on v1.2.0
==================================================================

This upgrade records the workspace as v1.2.0, so the installed Dev-Trio
extension should be v1.2.0 first. Check the version shown at the bottom of the
Dev-Trio sidebar (or in the Extensions panel).

- If the extension is still v1.1.0 (or older): update it first. Download the
  latest dev-trio-1.2.0-marketplace.vsix from
  https://github.com/microsoft/Dev-Trio/releases and install it (Command
  Palette -> "Extensions: Install from VSIX…"), reload VS Code, then re-run
  this upgrade.
- If the extension is already v1.2.0: continue with STEP C.

This is a confirmation step — it changes no files.

==================================================================
STEP C - Update setupVersion in .dev-trio/agent-config.json
==================================================================

Read .dev-trio/agent-config.json and parse it.

1. Update "setupVersion" to "1.2.0".
2. Preserve every other field exactly as-is — the "agents" block and the entire
   "models" block in particular. The developer may have customized model choices
   through the Dev-Trio UI; do not overwrite them.
3. Write the merged JSON back.

NOTE - v1.2.0 adds no new agent-config fields. Only setupVersion changes here.

==================================================================
STEP D - What changed in v1.2.0 (informational — no file changes)
==================================================================

In v1.2.0, "Refresh project files" in the Update Project panel is now a direct
extension action. It no longer generates a prompt to copy and paste into
GitHub Copilot Chat.

To refresh your workspace scaffold files, open the Dev-Trio sidebar -> Update
Project -> "Refresh project files" and confirm when prompted. The extension
regenerates the scaffold files directly; each Category A file is backed up
automatically before any overwrite, your memory files are preserved, and your
notification and backup-log wiring is re-applied after the refresh.

This step makes no changes to any file — it is here so you know the refresh
workflow changed.

==================================================================
STEP E - Write .dev-trio/file-version.json
==================================================================

Create or overwrite .dev-trio/file-version.json with this exact content:

{"version":"1.2.0"}

This records that the workspace's scaffolded files are now at version 1.2.0.
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
- extension version: [v1.2.0 confirmed | user asked to update first]
- agent-config.json: setupVersion -> 1.2.0, all other fields preserved
- refresh workflow: noted (direct extension action — informational)
- file-version.json (after): version 1.2.0
- upgrade-pending pill: will clear once the panel re-reads file-version.json

TASK COMPLETE

TIERS: T2[agent-config.json setupVersion update]
T3[file-version.json version check + write, extension-version gate, final report]

import * as vscode from 'vscode';
import { probeWorkspace, type ProbeResult } from './workspaceProbe';
import { writeProvisionalMemory } from './provisionalMemory';
import { readAgentConfig, writeAgentConfig, type AgentConfig, type AgentModelConfig } from '../utils/agentDetection';

interface SkeletonFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * Writes the analysis-independent Dev-Trio skeleton files into the given workspace.
 *
 * Existing files are never overwritten: each target is probed with stat and, if it
 * already exists, recorded as "[skipped] <path>" instead of being written.
 *
 * @returns the relative paths of every target, prefixed with "[skipped] " when the
 *          file already existed and was left untouched.
 */
export async function generateSkeletonFiles(workspaceUri: vscode.Uri): Promise<string[]> {
  const files = SKELETON_FILES;
  const encoder = new TextEncoder();
  const results: string[] = [];

  for (const file of files) {
    const segments = file.relativePath.split('/');
    const targetUri = vscode.Uri.joinPath(workspaceUri, ...segments);

    if (await pathExists(targetUri)) {
      results.push(`[skipped] ${file.relativePath}`);
      continue;
    }

    const parentUri = vscode.Uri.joinPath(targetUri, '..');
    await vscode.workspace.fs.createDirectory(parentUri);
    await vscode.workspace.fs.writeFile(targetUri, encoder.encode(file.content));
    results.push(file.relativePath);
  }

  return results;
}

/**
 * Category A relative paths: structural/template files the extension owns. On regenerate these are
 * backed up (.bak) then overwritten with the latest template. AGENTS.md is included here because
 * its current template carries none of the DEV-TRIO merge markers, so Category C collapses to A.
 * Every skeleton file NOT listed here is Category B (project memory) and is preserved if present.
 */
const CATEGORY_A_PATHS: ReadonlySet<string> = new Set([
  'AGENTS.md',
  '.github/copilot-instructions.md',
  '.github/agents/planner.agent.md',
  '.github/agents/implementer.agent.md',
  '.github/agents/critic.agent.md',
  '.github/instructions/constraints.instructions.md',
  '.github/prompts/dev-trio.prompt.md'
]);

/**
 * Generates or refreshes the Dev-Trio skeleton files with a per-file strategy so users pick up
 * template improvements without losing live project data:
 *
 * - Missing file        -> created from template               ("[created] <path>")
 * - Category A, exists  -> backed up (.bak) then overwritten    ("[updated] <path>", or
 *                          "[backup-failed] <path>" when the backup write fails — the original
 *                          is then left untouched, never overwritten without a backup)
 * - Category B, exists  -> preserved untouched                  ("[preserved] <path>")
 *
 * Category A = structural/template files (agent files, instructions, prompt, copilot-instructions,
 * AGENTS.md). Category B = project memory (MEMORY/ROADMAP/PROMPT_EXAMPLES) the Planner authors.
 *
 * When memory/MEMORY.md is freshly created, its placeholder is replaced with a probe-seeded
 * provisional memory file. Each result line is "[status] <relative-path>" for the walkthrough UI.
 */
export async function generateDevTrioFiles(
  workspaceUri: vscode.Uri,
  probe?: ProbeResult,
  projectName?: string,
  extensionUri?: vscode.Uri,
  agentConfig?: AgentConfig
): Promise<string[]> {
  const encoder = new TextEncoder();
  const results: string[] = [];
  let memoryCreated = false;

  // Remove a stale DEV-TRIO-REMOVED.md (left by a prior uninstall-cleanup) before scaffolding,
  // so a reinstall never carries the removal notice into the fresh setup. Absent = normal case.
  const removedMarker = vscode.Uri.joinPath(workspaceUri, 'DEV-TRIO-REMOVED.md');
  try {
    await vscode.workspace.fs.delete(removedMarker);
  } catch {
    // File does not exist — the normal case. Silently continue.
  }

  // Effective agent selection. Undefined/null => GHCP-only (backward-compatible legacy behavior).
  const effectiveCfg: AgentConfig =
    agentConfig ?? { agents: { ghcp: true, claudeCode: false, codex: false }, setupVersion: CURRENT_FILE_VERSION };
  const wantGhcp = effectiveCfg.agents.ghcp;
  const wantClaude = effectiveCfg.agents.claudeCode;
  const wantCodex = effectiveCfg.agents.codex;

  // The 3 memory files are shared by every agent and are always written. GHCP structural files are
  // written when GHCP is selected; AGENTS.md is also written for Codex (Codex reads it natively).
  const sharedMemoryPaths = new Set(['memory/MEMORY.md', 'memory/ROADMAP.md', 'memory/PROMPT_EXAMPLES.md']);
  const selectedFiles = SKELETON_FILES.filter((f) => {
    if (sharedMemoryPaths.has(f.relativePath)) { return true; }
    if (wantGhcp) { return true; }
    if (wantCodex && f.relativePath === 'AGENTS.md') { return true; }
    return false;
  });

  for (const file of selectedFiles) {
    const segments = file.relativePath.split('/');
    const targetUri = vscode.Uri.joinPath(workspaceUri, ...segments);
    const parentUri = vscode.Uri.joinPath(targetUri, '..');

    if (!(await pathExists(targetUri))) {
      await vscode.workspace.fs.createDirectory(parentUri);
      await vscode.workspace.fs.writeFile(targetUri, encoder.encode(file.content));
      results.push(`[created] ${file.relativePath}`);
      if (file.relativePath === 'memory/MEMORY.md') {
        memoryCreated = true;
      }
      continue;
    }

    if (!CATEGORY_A_PATHS.has(file.relativePath)) {
      results.push(`[preserved] ${file.relativePath}`); // Category B — never overwrite
      continue;
    }

    // Category A — back up the existing file, then overwrite. Never overwrite without a backup.
    const fileName = segments[segments.length - 1];
    const backedUp = await backupExistingFile(targetUri, parentUri, fileName);
    if (!backedUp) {
      results.push(`[backup-failed] ${file.relativePath}`);
      continue;
    }
    await vscode.workspace.fs.writeFile(targetUri, encoder.encode(file.content));
    results.push(`[updated] ${file.relativePath}`);
  }

  if (memoryCreated) {
    const effectiveProbe = probe ?? (await probeWorkspace(workspaceUri));
    await writeProvisionalMemory(workspaceUri, effectiveProbe, projectName);
  }
  await writeFileVersion(workspaceUri);
  const constraintsDisplayUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR, CONSTRAINTS_DISPLAY_FILE);
  if (!(await pathExists(constraintsDisplayUri))) {
    await writeConstraintsDisplay(workspaceUri, DEFAULT_CONSTRAINTS_DISPLAY);
  }
  await writeAgentConfig(workspaceUri, effectiveCfg);
  if (wantClaude && extensionUri) {
    await writeClaudeFiles(workspaceUri, extensionUri, results, effectiveCfg.models?.claudeCode);
  }
  if (wantCodex && extensionUri) {
    await writeCodexFiles(workspaceUri, extensionUri, results, effectiveCfg.models?.codex);
  }
  await configureGitignore(workspaceUri, effectiveCfg);
  if (extensionUri) {
    await writeUpgradeCurrent(workspaceUri, extensionUri);
  }
  return results;
}

/** True when every skeleton file already exists in the workspace (used to auto-complete Step 1). */
export async function allSkeletonFilesExist(workspaceUri: vscode.Uri): Promise<boolean> {
  for (const file of SKELETON_FILES) {
    const segments = file.relativePath.split('/');
    if (!(await pathExists(vscode.Uri.joinPath(workspaceUri, ...segments)))) {
      return false;
    }
  }
  return true;
}

/**
 * True when at least one Category A (structural/template) file already exists in the workspace.
 * Used by the walkthrough to warn before a re-generate would overwrite those files (and require
 * re-wiring of notification/backup integrations).
 */
export async function categoryAFilesExist(workspaceUri: vscode.Uri): Promise<boolean> {
  for (const relativePath of CATEGORY_A_PATHS) {
    if (await pathExists(vscode.Uri.joinPath(workspaceUri, ...relativePath.split('/')))) {
      return true;
    }
  }
  return false;
}

const INITIALIZED_SENTINEL_DIR = '.dev-trio';
const INITIALIZED_SENTINEL_FILE = 'initialized';

/**
 * Writes the .dev-trio/initialized sentinel that marks the walkthrough as fully complete.
 *
 * Existence of THIS file — not the presence of skeleton files and not the MEMORY.md phase — is the
 * ground truth for "this workspace has finished the setup walkthrough". It is written only when the
 * user completes the final walkthrough step, so generating the skeleton files in Step 1 no longer
 * flips the surfaces to an initialized/active state.
 */
export async function writeInitializedSentinel(workspaceUri: vscode.Uri): Promise<void> {
  const dirUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(dirUri, INITIALIZED_SENTINEL_FILE);
  const body = `Dev-Trio walkthrough completed ${new Date().toISOString()}\n`;
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(body));
}

/** Ground truth for initialized state: the .dev-trio/initialized sentinel exists on disk. */
export async function isWorkspaceInitialized(workspaceUri: vscode.Uri): Promise<boolean> {
  return pathExists(
    vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR, INITIALIZED_SENTINEL_FILE)
  );
}

const WIZARD_PROGRESS_FILE = 'wizard-progress.json';

/** Per-workspace walkthrough progress, persisted in .dev-trio/wizard-progress.json. */
export interface WizardProgress {
  completedSteps: number[];
  lastUpdated: string;
}

/**
 * Writes .dev-trio/wizard-progress.json with the given completed step numbers so a partially
 * completed walkthrough can resume after VS Code is closed. Lives alongside the initialized
 * sentinel in .dev-trio/. Uses vscode.workspace.fs (consistent with the sentinel writer and
 * correct for workspace files) rather than Node fs.
 */
export async function writeWizardProgress(
  workspaceUri: vscode.Uri,
  completedSteps: number[]
): Promise<void> {
  const dirUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(dirUri, WIZARD_PROGRESS_FILE);
  const body: WizardProgress = { completedSteps, lastUpdated: new Date().toISOString() };
  await vscode.workspace.fs.writeFile(
    fileUri,
    new TextEncoder().encode(JSON.stringify(body, null, 2) + '\n')
  );
}

/** Reads .dev-trio/wizard-progress.json. Returns undefined when absent or malformed. */
export async function readWizardProgress(workspaceUri: vscode.Uri): Promise<WizardProgress | undefined> {
  const fileUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR, WIZARD_PROGRESS_FILE);
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<WizardProgress>;
    const completedSteps = Array.isArray(parsed.completedSteps)
      ? parsed.completedSteps.filter((n): n is number => typeof n === 'number')
      : [];
    return {
      completedSteps,
      lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : ''
    };
  } catch {
    return undefined;
  }
}

/** Deletes .dev-trio/wizard-progress.json if present (no-op otherwise). */
export async function deleteWizardProgress(workspaceUri: vscode.Uri): Promise<void> {
  await deleteIfExists(
    vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR, WIZARD_PROGRESS_FILE)
  );
}

/**
 * Appends `.dev-trio/wizard-progress.json` to .gitignore when a .gitignore exists and does not
 * already cover it. Never creates a .gitignore; idempotent (checks before appending).
 */
export async function ensureWizardProgressGitignored(workspaceUri: vscode.Uri): Promise<void> {
  const gitignoreUri = vscode.Uri.joinPath(workspaceUri, '.gitignore');
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignoreUri));
  } catch {
    return; // no .gitignore in this workspace — do not create one
  }
  const entry = '.dev-trio/wizard-progress.json';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes('.dev-trio/') || lines.includes('.dev-trio')) {
    return; // already ignored
  }
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  await vscode.workspace.fs.writeFile(
    gitignoreUri,
    new TextEncoder().encode(text + separator + entry + '\n')
  );
}

/** Marker comment line for the current Dev-Trio .gitignore section (idempotency key). */
const GITIGNORE_MARKER = '# Dev-Trio scaffolded files';

/** Legacy marker from earlier builds; existing workspaces with this block are migrated in place. */
const GITIGNORE_OLD_MARKER = '# Dev-Trio per-developer state';

/** The exact known entries of the legacy '# Dev-Trio per-developer state' block, for in-place replacement. */
const OLD_GITIGNORE_ENTRIES: ReadonlySet<string> = new Set([
  'memory/MEMORY.md',
  'memory/ROADMAP.md',
  'memory/PROMPT_EXAMPLES.md',
  '.dev-trio/',
  '.dev-trio/wizard-progress.json'
]);

/**
 * Removes a legacy Dev-Trio '# Dev-Trio per-developer state' block (the marker line plus its
 * contiguous known entries) from .gitignore text, preserving all surrounding content. One trailing
 * blank separator line left behind by the block is also dropped.
 */
function stripOldDevTrioBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith(GITIGNORE_OLD_MARKER)) {
      i++; // drop the old marker line
      while (i < lines.length && OLD_GITIGNORE_ENTRIES.has(lines[i].trim())) {
        i++; // drop each contiguous known legacy entry
      }
      if (i < lines.length && lines[i].trim() === '') {
        i++; // drop one trailing blank separator
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/** Per-agent .gitignore blocks (comment header + entries, no trailing blank line). Shared by the
 *  fresh-write path and the incremental-merge path so the two can never drift. */
const GHCP_GITIGNORE_BLOCK =
  '# Agent role definitions (GitHub Copilot)\n' +
  'copilot-instructions.md\n' +
  '.github/agents/\n' +
  'constraints.instructions.md\n' +
  'dev-trio.prompt.md\n';
const CLAUDE_GITIGNORE_BLOCK =
  '# Agent role definitions (Claude Code)\n' +
  '.claude/agents/\n' +
  '.claude/commands/dt-upgrade.md\n';
const CODEX_GITIGNORE_BLOCK =
  '# Agent role definitions (Codex)\n' +
  '.codex/agents/\n';

/** Comment line that opens the per-developer-memory portion of the Dev-Trio .gitignore section.
 *  Used as the insertion anchor when merging a missing agent block into an existing section. */
const GITIGNORE_MEMORY_ANCHOR = '# Per-developer project memory (always keep ignored)';

/**
 * Returns `text` with each configured-agent per-agent block that is NOT already present inserted
 * immediately before the per-developer-memory anchor (or appended to the end when that anchor is
 * absent). Strictly additive — never reorders or removes existing lines. Pure (no I/O).
 */
function addMissingAgentGitignoreBlocks(text: string, cfg: AgentConfig): string {
  const additions: string[] = [];
  if (cfg.agents.ghcp && !text.includes('# Agent role definitions (GitHub Copilot)')) {
    additions.push(GHCP_GITIGNORE_BLOCK);
  }
  if (cfg.agents.claudeCode && !text.includes('# Agent role definitions (Claude Code)')) {
    additions.push(CLAUDE_GITIGNORE_BLOCK);
  }
  if (cfg.agents.codex && !text.includes('# Agent role definitions (Codex)')) {
    additions.push(CODEX_GITIGNORE_BLOCK);
  }
  if (additions.length === 0) {
    return text;
  }
  const insertion = additions.map((b) => b + '\n').join('');
  const anchorIdx = text.indexOf(GITIGNORE_MEMORY_ANCHOR);
  if (anchorIdx === -1) {
    const sep = text.endsWith('\n') ? '' : '\n';
    return text + sep + '\n' + insertion.replace(/\n+$/, '\n');
  }
  return text.slice(0, anchorIdx) + insertion + text.slice(anchorIdx);
}

/**
 * Best-effort: ensures the workspace .gitignore contains the Dev-Trio scaffolded-files section so a
 * developer's generated Dev-Trio configuration is ignored by default — the agent role definitions,
 * the per-developer project memory, and the .dev-trio/ internal state. Additive and idempotent —
 * keyed on the marker line, so running setup twice never duplicates the block. Workspaces that still
 * carry the legacy '# Dev-Trio per-developer state' block are migrated in place (the old block is
 * replaced with the new one). Creates .gitignore if absent. Never throws: a gitignore failure is
 * logged and swallowed (this is a convenience, not a required setup step). Teams that prefer to share
 * the agent config across the repo can delete the agent-role entries from the generated block (a
 * comment in the block points this out); the per-developer memory + .dev-trio/ state stay ignored.
 */
export async function configureGitignore(
  workspaceUri: vscode.Uri,
  agentConfig?: AgentConfig,
  log?: vscode.OutputChannel
): Promise<void> {
  try {
    const gitignoreUri = vscode.Uri.joinPath(workspaceUri, '.gitignore');
    const cfg: AgentConfig =
      agentConfig ?? (await readAgentConfig(workspaceUri)) ??
      { agents: { ghcp: true, claudeCode: false, codex: false }, setupVersion: CURRENT_FILE_VERSION };
    // AGENTS.md is intentionally NOT ignored — it is shared with Codex and committed.
    let section =
      GITIGNORE_MARKER + '\n' +
      '# Remove entries below if your team wants to share\n' +
      '# these configurations across the repo.\n' +
      '\n';
    if (cfg.agents.ghcp) { section += GHCP_GITIGNORE_BLOCK + '\n'; }
    if (cfg.agents.claudeCode) { section += CLAUDE_GITIGNORE_BLOCK + '\n'; }
    if (cfg.agents.codex) { section += CODEX_GITIGNORE_BLOCK + '\n'; }
    section +=
      GITIGNORE_MEMORY_ANCHOR + '\n' +
      'memory/MEMORY.md\n' +
      'memory/ROADMAP.md\n' +
      'memory/PROMPT_EXAMPLES.md\n' +
      '\n' +
      '# Dev-Trio internal state\n' +
      '.dev-trio/\n';

    let existed = true;
    let text = '';
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignoreUri));
    } catch {
      existed = false; // no .gitignore yet — create one containing only the Dev-Trio section
    }

    if (text.includes(GITIGNORE_MARKER)) {
      // Section already present. Additively insert any per-agent block that is missing — e.g. when an
      // agent is added post-setup via the Update Project "Manage agents" card. Never reorders/removes.
      const mergedText = addMissingAgentGitignoreBlocks(text, cfg);
      if (mergedText !== text) {
        await vscode.workspace.fs.writeFile(gitignoreUri, new TextEncoder().encode(mergedText));
        log?.appendLine('[gitignore] Added missing agent block(s) to the existing Dev-Trio section');
      } else {
        log?.appendLine('[gitignore] Dev-Trio scaffolded-files section already present');
      }
      return;
    }

    let replacedOld = false;
    if (text.includes(GITIGNORE_OLD_MARKER)) {
      text = stripOldDevTrioBlock(text);
      replacedOld = true;
    }

    // Drop trailing blank lines so the appended section is separated by exactly one blank line.
    const trimmedLines = text.split('\n');
    while (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1].trim() === '') {
      trimmedLines.pop();
    }
    const base = trimmedLines.join('\n');
    const next = base.length === 0 ? section : base + '\n\n' + section;

    await vscode.workspace.fs.writeFile(gitignoreUri, new TextEncoder().encode(next));
    log?.appendLine(
      replacedOld
        ? '[gitignore] Replaced legacy Dev-Trio block with scaffolded-files section'
        : existed
          ? '[gitignore] Appended Dev-Trio scaffolded-files section to .gitignore'
          : '[gitignore] Created .gitignore with Dev-Trio scaffolded-files section'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.appendLine('[gitignore] failed to configure .gitignore — ' + message);
  }
}

export const CURRENT_FILE_VERSION = '1.2.0';
// This constant must be manually updated with each extension release to match the
// new version number in package.json. It represents the version of agent file
// templates shipped with this build.

const FILE_VERSION_FILE = 'file-version.json';

export async function writeFileVersion(workspaceUri: vscode.Uri): Promise<void> {
  const dirUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(dirUri, FILE_VERSION_FILE);
  const body = { version: CURRENT_FILE_VERSION, updatedAt: new Date().toISOString() };
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(body, null, 2) + '\n'));
}

const UPGRADE_CURRENT_FILE = 'upgrade-current.md';

/**
 * Writes .dev-trio/upgrade-current.md: the shipped upgrade prompt for the current version with a
 * version-stamp comment on line 1, loaded from the bundled media/prompts/upgrade-v{version}.md
 * asset. Best-effort — on any read failure the file is left untouched (no broken write).
 */
export async function writeUpgradeCurrent(workspaceUri: vscode.Uri, extensionUri: vscode.Uri): Promise<void> {
  const assetUri = vscode.Uri.joinPath(extensionUri, 'media', 'prompts', 'upgrade-v' + CURRENT_FILE_VERSION + '.md');
  let content: string;
  try {
    content = new TextDecoder().decode(await vscode.workspace.fs.readFile(assetUri));
  } catch {
    return;
  }
  const stamp = '<!-- dev-trio-upgrade-version: ' + CURRENT_FILE_VERSION + ' -->\n';
  const dirUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(dirUri, UPGRADE_CURRENT_FILE);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(stamp + content));
}

/** Reads a scaffold template asset from media/scaffold/. Returns null on any read failure. */
async function readScaffoldAsset(extensionUri: vscode.Uri, ...segments: string[]): Promise<string | null> {
  try {
    const uri = vscode.Uri.joinPath(extensionUri, 'media', 'scaffold', ...segments);
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}

/** Writes a scaffold file only when absent (create-or-preserve); records the result line. */
async function writeScaffoldIfAbsent(
  workspaceUri: vscode.Uri,
  relSegments: string[],
  content: string,
  results: string[]
): Promise<void> {
  const rel = relSegments.join('/');
  const targetUri = vscode.Uri.joinPath(workspaceUri, ...relSegments);
  if (await pathExists(targetUri)) {
    results.push(`[preserved] ${rel}`);
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetUri, '..'));
  await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(content));
  results.push(`[created] ${rel}`);
}

const CLAUDE_MD_MARKER = '<!-- dev-trio-claude-md -->';

/** Maps a subagent scaffold asset filename to its dev-trio role, or null when it carries no model. */
function roleForAsset(asset: string): keyof AgentModelConfig | null {
  if (asset.startsWith('dt-planner')) { return 'planner'; }
  if (asset.startsWith('dt-implementer')) { return 'implementer'; }
  if (asset.startsWith('dt-critic')) { return 'critic'; }
  return null;
}

/** Applies a Claude Code model override by replacing the frontmatter `model:` line. No-op when unset. */
function applyClaudeModel(content: string, override: string | undefined): string {
  if (!override) { return content; }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('model:')) {
      lines[i] = 'model: ' + override;
      break;
    }
  }
  return lines.join('\n');
}

/** Applies a Codex model override by replacing the top-level `model =` line. No-op when unset. */
function applyCodexModel(content: string, override: string | undefined): string {
  if (!override) { return content; }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('model =')) {
      lines[i] = 'model = "' + override + '"';
      break;
    }
  }
  return lines.join('\n');
}

/**
 * Force-rewrites the three subagent scaffold files for one agent ecosystem with updated per-role
 * model overrides applied. Used by the Manage Agents "edit models" flow — overwrites existing files
 * (unlike the create-or-preserve scaffold path) so a model change actually lands. Only rewrites files
 * that already exist (the agent must be configured); never creates files here.
 */
export async function regenerateAgentModelFiles(
  workspaceUri: vscode.Uri,
  extensionUri: vscode.Uri,
  agent: 'claudeCode' | 'codex',
  models: AgentModelConfig
): Promise<void> {
  const enc = new TextEncoder();
  const sub = agent === 'claudeCode' ? 'claude' : 'codex';
  const ext = agent === 'claudeCode' ? 'md' : 'toml';
  const destDir = agent === 'claudeCode' ? ['.claude', 'agents'] : ['.codex', 'agents'];
  const apply = agent === 'claudeCode' ? applyClaudeModel : applyCodexModel;
  for (const role of ['planner', 'implementer', 'critic'] as const) {
    const asset = 'dt-' + role + '.' + ext;
    let content = await readScaffoldAsset(extensionUri, sub, asset);
    if (content === null) { continue; }
    content = apply(content, models[role]);
    const targetUri = vscode.Uri.joinPath(workspaceUri, ...destDir, asset);
    if (await pathExists(targetUri)) {
      await vscode.workspace.fs.writeFile(targetUri, enc.encode(content));
    }
  }
}

/** Writes the Claude Code scaffold: the three subagent files, the upgrade command, and CLAUDE.md. */
async function writeClaudeFiles(workspaceUri: vscode.Uri, extensionUri: vscode.Uri, results: string[], models?: AgentModelConfig): Promise<void> {
  const files: ReadonlyArray<[string, string[]]> = [
    ['dt-planner.md', ['.claude', 'agents', 'dt-planner.md']],
    ['dt-implementer.md', ['.claude', 'agents', 'dt-implementer.md']],
    ['dt-critic.md', ['.claude', 'agents', 'dt-critic.md']],
    ['dt-upgrade.md', ['.claude', 'commands', 'dt-upgrade.md']]
  ];
  for (const [asset, dest] of files) {
    let content = await readScaffoldAsset(extensionUri, 'claude', asset);
    if (content === null) { results.push(`[skipped-no-asset] ${dest.join('/')}`); continue; }
    const role = roleForAsset(asset);
    if (role && models) { content = applyClaudeModel(content, models[role]); }
    await writeScaffoldIfAbsent(workspaceUri, dest, content, results);
  }
  const claudeMd = await readScaffoldAsset(extensionUri, 'claude', 'CLAUDE.md');
  if (claudeMd === null) { return; }
  const uri = vscode.Uri.joinPath(workspaceUri, 'CLAUDE.md');
  let existing: string | null = null;
  try { existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { existing = null; }
  if (existing === null) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(claudeMd));
    results.push('[created] CLAUDE.md');
  } else if (existing.includes(CLAUDE_MD_MARKER)) {
    results.push('[preserved] CLAUDE.md');
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(existing + sep + claudeMd));
    results.push('[merged] CLAUDE.md');
  }
}

const AGENTS_CODEX_MARKER = 'Dev-Trio Multi-Agent';

/**
 * Writes the Codex scaffold: the three subagent .toml files, config.toml (skipped if already
 * present — never overwrites the user's Codex config), and the Codex section appended to the shared
 * AGENTS.md (idempotent on the AGENTS_CODEX_MARKER text).
 */
async function writeCodexFiles(workspaceUri: vscode.Uri, extensionUri: vscode.Uri, results: string[], models?: AgentModelConfig): Promise<void> {
  const files: ReadonlyArray<[string, string[]]> = [
    ['dt-planner.toml', ['.codex', 'agents', 'dt-planner.toml']],
    ['dt-implementer.toml', ['.codex', 'agents', 'dt-implementer.toml']],
    ['dt-critic.toml', ['.codex', 'agents', 'dt-critic.toml']]
  ];
  for (const [asset, dest] of files) {
    let content = await readScaffoldAsset(extensionUri, 'codex', asset);
    if (content === null) { results.push(`[skipped-no-asset] ${dest.join('/')}`); continue; }
    const role = roleForAsset(asset);
    if (role && models) { content = applyCodexModel(content, models[role]); }
    await writeScaffoldIfAbsent(workspaceUri, dest, content, results);
  }
  const configToml = await readScaffoldAsset(extensionUri, 'codex', 'config.toml');
  if (configToml !== null) {
    const cfgUri = vscode.Uri.joinPath(workspaceUri, '.codex', 'config.toml');
    if (await pathExists(cfgUri)) {
      results.push('[skipped] .codex/config.toml');
    } else {
      await writeScaffoldIfAbsent(workspaceUri, ['.codex', 'config.toml'], configToml, results);
    }
  }
  const section = await readScaffoldAsset(extensionUri, 'agents-codex-section.md');
  if (section === null) { return; }
  const agentsUri = vscode.Uri.joinPath(workspaceUri, 'AGENTS.md');
  let existing: string | null = null;
  try { existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(agentsUri)); } catch { existing = null; }
  if (existing === null) {
    await vscode.workspace.fs.writeFile(agentsUri, new TextEncoder().encode(section));
    results.push('[created] AGENTS.md (Codex section)');
  } else if (existing.includes(AGENTS_CODEX_MARKER)) {
    results.push('[preserved] AGENTS.md (Codex section present)');
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    await vscode.workspace.fs.writeFile(agentsUri, new TextEncoder().encode(existing + sep + section));
    results.push('[merged] AGENTS.md (Codex section)');
  }
}

export async function readFileVersion(workspaceUri: vscode.Uri): Promise<string | null> {
  const fileUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR, FILE_VERSION_FILE);
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

const CONSTRAINTS_DISPLAY_FILE = 'constraints-display.json';

export interface ConstraintDisplay {
  id: number;
  name: string;
  description: string;
  category: 'security' | 'architecture' | 'quality' | 'workflow';
  severity: 'hard' | 'advisory';
}

export async function writeConstraintsDisplay(
  workspaceUri: vscode.Uri,
  constraints: ConstraintDisplay[]
): Promise<void> {
  const dirUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(dirUri, CONSTRAINTS_DISPLAY_FILE);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(constraints, null, 2) + '\n'));
}

export async function readConstraintsDisplay(workspaceUri: vscode.Uri): Promise<ConstraintDisplay[]> {
  const fileUri = vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR, CONSTRAINTS_DISPLAY_FILE);
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(parsed) ? (parsed as ConstraintDisplay[]) : [];
  } catch {
    return [];
  }
}

export async function readConstraintsInstructions(workspaceUri: vscode.Uri): Promise<ConstraintDisplay[]> {
  const uri = vscode.Uri.joinPath(workspaceUri, '.github', 'instructions', 'constraints.instructions.md');
  let text: string;
  try { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); }
  catch { return []; }
  const out: ConstraintDisplay[] = [];
  for (const rawLine of text.split('\n')) {
    const m = /^(\d+)\.\s+(.*\S)\s*$/.exec(rawLine.trim());
    if (!m) { continue; }
    const id = parseInt(m[1], 10);
    const full = m[2].trim();
    out.push({ id, name: full.length > 50 ? full.slice(0, 50) : full, description: full, category: 'workflow', severity: 'hard' });
  }
  return out;
}

const DEFAULT_CONSTRAINTS_DISPLAY: ConstraintDisplay[] = [
  { id: 1, name: 'Keep secrets out of code', description: 'Passwords, API keys, and tokens must never appear in your source files, logs, or reports.', category: 'security', severity: 'hard' },
  { id: 2, name: 'No silent workarounds', description: 'If something goes wrong, the team stops and tells you — it never quietly patches around a problem.', category: 'workflow', severity: 'hard' },
  { id: 3, name: 'Every change gets a plan', description: 'Before writing any code, the team writes out exactly what they will do and why. No surprises.', category: 'workflow', severity: 'hard' },
  { id: 4, name: 'Test before moving on', description: 'The team verifies their work actually works before calling it done.', category: 'quality', severity: 'hard' },
  { id: 5, name: "Use the project's own terms", description: "The team uses your project's defined names consistently — nothing gets renamed without your input.", category: 'architecture', severity: 'hard' },
  { id: 6, name: 'Ship production quality', description: 'Everything the team builds is ready for real users — no half-finished features or shortcuts.', category: 'quality', severity: 'hard' },
  { id: 7, name: 'No git operations without permission', description: 'The team will never commit, push, or branch your code without you explicitly asking.', category: 'workflow', severity: 'hard' }
];

/**
 * Removes all Dev-Trio setup artifacts from the workspace: the wizard-progress file, the
 * initialized sentinel, and the generated skeleton files (each only if present). Used by the
 * sidebar "Reset setup wizard" action so the workspace returns to a clean, uninitialized state.
 *
 * Two-phase for safety: every existing skeleton file is backed up (.bak) FIRST; if any backup
 * fails the function throws before deleting anything, so a failed reset never loses a file.
 */
export async function resetWorkspaceSetup(workspaceUri: vscode.Uri): Promise<void> {
  // Phase 1: back up every existing skeleton file first. If any backup fails, abort before any
  // delete so the workspace is left intact ("No files were deleted").
  for (const file of SKELETON_FILES) {
    const segments = file.relativePath.split('/');
    const targetUri = vscode.Uri.joinPath(workspaceUri, ...segments);
    const parentUri = vscode.Uri.joinPath(targetUri, '..');
    if (await pathExists(targetUri)) {
      const fileName = segments[segments.length - 1];
      const backedUp = await backupExistingFile(targetUri, parentUri, fileName);
      if (!backedUp) {
        throw new Error(`Reset aborted — could not create backup for ${file.relativePath}. No files were deleted.`);
      }
    }
  }
  // Phase 2: now delete the ephemeral state + the (backed-up) skeleton files.
  await deleteWizardProgress(workspaceUri);
  await deleteIfExists(
    vscode.Uri.joinPath(workspaceUri, INITIALIZED_SENTINEL_DIR, INITIALIZED_SENTINEL_FILE)
  );
  for (const file of SKELETON_FILES) {
    const segments = file.relativePath.split('/');
    await deleteIfExists(vscode.Uri.joinPath(workspaceUri, ...segments));
  }
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // not present — nothing to delete
  }
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Compact UTC timestamp YYYYMMDDTHHmmssZ (e.g. 20260608T143022Z) for backup filenames. */
export function utcBackupStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Copies an existing file to "<name>.<UTC-stamp>.bak" in the same directory before it is
 * overwritten. The .bak extension keeps the backup out of Copilot Chat's view. Returns true on
 * success; false when the backup could not be written — the caller must then skip the overwrite so
 * the original is never lost.
 */
async function backupExistingFile(
  targetUri: vscode.Uri,
  parentUri: vscode.Uri,
  fileName: string
): Promise<boolean> {
  try {
    const existing = await vscode.workspace.fs.readFile(targetUri);
    const backupUri = vscode.Uri.joinPath(parentUri, `${fileName}.${utcBackupStamp(new Date())}.bak`);
    await vscode.workspace.fs.writeFile(backupUri, existing);
    return true;
  } catch {
    return false;
  }
}

const AGENTS_GUARDRAILS = `# [Project Name] — Agent Guardrails

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

Command: pwsh -NoProfile -File "%LOCALAPPDATA%\\Dev-Trio\\notify.ps1" -Message "your message"

Note: notify.ps1 is written to your user profile at
%LOCALAPPDATA%\\Dev-Trio\\notify.ps1 during notification setup.
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
`;

const COPILOT_INSTRUCTIONS = `# [Project Name] — Global Copilot Instructions

This project uses a dev-trio agent architecture: planner, implementer, critic.

## Project context — three files (read MEMORY and ROADMAP every session)
- memory/MEMORY.md — project state, constraints, build status, slice history
- memory/ROADMAP.md — phase sequence, acceptance criteria, planner principles
- memory/PROMPT_EXAMPLES.md — full example prompts (read when writing a new
  phase's first prompt)

Read MEMORY.md and ROADMAP.md completely before any work begins.
Read PROMPT_EXAMPLES.md when you need to calibrate prompt quality.

## Key rules (all agents)
- Never run git unless the developer explicitly directs
- Never silently fix-forward during validation phases
- Respect all binding architectural constraints in memory/MEMORY.md
- Use targeted validation by default, not full regression
- Terminology is binding — use the project's defined terms exactly as written
  in memory/MEMORY.md

## Project structure
[TO BE FILLED DURING INITIALIZATION — replace with real directory layout]

## Memory/state files
- memory/MEMORY.md — project state and constraints
- memory/ROADMAP.md — phase plan and acceptance criteria
- Phase reports: _temp/
- Backup log: _backup/Dev_Trio_Chat_Backup.md

## Production notes
[TO BE FILLED DURING INITIALIZATION — any production-specific rules,
deployment constraints, or runtime notes the agents must know.]
`;

const PLANNER_AGENT = `---
name: planner
description: Plans work and orchestrates the dev-trio across phases
tools:
  - agent
  - read
  - search
  - grep
  - glob
  - shell
---
You are the planner and orchestrator for this project's dev-trio.

## FIRST ACTION EVERY SESSION
Before doing ANY work, read BOTH:
- memory/MEMORY.md (project state, constraints, build status)
- memory/ROADMAP.md (phase sequence, acceptance criteria, planner principles)

Do not plan or delegate until you have read both files completely.
When writing your first prompt for a new phase, also read memory/PROMPT_EXAMPLES.md.

## YOUR ROLE
You replace the human planner that previously wrote structured implementation
prompts. You must match that level of rigor. Read the project roadmap, write
detailed implementation prompts, delegate to subagents, evaluate results,
close out phases when acceptance criteria are met, and advance to the next
phase — all autonomously.

## PROMPT TIERS — CLASSIFY BEFORE ANY ACTION
Classify every incoming prompt into one tier and state the tier explicitly at
the top of your response before doing anything else. A prompt may contain
several changes; label each change with its tier and process it at that tier's
depth. Run only the highest tier's gates, once, at the end.

TIER 1 — Structural (full process): TypeScript or code changes, algorithm or
logic fixes, anything affecting compilation or the test harnesses, new
features. Read the affected files in full, extract the exact line ranges and
anchor lines, and delegate only those excerpts to the implementer (the
implementer does NOT re-read full files). Independently re-derive every
critical-evidence value. The critic reads the changed regions plus gate output
for a full three-source sign-off.

TIER 2 — Content (abbreviated): Markdown, string literals in templates,
text-only CSS, prompt files, README, documentation. Read only the affected
file, extract the exact region, and delegate that region to the implementer
(no re-read). The critic spot-checks the changed text by grep plus one gate
run. No independent planner re-derivation unless a test harness is affected.

TIER 3 — Mechanical (planner-only, no loop): packaging, reinstall, cleanup,
.vsix inspection, MEMORY.md close-out updates, git operations the developer
explicitly requested. Confirm preconditions, run the operations yourself, and
confirm the result. No implementer or critic pass.

TARGETED EXCERPT PROTOCOL (Tier 1 and Tier 2): read files completely, then hand
the implementer the exact line range(s), the anchor lines above and below for
the edit, and the precise replacement content. The implementer edits from that
excerpt and self-checks only the changed region.

## BUILT-IN COMMANDS

Some short prompts are recognized as built-in commands rather than tasks. A
prompt is a built-in command ONLY if it contains no additional task
description after the command phrase.

Recognized upgrade triggers (case-insensitive, trim whitespace before
matching):
  /dev-trio: upgrade
  /dev-trio: upgrade dev-trio
  /dev-trio: update dev-trio
  /dev-trio: check for updates

"/dev-trio: upgrade my database schema" is NOT a built-in command — it has
task content after the command word. Process it normally as a task.

UPGRADE COMMAND behavior (Tier 3):
1. Check for .dev-trio/upgrade-current.md in the workspace root.
2. If EXISTS: read the version stamp on line 1 (format:
   dev-trio-upgrade-version: X.X.X). Read package.json "version" field. If
   versions match and a quick scan shows no meaningful changes are needed
   (gitignore marker current, sentinel present, agent files have BUILT-IN
   COMMANDS), report "Already up to date — no changes needed." and stop. If
   versions differ or any step finds a real change to apply, execute every
   step in the file exactly as written and report each step's result.
3. If NOT FOUND: respond exactly:
   "Run Update Project from the Dev-Trio sidebar first, then use the upgrade
   command again."
4. No confirmation needed before running.

## AUTONOMOUS MULTI-PHASE LOOP
When the developer says "pick up where we left off" or gives a task:

1. Identify from MEMORY.md and ROADMAP.md:
   - Current active phase
   - Current step within that phase
   - Entry conditions (are they met?)
   - What work remains
   - Acceptance criteria for closing this phase

2. If the phase requires developer manual action:
   - Run any autonomous pre-checks you can
   - Write clear numbered manual instructions for the developer
   - Send notification with DECISION NEEDED
   - STOP and wait

3. If the phase is autonomous:
   a. Write a complete implementation prompt using EXACTLY:
      CONTEXT / ASSUMPTIONS / PLAN / KNOWN RISKS / AUDIT INSTRUCTION
   b. Delegate to implementer via agent tool. Wait for result.
   c. CRITICAL EVIDENCE RE-DERIVATION (before critic):
      Independently re-derive every critical-evidence value listed in
      AGENTS.md using your own shell. Record your independently verified
      values.
   d. Delegate to critic via agent tool. Include in your delegation:
      - The implementer's full report
      - Paths to the implementer's raw evidence files
      - Your own independently verified critical-evidence values
      Wait for result.
   e. Evaluate:
      - Step done, more steps remain: next prompt, delegate again. No stop.
      - Phase complete: run validation, write report, update MEMORY.md, advance.
      - Fixable error: write fix prompt, delegate again. No stop.
      - Unfixable error: log, notify developer, stop.
      - Decision needed: log, notify developer, stop.
      - Evidence mismatch flagged by critic: treat as ERROR. Do not proceed.

4. When advancing to the next phase:
   - Check entry conditions
   - If manual action needed, prepare and notify
   - If autonomous, begin immediately

## MANDATORY DELEGATION
Use the agent tool for ALL implementation (implementer) and ALL audit (critic).
You are FORBIDDEN from editing files, writing code, or auditing constraints.

## I/O RESPONSIBILITIES (planner only)
After the loop ends:
a. LOG all cycles to _backup/Dev_Trio_Chat_Backup.md
b. Send notification
c. Update memory/MEMORY.md
d. End response with: Continue to the next task, or stop here?

## NOTIFICATION
pwsh -NoProfile -File "\${workspaceFolder}/notify.ps1" -Message "your message"
Only on: TASK COMPLETE, ERROR, or DECISION NEEDED.
If notify.ps1 does not exist, skip and note in the log. Do not error.

## WHAT NEEDS THE DEVELOPER
Stop: constraint violation, manual action required, architectural ambiguity,
dead end, evidence mismatch.
Fix yourself: build errors, missing imports, type errors, test failures,
syntax errors, linting issues.
`;

const IMPLEMENTER_AGENT = `---
name: implementer
description: Implements code changes, runs builds and tests
tools:
  - read
  - edit
  - write
  - search
  - grep
  - glob
  - shell
---
You are the implementer.

## TIERED INPUT
The planner hands you a targeted excerpt: the exact line range(s), the anchor
lines, and the replacement content. Work from that excerpt — do NOT re-read the
full file. Make the edit, run the gates the plan specifies, and self-check only
the changed region.

When you receive a prompt:
1. FIRST audit the plan against all binding constraints in memory/MEMORY.md.
2. If ANY constraint is at risk — STOP and report the violation.
3. If clean — implement directly in the solution files.
4. Run builds and tests as specified in the plan.
5. Report exactly what changed (files, lines, behavior).

## Critical Evidence Files
For any step involving critical-evidence checks (defined in AGENTS.md),
you MUST write raw command output to a machine-readable evidence file
under _temp/ for the current phase directory:

Evidence file naming: evidence__.log
Reference each evidence file path in your implementation report.
These files must contain actual command output — never prose summaries.

## Hard rules
Never run git unless the developer explicitly directs.
Never silently fix-forward during validation phases.

Do NOT log to the backup file. Do NOT send notifications.
Do NOT ask the developer questions. The planner handles all I/O after
you return.
`;

const CRITIC_AGENT = `---
name: critic
description: Audits implementer output against project binding constraints
tools:
  - read
  - search
  - grep
  - glob
---
You are the critic.

## TIERED REVIEW
For Tier 1 (structural) review the changed regions the planner sends plus the
gate exit codes and grep results; read a changed region directly only if
needed; do not re-read full files. For Tier 2 (content) verify the changed text
before and after by grep plus one gate run; do not read source files. Always
run the three-source cross-check for critical-evidence claims.

After reviewing the implementer output:
1. Review every change against ALL binding constraints in memory/MEMORY.md.
2. Review against v1-completeness requirements.
3. For critical-evidence claims, cross-check THREE sources:
   a. The implementer's prose report
   b. The implementer's raw evidence file(s) — read them directly
   c. The planner's independently verified values (provided in your delegation)
   If ANY mismatch exists between these three sources, report it as a hard stop
   even if the final values appear correct. A mismatch means the verification
   chain is broken.
4. If ANY constraint violation — report it as a hard stop. Do not approve
   fix-forward.
5. If clean — confirm and summarize what was done, including evidence
   verification results.
6. State whether the result is DONE, ERROR, or DECISION NEEDED.

Critical-evidence claims require three-source verification as defined in
AGENTS.md. For non-critical claims (UI changes, file edits, code behavior),
the implementer's report is sufficient — audit those against binding
constraints as usual.

## Hard rules
Never run git unless the developer explicitly directs.

Do NOT log to the backup file. Do NOT send notifications.
Do NOT ask the developer questions. The planner handles all I/O after
you return.
`;

const CONSTRAINTS_INSTRUCTIONS = `---
applyTo: "**"
---
# [Project Name] — Binding Architectural Constraints

Before writing ANY implementation code, evaluate the plan against these
constraints. If the plan violates any constraint, surface the conflict
to the developer instead of writing code. See memory/MEMORY.md for the
full authoritative constraint list with details.

[TO BE FILLED DURING INITIALIZATION — the planner will derive and write
the binding constraints for this specific project during the first
dev-trio session. Until then, the universal constraints below apply.]

## Universal constraints (always apply, every project)

1. Never run git operations unless the developer explicitly directs.
2. Never silently fix-forward during validation phases.
3. Never hardcode secrets, tokens, credentials, or environment-specific
   values in source files.
4. Every implementation prompt must use the structured format:
   CONTEXT / ASSUMPTIONS / PLAN / KNOWN RISKS / AUDIT INSTRUCTION
5. Targeted validation by default — do not run full regression for
   every change unless the change warrants it.
6. Use the project's defined terminology exactly as written in
   memory/MEMORY.md — never rename or reframe established terms.
7. v1 must be production-ready — do not ship amputated features or
   internal-only builds that differ architecturally from production.
`;

const DEV_TRIO_PROMPT = `---
name: dev-trio
description: Run the dev-trio plan-implement-audit loop
agent: planner
argument-hint: Describe the task, or say "pick up where we left off"
---
STOP. Before doing ANYTHING else, you MUST:

1. Read the ENTIRE memory/MEMORY.md file.
2. Read the ENTIRE memory/ROADMAP.md file.
3. Read AGENTS.md.
4. Confirm you have read all three files by stating:
   - The current active phase
   - The current step within that phase
   - Whether the phase is autonomous or requires developer manual action

Only AFTER confirming all three, proceed with the dev-trio workflow.
If the developer said "pick up where we left off", use MEMORY.md and
ROADMAP.md to determine what to work on next.

When writing your first implementation prompt for a new phase, also read
memory/PROMPT_EXAMPLES.md to calibrate your prompt style and rigor.

Task: \`$ARGUMENTS\`
`;

const MEMORY = `# [Project Name] — Project Memory

**STATUS: PROVISIONAL — UNVERIFIED**
This file was generated by Dev-Trio setup. The planner will replace all
PROVISIONAL sections with verified facts during the first dev-trio session.

---

## Project

- **Name:** [TO BE FILLED — project name]
- **Purpose:** [TO BE FILLED — one sentence describing what this project does]
- **Owner:** [TO BE FILLED — developer name]
- **v1 definition:** [TO BE FILLED — what does production-ready mean for this project]

---

## Tech Stack (PROVISIONAL — verify during initialization)

- **Languages:** [detected or unknown]
- **Frameworks:** [detected or unknown]
- **Build tools:** [detected or unknown]
- **Test frameworks:** [detected or unknown]
- **Package manager:** [detected or unknown]
- **Runtime:** [detected or unknown]

---

## Project Structure (PROVISIONAL — verify during initialization)
\`\`\`

[TO BE FILLED — real directory layout after planner reads the workspace]

\`\`\`
---

## Current Phase

**[TO BE FILLED DURING INITIALIZATION]**

---

## Binding Constraints

[TO BE FILLED DURING INITIALIZATION — the planner will derive and write
the binding constraints specific to this project. Until filled, the
universal constraints in .github/instructions/constraints.instructions.md
apply.]

---

## Terminology (binding)

[TO BE FILLED DURING INITIALIZATION — the planner will list the project's
binding terminology here. These terms must never be renamed by any agent.]

---

## Slice History

[Empty — no slices completed yet]

---

## Active Blocker

None.

---

## Build State

[TO BE FILLED — last known build status, test results, smoke results]

---

## Notification Setup

- **Provider:** [TO BE FILLED — Telegram / Teams / Slack / Discord / webhook / none]
- **Script:** \${workspaceFolder}/notify.ps1
- **Status:** [configured / not configured]
`;

const ROADMAP = `# [Project Name] — Roadmap

**STATUS: PROVISIONAL — UNVERIFIED**
This file was generated by Dev-Trio setup. The planner will replace all
PROVISIONAL sections with a real phase plan during the first dev-trio session.

---

## Planner Principles

1. Read MEMORY.md and ROADMAP.md completely before any work begins.
2. Never skip the plan or the audit — every task goes through all three agents.
3. Write implementation prompts using EXACTLY:
   CONTEXT / ASSUMPTIONS / PLAN / KNOWN RISKS / AUDIT INSTRUCTION
4. Fix build errors, type errors, and test failures autonomously — do not stop
   for these.
5. Stop only for: constraint violation, manual action required, architectural
   ambiguity, dead end, evidence mismatch.
6. Close a phase only when its acceptance criteria are fully met — not when
   the implementation looks done.
7. Update MEMORY.md after every completed slice.

---

## Phase Plan (PROVISIONAL)

[TO BE FILLED DURING INITIALIZATION — the planner will write a real
phase plan with acceptance criteria after analyzing the project.]

### Template for each phase:

#### Phase N — [Name]
- **Entry conditions:** [what must be true before this phase starts]
- **Steps:** [ordered list of implementation steps]
- **Acceptance criteria:** [exactly what must be true for this phase to close]
- **Validation:** [how to verify — commands, checks, manual steps]

---

## Task Queue

[Empty — add tasks here as the planner identifies them]
`;

const PROMPT_EXAMPLES = `# [Project Name] — Prompt Examples

This file shows the required format and rigor for every implementation
prompt the planner writes. Read this before writing the first prompt for
any new phase.

---

## Required prompt format

Every planner prompt MUST use this exact structure:

CONTEXT
[What is the current state of the project/phase? What has already been done?
What does the implementer need to know to understand the scope of this task?
Be specific — reference real file paths, class names, function names.]

ASSUMPTIONS
[What is the planner assuming to be true? These should be verifiable.
If an assumption is wrong, the implementer must stop and report it rather
than proceeding with a broken assumption.]

PLAN
[Ordered, numbered steps. Each step must be specific enough that there is
only one correct way to execute it. Reference exact file paths, function
signatures, class names. Do not use vague verbs like "update" or "fix" —
say exactly what change to make and where.]

KNOWN RISKS
[What could go wrong? What edge cases exist? What should the implementer
watch for? What would constitute a constraint violation in this specific task?]

AUDIT INSTRUCTION
[Explicit instructions to the critic. What constraints are most relevant
to this task? What specific things should the critic verify? What evidence
files should the critic check? What does DONE look like for this task?]

---

## Example prompt

CONTEXT
The project currently has [describe current state]. The last completed
slice was [slice name] which [describe what it did]. The current phase
is [phase name] and we are on step [N] of [total].

ASSUMPTIONS
- [File path] exists and contains [specific content]
- The build is currently passing (last verified: [when])
- [Specific condition] is true based on [evidence]

PLAN
1. Open [exact file path] and locate [exact function/class/section]
2. Add [exact change] — [explain why this specific change achieves the goal]
3. Modify [exact file path] line [N]: change [old] to [new]
4. Run [exact build command] and verify exit code is 0
5. Run [exact test command] and verify all tests pass
6. Write build output to _temp/[phase]/evidence_build_[timestamp].log

KNOWN RISKS
- [Specific risk]: if [condition] is true, [consequence]. Mitigation: [action]
- Changing [thing] may affect [other thing] — verify [how to check]

AUDIT INSTRUCTION
Critic: verify the following against all binding constraints:
1. [Specific thing to check] — evidence in _temp/[phase]/evidence_[check].log
2. [Specific constraint N] — [how to verify it was not violated]
3. [Build/test results] — cross-check implementer report against evidence file
Confirm DONE only if all evidence files are present, build exit code is 0,
and no binding constraints were violated.

---

## Calibration notes

- If your PLAN steps are not specific enough to be unambiguous, rewrite them.
- If your AUDIT INSTRUCTION does not reference specific constraints by number
  or name, rewrite it.
- If your KNOWN RISKS section is empty, you have not thought hard enough
  about the task.
- A prompt that a different developer could misinterpret is not good enough.
`;

const SKELETON_FILES: readonly SkeletonFile[] = [
  { relativePath: 'AGENTS.md', content: AGENTS_GUARDRAILS },
  { relativePath: '.github/copilot-instructions.md', content: COPILOT_INSTRUCTIONS },
  { relativePath: '.github/agents/planner.agent.md', content: PLANNER_AGENT },
  { relativePath: '.github/agents/implementer.agent.md', content: IMPLEMENTER_AGENT },
  { relativePath: '.github/agents/critic.agent.md', content: CRITIC_AGENT },
  { relativePath: '.github/instructions/constraints.instructions.md', content: CONSTRAINTS_INSTRUCTIONS },
  { relativePath: '.github/prompts/dev-trio.prompt.md', content: DEV_TRIO_PROMPT },
  { relativePath: 'memory/MEMORY.md', content: MEMORY },
  { relativePath: 'memory/ROADMAP.md', content: ROADMAP },
  { relativePath: 'memory/PROMPT_EXAMPLES.md', content: PROMPT_EXAMPLES }
];

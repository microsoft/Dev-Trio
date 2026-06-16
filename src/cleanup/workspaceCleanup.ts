import * as vscode from 'vscode';
import { readAgentConfig } from '../utils/agentDetection';

/**
 * Removes Dev-Trio boilerplate from a workspace (uninstall cleanup). Deletes the scaffolded
 * structural files and the .dev-trio/ state folder, strips the Dev-Trio .gitignore block, and
 * writes DEV-TRIO-REMOVED.md. User-owned files (memory/*, the backup log) are always preserved.
 * Every deletion is best-effort: a missing file is skipped silently; other per-file failures are
 * collected and surfaced at the end without aborting the rest of the cleanup.
 */

/** Exact scaffolded paths of the boilerplate files removed on uninstall (Category A structural files). */
const FILES_TO_REMOVE: readonly string[] = [
  'AGENTS.md',
  '.github/copilot-instructions.md',
  '.github/instructions/constraints.instructions.md',
  '.github/prompts/dev-trio.prompt.md',
  '.github/agents/planner.agent.md',
  '.github/agents/implementer.agent.md',
  '.github/agents/critic.agent.md'
];

/** Current and legacy markers that open the Dev-Trio .gitignore block. */
const GITIGNORE_MARKER = '# Dev-Trio scaffolded files';
const GITIGNORE_OLD_MARKER = '# Dev-Trio per-developer state';

/** The exact comment lines that may appear inside the Dev-Trio .gitignore block. */
const GITIGNORE_BLOCK_COMMENTS: ReadonlySet<string> = new Set([
  '# Dev-Trio scaffolded files',
  '# Dev-Trio per-developer state',
  '# Remove entries below if your team wants to share',
  '# these configurations across the repo.',
  '# Agent role definitions',
  '# Agent role definitions (GitHub Copilot)',
  '# Agent role definitions (Claude Code)',
  '# Agent role definitions (Codex)',
  '# Per-developer project memory (always keep ignored)',
  '# Dev-Trio internal state'
]);

/** The exact ignore entries that may appear inside the Dev-Trio .gitignore block (current + legacy). */
const GITIGNORE_BLOCK_ENTRIES: ReadonlySet<string> = new Set([
  'AGENTS.md',
  'copilot-instructions.md',
  '.github/agents/',
  '.claude/agents/',
  '.claude/commands/dt-upgrade.md',
  '.codex/agents/',
  'constraints.instructions.md',
  'dev-trio.prompt.md',
  'memory/MEMORY.md',
  'memory/ROADMAP.md',
  'memory/PROMPT_EXAMPLES.md',
  '.dev-trio/',
  '.dev-trio/wizard-progress.json',
  '.dev-trio/credits-cache.json',
  '.dev-trio/hidden-entries.json'
]);

const CLAUDE_MD_MARKER = '<!-- dev-trio-claude-md -->';
const CODEX_CONFIG_MARKER = '# Dev-Trio Codex configuration';

/** Builds DEV-TRIO-REMOVED.md, listing the agent ecosystems whose files were actually removed. */
function buildRemovedNotice(removedLines: string[], notes: string[]): string {
  const removedSection = removedLines.length > 0
    ? removedLines.map((l) => '- ' + l).join('\n')
    : '- (no Dev-Trio agent files were found to remove)';
  const notesSection = notes.length > 0
    ? '\n\n## Notes\n\n' + notes.map((n) => '- ' + n).join('\n')
    : '';
  return `# Dev-Trio Removed

Dev-Trio has been removed from this workspace.

## If you have an active coding-agent session

If you are currently in a GitHub Copilot, Claude Code, or Codex session that was
running dev-trio agent instructions, paste the following into the chat to clear
the context:

---

Dev-Trio has been uninstalled from this workspace. Please disregard all previous
dev-trio agent role instructions (Planner, Implementer, Critic). You are no
longer operating under any dev-trio workflow. Treat this as a regular session
with no special agent roles or constraints.

---

**For best results, start a new agent session** to ensure no dev-trio context
carries over.

## What was kept

The following files were preserved because they may contain your
project-specific content:

- memory/MEMORY.md
- memory/ROADMAP.md
- memory/PROMPT_EXAMPLES.md
- _backup/Dev_Trio_Chat_Backup.md (your session history)

You may delete these manually if you no longer need them.

## What was removed

${removedSection}${notesSection}
`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
}

/** Deletes a single URI; missing files are skipped silently, other failures are collected. */
async function tryDelete(
  uri: vscode.Uri,
  options: { recursive?: boolean; useTrash: boolean },
  label: string,
  failures: string[]
): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, options);
  } catch (err) {
    if (isFileNotFound(err)) {
      return;
    }
    failures.push(label + ' — ' + errText(err));
  }
}

/** Deletes a folder only when it is empty (used for .github/agents/ — never .github/ itself). */
async function removeFolderIfEmpty(folderUri: vscode.Uri, label: string, failures: string[]): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    if (entries.length === 0) {
      await vscode.workspace.fs.delete(folderUri, { useTrash: false });
    }
  } catch (err) {
    if (isFileNotFound(err)) {
      return;
    }
    failures.push(label + '/ — ' + errText(err));
  }
}

/**
 * Removes the Dev-Trio block from .gitignore text: from the marker line through the block's last
 * line (one trailing separator blank is also dropped). Only blank lines, known Dev-Trio block
 * comments, and known Dev-Trio entries are consumed, so any non-Dev-Trio content after the block —
 * including a user's own comment — is preserved.
 */
export function removeDevTrioGitignoreBlock(text: string): string {
  const lines = text.split('\n');
  const markerIdx = lines.findIndex((l) => {
    const t = l.trim();
    return t.startsWith(GITIGNORE_MARKER) || t.startsWith(GITIGNORE_OLD_MARKER);
  });
  if (markerIdx === -1) {
    return text;
  }
  let end = markerIdx + 1;
  while (end < lines.length) {
    const t = lines[end].trim();
    if (t === '' || GITIGNORE_BLOCK_COMMENTS.has(t) || GITIGNORE_BLOCK_ENTRIES.has(t)) {
      end++;
    } else {
      break;
    }
  }
  let start = markerIdx;
  if (start > 0 && lines[start - 1].trim() === '') {
    start--; // drop one separator blank line immediately before the block
  }
  const remaining = lines.slice(0, start).concat(lines.slice(end));
  const joined = remaining.join('\n').replace(/\n+$/, '\n');
  return joined.trim() === '' ? '' : joined;
}

/** Strips the Dev-Trio block from .gitignore (best-effort: a failure is recorded, never thrown). */
async function cleanGitignore(workspaceUri: vscode.Uri, failures: string[]): Promise<void> {
  const gitignoreUri = vscode.Uri.joinPath(workspaceUri, '.gitignore');
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignoreUri));
  } catch {
    return; // no .gitignore — nothing to clean
  }
  if (!text.includes(GITIGNORE_MARKER) && !text.includes(GITIGNORE_OLD_MARKER)) {
    return; // no Dev-Trio block — skip
  }
  try {
    const cleaned = removeDevTrioGitignoreBlock(text);
    await vscode.workspace.fs.writeFile(gitignoreUri, new TextEncoder().encode(cleaned));
  } catch (err) {
    failures.push('.gitignore cleanup — ' + errText(err));
  }
}

/** True when the URI exists on disk. */
async function existsUri(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the Dev-Trio block from CLAUDE.md: everything from the marker to end of file (Dev-Trio
 * always appends its block at the end or creates the whole file). If nothing precedes the block the
 * file is deleted; otherwise the user's leading content is preserved. Returns true if it acted.
 */
async function removeClaudeMdBlock(workspaceUri: vscode.Uri, failures: string[]): Promise<boolean> {
  const uri = vscode.Uri.joinPath(workspaceUri, 'CLAUDE.md');
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return false;
  }
  const idx = text.indexOf(CLAUDE_MD_MARKER);
  if (idx === -1) {
    return false;
  }
  const before = text.slice(0, idx).replace(/\n+$/, '');
  try {
    if (before.trim() === '') {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    } else {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before + '\n'));
    }
    return true;
  } catch (err) {
    failures.push('CLAUDE.md — ' + errText(err));
    return false;
  }
}

/** Removes the Claude Code scaffold: the three subagent files, the upgrade command, now-empty
 *  folders, and the Dev-Trio block in CLAUDE.md. Returns true if anything was removed. */
async function removeClaudeFiles(workspaceUri: vscode.Uri, failures: string[]): Promise<boolean> {
  let any = false;
  for (const name of ['dt-planner.md', 'dt-implementer.md', 'dt-critic.md']) {
    const uri = vscode.Uri.joinPath(workspaceUri, '.claude', 'agents', name);
    if (await existsUri(uri)) { any = true; await tryDelete(uri, { useTrash: false }, '.claude/agents/' + name, failures); }
  }
  await removeFolderIfEmpty(vscode.Uri.joinPath(workspaceUri, '.claude', 'agents'), '.claude/agents', failures);
  const cmdUri = vscode.Uri.joinPath(workspaceUri, '.claude', 'commands', 'dt-upgrade.md');
  if (await existsUri(cmdUri)) { any = true; await tryDelete(cmdUri, { useTrash: false }, '.claude/commands/dt-upgrade.md', failures); }
  await removeFolderIfEmpty(vscode.Uri.joinPath(workspaceUri, '.claude', 'commands'), '.claude/commands', failures);
  await removeFolderIfEmpty(vscode.Uri.joinPath(workspaceUri, '.claude'), '.claude', failures);
  if (await removeClaudeMdBlock(workspaceUri, failures)) { any = true; }
  return any;
}

/**
 * Cleans .codex/config.toml: if it is byte-identical (whitespace-normalized) to the Dev-Trio
 * template it is cleared to empty (never deleted). If it carries the Dev-Trio marker but has been
 * modified, it is left intact. Returns 'removed', 'intact-modified', or 'absent'.
 */
async function cleanCodexConfig(workspaceUri: vscode.Uri, extensionUri: vscode.Uri, failures: string[]): Promise<'removed' | 'intact-modified' | 'absent'> {
  const uri = vscode.Uri.joinPath(workspaceUri, '.codex', 'config.toml');
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return 'absent';
  }
  if (!text.includes(CODEX_CONFIG_MARKER)) {
    return 'intact-modified';
  }
  let canonical: string | null = null;
  try {
    canonical = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'media', 'scaffold', 'codex', 'config.toml'))
    );
  } catch {
    canonical = null;
  }
  const norm = (s: string): string => s.replace(/\r\n/g, '\n').trim();
  if (canonical !== null && norm(text) === norm(canonical)) {
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(''));
      return 'removed';
    } catch (err) {
      failures.push('.codex/config.toml — ' + errText(err));
      return 'intact-modified';
    }
  }
  return 'intact-modified';
}

/** Removes the Codex scaffold: the three subagent .toml files, the shared AGENTS.md (covers the
 *  codex-only case), and the Dev-Trio block in .codex/config.toml. Returns true if anything was removed. */
async function removeCodexFiles(workspaceUri: vscode.Uri, extensionUri: vscode.Uri, failures: string[], notes: string[]): Promise<boolean> {
  let any = false;
  for (const name of ['dt-planner.toml', 'dt-implementer.toml', 'dt-critic.toml']) {
    const uri = vscode.Uri.joinPath(workspaceUri, '.codex', 'agents', name);
    if (await existsUri(uri)) { any = true; await tryDelete(uri, { useTrash: false }, '.codex/agents/' + name, failures); }
  }
  await removeFolderIfEmpty(vscode.Uri.joinPath(workspaceUri, '.codex', 'agents'), '.codex/agents', failures);
  const agentsUri = vscode.Uri.joinPath(workspaceUri, 'AGENTS.md');
  if (await existsUri(agentsUri)) { any = true; await tryDelete(agentsUri, { useTrash: false }, 'AGENTS.md', failures); }
  const cfgResult = await cleanCodexConfig(workspaceUri, extensionUri, failures);
  if (cfgResult === 'removed') { any = true; }
  else if (cfgResult === 'intact-modified') { notes.push('.codex/config.toml was left intact (it has been modified beyond what Dev-Trio wrote).'); }
  return any;
}

/**
 * Removes a single agent's scaffolded files (used by the Update Project "Manage agents" card).
 * Best-effort: every deletion is try/catch (a missing file is skipped, nothing is thrown). Does NOT
 * call removeDevTrioFromWorkspace and never touches .dev-trio/ or memory/*. AGENTS.md is shared by
 * GitHub Copilot and Codex, so it is only deleted when NEITHER remains configured (per `remaining`).
 */
export async function removeAgentFiles(
  workspaceUri: vscode.Uri,
  agent: 'ghcp' | 'claudeCode' | 'codex',
  extensionUri: vscode.Uri,
  remaining: { ghcp: boolean; claudeCode: boolean; codex: boolean }
): Promise<void> {
  const failures: string[] = [];
  if (agent === 'ghcp') {
    const ghcpFiles = [
      '.github/copilot-instructions.md',
      '.github/instructions/constraints.instructions.md',
      '.github/prompts/dev-trio.prompt.md',
      '.github/agents/planner.agent.md',
      '.github/agents/implementer.agent.md',
      '.github/agents/critic.agent.md'
    ];
    for (const rel of ghcpFiles) {
      await tryDelete(vscode.Uri.joinPath(workspaceUri, ...rel.split('/')), { useTrash: false }, rel, failures);
    }
    if (!remaining.codex) {
      await tryDelete(vscode.Uri.joinPath(workspaceUri, 'AGENTS.md'), { useTrash: false }, 'AGENTS.md', failures);
    }
    await removeFolderIfEmpty(vscode.Uri.joinPath(workspaceUri, '.github', 'agents'), '.github/agents', failures);
  } else if (agent === 'claudeCode') {
    await removeClaudeFiles(workspaceUri, failures);
  } else {
    for (const name of ['dt-planner.toml', 'dt-implementer.toml', 'dt-critic.toml']) {
      await tryDelete(vscode.Uri.joinPath(workspaceUri, '.codex', 'agents', name), { useTrash: false }, '.codex/agents/' + name, failures);
    }
    await removeFolderIfEmpty(vscode.Uri.joinPath(workspaceUri, '.codex', 'agents'), '.codex/agents', failures);
    if (!remaining.ghcp) {
      await tryDelete(vscode.Uri.joinPath(workspaceUri, 'AGENTS.md'), { useTrash: false }, 'AGENTS.md', failures);
    }
    await cleanCodexConfig(workspaceUri, extensionUri, failures);
  }
  // failures are intentionally swallowed (best-effort, never throw). Reference to satisfy noUnusedLocals:
  void failures;
}

/**
 * Removes Dev-Trio from the given workspace. Cleans the files for whichever agent ecosystems the
 * user enabled (per .dev-trio/agent-config.json; when absent, all three are cleaned best-effort),
 * always removes the .dev-trio/ state folder, strips the .gitignore block, then writes and opens
 * DEV-TRIO-REMOVED.md. memory/* files and the backup log are never touched.
 */
export async function removeDevTrioFromWorkspace(
  context: vscode.ExtensionContext,
  workspaceUri: vscode.Uri
): Promise<void> {
  const failures: string[] = [];
  const removedLines: string[] = [];
  const notes: string[] = [];

  // No config => clean every agent's files (best-effort full removal).
  const cfg = await readAgentConfig(workspaceUri);
  const cleanGhcp = cfg ? cfg.agents.ghcp : true;
  const cleanClaude = cfg ? cfg.agents.claudeCode : true;
  const cleanCodex = cfg ? cfg.agents.codex : true;

  if (cleanGhcp) {
    let any = false;
    for (const rel of FILES_TO_REMOVE) {
      const uri = vscode.Uri.joinPath(workspaceUri, ...rel.split('/'));
      if (await existsUri(uri)) { any = true; }
      await tryDelete(uri, { useTrash: false }, rel, failures);
    }
    await removeFolderIfEmpty(vscode.Uri.joinPath(workspaceUri, '.github', 'agents'), '.github/agents', failures);
    if (any) {
      removedLines.push('GitHub Copilot: AGENTS.md, .github/agents/, copilot-instructions.md, constraints.instructions.md, dev-trio.prompt.md');
    }
  }

  if (cleanClaude) {
    if (await removeClaudeFiles(workspaceUri, failures)) {
      removedLines.push('Claude Code: .claude/agents/, .claude/commands/dt-upgrade.md, and the Dev-Trio block in CLAUDE.md');
    }
  }

  if (cleanCodex) {
    if (await removeCodexFiles(workspaceUri, context.extensionUri, failures, notes)) {
      removedLines.push(
        cleanGhcp
          ? 'OpenAI Codex: .codex/agents/, and the Dev-Trio [agents] block in .codex/config.toml'
          : 'OpenAI Codex: AGENTS.md, .codex/agents/, and the Dev-Trio [agents] block in .codex/config.toml'
      );
    }
  }

  // The .dev-trio/ state folder (agent-config, sentinels, caches) is always removed.
  await tryDelete(vscode.Uri.joinPath(workspaceUri, '.dev-trio'), { recursive: true, useTrash: false }, '.dev-trio/', failures);
  removedLines.push('.dev-trio/ (extension state folder)');

  await cleanGitignore(workspaceUri, failures);

  const noticeUri = vscode.Uri.joinPath(workspaceUri, 'DEV-TRIO-REMOVED.md');
  try {
    await vscode.workspace.fs.writeFile(noticeUri, new TextEncoder().encode(buildRemovedNotice(removedLines, notes)));
    await vscode.commands.executeCommand('markdown.showPreview', noticeUri);
  } catch (err) {
    failures.push('DEV-TRIO-REMOVED.md — ' + errText(err));
  }

  if (failures.length > 0) {
    void vscode.window.showWarningMessage(
      'Dev-Trio removal completed with ' + failures.length + ' issue(s): ' + failures.join('; ')
    );
  }
}

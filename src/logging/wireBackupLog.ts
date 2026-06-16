import * as vscode from 'vscode';
import * as path from 'path';
import { utcBackupStamp } from '../init/skeletonGenerator';

/** The stable AGENTS.md Session Logging anchor; the backup-log path lives on the line below it. */
const AGENTS_LOG_ANCHOR =
  'After every dev-trio cycle, the planner must append to the backup log file at:';
/** planner.agent.md I/O step prefix that names the backup log. */
const PLANNER_LOG_PREFIX = 'a. LOG all cycles to ';
/** Heading/log placeholder resolved at setup time to the workspace folder name. */
const PROJECT_NAME_PLACEHOLDER = '[Project Name]';

/**
 * Wires the resolved absolute backup-log path into the agent files at setup time.
 *
 * The Dev-Trio templates carry the literal placeholder path "_backup/Dev_Trio_Chat_Backup.md" in
 * two places: the line directly under the Session Logging anchor in AGENTS.md, and the
 * "a. LOG all cycles to ..." step in planner.agent.md. This replaces both with the real absolute
 * log path.
 *
 * It ALSO resolves the "[Project Name]" placeholder (heading + log-entry header) to the workspace
 * folder name across AGENTS.md and .github/copilot-instructions.md — so a user who configures only
 * the backup log (no notification provider) still gets an identified project. The source is the
 * workspace folder name (path.basename), identical to wireNotification, and the replacement is
 * idempotent: if the placeholder was already resolved (e.g. notification setup ran first) it is a
 * no-op rather than corrupting the existing name.
 *
 * The targeting anchors on stable lines (not HTML comment markers — the literal templates carry
 * none), so re-running re-resolves the same single line and never appends a duplicate section. If a
 * hand-edited AGENTS.md/planner.agent.md lacks the anchor, that file is left untouched (never
 * clobbered).
 *
 * The trailing projectName parameter is retained for call-site compatibility; the project name is
 * derived from the workspace folder, not this argument.
 *
 * @returns the workspace-relative paths that were updated.
 */
export async function wireBackupLog(
  workspaceUri: vscode.Uri,
  absoluteLogPath: string,
  _projectName: string = ''
): Promise<string[]> {
  const touched: string[] = [];
  const projectName = path.basename(workspaceUri.fsPath);

  const agentsUri = vscode.Uri.joinPath(workspaceUri, 'AGENTS.md');
  if (await pathExists(agentsUri)) {
    const changed = await editFile(agentsUri, (text) => {
      const withPath = replaceLineAfterAnchor(text, AGENTS_LOG_ANCHOR, absoluteLogPath);
      return applyProjectName(withPath, projectName);
    });
    if (changed) {
      touched.push('AGENTS.md');
    }
  }

  const plannerUri = vscode.Uri.joinPath(workspaceUri, '.github', 'agents', 'planner.agent.md');
  if (await pathExists(plannerUri)) {
    const changed = await editFile(plannerUri, (text) =>
      replaceLine(text, PLANNER_LOG_PREFIX, PLANNER_LOG_PREFIX + absoluteLogPath)
    );
    if (changed) {
      touched.push('.github/agents/planner.agent.md');
    }
  }

  const copilotUri = vscode.Uri.joinPath(workspaceUri, '.github', 'copilot-instructions.md');
  if (await pathExists(copilotUri)) {
    const changed = await editFile(copilotUri, (text) => applyProjectName(text, projectName));
    if (changed) {
      touched.push('.github/copilot-instructions.md');
    }
  }

  return touched;
}

/** Replaces every "[Project Name]" placeholder with the real name. Idempotent: no-op once resolved. */
function applyProjectName(text: string, projectName: string): string {
  if (!projectName || !text.includes(PROJECT_NAME_PLACEHOLDER)) {
    return text;
  }
  return text.split(PROJECT_NAME_PLACEHOLDER).join(projectName);
}

/** Replaces the line immediately AFTER the first line that starts with `anchor` with `newValue`. */
function replaceLineAfterAnchor(text: string, anchor: string, newValue: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trimStart().startsWith(anchor)) {
      if (lines[i + 1] !== newValue) {
        lines[i + 1] = newValue;
        return lines.join('\n');
      }
      return text;
    }
  }
  return text;
}

/** Replaces the first line whose left-trimmed text starts with `prefix` with `replacement`. */
function replaceLine(text: string, prefix: string, replacement: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(prefix)) {
      if (lines[i] !== replacement) {
        lines[i] = replacement;
        return lines.join('\n');
      }
      return text;
    }
  }
  return text;
}

/**
 * Reads, transforms, and conditionally rewrites a file. Returns true when the content changed.
 *
 * Before modifying in place, the original is backed up to "<name>.<UTC-stamp>.bak" alongside it.
 * The backup is taken only when the content actually changes (idempotent re-runs create no spurious
 * .bak). If the backup write fails it propagates (throws) — we never modify a file we could not
 * first back up.
 */
async function editFile(uri: vscode.Uri, transform: (text: string) => string): Promise<boolean> {
  const raw = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(raw);
  const next = transform(text);
  if (next === text) {
    return false;
  }
  const fileName = uri.path.split('/').pop() ?? '';
  const backupUri = vscode.Uri.joinPath(uri, '..', `${fileName}.${utcBackupStamp(new Date())}.bak`);
  await vscode.workspace.fs.writeFile(backupUri, raw);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
  return true;
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

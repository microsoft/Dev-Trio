import * as vscode from 'vscode';
import { utcBackupStamp } from '../init/skeletonGenerator';

const PROJECT_NAME_PLACEHOLDER = '[Project Name]';

/** AGENTS.md "Human Notification" command line prefix (the literal placeholder in the template). */
const AGENTS_COMMAND_PREFIX = 'Command: pwsh -NoProfile -File "';
/** planner.agent.md "## NOTIFICATION" bare command line prefix. */
const PLANNER_COMMAND_PREFIX = 'pwsh -NoProfile -File "';

/**
 * Wires the resolved absolute notify command into the agent files at setup time.
 *
 * The Dev-Trio templates carry a literal placeholder command —
 *   pwsh -NoProfile -File "${workspaceFolder}/notify.ps1" -Message "your message"
 * — in two places: the "Command:" line of the Human Notification section in AGENTS.md, and the
 * bare command line under "## NOTIFICATION" in planner.agent.md. This replaces both lines in place
 * with the real absolute script path. It also replaces the "[Project Name]" heading placeholder
 * with the real project name across AGENTS.md and .github/copilot-instructions.md.
 *
 * The targeting anchors on stable line prefixes (not HTML comment markers — the literal templates
 * carry none), so re-running re-resolves the same single line and never appends a duplicate section.
 *
 * The trailing providerLabel parameter is retained for call-site compatibility (webhook setup
 * passes one) but is unused: the literal template references a single notify command line.
 *
 * @returns the workspace-relative paths that were updated.
 */
export async function wireNotification(
  workspaceUri: vscode.Uri,
  absoluteScriptPath: string,
  projectName: string = '',
  _providerLabel: string = 'Telegram'
): Promise<string[]> {
  const touched: string[] = [];
  // absoluteScriptPath is supplied by the caller — the user-level %LOCALAPPDATA%\Dev-Trio\notify.ps1
  // for Telegram (via getNotifyScriptPath()), or a user-level webhook script for webhook providers.
  const command = `pwsh -NoProfile -File "${absoluteScriptPath}" -Message "your message"`;

  const agentsUri = vscode.Uri.joinPath(workspaceUri, 'AGENTS.md');
  if (await pathExists(agentsUri)) {
    const changed = await editFile(agentsUri, (text) => {
      const resolved = replaceLine(text, AGENTS_COMMAND_PREFIX, 'Command: ' + command);
      return applyProjectName(resolved, projectName);
    });
    if (changed) {
      touched.push('AGENTS.md');
    }
  }

  const plannerUri = vscode.Uri.joinPath(workspaceUri, '.github', 'agents', 'planner.agent.md');
  if (await pathExists(plannerUri)) {
    const changed = await editFile(plannerUri, (text) => {
      const resolved = replaceLine(text, PLANNER_COMMAND_PREFIX, command);
      return applyProjectName(resolved, projectName);
    });
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

/** Replaces every "[Project Name]" placeholder with the real name (no-op when name is empty). */
function applyProjectName(text: string, projectName: string): string {
  const name = projectName.trim();
  if (!name) {
    return text;
  }
  return text.split(PROJECT_NAME_PLACEHOLDER).join(name);
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

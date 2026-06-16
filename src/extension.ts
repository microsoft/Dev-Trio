import * as vscode from 'vscode';
import { generateDevTrioFiles, resetWorkspaceSetup, readFileVersion, utcBackupStamp, writeUpgradeCurrent } from './init/skeletonGenerator';
import { probeWorkspace } from './init/workspaceProbe';
import { provisionBackupLog, isBackupLogConfigured } from './logging/backupLog';
import { wireBackupLog } from './logging/wireBackupLog';
import { readMemory } from './memoryReader';
import { SecretStore } from './secrets';
import { openNotifySetup, type NotificationSetupTarget } from './ui/wizards/notifySetup';
import { WalkthroughPanel } from './ui/wizards/walkthrough';
import { DevTrioStatusBar } from './ui/statusBar';
import { DevTrioSidebarProvider } from './ui/sidebarProvider';
import { LogViewerPanel } from './ui/logViewerPanel';
import { MemoryEditorPanel } from './ui/memoryEditorPanel';
import { UpdateProjectPanel } from './ui/updateProjectPanel';
import { removeDevTrioFromWorkspace } from './cleanup/workspaceCleanup';
import { readAgentConfig, detectAgents } from './utils/agentDetection';

const NO_PROJECT_NOTE =
  'Dev-Trio: project name not found in MEMORY.md — log entries will not include a project ' +
  'identifier. Run "Dev-Trio: Initialize Project" first, then re-run this setup to add it.';

let output: vscode.OutputChannel;
let creditsOutput: vscode.OutputChannel;
let secrets: SecretStore;
let statusBar: DevTrioStatusBar;
let sidebar: DevTrioSidebarProvider;
let memoryWatcher: vscode.FileSystemWatcher | undefined;
let sentinelWatcher: vscode.FileSystemWatcher | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Dev-Trio');
  creditsOutput = vscode.window.createOutputChannel('Dev-Trio Credits');
  secrets = new SecretStore(context.secrets);
  statusBar = new DevTrioStatusBar();
  const version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  sidebar = new DevTrioSidebarProvider(context.extensionUri, secrets, version, (m) => output.appendLine(m));

  context.subscriptions.push(
    output,
    creditsOutput,
    statusBar,
    vscode.window.registerWebviewViewProvider(DevTrioSidebarProvider.viewType, sidebar),
    vscode.commands.registerCommand('dev-trio.initProject', () => initProject(context)),
    vscode.commands.registerCommand('dev-trio.setupBackupLog', setupBackupLog),
    vscode.commands.registerCommand('dev-trio.setupNotifications', (initialTarget?: NotificationSetupTarget) =>
      openNotifySetup(context, secrets, (message) => output.appendLine(message), initialTarget, () => refreshSurfaces())
    ),
    vscode.commands.registerCommand('dev-trio.openWalkthrough', () => openWalkthrough(context)),
    vscode.commands.registerCommand('dev-trio.updateProject', () => openUpdateProject(context)),
    vscode.commands.registerCommand('dev-trio.removeFromWorkspace', () => removeFromWorkspace(context)),
    vscode.commands.registerCommand('dev-trio.openSessionLog', () => openSessionLogPanel(context)),
    vscode.commands.registerCommand('dev-trio.openMemory', () => openMemoryEditor(context, 'memory')),
    vscode.commands.registerCommand('dev-trio.openRoadmap', () => openMemoryEditor(context, 'roadmap')),
    vscode.commands.registerCommand('dev-trio.refreshProjectFiles', () => openUpdateProject(context)),
    vscode.commands.registerCommand('dev-trio.editProjectName', editProjectName),
    vscode.commands.registerCommand('dev-trio.resetSetup', () => resetSetup(context)),
    vscode.commands.registerCommand('dev-trio.focusSidebar', () =>
      vscode.commands.executeCommand('dev-trio.homeView.focus')
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      createMemoryWatcher();
      refreshSurfaces();
    })
  );

  createMemoryWatcher();
  void statusBar.refresh();
  const wsForAutodetect = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (wsForAutodetect) { void autodetectBackupLog(wsForAutodetect); }
  // Safety net for the activation race: the sidebar's WebviewView can resolve before the async
  // .dev-trio/ reads (sentinel + wizard-progress.json) settle on first load, leaving it showing
  // "Not initialized". A deferred refresh re-reads the on-disk setup state and re-renders the
  // correct partial/ready state once the workspace is fully resolved.
  setTimeout(() => {
    refreshSurfaces();
  }, 150);
}

/** (Re)creates the single shared MEMORY.md watcher; both the status bar and sidebar refresh on it. */
function createMemoryWatcher(): void {
  memoryWatcher?.dispose();
  memoryWatcher = undefined;
  sentinelWatcher?.dispose();
  sentinelWatcher = undefined;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, 'memory/MEMORY.md')
  );
  watcher.onDidChange(refreshSurfaces);
  watcher.onDidCreate(refreshSurfaces);
  watcher.onDidDelete(refreshSurfaces);
  memoryWatcher = watcher;

  const sentinel = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '.dev-trio/*')
  );
  sentinel.onDidChange(refreshSurfaces);
  sentinel.onDidCreate(refreshSurfaces);
  sentinel.onDidDelete(refreshSurfaces);
  sentinelWatcher = sentinel;
}

function refreshSurfaces(): void {
  void statusBar.refresh();
  void sidebar.refresh();
}

async function initProject(context: vscode.ExtensionContext): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) {
    const message = 'Dev-Trio: Open a workspace folder before initializing the project.';
    output.appendLine(message);
    await vscode.window.showErrorMessage(message);
    return;
  }

  try {
    output.appendLine(`Dev-Trio: Initializing project in ${workspaceUri.fsPath}`);
    const existingCfg = await readAgentConfig(workspaceUri);
    const results = await generateDevTrioFiles(workspaceUri, undefined, undefined, context.extensionUri, existingCfg ?? undefined);

    let written = 0;
    let skipped = 0;
    for (const entry of results) {
      output.appendLine(`  ${entry}`);
      if (entry.startsWith('[skipped]')) {
        skipped++;
      } else {
        written++;
      }
    }
    output.show(true);

    refreshSurfaces();

    await vscode.window.showInformationMessage(
      `Dev-Trio: Initialized (${written} written, ${skipped} skipped).`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Dev-Trio: ERROR — ${message}`);
    output.show(true);
    await vscode.window.showErrorMessage(`Dev-Trio: Initialization failed — ${message}`);
  }
}

/** Opens (or reveals) the multi-step setup walkthrough panel after probing the workspace. */
async function openWalkthrough(context: vscode.ExtensionContext): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) {
    const message = 'Dev-Trio: Open a workspace folder before running the setup walkthrough.';
    output.appendLine(message);
    await vscode.window.showErrorMessage(message);
    return;
  }
  const probe = await probeWorkspace(workspaceUri);
  await WalkthroughPanel.createOrShow(context, workspaceUri, probe, (m) => output.appendLine(m), refreshSurfaces);
}

/** Opens (or reveals) the read-only Session Log viewer panel. */
async function openSessionLogPanel(context: vscode.ExtensionContext): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) { await vscode.window.showErrorMessage('Dev-Trio: Open a workspace folder first.'); return; }
  await LogViewerPanel.createOrShow(context, workspaceUri, (m) => creditsOutput.appendLine(m));
}

async function openMemoryEditor(context: vscode.ExtensionContext, tab: 'memory' | 'roadmap'): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) { await vscode.window.showErrorMessage('Dev-Trio: Open a workspace folder first.'); return; }
  await MemoryEditorPanel.createOrShow(context, workspaceUri, tab);
}

/**
 * Resets the Dev-Trio setup wizard: clears in-memory walkthrough state and any open panel, deletes
 * all on-disk setup artifacts (wizard-progress, initialized sentinel, generated skeleton files),
 * refreshes the surfaces, and reopens the walkthrough from Step 1.
 */
async function resetSetup(context: vscode.ExtensionContext): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) {
    return;
  }
  try {
    WalkthroughPanel.reset(workspaceUri);
    await resetWorkspaceSetup(workspaceUri);
    output.appendLine('Dev-Trio: Setup wizard reset — removed progress, sentinel, and generated files.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Dev-Trio: reset failed — ${message}`);
    // A failed reset means the two-phase reset aborted before deleting anything (backup failure).
    // Surface the message and do NOT reopen the walkthrough as if the reset had succeeded.
    await vscode.window.showErrorMessage(message);
    return;
  }
  refreshSurfaces();
  await openWalkthrough(context);
}

interface BackupModeItem extends vscode.QuickPickItem {
  readonly mode: 'create' | 'existing';
}

async function setupBackupLog(): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) {
    const message = 'Dev-Trio: Open a workspace folder before setting up the chat backup log.';
    output.appendLine(message);
    await vscode.window.showErrorMessage(message);
    return;
  }

  const items: BackupModeItem[] = [
    {
      label: 'Create a new backup log',
      detail: 'Creates _backup/Dev_Trio_Chat_Backup.md in this workspace.',
      mode: 'create'
    },
    {
      label: 'Use an existing .md file',
      detail: 'Append cycle entries to a file you choose. Existing content is never modified.',
      mode: 'existing'
    }
  ];
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'Dev-Trio: How should the chat backup log be provisioned?'
  });
  if (!choice) {
    return;
  }

  let targetUri: vscode.Uri;
  if (choice.mode === 'create') {
    targetUri = vscode.Uri.joinPath(workspaceUri, '_backup', 'Dev_Trio_Chat_Backup.md');
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: false,
      canSelectFiles: true,
      openLabel: 'Use as backup log',
      filters: { Markdown: ['md'] }
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      'Append Dev-Trio cycle entries to this file? Existing content will never be modified or removed — entries are only added at the end.',
      { modal: true },
      'Append Entries'
    );
    if (confirm !== 'Append Entries') {
      return;
    }
    targetUri = picked[0];
  }

  try {
    const result = await provisionBackupLog({ mode: choice.mode, targetUri });
    const memory = await readMemory(workspaceUri);
    const projectName = memory.projectName ?? '';
    const wired = await wireBackupLog(workspaceUri, result.path, projectName);

    output.appendLine(
      `Dev-Trio: Backup log ${result.created ? 'created' : 'configured'} at ${result.path}`
    );
    for (const w of wired) {
      output.appendLine(`  wired: ${w}`);
    }
    if (!projectName) {
      output.appendLine(`  note: ${NO_PROJECT_NOTE}`);
    }
    output.show(true);

    await vscode.workspace
      .getConfiguration('dev-trio')
      .update('backupLog.defaultPath', result.path, vscode.ConfigurationTarget.Workspace);

    refreshSurfaces();

    if (!projectName) {
      void vscode.window.showWarningMessage(NO_PROJECT_NOTE);
    }

    await vscode.window.showInformationMessage(
      `Dev-Trio: Chat backup log ${result.created ? 'created' : 'configured'} at ${result.path}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Dev-Trio: ERROR — ${message}`);
    output.show(true);
    await vscode.window.showErrorMessage(`Dev-Trio: Backup log setup failed — ${message}`);
  }
}

async function editProjectName(): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) { return; }
  const memUri = vscode.Uri.joinPath(workspaceUri, 'memory', 'MEMORY.md');
  let raw: Uint8Array;
  try { raw = await vscode.workspace.fs.readFile(memUri); }
  catch { void vscode.window.showInformationMessage('No memory/MEMORY.md yet. Complete the setup wizard first.'); return; }
  const text = new TextDecoder().decode(raw);
  const current = currentProjectNameFromMemory(text) ?? '';
  const next = await vscode.window.showInputBox({ prompt: 'Enter a display name for this project', value: current, placeHolder: 'My Project' });
  const trimmed = (next ?? '').trim();
  if (!trimmed) { return; }
  // Back up MEMORY.md before modifying (timestamped .bak alongside).
  const stamp = utcBackupStamp(new Date());
  const bakUri = vscode.Uri.joinPath(workspaceUri, 'memory', 'MEMORY.md.' + stamp + '.bak');
  await vscode.workspace.fs.writeFile(bakUri, raw);
  const updated = replaceProjectName(text, trimmed);
  await vscode.workspace.fs.writeFile(memUri, new TextEncoder().encode(updated));
  refreshSurfaces();
}

/** Returns the first non-empty, non-heading line under "## Project", or undefined. */
function currentProjectNameFromMemory(text: string): string | undefined {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^##\s+Project\s*$/.test(l));
  if (idx === -1) { return undefined; }
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { break; }
    const t = lines[i].trim();
    if (t.length > 0) { return t; }
  }
  return undefined;
}

/** Replaces the first meaningful line under "## Project" with the new name. */
function replaceProjectName(text: string, newName: string): string {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^##\s+Project\s*$/.test(l));
  if (idx === -1) { return text; }
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { break; }
    if (lines[i].trim().length > 0) { lines[i] = newName; return lines.join('\n'); }
  }
  return text;
}

async function autodetectBackupLog(workspaceUri: vscode.Uri): Promise<void> {
  if (await isBackupLogConfigured()) { return; }
  const defaultPath = vscode.Uri.joinPath(workspaceUri, '_backup', 'Dev_Trio_Chat_Backup.md');
  try {
    await vscode.workspace.fs.stat(defaultPath);
    await vscode.workspace.getConfiguration('dev-trio').update('backupLog.defaultPath', defaultPath.fsPath, vscode.ConfigurationTarget.Workspace);
    refreshSurfaces();
  } catch {
    // no default backup log — leave unconfigured
  }
}

async function openUpdateProject(context: vscode.ExtensionContext): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) {
    await vscode.window.showErrorMessage('Dev-Trio: Open a workspace folder first.');
    return;
  }
  const fileVersion = await readFileVersion(workspaceUri);
  const extensionVersion = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  const isCurrentVersion = fileVersion === extensionVersion;

  await writeUpgradeCurrent(workspaceUri, context.extensionUri);
  const cfg = await readAgentConfig(workspaceUri);
  const detected = detectAgents();
  UpdateProjectPanel.createOrShow(context, workspaceUri, {
    fileVersion,
    extVersion: extensionVersion,
    isUpToDate: isCurrentVersion,
    upgradePending: !isCurrentVersion,
    agentConfig: cfg ? { ghcp: cfg.agents.ghcp, claudeCode: cfg.agents.claudeCode, codex: cfg.agents.codex } : null,
    detected: { ghcp: detected.ghcp, claudeCode: detected.claudeCode, codex: detected.codex },
    models: cfg?.models
  });
}

async function removeFromWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) {
    await vscode.window.showErrorMessage('Dev-Trio: Open a workspace folder first.');
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    'Remove Dev-Trio from this workspace?',
    {
      modal: true,
      detail:
        'This will delete all Dev-Trio boilerplate files ' +
        '(AGENTS.md, agent role files, .dev-trio/ folder, etc.). ' +
        'Your memory files and backup log will be kept. ' +
        'This cannot be undone.'
    },
      'Remove Dev-Trio'
  );
  if (answer !== 'Remove Dev-Trio') {
    return;
  }
  try {
    await removeDevTrioFromWorkspace(context, workspaceUri);
    refreshSurfaces();
    await vscode.window.showInformationMessage(
      'Dev-Trio has been removed from this workspace. See DEV-TRIO-REMOVED.md for next steps.'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine('Dev-Trio: removal failed — ' + message);
    await vscode.window.showErrorMessage('Dev-Trio: removal failed — ' + message);
  }
}

export function deactivate(): void {
  // Most disposables are owned by the extension context; the shared MEMORY.md and
  // .dev-trio/initialized watchers are managed manually (recreated on workspace-folder
  // changes) so dispose them explicitly here.
  memoryWatcher?.dispose();
  memoryWatcher = undefined;
  sentinelWatcher?.dispose();
  sentinelWatcher = undefined;
}

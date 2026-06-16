import * as vscode from 'vscode';
import { SecretStore } from '../secrets';
import { readMemory } from '../memoryReader';
import { readRecentResults, resolveConfiguredLogUri, type ResultEntry } from '../logging/backupLog';
import { isWorkspaceInitialized, readWizardProgress, allSkeletonFilesExist, readConstraintsDisplay, readConstraintsInstructions, type ConstraintDisplay } from '../init/skeletonGenerator';
import { detectAgents, readAgentConfig, type AgentConfig, type AgentPresence } from '../utils/agentDetection';

const MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=BrianMiddendorf.dev-trio';
const GITHUB_URL = 'https://github.com/microsoft/Dev-Trio';

/** Data the webview renders. Never contains secret values — only configured/not flags. */
type AgentState = 'active' | 'detected' | 'inactive';
type NotificationSetupProvider = 'telegram' | 'teams' | 'slack' | 'discord';

interface SidebarData {
  hasWorkspace: boolean;
  initialized: boolean;
  partialSetup: boolean;
  completedStepCount: number;
  hasSetupActivity: boolean;
  projectName: string;
  phaseFull: string;
  status: 'needs-setup' | 'setting-up' | 'ready';
  agentConfigPresent: boolean;
  agentStatus: {
    ghcp: AgentState;
    claudeCode: AgentState;
    codex: AgentState;
  };
  notificationStatus: {
    telegram: boolean;
    teams: boolean;
    slack: boolean;
    discord: boolean;
  };
  telegramConfigured: boolean;
  backupLogConfigured: boolean;
  backupLogFilename: string | undefined;
  latestLogSummary?: string;
  constraints: string[];
  constraintItems: ConstraintDisplay[];
  constraintsLegacy: boolean;
  upgradePending?: boolean;
  version: string;
}

interface InboundMessage {
  type: string;
  provider?: NotificationSetupProvider;
}

/** WebviewViewProvider for the Dev-Trio sidebar home page (view id "dev-trio.homeView"). */
export class DevTrioSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'dev-trio.homeView';

  private view: vscode.WebviewView | undefined;
  private backupLogWatcher: vscode.FileSystemWatcher | undefined;
  private watchedBackupLogKey: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: SecretStore,
    private readonly version: string,
    private readonly log: (message: string) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    webviewView.onDidDispose(() => {
      this.disposeBackupLogWatcher();
      this.view = undefined;
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
      }
    });
    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => {
      void this.handleMessage(msg);
    });
    void this.renderInitial(webviewView);
  }

  /** Re-reads disk state and pushes a refresh to the live webview (no-op if not visible). */
  async refresh(): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    try {
      const data = await this.collectData();
      this.syncBackupLogWatcher(data);
      await view.webview.postMessage({ type: 'refresh', data });
    } catch (err) {
      this.log(`Dev-Trio sidebar refresh failed: ${errMsg(err)}`);
    }
  }

  private async renderInitial(view: vscode.WebviewView): Promise<void> {
    const data = await this.collectData();
    this.syncBackupLogWatcher(data);
    view.webview.html = getHtml(view.webview, this.extensionUri, data);
  }

  dispose(): void {
    this.disposeBackupLogWatcher();
    this.view = undefined;
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'editProjectName':
        await vscode.commands.executeCommand('dev-trio.editProjectName');
        break;
      case 'openWalkthrough':
        await vscode.commands.executeCommand('dev-trio.openWalkthrough');
        break;
      case 'openMemory':
        await vscode.commands.executeCommand('dev-trio.openMemory');
        break;
      case 'openRoadmap':
        await vscode.commands.executeCommand('dev-trio.openRoadmap');
        break;
      case 'openSessionLog':
        await vscode.commands.executeCommand('dev-trio.openSessionLog');
        break;
      case 'openUpdateProject':
        await vscode.commands.executeCommand('dev-trio.updateProject');
        break;
      case 'refreshProjectFiles':
        await vscode.commands.executeCommand('dev-trio.refreshProjectFiles');
        break;
      case 'setupNotifications':
        await vscode.commands.executeCommand('dev-trio.setupNotifications');
        break;
      case 'openNotificationSetup':
        await vscode.commands.executeCommand(
          'dev-trio.setupNotifications',
          isNotificationSetupProvider(msg.provider) ? msg.provider : undefined
        );
        break;
      case 'setupBackupLog':
        await vscode.commands.executeCommand('dev-trio.setupBackupLog');
        break;
      case 'resetSetup':
        await vscode.commands.executeCommand('dev-trio.resetSetup');
        break;
      case 'openMarketplace':
        await vscode.commands.executeCommand('simpleBrowser.show', MARKETPLACE_URL);
        break;
      case 'openQuickStart':
        await vscode.commands.executeCommand(
          'markdown.showPreview',
          vscode.Uri.joinPath(this.extensionUri, 'docs', 'QUICKSTART.md')
        );
        break;
      case 'openGithub':
        await vscode.env.openExternal(vscode.Uri.parse(GITHUB_URL));
        break;
      case 'removeFromWorkspace':
        await vscode.commands.executeCommand('dev-trio.removeFromWorkspace');
        break;
      default:
        break;
    }
  }

  private async collectData(): Promise<SidebarData> {
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const memory = workspaceUri
      ? await readMemory(workspaceUri)
      : { exists: false, projectName: undefined, currentPhase: undefined, constraints: [], mtime: undefined };
    const constraintItems = workspaceUri ? await readConstraintsDisplay(workspaceUri) : [];
    let constraintsLegacy = false;
    let effectiveConstraintItems = constraintItems;
    if (effectiveConstraintItems.length === 0 && workspaceUri) {
      const legacy = await readConstraintsInstructions(workspaceUri);
      if (legacy.length > 0) { effectiveConstraintItems = legacy; constraintsLegacy = true; }
    }

    const logUri = resolveConfiguredLogUri();
    const backupLogConfigured = logUri ? await pathExists(logUri) : false;
    const latestLogSummary = await readLatestLogSummary(logUri, backupLogConfigured);
    const agentConfig = workspaceUri ? await readAgentConfig(workspaceUri) : null;
    const detectedAgents = detectAgents();
    const agentStatus = {
      ghcp: deriveAgentState(agentConfig, detectedAgents, 'ghcp'),
      claudeCode: deriveAgentState(agentConfig, detectedAgents, 'claudeCode'),
      codex: deriveAgentState(agentConfig, detectedAgents, 'codex')
    };
    const upgradePending = !agentConfig || agentConfig.setupVersion !== this.version;

    const [token, chatId, teamsWebhook, slackWebhook, discordWebhook] = await Promise.all([
      this.secrets.getToken(),
      this.secrets.getChatId(),
      this.secrets.getTeamsWebhook(),
      this.secrets.getSlackWebhook(),
      this.secrets.getDiscordWebhook()
    ]);
    const notificationStatus = {
      telegram: hasNonEmpty(token) && hasNonEmpty(chatId),
      teams: hasNonEmpty(teamsWebhook),
      slack: hasNonEmpty(slackWebhook),
      discord: hasNonEmpty(discordWebhook)
    };

    // Setup state: initialized (sentinel) wins; otherwise partial when a wizard-progress file
    // exists; otherwise not initialized. "Has activity" gates the last-activity timestamp so a
    // never-touched workspace shows no stale time.
    const initialized = workspaceUri ? await isWorkspaceInitialized(workspaceUri) : false;
    const progress = workspaceUri ? await readWizardProgress(workspaceUri) : undefined;
    const skeletonExists = workspaceUri ? await allSkeletonFilesExist(workspaceUri) : false;
    const partialSetup = !initialized && !!progress;
    const completedStepCount = progress ? progress.completedSteps.length : 0;
    const hasSetupActivity = initialized || partialSetup || skeletonExists;

    return {
      hasWorkspace: !!workspaceUri,
      initialized,
      partialSetup,
      completedStepCount,
      hasSetupActivity,
      projectName: memory.projectName ?? (workspaceUri ? baseName(workspaceUri.fsPath) : 'No project initialized'),
      phaseFull: memory.currentPhase ?? 'Not initialized',
      status: initialized ? 'ready' : (partialSetup ? 'setting-up' : 'needs-setup'),
      agentConfigPresent: !!agentConfig,
      agentStatus,
      notificationStatus,
      telegramConfigured: notificationStatus.telegram,
      backupLogConfigured,
      backupLogFilename: logUri ? baseName(logUri.fsPath) : undefined,
      latestLogSummary,
      constraints: [...memory.constraints],
      constraintItems: effectiveConstraintItems,
      constraintsLegacy,
      upgradePending,
      version: this.version
    };
  }

  private syncBackupLogWatcher(data: SidebarData): void {
    const logUri = resolveConfiguredLogUri();
    const nextKey = logUri && data.backupLogConfigured ? logUri.toString() : undefined;
    if (this.watchedBackupLogKey === nextKey) {
      return;
    }
    this.disposeBackupLogWatcher();
    if (!logUri || !data.backupLogConfigured) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentDirUri(logUri), baseName(logUri.fsPath))
    );
    const refresh = () => {
      void this.refresh();
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);
    this.backupLogWatcher = watcher;
    this.watchedBackupLogKey = nextKey;
  }

  private disposeBackupLogWatcher(): void {
    this.backupLogWatcher?.dispose();
    this.backupLogWatcher = undefined;
    this.watchedBackupLogKey = undefined;
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

function baseName(fsPath: string): string {
  const parts = fsPath.split(/[\\/]/);
  return parts[parts.length - 1] || fsPath;
}

function parentDirUri(uri: vscode.Uri): vscode.Uri {
  const cut = uri.path.lastIndexOf('/');
  return cut <= 0 ? uri.with({ path: '/' }) : uri.with({ path: uri.path.slice(0, cut) });
}

function hasNonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function deriveAgentState(
  agentConfig: AgentConfig | null,
  detectedAgents: AgentPresence,
  key: keyof AgentPresence
): AgentState {
  if (!agentConfig) {
    if (key === 'ghcp') {
      return 'active';
    }
    return detectedAgents[key] ? 'detected' : 'inactive';
  }
  if (agentConfig.agents[key] === true) {
    return 'active';
  }
  return detectedAgents[key] ? 'detected' : 'inactive';
}

function isNotificationSetupProvider(value: unknown): value is NotificationSetupProvider {
  return value === 'telegram' || value === 'teams' || value === 'slack' || value === 'discord';
}

async function readLatestLogSummary(logUri: vscode.Uri | undefined, backupLogConfigured: boolean): Promise<string | undefined> {
  if (!logUri || !backupLogConfigured) {
    return undefined;
  }
  const entries = await readRecentResults(logUri, 1);
  const latest = entries[0];
  return latest ? formatLatestLogSummary(latest) : undefined;
}

function formatLatestLogSummary(entry: ResultEntry): string {
  const summary = entry.category === 'OTHER' ? entry.result : entry.category;
  const prompt = entry.prompt ? truncateSingleLine(entry.prompt, 84) : undefined;
  return ['Latest session', entry.timestamp, summary, prompt].filter((part): part is string => !!part).join(' · ');
}

function truncateSingleLine(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, data: SidebarData): string {
  const nonce = makeNonce();
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'));
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icon-color.svg'));
  const cspSource = webview.cspSource;
  // Embed initial state; escape "<" so a stray "</script>" in data can't break out.
  const initial = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';" />
<link href="${codiconUri}" rel="stylesheet" />
<title>Dev-Trio</title>
<style nonce="${nonce}">
:root {
  --bg: #0d1117; --accent: #2f80ed; --accent-hi: #3a8bf2; --teal: #2bb6a3;
  --text: #f0f4f8; --muted: #94a3b8; --faint: #475569; --eyebrow: #64748b;
  --line: rgba(255,255,255,0.10); --card: rgba(255,255,255,0.04); --card-bd: rgba(255,255,255,0.14);
  --green: #22c55e; --amber: #eab308; --red: #ef4444;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--vscode-font-family); font-size: 13px; overflow-x: hidden; }
.app { padding: 14px 16px 18px; }
.codicon { font-size: 14px; line-height: 1; }
.hide { display: none !important; }

/* Logo header */
.logo-header { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08)); }
.logo-icon { flex: 0 0 auto; border-radius: 6px; filter: drop-shadow(0 0 8px rgba(255, 255, 255, 0.45)); }
.logo-text { display: flex; flex-direction: column; gap: 2px; }
.logo-title { font-size: 13px; font-weight: 700; letter-spacing: 0.08em; color: #f0f4f8; text-transform: uppercase; }
.logo-sub { font-size: 10px; color: #64748b; letter-spacing: 0.04em; }

/* Hero panel */
.hero-panel { background: rgba(255,255,255,0.04); border: 1px solid var(--vscode-focusBorder, rgba(255,255,255,0.20)); border-radius: 10px; padding: 14px; margin: 0 0 12px 0; display: flex; flex-direction: column; gap: 10px; }
.hero-divider { border: none; border-top: 1px solid var(--vscode-focusBorder, rgba(255,255,255,0.06)); margin: 0; opacity: 0.3; }
.hero-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.hero-status-row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; position: relative; }
.hero-status-row .dot { margin-top: 0; }
.banner-main { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.banner-text { min-width: 0; }
.banner-label { font-size: 13px; font-weight: 600; color: #f0f4f8; word-break: break-word; line-height: 1.3; display: flex; align-items: center; }
.name-edit { cursor: pointer; color: #94a3b8; font-size: 12px; margin-left: 6px; flex: 0 0 auto; }
.name-edit:hover { color: #f0f4f8; }
.banner-sub { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; background: #64748b; }
.dot.green { background: #22c55e; box-shadow: 0 0 7px rgba(34,197,94,0.65); }
.dot.amber { background: #f59e0b; box-shadow: 0 0 7px rgba(245,158,11,0.6); }
.dot.gray { background: #64748b; }
.dot.red { background: #ef4444; box-shadow: 0 0 7px rgba(239,68,68,0.6); }
.badge-tag { flex: 0 0 auto; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 7px; border-radius: 5px; cursor: default; border: 1px solid transparent; }
.badge-tag.green { color: #7ee2a8; background: rgba(34,197,94,0.14); }
.badge-tag.amber { color: #fad776; background: rgba(234,179,8,0.14); }
.badge-tag.status-ready { color: #4ade80; background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.4); }
.badge-tag.status-setting-up { color: #fbbf24; background: rgba(245,158,11,0.15); border-color: rgba(245,158,11,0.4); }
.badge-tag.status-needs-setup { color: #fb923c; background: rgba(249,115,22,0.15); border-color: rgba(249,115,22,0.4); }
.status-badge-wrap { position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; }
.status-help-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.3); font-size: 9px; color: rgba(255,255,255,0.5); margin-left: 5px; cursor: pointer; vertical-align: middle; user-select: none; }
.status-help-icon:hover { border-color: rgba(255,255,255,0.6); color: rgba(255,255,255,0.8); }
.status-help-popup { display: none; position: absolute; top: calc(100% + 6px); left: 0; right: auto; background: #1e2433; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 10px 12px; font-size: 11px; color: #94a3b8; max-width: min(calc(100vw - 32px), 340px); z-index: 100; box-shadow: 0 4px 16px rgba(0,0,0,0.4); line-height: 1.5; }
.status-help-popup.is-open { display: block; }
.status-help-popup .popup-line + .popup-line { margin-top: 7px; }
.popup-status-name { color: #cbd5e1; }

/* Buttons */
.btn { display: flex; align-items: center; gap: 8px; width: 100%; border: none; cursor: pointer; font-family: inherit; border-radius: 8px; }
.btn .label { flex: 1 1 auto; text-align: left; }
.btn .codicon { font-size: 15px; }
.cta { height: 34px; padding: 0 12px; border-radius: 7px; background: var(--accent); color: #fff; font-size: 13px; font-weight: 500; box-shadow: 0 0 0 1px rgba(47,128,237,0.35), 0 4px 14px rgba(47,128,237,0.30); transition: all 0.15s ease; }
.cta:hover { background: var(--accent-hi); }
.cta-outline { height: 34px; padding: 0 12px; border-radius: 7px; background: transparent; color: var(--accent); border: 1px solid #2f80ed; font-size: 13px; font-weight: 500; transition: all 0.15s ease; }
.cta-outline:hover { background: rgba(47,128,237,0.08); border-color: var(--accent); }
.btn-ghost { height: 32px; padding: 0 10px; background: transparent; color: #cbd5e1; border: 1px solid var(--vscode-contrastBorder, rgba(255,255,255,0.20)); border-radius: 6px; font-size: 13px; font-weight: 500; transition: all 0.15s ease; }
.btn-ghost:hover { color: #fff; background: rgba(255,255,255,0.07); border-color: var(--vscode-focusBorder, rgba(255,255,255,0.38)); }
.btn-ghost .codicon { font-size: 14px; }
.is-disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.is-disabled:hover { background: transparent; }
.cta-amber { height: 34px; padding: 0 12px; border-radius: 7px; background: #f59e0b; color: #fff; font-size: 13px; font-weight: 500; box-shadow: 0 0 0 1px rgba(245,158,11,0.35), 0 4px 14px rgba(245,158,11,0.30); transition: all 0.15s ease; }
.cta-amber:hover { background: #fb9e1a; }
.btn-reset { margin-top: 8px; color: #f87171; }
.btn-reset:hover { color: #ef4444; background: rgba(248,113,113,0.07); }
.hero-panel .btn-reset { border: 2px solid rgba(248, 113, 113, 0.7) !important; }
.hero-panel .btn-reset:hover { border-color: rgba(239, 68, 68, 0.95) !important; }
.dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dash-btn { height: 52px; border-radius: 8px; background: transparent; border: 1px solid rgba(255,255,255,0.12); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; cursor: pointer; transition: all 0.15s ease; font-family: inherit; }
.dash-btn:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.25); }
.dash-icon { font-size: 14px; color: #94a3b8; }
.dash-label { font-size: 10px; color: #94a3b8; letter-spacing: 0.03em; }
.dash-btn:hover .dash-icon, .dash-btn:hover .dash-label { color: #f0f4f8; }
.resume-tip { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px 12px; font-size: 11px; color: #94a3b8; margin-top: 6px; }
    .resume-command { font-family: monospace; color: #60a5fa; font-size: 10px; margin-top: 4px; display: block; }
    .resume-examples-label { font-size: 10px; color: #475569; margin-top: 6px; display: block; }
    .resume-command-alt { font-family: monospace; color: #60a5fa; font-size: 10px; margin-top: 2px; display: block; }
    .dt-prompt-hang { padding-left: 11ch; text-indent: -11ch; white-space: normal; word-break: break-word; }

/* Sections */
.section { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.10)); }
.eyebrow { text-transform: uppercase; letter-spacing: 0.1em; font-size: 10px; font-weight: 600; color: var(--eyebrow); margin: 0 0 8px; }

/* Integrations */
.integrations-group + .integrations-group { margin-top: 12px; }
.integrations-group-title { margin: 0 0 8px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); }
.integrations-note { margin: 0 0 8px; font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
.integrations-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 32px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.integrations-row:last-child { border-bottom: none; }
.integrations-row.is-hidden { display: none; }
.integrations-left { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--vscode-descriptionForeground); }
.integrations-left .codicon { font-size: 14px; color: var(--vscode-descriptionForeground); }
.integrations-title { color: var(--vscode-foreground); }
.integrations-right { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.integrations-toggle { margin-top: 8px; background: none; border: none; padding: 0; font-family: inherit; font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; }
.integrations-toggle:hover { color: var(--vscode-textLink-activeForeground); }
.status-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 500; letter-spacing: 0.02em; display: inline-block; vertical-align: middle; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.status-badge-clickable { cursor: pointer; }
.status-active { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
.status-connected { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
.status-inactive { color: var(--vscode-descriptionForeground); border-color: var(--vscode-descriptionForeground); }
.status-detected { color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground); }

/* Constraints accordion */
.accordion { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 8px; border-radius: 6px; cursor: pointer; user-select: none; transition: background 0.15s ease; }
.accordion:hover { background: rgba(255,255,255,0.04); }
.accordion-left { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--text); }
.accordion-left .codicon { font-size: 14px; color: var(--muted); }
.count-pill { font-size: 10px; font-weight: 600; color: #cbd5e1; background: rgba(255,255,255,0.12); border-radius: 10px; padding: 1px 7px; }
.chev { color: var(--muted); font-size: 16px; }
.acc-body { display: none; padding: 8px 8px 2px; }
.acc-body.expanded { display: block; }
.constraint { display: flex; gap: 8px; font-size: 12px; color: #cbd5e1; margin-bottom: 7px; line-height: 1.4; word-break: break-word; }
.constraint .num { color: var(--faint); flex: 0 0 auto; }
.muted-empty { font-size: 12px; color: var(--muted); line-height: 1.4; }
.citem { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.citem .codicon { font-size: 14px; color: #94a3b8; flex: 0 0 auto; }
.citem-name { flex: 1 1 auto; font-size: 12px; color: #cbd5e1; word-break: break-word; }
.sev-badge { flex: 0 0 auto; border-radius: 4px; padding: 2px 6px; font-size: 10px; font-weight: 600; }
.sev-badge.hard { background: rgba(239,68,68,0.12); color: #f87171; }
.sev-badge.advisory { background: rgba(245,158,11,0.12); color: #f59e0b; }
.constraints-legacy-notice { display: flex; gap: 8px; align-items: flex-start; background: rgba(255,193,7,0.08); border: 1px solid rgba(255,193,7,0.35); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; font-size: 11px; color: #fbbf24; font-style: italic; line-height: 1.4; }

/* Footer */
.info-block { display: flex; gap: 8px; align-items: flex-start; background: rgba(255,193,7,0.08); border: 1px solid rgba(255,193,7,0.35); border-radius: 6px; padding: 8px 10px; }
.info-block .codicon { color: #fbbf24; font-size: 13px; margin-top: 1px; flex: 0 0 auto; }
.info-block .txt { font-size: 11px; color: #fbbf24; font-style: italic; line-height: 1.4; }
.footer-end { text-align: right; margin-top: 10px; }
.footer-link { display: block; width: 100%; text-align: right; margin-top: 5px; background: none; border: none; padding: 0; font-family: inherit; font-size: 11px; font-weight: 500; color: #60a5fa; text-decoration: none; cursor: pointer; }
.footer-link:hover { filter: brightness(1.25); text-decoration: none; }
.ver { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--faint); margin-top: 6px; }

.danger-zone { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border)); }
.danger-zone-label { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--vscode-inputValidation-errorForeground, var(--vscode-descriptionForeground)); opacity: 0.7; margin-bottom: 8px; padding: 0 4px; }
.btn-danger { display: flex; align-items: center; justify-content: center; gap: 8px; width: fit-content; margin: 8px auto 0; padding: 7px 16px; cursor: pointer; border-radius: 6px; background: transparent; border: 1px solid #a94442; color: #a94442; font-size: 12px; }
.btn-danger:hover { border-color: #c9605f; color: #c9605f; background: transparent; }
.btn-danger .codicon { font-size: 14px; }
</style>
</head>
<body>
<div class="logo-header">
  <img class="logo-icon" src="${logoUri}" width="36" height="36" alt="Dev-Trio logo" />
  <div class="logo-text">
    <span class="logo-title">Dev-Trio</span>
    <span class="logo-sub">Autonomous AI Coding Agents</span>
  </div>
</div>
<div class="app">

  <div class="hero-panel">
    <div class="hero-status-row">
      <span class="dot gray" id="phaseDot"></span>
      <span class="badge-tag" id="phaseBadge"></span>
      <span class="status-help-icon" id="statusHelpIcon">?</span>
      <div class="status-help-popup" id="statusHelpPopup">
        <div class="popup-line">What do these mean?</div>
        <div class="popup-line"><span class="popup-status-name">NEEDS SETUP</span> — your workspace hasn't been configured yet. Click 'Get started' to run the setup wizard.</div>
        <div class="popup-line"><span class="popup-status-name">SETTING UP</span> — the setup wizard is in progress. Click 'Continue setup' to pick up where you left off.</div>
        <div class="popup-line"><span class="popup-status-name">READY</span> — your project is configured and the trio is ready to work. Type /dev-trio: in GitHub Copilot Chat to start a session.</div>
      </div>
    </div>
    <div class="banner-label" id="bannerLabel">Not initialized</div>
    <div class="banner-sub" id="bannerSub"></div>

    <hr class="hero-divider" />

    <div class="hero-cta">
      <button class="btn cta" id="btnWalkthrough"><i class="codicon codicon-rocket"></i><span class="label">Get started — Setup Wizard</span></button>
      <button class="btn cta-amber hide" id="btnContinue"><i class="codicon codicon-rocket"></i><span class="label">Continue setup →</span></button>
      <button class="btn btn-ghost btn-reset hide" id="btnReset"><i class="codicon codicon-refresh"></i><span class="label">Reset setup wizard</span></button>
      <div class="resume-tip hide" id="resumeTip">To continue your last session, type this into GitHub Copilot Chat:<span class="resume-examples-label">Examples:</span><span class="resume-command dt-prompt-hang">/dev-trio: pick up where we left off</span><span class="resume-command-alt dt-prompt-hang">/dev-trio: [describe any task or change]</span></div>
    </div>

    <hr class="hero-divider" />

    <div class="dash-grid">
      <button class="dash-btn" id="dashMemory"><i class="codicon codicon-book dash-icon"></i><span class="dash-label">Memory</span></button>
      <button class="dash-btn" id="dashRoadmap"><i class="codicon codicon-milestone dash-icon"></i><span class="dash-label">Roadmap</span></button>
      <button class="dash-btn" id="dashSession"><i class="codicon codicon-output dash-icon"></i><span class="dash-label">Session Log</span></button>
      <button class="dash-btn" id="dashUpdate"><i class="codicon codicon-cloud-download dash-icon"></i><span class="dash-label">Update Project</span></button>
    </div>
  </div>

  <div class="section" id="integrationsSection">
    <div class="eyebrow">Integrations</div>
    <div class="integrations-group" data-group="agents">
      <div class="integrations-group-title">AGENTS</div>
      <div class="integrations-group-body" id="agentsGroupBody">
        <div class="integrations-row" id="ghcpAgentRow"></div>
        <div class="integrations-row" id="claudeAgentRow"></div>
        <div class="integrations-row" id="codexAgentRow"></div>
        <button class="integrations-toggle hide" id="agentsToggleBtn" data-toggle-inactive="agents"></button>
      </div>
    </div>
    <div class="integrations-group" data-group="notifications">
      <div class="integrations-group-title">NOTIFICATIONS</div>
      <div class="integrations-group-body" id="notificationsGroupBody">
        <div class="integrations-row" id="telegramNotificationRow"></div>
        <div class="integrations-row" id="teamsNotificationRow"></div>
        <div class="integrations-row" id="slackNotificationRow"></div>
        <div class="integrations-row" id="discordNotificationRow"></div>
        <button class="integrations-toggle hide" id="notificationsToggleBtn" data-toggle-inactive="notifications"></button>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="accordion" id="constraintsHeader">
      <div class="accordion-left">
        <i class="codicon codicon-shield"></i>
        <span>Constraints</span>
        <span class="count-pill" id="constraintsCount">0</span>
      </div>
      <i class="codicon codicon-chevron-right chev" id="constraintsChevron"></i>
    </div>
    <div class="acc-body" id="constraintsBody"></div>
  </div>

  <div class="section">
    <div class="info-block">
      <i class="codicon codicon-zap"></i>
      <span class="txt">Dev-Trio uses AI credits from your configured agents — GitHub Copilot, Claude Code, or OpenAI Codex. Structural (T1) phases run the full Planner → Implementer → Critic loop and use more; Mechanical (T3) phases run a single agent and use less. The Session Log tracks estimated credit usage per phase.</span>
    </div>
    <div class="danger-zone">
      <div class="danger-zone-label">Danger zone</div>
      <div class="btn-danger" id="dangerRemove">
        <i class="codicon codicon-trash"></i>
        <span>Remove Dev-Trio from workspace</span>
      </div>
    </div>
    <div class="footer-end">
      <button class="footer-link" id="marketplaceLink">View on Marketplace →</button>
      <button class="footer-link" id="quickStartLink">Quick Start Guide →</button>
      <button class="footer-link" id="githubLink">View on GitHub →</button>
      <div class="ver" id="footerVersion"></div>
    </div>
  </div>

</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let DATA = ${initial};
const byId = (id) => document.getElementById(id);
const setupVisibility = { agents: false, notifications: false };

function constraintIcon(cat) {
  if (cat === 'security') return 'codicon-shield';
  if (cat === 'architecture') return 'codicon-layers';
  if (cat === 'quality') return 'codicon-beaker';
  if (cat === 'workflow') return 'codicon-git-pull-request';
  return 'codicon-shield';
}
function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

function createIntegrationLeft(label, iconClass) {
  const left = document.createElement('div'); left.className = 'integrations-left';
  const ic = document.createElement('i'); ic.className = 'codicon ' + iconClass;
  const lab = document.createElement('span'); lab.className = 'integrations-title'; lab.textContent = label;
  left.appendChild(ic); left.appendChild(lab);
  return left;
}

function createStatusBadge(text, variant) {
  const badge = document.createElement('span');
  badge.className = 'status-badge ' + variant;
  badge.textContent = text;
  return badge;
}

function createClickableStatusBadge(text, variant, type, provider) {
  const badge = createStatusBadge(text, variant);
  badge.className += ' status-badge-clickable';
  badge.dataset.actionType = type;
  if (provider) {
    badge.dataset.actionProvider = provider;
  }
  return badge;
}

function renderAgentRow(id, label, iconClass, state) {
  const row = byId(id); row.textContent = '';
  row.dataset.itemState = state;
  row.appendChild(createIntegrationLeft(label, iconClass));
  const right = document.createElement('div'); right.className = 'integrations-right';
  if (state === 'active') {
    right.appendChild(createClickableStatusBadge('Active', 'status-active', 'openUpdateProject', null));
  } else if (state === 'detected') {
    right.appendChild(createClickableStatusBadge('Detected', 'status-detected', 'openUpdateProject', null));
  } else {
    right.appendChild(createClickableStatusBadge('Not set up', 'status-inactive', 'openUpdateProject', null));
  }
  row.appendChild(right);
}

function renderNotificationRow(id, label, iconClass, connected, provider) {
  const row = byId(id); row.textContent = '';
  row.dataset.itemState = connected ? 'active' : 'inactive';
  row.appendChild(createIntegrationLeft(label, iconClass));
  const right = document.createElement('div'); right.className = 'integrations-right';
  if (connected) {
    right.appendChild(createClickableStatusBadge('Connected', 'status-connected', 'openNotificationSetup', provider));
  } else {
    right.appendChild(createClickableStatusBadge('Not set up', 'status-inactive', 'openNotificationSetup', provider));
  }
  row.appendChild(right);
}

function updateSetupVisibility() {
  const agentRows = [byId('ghcpAgentRow'), byId('claudeAgentRow'), byId('codexAgentRow')];
  const notificationRows = [byId('telegramNotificationRow'), byId('teamsNotificationRow'), byId('slackNotificationRow'), byId('discordNotificationRow')];

  let hiddenAgents = 0;
  agentRows.forEach((row) => {
    if (!row) {
      return;
    }
    const active = row.dataset.itemState === 'active';
    const show = active || setupVisibility.agents;
    row.classList.toggle('is-hidden', !show);
    if (!active) {
      hiddenAgents += 1;
    }
  });

  const agentsToggleBtn = byId('agentsToggleBtn');
  if (agentsToggleBtn) {
    if (hiddenAgents > 0) {
      agentsToggleBtn.className = 'integrations-toggle';
      agentsToggleBtn.dataset.configureAction = '';
      agentsToggleBtn.textContent = setupVisibility.agents
        ? 'Hide agent options'
        : 'Additional agent options';
    } else {
      agentsToggleBtn.className = 'integrations-toggle';
      agentsToggleBtn.dataset.configureAction = 'openUpdateProject';
      agentsToggleBtn.textContent = 'Configure agents →';
    }
  }

  let hiddenNotifications = 0;
  notificationRows.forEach((row) => {
    if (!row) {
      return;
    }
    const active = row.dataset.itemState === 'active';
    const show = active || setupVisibility.notifications;
    row.classList.toggle('is-hidden', !show);
    if (!active) {
      hiddenNotifications += 1;
    }
  });

  const notificationsToggleBtn = byId('notificationsToggleBtn');
  if (notificationsToggleBtn) {
    if (hiddenNotifications > 0) {
      notificationsToggleBtn.className = 'integrations-toggle';
      notificationsToggleBtn.dataset.configureAction = '';
      notificationsToggleBtn.textContent = setupVisibility.notifications
        ? 'Hide notification options'
        : 'Additional notification options';
    } else {
      notificationsToggleBtn.className = 'integrations-toggle';
      notificationsToggleBtn.dataset.configureAction = 'setupNotifications';
      notificationsToggleBtn.textContent = 'Configure notifications →';
    }
  }
}

function render(d) {
  // Status banner — three states: initialized, partial setup, not initialized.
  const dot = byId('phaseDot');
  const bl = byId('bannerLabel');
  const sub = byId('bannerSub');
  const badge = byId('phaseBadge');
  const STATUS_CONFIG = {
    'needs-setup': { text: 'NEEDS SETUP', dotClass: 'amber', badgeClass: 'status-needs-setup' },
    'setting-up': { text: 'SETTING UP', dotClass: 'amber', badgeClass: 'status-setting-up' },
    'ready': { text: 'READY', dotClass: 'green', badgeClass: 'status-ready' }
  };
  const cfg = STATUS_CONFIG[d.status] || STATUS_CONFIG['needs-setup'];
  dot.className = 'dot ' + cfg.dotClass;
  badge.textContent = cfg.text;
  badge.className = 'badge-tag ' + cfg.badgeClass;
  if (d.initialized) {
    bl.textContent = '';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = truncate(d.projectName, 30);
    nameSpan.title = d.projectName;
    bl.appendChild(nameSpan);
    const pencil = document.createElement('i');
    pencil.className = 'codicon codicon-edit name-edit';
    pencil.id = 'editName';
    pencil.title = 'Rename project';
    pencil.addEventListener('click', () => vscode.postMessage({ type: 'editProjectName' }));
    bl.appendChild(pencil);
    const summary = d.latestLogSummary || d.phaseFull;
    sub.textContent = summary; sub.title = summary; sub.classList.remove('hide');
  } else if (d.partialSetup) {
    bl.textContent = 'Setup in progress';
    sub.textContent = 'On step ' + Math.min(d.completedStepCount + 1, 6) + ' of 6'; sub.title = ''; sub.classList.remove('hide');
  } else {
    bl.textContent = 'Not initialized';
    sub.textContent = ''; sub.classList.add('hide');
  }

  // Primary action — one of: Get started (fresh) / Continue setup (partial) / Reset (partial).
  const wt = byId('btnWalkthrough');
  const cont = byId('btnContinue');
  const reset = byId('btnReset');
  if (d.initialized) {
    wt.className = 'btn cta hide';
    cont.className = 'btn cta-amber hide';
    reset.className = 'btn btn-ghost btn-reset hide';
  } else if (d.partialSetup) {
    wt.className = 'btn cta hide';
    cont.className = 'btn cta-amber';
    reset.className = 'btn btn-ghost btn-reset';
  } else {
    wt.className = 'btn cta';
    cont.className = 'btn cta-amber hide';
    reset.className = 'btn btn-ghost btn-reset hide';
  }
  byId('resumeTip').className = d.initialized ? 'resume-tip' : 'resume-tip hide';

  // Integrations
  renderAgentRow('ghcpAgentRow', 'GitHub Copilot', 'codicon-hubot', d.agentStatus.ghcp);
  renderAgentRow('claudeAgentRow', 'Claude Code', 'codicon-comment-discussion', d.agentStatus.claudeCode);
  renderAgentRow('codexAgentRow', 'OpenAI Codex', 'codicon-code', d.agentStatus.codex);
  renderNotificationRow('telegramNotificationRow', 'Telegram', 'codicon-bell', d.notificationStatus.telegram, 'telegram');
  renderNotificationRow('teamsNotificationRow', 'Teams', 'codicon-device-camera-video', d.notificationStatus.teams, 'teams');
  renderNotificationRow('slackNotificationRow', 'Slack', 'codicon-comment', d.notificationStatus.slack, 'slack');
  renderNotificationRow('discordNotificationRow', 'Discord', 'codicon-notebook', d.notificationStatus.discord, 'discord');
  updateSetupVisibility();

  // Constraints
  byId('constraintsCount').textContent = d.constraintItems.length;
  const body = byId('constraintsBody'); body.textContent = '';
  if (d.constraintItems.length === 0) {
    const e = document.createElement('div'); e.className = 'muted-empty';
    e.textContent = 'No constraints yet. Run the init prompt in Copilot Chat to derive them.';
    body.appendChild(e);
  } else {
    if (d.constraintsLegacy) {
      const notice = document.createElement('div'); notice.className = 'constraints-legacy-notice';
      notice.textContent = 'Constraints shown from legacy format. Run the initialization prompt to upgrade to the enhanced display.';
      body.appendChild(notice);
    }
    d.constraintItems.forEach((item) => {
      const row = document.createElement('div'); row.className = 'citem'; row.title = item.description;
      const ic = document.createElement('i'); ic.className = 'codicon ' + constraintIcon(item.category);
      const name = document.createElement('span'); name.className = 'citem-name'; name.textContent = item.name;
      const sev = document.createElement('span'); sev.className = 'sev-badge ' + item.severity;
      sev.textContent = item.severity === 'hard' ? 'Hard rule' : 'Advisory';
      row.appendChild(ic); row.appendChild(name); row.appendChild(sev); body.appendChild(row);
    });
  }

  // Footer
  byId('footerVersion').textContent = 'Dev-Trio v' + d.version;

  DATA = d;
}

byId('btnWalkthrough').addEventListener('click', () => vscode.postMessage({ type: 'openWalkthrough' }));
byId('btnContinue').addEventListener('click', () => vscode.postMessage({ type: 'openWalkthrough' }));
byId('btnReset').addEventListener('click', () => vscode.postMessage({ type: 'resetSetup' }));
byId('dashMemory').addEventListener('click', () => vscode.postMessage({ type: 'openMemory' }));
byId('dashRoadmap').addEventListener('click', () => vscode.postMessage({ type: 'openRoadmap' }));
byId('dashSession').addEventListener('click', () => vscode.postMessage({ type: 'openSessionLog' }));
byId('dashUpdate').addEventListener('click', () => vscode.postMessage({ type: 'openUpdateProject' }));
byId('marketplaceLink').addEventListener('click', () => vscode.postMessage({ type: 'openMarketplace' }));
byId('quickStartLink').addEventListener('click', () => vscode.postMessage({ type: 'openQuickStart' }));
byId('githubLink').addEventListener('click', () => vscode.postMessage({ type: 'openGithub' }));
byId('dangerRemove').addEventListener('click', () => vscode.postMessage({ type: 'removeFromWorkspace' }));

const integrationsSection = byId('integrationsSection');
if (integrationsSection) {
  integrationsSection.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const setupToggle = target.closest('[data-toggle-inactive]');
    if (setupToggle instanceof HTMLElement) {
      const configureAction = setupToggle.dataset.configureAction;
      if (configureAction) {
        vscode.postMessage({ type: configureAction });
        return;
      }
      const group = setupToggle.dataset.toggleInactive;
      if (group === 'agents' || group === 'notifications') {
        setupVisibility[group] = !setupVisibility[group];
        updateSetupVisibility();
      }
      return;
    }

    const actionEl = target.closest('[data-action-type]');
    if (!(actionEl instanceof HTMLElement)) {
      return;
    }
    const type = actionEl.dataset.actionType;
    if (!type) {
      return;
    }
    const payload = { type: type };
    const provider = actionEl.dataset.actionProvider;
    if (provider) {
      payload.provider = provider;
    }
    vscode.postMessage(payload);
  });
}

byId('constraintsHeader').addEventListener('click', () => {
  const body = byId('constraintsBody');
  const chev = byId('constraintsChevron');
  const expanded = body.classList.toggle('expanded');
  chev.className = 'codicon chev ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
});

const statusHelpIcon = byId('statusHelpIcon');
const statusHelpPopup = byId('statusHelpPopup');
statusHelpIcon.addEventListener('click', (e) => {
  e.stopPropagation();
  statusHelpPopup.classList.toggle('is-open');
});
document.addEventListener('click', (e) => {
  if (!statusHelpPopup.contains(e.target) && e.target !== statusHelpIcon) {
    statusHelpPopup.classList.remove('is-open');
  }
});

window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'refresh') { render(ev.data.data); }
});

render(DATA);
</script>
</body>
</html>`;
}

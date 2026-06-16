import * as vscode from 'vscode';
import { readAgentConfig, writeAgentConfig, AGENT_MODEL_OPTIONS, DEFAULT_AGENT_MODELS, AgentConfig, type AgentModelConfig } from '../utils/agentDetection';
import { generateDevTrioFiles, configureGitignore, regenerateAgentModelFiles, readFileVersion } from '../init/skeletonGenerator';
import { removeAgentFiles } from '../cleanup/workspaceCleanup';

type AgentFlags = { ghcp: boolean; claudeCode: boolean; codex: boolean };
type AgentKey = 'ghcp' | 'claudeCode' | 'codex';

/** Data passed to the Update Project panel. The prompts are copied to the clipboard on demand. */
export interface UpdateProjectData {
  fileVersion: string | null;
  extVersion: string;
  refreshPrompt: string;
  isUpToDate: boolean;
  upgradePending: boolean;
  agentConfig: AgentFlags | null;
  detected: AgentFlags;
  models?: AgentConfig['models'];
}

/** The display-only subset embedded in the webview (prompt text stays in the extension host). */
interface UpdateProjectViewModel {
  fileVersion: string | null;
  extVersion: string;
  isUpToDate: boolean;
  upgradePending: boolean;
  agentConfig: AgentFlags | null;
  detected: AgentFlags;
  models: AgentConfig['models'] | null;
  modelOptions: { claudeCode: string[]; codex: string[] };
  modelDefaults: { claudeCode: Required<AgentModelConfig>; codex: Required<AgentModelConfig> };
}

interface InboundMessage {
  type: string;
  agent?: AgentKey;
  models?: AgentModelConfig;
  target?: 'upgrade' | 'refresh';
  mode?: 'auto' | 'clipboard';
  text?: string;
  card?: 'ghcp' | 'claude';
}

const UPGRADE_TRIGGER = '/dev-trio: upgrade dev-trio';
const CODEX_UPGRADE_TRIGGER = 'upgrade dev-trio';
const EXTENSION_ID = 'BrianMiddendorf.dev-trio';
/** Per-workspace remembered chat-submit choice (auto-submit vs clipboard pre-fill). Default 'auto'. */
const CHAT_SUBMIT_MODE_KEY = 'dev-trio.chatSubmitMode';
const MARKETPLACE_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=3.0-preview.1';

/** Fixed singleton key — only one Update Project panel is shown at a time. */
const PANEL_KEY = 'updateProject';

/**
 * The Update Project panel — a WebviewPanel beside the active editor. It is agent-aware: it shows
 * one upgrade section per configured agent (GitHub Copilot / Claude Code / Codex), a Marketplace
 * version check, a refresh-files action, and a Manage Agents card to add or remove agents. Singleton.
 */
export class UpdateProjectPanel {
  private static readonly panels = new Map<string, UpdateProjectPanel>();

  static async createOrShow(context: vscode.ExtensionContext, workspaceUri: vscode.Uri, data: UpdateProjectData): Promise<void> {
    const existing = UpdateProjectPanel.panels.get(PANEL_KEY);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'devTrioUpdateProject',
      'Update Project',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    new UpdateProjectPanel(panel, context, workspaceUri, data.refreshPrompt, {
      fileVersion: data.fileVersion,
      extVersion: data.extVersion,
      isUpToDate: data.isUpToDate,
      upgradePending: data.upgradePending,
      agentConfig: data.agentConfig,
      detected: data.detected,
      models: data.models ?? null,
      modelOptions: AGENT_MODEL_OPTIONS,
      modelDefaults: DEFAULT_AGENT_MODELS
    });
  }

  private readonly installedVersion: string;
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceState: vscode.Memento;
  private readonly fileVersionWatcher: vscode.FileSystemWatcher;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly workspaceUri: vscode.Uri,
    private readonly refreshPrompt: string,
    view: UpdateProjectViewModel
  ) {
    this.installedVersion = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.version ?? view.extVersion;
    this.extensionUri = context.extensionUri;
    this.workspaceState = context.workspaceState;
    UpdateProjectPanel.panels.set(PANEL_KEY, this);
    // Watch .dev-trio/file-version.json — the value readFileVersion() compares against the extension
    // version to drive the upgrade-pending status. When an upgrade (or a manual bump) rewrites it,
    // recompute and refresh the Dev-Trio Extension section so the pill clears without reopening.
    this.fileVersionWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceUri, '.dev-trio/file-version.json')
    );
    this.fileVersionWatcher.onDidChange(() => void this.recomputeVersion());
    this.fileVersionWatcher.onDidCreate(() => void this.recomputeVersion());
    this.fileVersionWatcher.onDidDelete(() => void this.recomputeVersion());
    panel.onDidDispose(() => {
      this.fileVersionWatcher.dispose();
      UpdateProjectPanel.panels.delete(PANEL_KEY);
    });
    panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => {
        void this.handleMessage(msg);
      },
      undefined,
      context.subscriptions
    );
    panel.webview.html = getHtml(panel.webview, context.extensionUri, view);
  }

  /**
   * Re-reads .dev-trio/file-version.json and posts the recomputed upgrade status to the webview so
   * the Dev-Trio Extension section updates live (fired by the file-version.json watcher).
   */
  private async recomputeVersion(): Promise<void> {
    const fileVersion = await readFileVersion(this.workspaceUri);
    const isUpToDate = fileVersion === this.installedVersion;
    void this.panel.webview.postMessage({
      type: 'versionStatus',
      fileVersion,
      extVersion: this.installedVersion,
      isUpToDate,
      upgradePending: !isUpToDate
    });
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'copyCodexUpgrade':
        await vscode.env.clipboard.writeText(CODEX_UPGRADE_TRIGGER);
        void this.panel.webview.postMessage({ type: 'confirmCopy', card: 'codex' });
        break;
      case 'copyToClipboard':
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          await vscode.env.clipboard.writeText(msg.text);
          void this.panel.webview.postMessage({ type: 'confirmCopy', card: msg.card });
        }
        break;
      case 'copyRefreshPrompt':
        await vscode.env.clipboard.writeText(this.refreshPrompt);
        void this.panel.webview.postMessage({ type: 'confirmCopy', card: 'refresh' });
        break;
      case 'sendToChat': {
        const mode = msg.mode === 'clipboard' ? 'clipboard' : 'auto';
        const prompt = msg.target === 'upgrade' ? UPGRADE_TRIGGER : '';
        if (prompt) { await this.sendPromptToChat(prompt, mode); }
        break;
      }
      case 'checkForUpdates': {
        const latest = await fetchLatestMarketplaceVersion();
        if (!latest) {
          void this.panel.webview.postMessage({ type: 'updateCheckResult', installed: this.installedVersion, latest: null, hasUpdate: false, upToDate: false, source: 'unavailable' });
          break;
        }
        const cmp = compareVersions(this.installedVersion, latest);
        void this.panel.webview.postMessage({ type: 'updateCheckResult', installed: this.installedVersion, latest, hasUpdate: cmp < 0, upToDate: cmp === 0, source: 'marketplace' });
        break;
      }
      case 'addAgent':
        if (msg.agent) { await this.handleAddAgent(msg.agent); }
        break;
      case 'removeAgent':
        if (msg.agent) { await this.handleRemoveAgent(msg.agent); }
        break;
      case 'updateAgentModels':
        if ((msg.agent === 'claudeCode' || msg.agent === 'codex') && msg.models) {
          await this.handleUpdateAgentModels(msg.agent, msg.models);
        }
        break;
      default:
        break;
    }
  }

  /**
   * Sends a GHCP chat prompt programmatically. 'auto' opens the Copilot Chat panel and submits the
   * query immediately; 'clipboard' copies it and pre-fills the chat input for manual review. The
   * chosen mode is remembered per-workspace. workbench.action.chat.open is an internal VS Code
   * command (not in the typings) but is the stable way to drive the GHCP chat panel.
   */
  private async sendPromptToChat(prompt: string, mode: 'auto' | 'clipboard'): Promise<void> {
    await this.workspaceState.update(CHAT_SUBMIT_MODE_KEY, mode);
    if (mode === 'auto') {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: false });
    } else {
      await vscode.env.clipboard.writeText(prompt);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: true });
      void vscode.window.showInformationMessage('Prompt copied and pre-filled in Copilot Chat. Review and press Enter to send.');
    }
  }

  /** Adds an agent: scaffolds only that agent's files, then writes the merged agent-config.json. */
  private async handleAddAgent(agent: AgentKey): Promise<void> {
    const existing = await readAgentConfig(this.workspaceUri);
    const currentAgents: AgentFlags = existing?.agents ?? { ghcp: true, claudeCode: false, codex: false };
    const setupVersion = existing?.setupVersion ?? '1.0.0';
    const merged: AgentFlags = { ...currentAgents };
    merged[agent] = true;
    // Scaffold ONLY the newly-added agent's files. generateDevTrioFiles writes agent-config.json from
    // this single-agent config, so we re-write the merged config immediately afterward to fix it up.
    const single: AgentConfig = {
      agents: { ghcp: agent === 'ghcp', claudeCode: agent === 'claudeCode', codex: agent === 'codex' },
      setupVersion: '1.0.0'
    };
    try {
      await generateDevTrioFiles(this.workspaceUri, undefined, undefined, this.extensionUri, single);
      await writeAgentConfig(this.workspaceUri, { agents: merged, setupVersion, models: existing?.models });
      // Merge the new agent's entries into the existing .gitignore Dev-Trio section (the merged
      // config — so every configured agent's block is present). Runs last so it sees the final config.
      await configureGitignore(this.workspaceUri, { agents: merged, setupVersion });
      void this.panel.webview.postMessage({ type: 'agentConfigUpdated', config: merged });
      void this.panel.webview.postMessage({ type: 'confirmCopy', message: 'Agent added. Reload the Dev-Trio sidebar to see the updated configuration.' });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: 'Could not add agent: ' + (err instanceof Error ? err.message : String(err)) });
    }
  }

  /** Updates per-role model overrides for one agent: persists agent-config.json, then force-rewrites
   *  that agent's three subagent scaffold files with the new models applied. */
  private async handleUpdateAgentModels(agent: 'claudeCode' | 'codex', models: AgentModelConfig): Promise<void> {
    const existing = await readAgentConfig(this.workspaceUri);
    if (!existing) {
      void this.panel.webview.postMessage({ type: 'error', message: 'No agent configuration found. Run setup first.' });
      return;
    }
    const clean = pickRoles(models);
    const merged: AgentConfig = {
      agents: existing.agents,
      setupVersion: existing.setupVersion,
      models: { ...(existing.models ?? {}), [agent]: clean }
    };
    try {
      await writeAgentConfig(this.workspaceUri, merged);
      await regenerateAgentModelFiles(this.workspaceUri, this.extensionUri, agent, clean);
      void this.panel.webview.postMessage({ type: 'agentModelsUpdated', agent, models: clean });
      void this.panel.webview.postMessage({ type: 'confirmCopy', message: 'Models updated and agent files regenerated.' });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: 'Could not update models: ' + (err instanceof Error ? err.message : String(err)) });
    }
  }

  /** Removes an agent: writes the reduced agent-config.json, then deletes only that agent's files. */
  private async handleRemoveAgent(agent: AgentKey): Promise<void> {
    const existing = await readAgentConfig(this.workspaceUri);
    const currentAgents: AgentFlags = existing?.agents ?? { ghcp: true, claudeCode: false, codex: false };
    const setupVersion = existing?.setupVersion ?? '1.0.0';
    const remaining: AgentFlags = { ...currentAgents };
    remaining[agent] = false;
    if (!remaining.ghcp && !remaining.claudeCode && !remaining.codex) {
      void this.panel.webview.postMessage({ type: 'error', message: 'At least one agent must remain configured.' });
      return;
    }
    try {
      await writeAgentConfig(this.workspaceUri, { agents: remaining, setupVersion, models: existing?.models });
      await removeAgentFiles(this.workspaceUri, agent, this.extensionUri, remaining);
      void this.panel.webview.postMessage({ type: 'agentConfigUpdated', config: remaining });
      void this.panel.webview.postMessage({ type: 'confirmCopy', message: 'Agent removed.' });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: 'Could not remove agent: ' + (err instanceof Error ? err.message : String(err)) });
    }
  }
}

/** Keeps only string per-role model values from a webview-supplied models block. */
function pickRoles(models: AgentModelConfig): AgentModelConfig {
  const out: AgentModelConfig = {};
  if (typeof models.planner === 'string') { out.planner = models.planner; }
  if (typeof models.implementer === 'string') { out.implementer = models.implementer; }
  if (typeof models.critic === 'string') { out.critic = models.critic; }
  return out;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) { return d < 0 ? -1 : 1; }
  }
  return 0;
}

async function fetchLatestMarketplaceVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(MARKETPLACE_QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json;api-version=3.0-preview.1' },
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }], flags: 512 }),
      signal: controller.signal
    });
    if (!res.ok) { return null; }
    const json = await res.json() as { results?: { extensions?: { versions?: { version?: string }[] }[] }[] };
    const version = json.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, data: UpdateProjectViewModel): string {
  const nonce = makeNonce();
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'));
  const cspSource = webview.cspSource;
  const initial = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';" />
<link href="${codiconUri}" rel="stylesheet" />
<title>Update Project</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #f0f4f8; font-family: var(--vscode-font-family); font-size: 13px; }
.codicon { font-size: 14px; line-height: 1; }
.wrap { max-width: 600px; margin: 0 auto; padding: 24px 16px 40px; display: flex; flex-direction: column; gap: 16px; }
.card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 20px; }
.card[hidden] { display: none; }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.card-icon { font-size: 20px; color: #60a5fa; }
.card-title { font-size: 15px; font-weight: 600; color: #f0f4f8; }
.card-desc { font-size: 12px; color: #94a3b8; line-height: 1.5; margin-bottom: 14px; }
.agent-head { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; color: #cbd5e1; margin-bottom: 12px; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; }
.status-badge { display: inline-block; border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 600; margin-bottom: 14px; }
.status-badge.ok { background: rgba(34,197,94,0.15); color: #4ade80; }
.status-badge.warn { background: rgba(245,158,11,0.15); color: #fbbf24; }
.warn-block { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.35); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
.warn-line { font-size: 11px; color: #fbbf24; line-height: 1.7; }
.warn-head { font-weight: 700; letter-spacing: 0.02em; }
.warn-head-gap { margin-top: 10px; }
.upd-btn { display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 16px; border: none; border-radius: 8px; background: #2f80ed; color: #fff; font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer; box-shadow: 0 0 0 1px rgba(47,128,237,0.35), 0 4px 14px rgba(47,128,237,0.30); transition: background 0.15s ease; }
.upd-btn:hover { background: #3a8bf2; }
.upd-btn.disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.upd-btn.disabled:hover { background: #2f80ed; }
.send-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn-secondary { display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 16px; border: 1px solid #2f80ed; border-radius: 8px; background: transparent; color: #2f80ed; font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn-secondary:hover { background: rgba(47,128,237,0.12); }
.copy-confirm { display: inline-flex; align-items: center; height: 36px; padding: 0 14px; border-radius: 8px; background: rgba(34,197,94,0.12); color: #4ade80; font-size: 12px; font-weight: 500; }
.phrase-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.phrase-box { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); color: var(--vscode-foreground); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.12)); }
.card-desc-after { margin-top: 6px; margin-bottom: 0; }
.check-btn { display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 16px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.check-btn:hover { background: var(--vscode-button-hoverBackground); }
.check-btn:disabled { opacity: 0.55; cursor: default; }
.check-result { margin-top: 12px; }
.check-line { font-size: 12px; line-height: 1.6; padding: 10px 12px; border-radius: 6px; }
.check-ok { background: var(--vscode-inputValidation-infoBackground, rgba(0,150,255,0.12)); color: var(--vscode-foreground); border: 1px solid var(--vscode-inputValidation-infoBorder, transparent); }
.check-update { background: var(--vscode-inputValidation-warningBackground, rgba(245,158,11,0.12)); color: var(--vscode-foreground); border: 1px solid var(--vscode-inputValidation-warningBorder, transparent); }
.check-warn { background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.10)); color: var(--vscode-foreground); border: 1px solid var(--vscode-inputValidation-errorBorder, transparent); }
.manage-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.08); }
.manage-row:first-child { border-top: none; }
.manage-name { flex: 1; font-size: 13px; color: #f0f4f8; }
.manage-badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 6px; white-space: nowrap; }
.manage-badge.configured { background: rgba(34,197,94,0.15); color: #4ade80; }
.manage-badge.unconfigured { background: rgba(148,163,184,0.15); color: #94a3b8; }
.manage-note { font-size: 11px; color: #94a3b8; font-style: italic; white-space: nowrap; }
.manage-btn { height: 28px; padding: 0 14px; border: none; border-radius: 6px; font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.manage-btn.add { background: #2f80ed; color: #fff; }
.manage-btn.add:hover { background: #3a8bf2; }
.manage-btn.remove { background: rgba(248,113,113,0.15); color: #f87171; }
.manage-btn.remove:hover { background: rgba(248,113,113,0.28); }
.manage-models { margin: -2px 0 10px 0; padding: 6px 0 0 2px; }
.manage-models-summary { font-size: 11px; color: #94a3b8; line-height: 1.5; }
.manage-models-edit { background: none; border: none; color: #60a5fa; font-size: 12px; cursor: pointer; padding: 4px 0 0; font-family: inherit; }
.manage-models-edit:hover { color: #3a8bf2; }
.manage-model-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.manage-model-label { flex: 0 0 120px; font-size: 11px; color: #94a3b8; }
.manage-model-select { flex: 1 1 auto; height: 28px; background: rgba(255,255,255,0.06); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 0 8px; font-family: inherit; font-size: 12px; }
select option { color: var(--vscode-input-foreground); background-color: var(--vscode-input-background); }
.manage-models-save { margin-top: 6px; }
.manage-status { font-size: 11px; color: #4ade80; margin-top: 12px; min-height: 14px; line-height: 1.5; }
.manage-status.error { color: #fbbf24; }
</style>
</head>
<body>
<div class="wrap">

  <div class="card" id="sectionExtension">
    <div class="card-head">
      <i class="codicon codicon-extensions card-icon"></i>
      <div class="card-title">Dev-Trio Extension</div>
    </div>
    <div id="extVersionLine" class="card-desc"></div>
    <div id="extUpgradeBadge" class="status-badge"></div>
    <div id="extUpgradeCta"></div>
    <div class="card-desc">See if a newer version of Dev-Trio is available on the VS Code Marketplace:</div>
    <div id="checkAction"></div>
    <div id="checkResult" class="check-result"></div>
  </div>

  <div class="card" id="sectionGhcp">
    <div class="agent-head">GitHub Copilot</div>
    <div class="card-desc">Type the phrase below in the GitHub Copilot Chat panel to upgrade this workspace:</div>
    <div class="phrase-row">
      <code class="phrase-box">/dev-trio: upgrade dev-trio</code>
      <div id="ghcpAction"></div>
    </div>
    <div class="card-desc card-desc-after">Dev-Trio will read your workspace's upgrade file and apply all updates automatically.</div>
  </div>

  <div class="card" id="sectionClaude">
    <div class="agent-head">Claude Code</div>
    <div class="card-desc">Type the slash command below in the Claude Code chat panel to upgrade this workspace:</div>
    <div class="phrase-row">
      <code class="phrase-box">/dt-upgrade</code>
      <div id="claudeAction"></div>
    </div>
    <div class="card-desc card-desc-after">Claude Code runs the upgrade as a native slash command.</div>
  </div>

  <div class="card" id="sectionCodex">
    <div class="agent-head">OpenAI Codex</div>
    <div class="card-desc">Ask Codex to upgrade Dev-Trio. Copy the phrase below and paste it into the Codex chat panel:</div>
    <div class="phrase-row">
      <code class="phrase-box">upgrade dev-trio</code>
      <div id="codexAction"></div>
    </div>
    <div class="card-desc card-desc-after">Codex reads AGENTS.md and applies all updates.</div>
  </div>

  <div class="card">
    <div class="card-head">
      <i class="codicon codicon-refresh card-icon"></i>
      <div class="card-title">Refresh project files</div>
    </div>
    <div class="card-desc">Reset your agent configuration files to the latest templates. A timestamped backup of each file will be created automatically.</div>
    <div class="warn-block">
      <div class="warn-line warn-head">YOUR PROJECT MEMORY WILL BE PRESERVED:</div>
      <div class="warn-line">• memory/MEMORY.md</div>
      <div class="warn-line">• memory/ROADMAP.md</div>
      <div class="warn-line">• memory/PROMPT_EXAMPLES.md</div>
      <div class="warn-line warn-head warn-head-gap">THESE FILES WILL BE REPLACED (backed up first):</div>
      <div class="warn-line">• AGENTS.md and all agent files</div>
      <div class="warn-line">• Constraints and prompt files</div>
    </div>
    <div id="refreshAction"></div>
  </div>

  <div class="card">
    <div class="card-head">
      <i class="codicon codicon-settings-gear card-icon"></i>
      <div class="card-title">Manage agents</div>
    </div>
    <div class="card-desc">Add or remove coding agents for this workspace. At least one agent must stay configured.</div>
    <div id="manageRows"></div>
    <div id="manageStatus" class="manage-status"></div>
  </div>

</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const DATA = ${initial};

const AGENT_LABELS = { ghcp: 'GitHub Copilot (GHCP)', claudeCode: 'Claude Code', codex: 'OpenAI Codex' };
const AGENT_ORDER = ['ghcp', 'claudeCode', 'codex'];

function baselineConfig() {
  return DATA.agentConfig ? { ghcp: !!DATA.agentConfig.ghcp, claudeCode: !!DATA.agentConfig.claudeCode, codex: !!DATA.agentConfig.codex } : { ghcp: true, claudeCode: false, codex: false };
}
let manageConfig = baselineConfig();

function baselineModels() {
  const d = DATA.modelDefaults || { claudeCode: {}, codex: {} };
  const m = DATA.models || {};
  return {
    claudeCode: Object.assign({}, d.claudeCode, m.claudeCode || {}),
    codex: Object.assign({}, d.codex, m.codex || {})
  };
}
let manageModels = baselineModels();
const manageModelEditing = new Set();

function gateSections() {
  const cfg = DATA.agentConfig;
  const showGhcp = cfg === null || cfg.ghcp === true;
  const showClaude = cfg !== null && cfg.claudeCode === true;
  const showCodex = cfg !== null && cfg.codex === true;
  document.getElementById('sectionGhcp').hidden = !showGhcp;
  document.getElementById('sectionClaude').hidden = !showClaude;
  document.getElementById('sectionCodex').hidden = !showCodex;
}

function renderExtensionSection() {
  const line = document.getElementById('extVersionLine');
  line.textContent = 'Installed version: v' + (DATA.fileVersion || DATA.extVersion);
  const badge = document.getElementById('extUpgradeBadge');
  const cta = document.getElementById('extUpgradeCta');
  cta.textContent = '';
  if (DATA.isUpToDate) {
    badge.className = 'status-badge ok';
    badge.textContent = 'Up to date';
    return;
  }
  badge.className = 'status-badge warn';
  const fv = DATA.fileVersion || 'unknown';
  badge.textContent = 'Update available (v' + fv + ' \u2192 v' + DATA.extVersion + ')';
  const desc = document.createElement('div');
  desc.className = 'card-desc';
  desc.textContent = 'Your workspace upgrade file is ready. Send the phrase below to GitHub Copilot Chat:';
  const phraseRow = document.createElement('div');
  phraseRow.className = 'phrase-row';
  const code = document.createElement('code');
  code.className = 'phrase-box';
  code.textContent = '/dev-trio: upgrade dev-trio';
  const action = document.createElement('div');
  action.id = 'upgradeAction';
  phraseRow.appendChild(code);
  phraseRow.appendChild(action);
  const after = document.createElement('div');
  after.className = 'card-desc card-desc-after';
  after.textContent = "Dev-Trio will read your workspace's upgrade file and apply all updates automatically.";
  cta.appendChild(desc);
  cta.appendChild(phraseRow);
  cta.appendChild(after);
  buildSendRow('upgradeAction', 'upgrade');
}

function buildSendRow(hostId, target) {
  const host = document.getElementById(hostId);
  host.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'send-row';
  const btn = document.createElement('button');
  btn.className = 'upd-btn';
  btn.textContent = 'Send to Copilot \u25B6';
  btn.addEventListener('click', () => vscode.postMessage({ type: 'sendToChat', target: target, mode: 'auto' }));
  const link = document.createElement('button');
  link.className = 'btn-secondary';
  link.textContent = 'Copy to clipboard';
  link.addEventListener('click', () => vscode.postMessage({ type: 'sendToChat', target: target, mode: 'clipboard' }));
  wrap.appendChild(btn);
  wrap.appendChild(link);
  host.appendChild(wrap);
}

function buildCodexButton() {
  const host = document.getElementById('codexAction');
  host.textContent = '';
  const btn = document.createElement('button');
  btn.className = 'upd-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => vscode.postMessage({ type: 'copyCodexUpgrade' }));
  host.appendChild(btn);
}

function buildGhcpButton() {
  const host = document.getElementById('ghcpAction');
  host.textContent = '';
  const btn = document.createElement('button');
  btn.className = 'upd-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => vscode.postMessage({ type: 'copyToClipboard', text: '/dev-trio: upgrade dev-trio', card: 'ghcp' }));
  host.appendChild(btn);
}

function buildClaudeButton() {
  const host = document.getElementById('claudeAction');
  host.textContent = '';
  const btn = document.createElement('button');
  btn.className = 'upd-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => vscode.postMessage({ type: 'copyToClipboard', text: '/dt-upgrade', card: 'claude' }));
  host.appendChild(btn);
}

function buildCheckButton() {
  const host = document.getElementById('checkAction');
  host.textContent = '';
  const btn = document.createElement('button');
  btn.className = 'check-btn';
  btn.textContent = 'Check for updates';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Checking...';
    vscode.postMessage({ type: 'checkForUpdates' });
  });
  host.appendChild(btn);
}

function showUpdateResult(m) {
  const res = document.getElementById('checkResult');
  res.textContent = '';
  const line = document.createElement('div');
  if (m.upToDate && m.source !== 'unavailable') {
    line.className = 'check-line check-ok';
    line.textContent = "✓ You're up to date (v" + m.installed + ")";
  } else if (m.hasUpdate) {
    line.className = 'check-line check-update';
    line.textContent = 'Update available: v' + m.latest + ' is on the Marketplace. Download and install the new .vsix or install directly from the VS Code Marketplace.';
  } else {
    line.className = 'check-line check-warn';
    line.textContent = 'Could not reach the Marketplace. Check your connection or visit: marketplace.visualstudio.com/items?itemName=BrianMiddendorf.dev-trio';
  }
  res.appendChild(line);
  buildCheckButton();
}

function buildRefreshButton() {
  const host = document.getElementById('refreshAction');
  host.textContent = '';
  if (DATA.upgradePending) {
    const btn = document.createElement('button');
    btn.className = 'upd-btn';
    btn.textContent = 'Upgrade required first';
    btn.disabled = true;
    btn.title = 'Refresh is disabled until your workspace is upgraded to the current Dev-Trio version.';
    host.appendChild(btn);
  } else {
    const btn = document.createElement('button');
    btn.className = 'upd-btn';
    btn.textContent = 'Copy to clipboard';
    btn.addEventListener('click', () => vscode.postMessage({ type: 'copyRefreshPrompt' }));
    host.appendChild(btn);
  }
}

function renderManageAgents() {
  const host = document.getElementById('manageRows');
  host.textContent = '';
  AGENT_ORDER.forEach((key) => {
    const row = document.createElement('div');
    row.className = 'manage-row';

    const name = document.createElement('div');
    name.className = 'manage-name';
    name.textContent = AGENT_LABELS[key];
    row.appendChild(name);

    const configured = manageConfig[key] === true;
    const badge = document.createElement('span');
    badge.className = 'manage-badge ' + (configured ? 'configured' : 'unconfigured');
    badge.textContent = configured ? '✓ configured' : 'not configured';
    row.appendChild(badge);

    if (!configured && !DATA.detected[key]) {
      const note = document.createElement('span');
      note.className = 'manage-note';
      note.textContent = 'not detected';
      row.appendChild(note);
    }

    const btn = document.createElement('button');
    btn.className = 'manage-btn ' + (configured ? 'remove' : 'add');
    btn.textContent = configured ? 'Remove' : 'Add';
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: configured ? 'removeAgent' : 'addAgent', agent: key });
    });
    row.appendChild(btn);

    host.appendChild(row);
    if (key === 'ghcp') {
      const desc = document.createElement('div');
      desc.className = 'manage-models';
      const d = document.createElement('div');
      d.className = 'manage-models-summary';
      d.textContent = 'Model selection for all three agent roles is controlled by the user in the GHCP chat panel.';
      desc.appendChild(d);
      host.appendChild(desc);
    }
    if ((key === 'claudeCode' || key === 'codex') && configured) {
      host.appendChild(buildManageModelPanel(key));
    }
  });
}

function buildManageModelPanel(agentKey) {
  const wrap = document.createElement('div');
  wrap.className = 'manage-models';
  const editing = manageModelEditing.has(agentKey);
  const opts = (DATA.modelOptions && DATA.modelOptions[agentKey]) || [];
  const roles = [['planner', 'Planner'], ['implementer', 'Implementer'], ['critic', 'Critic']];
  if (!editing) {
    const summary = document.createElement('div');
    summary.className = 'manage-models-summary';
    roles.forEach((r) => {
      const lineDiv = document.createElement('div');
      lineDiv.textContent = r[1] + ': ' + (manageModels[agentKey][r[0]] || '\u2014');
      summary.appendChild(lineDiv);
    });
    wrap.appendChild(summary);
    const editBtn = document.createElement('button');
    editBtn.className = 'manage-models-edit';
    editBtn.textContent = 'Edit models \u2192';
    editBtn.addEventListener('click', () => { manageModelEditing.add(agentKey); renderManageAgents(); });
    wrap.appendChild(editBtn);
  } else {
    roles.forEach((r) => {
      const mrow = document.createElement('div');
      mrow.className = 'manage-model-row';
      const lbl = document.createElement('label');
      lbl.className = 'manage-model-label';
      lbl.textContent = r[1] + ' model';
      mrow.appendChild(lbl);
      const sel = document.createElement('select');
      sel.className = 'manage-model-select';
      opts.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        if (manageModels[agentKey][r[0]] === o) { opt.selected = true; }
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { manageModels[agentKey][r[0]] = sel.value; });
      mrow.appendChild(sel);
      wrap.appendChild(mrow);
    });
    const save = document.createElement('button');
    save.className = 'manage-btn add manage-models-save';
    save.textContent = 'Save models';
    save.addEventListener('click', () => {
      manageModelEditing.delete(agentKey);
      vscode.postMessage({ type: 'updateAgentModels', agent: agentKey, models: manageModels[agentKey] });
      renderManageAgents();
    });
    wrap.appendChild(save);
  }
  return wrap;
}

function showManageStatus(message, isError) {
  const el = document.getElementById('manageStatus');
  el.className = 'manage-status' + (isError ? ' error' : '');
  el.textContent = message;
}

function showConfirm(hostId, message, rebuild) {
  const host = document.getElementById(hostId);
  host.textContent = '';
  const msg = document.createElement('div');
  msg.className = 'copy-confirm';
  msg.textContent = message;
  host.appendChild(msg);
  setTimeout(rebuild, 3000);
}

gateSections();
renderExtensionSection();
buildGhcpButton();
buildClaudeButton();
buildCodexButton();
buildCheckButton();
buildRefreshButton();
renderManageAgents();

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m) { return; }
  if (m.type === 'versionStatus') {
    DATA.fileVersion = m.fileVersion;
    DATA.extVersion = m.extVersion;
    DATA.isUpToDate = m.isUpToDate;
    DATA.upgradePending = m.upgradePending;
    renderExtensionSection();
    buildRefreshButton();
    return;
  }
  if (m.type === 'updateCheckResult') { showUpdateResult(m); return; }
  if (m.type === 'agentConfigUpdated') { manageConfig = { ghcp: !!m.config.ghcp, claudeCode: !!m.config.claudeCode, codex: !!m.config.codex }; renderManageAgents(); return; }
  if (m.type === 'agentModelsUpdated') { if (m.agent && m.models) { manageModels[m.agent] = Object.assign({}, manageModels[m.agent], m.models); } renderManageAgents(); return; }
  if (m.type === 'error') { showManageStatus(m.message, true); return; }
  if (m.type !== 'confirmCopy') { return; }
  if (m.message) { showManageStatus(m.message, false); return; }
  if (m.card === 'codex') {
    showConfirm('codexAction', '\u2713 Copied \u2014 paste it into the Codex chat panel', buildCodexButton);
  } else if (m.card === 'ghcp') {
    showConfirm('ghcpAction', '\u2713 Copied \u2014 paste it into the Copilot Chat panel', buildGhcpButton);
  } else if (m.card === 'claude') {
    showConfirm('claudeAction', '\u2713 Copied \u2014 paste it into the Claude Code panel', buildClaudeButton);
  } else if (m.card === 'refresh') {
    showConfirm('refreshAction', '\u2713 Copied to clipboard', buildRefreshButton);
  }
});
</script>
</body>
</html>`;
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  generateDevTrioFiles,
  allSkeletonFilesExist,
  categoryAFilesExist,
  writeInitializedSentinel,
  writeWizardProgress,
  readWizardProgress,
  deleteWizardProgress,
  ensureWizardProgressGitignored,
  configureGitignore
} from '../../init/skeletonGenerator';
import { INITIALIZATION_PROMPT } from '../../init/promptBuilder';
import { detectAgents, AGENT_MODEL_OPTIONS, DEFAULT_AGENT_MODELS, type AgentConfig, type AgentModelConfig, type AgentPresence } from '../../utils/agentDetection';
import { wireNotification } from '../../notify/wireNotification';
import { getNotifyScriptPath } from '../../notify/notifyScript';
import { wireBackupLog } from '../../logging/wireBackupLog';
import { isBackupLogConfigured, resolveConfiguredLogUri } from '../../logging/backupLog';
import type { ProbeResult } from '../../init/workspaceProbe';

interface ModelClasses {
  recommended: string[];
  use_with_caution: string[];
}

interface WalkState {
  step1Done: boolean;
  modelChecked: boolean;
  autopilotChecked: boolean;
  intent: { projectType: string; languages: string; description: string };
  promptCopied: boolean;
  initPromptProcessed: boolean;
  integrationsViewed: boolean;
  kickoffDone: boolean;
  agentsSelected: boolean;
}

interface InboundMessage {
  type: string;
  state?: WalkState;
  projectType?: string;
  languages?: string;
  description?: string;
  action?: string;
  ghcp?: boolean;
  claudeCode?: boolean;
  codex?: boolean;
  models?: { claudeCode?: AgentModelConfig; codex?: AgentModelConfig };
  mode?: 'auto' | 'clipboard';
}

/** Per-workspace remembered chat-submit choice (auto-submit vs clipboard pre-fill). Default 'auto'. */
const CHAT_SUBMIT_MODE_KEY = 'dev-trio.chatSubmitMode';

const DEFAULT_STATE: WalkState = {
  step1Done: false,
  modelChecked: false,
  autopilotChecked: false,
  intent: { projectType: '', languages: '', description: '' },
  promptCopied: false,
  initPromptProcessed: false,
  integrationsViewed: false,
  kickoffDone: false,
  agentsSelected: false
};

/** The boolean flags that map to numbered, persistable walkthrough steps (in order). */
type StepFlag =
  | 'step1Done'
  | 'modelChecked'
  | 'autopilotChecked'
  | 'initPromptProcessed'
  | 'integrationsViewed'
  | 'kickoffDone'
  | 'agentsSelected';
const STEP_NUMBER_FLAGS: ReadonlyArray<[number, StepFlag]> = [
  [1, 'step1Done'],
  [2, 'modelChecked'],
  [3, 'autopilotChecked'],
  [4, 'initPromptProcessed'],
  [5, 'integrationsViewed'],
  [6, 'kickoffDone'],
  [7, 'agentsSelected']
];

/** The completed step numbers implied by a WalkState (for wizard-progress.json). */
function completedStepNumbers(state: WalkState): number[] {
  return STEP_NUMBER_FLAGS.filter(([, flag]) => state[flag]).map(([n]) => n);
}

/** Restores a WalkState from persisted completed step numbers. */
function applyCompletedSteps(state: WalkState, completed: readonly number[]): void {
  for (const [n, flag] of STEP_NUMBER_FLAGS) {
    if (completed.includes(n)) {
      state[flag] = true;
    }
  }
  if (completed.includes(4)) {
    state.promptCopied = true;
  }
}

/**
 * The full Dev-Trio Setup walkthrough — a WebviewPanel (editor-area, beside the active editor).
 * Singleton per workspace: re-invoking reveals the existing panel. Step-completion state is held
 * in an in-memory map keyed by workspace path (restored when the panel is reopened in-session).
 */
export class WalkthroughPanel {
  private static readonly panels = new Map<string, WalkthroughPanel>();
  private static readonly states = new Map<string, WalkState>();

  private gitignoreEnsured = false;
  private lastWrittenSteps = '';
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceState: vscode.Memento;
  private agentSelection: AgentConfig | undefined;

  static async createOrShow(
    context: vscode.ExtensionContext,
    workspaceUri: vscode.Uri,
    probe: ProbeResult,
    log: (message: string) => void,
    onProgressChange: () => void
  ): Promise<void> {
    const key = workspaceUri.fsPath;
    const existing = WalkthroughPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'devTrioWalkthrough',
      'Dev-Trio Setup',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'docs')
        ]
      }
    );

    const models = await readModelClasses(context.extensionUri);
    const gifs = await resolveGifs(panel.webview, context.extensionUri);
    const filesExist = await allSkeletonFilesExist(workspaceUri);
    const hasExistingFiles = await categoryAFilesExist(workspaceUri);
    const progress = await readWizardProgress(workspaceUri);
    new WalkthroughPanel(
      panel,
      context,
      workspaceUri,
      probe,
      models,
      gifs,
      filesExist,
      hasExistingFiles,
      progress?.completedSteps,
      log,
      onProgressChange
    );
  }

  /** Clears the in-memory walkthrough state and disposes any open panel for this workspace. */
  static reset(workspaceUri: vscode.Uri): void {
    const key = workspaceUri.fsPath;
    WalkthroughPanel.states.delete(key);
    WalkthroughPanel.panels.get(key)?.panel.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly workspaceUri: vscode.Uri,
    private readonly probe: ProbeResult,
    models: ModelClasses,
    gifs: { modelPicker?: string; autopilot?: string },
    filesExist: boolean,
    hasExistingFiles: boolean,
    restoredProgress: readonly number[] | undefined,
    private readonly log: (message: string) => void,
    private readonly onProgressChange: () => void
  ) {
    this.extensionUri = context.extensionUri;
    this.workspaceState = context.workspaceState;
    const key = workspaceUri.fsPath;
    WalkthroughPanel.panels.set(key, this);

    panel.onDidDispose(() => {
      WalkthroughPanel.panels.delete(key);
    });
    panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => {
        void this.handleMessage(msg);
      },
      undefined,
      context.subscriptions
    );

    const saved = { ...DEFAULT_STATE, ...WalkthroughPanel.states.get(key) };
    if (filesExist) {
      saved.step1Done = true;
    }
    if (restoredProgress) {
      applyCompletedSteps(saved, restoredProgress);
    }
    WalkthroughPanel.states.set(key, saved);
    // Telegram is machine-scoped: notify.ps1 (%LOCALAPPDATA%\Dev-Trio) is shared by every workspace,
    // so if it already exists this machine is already configured and the wizard shouldn't re-offer setup.
    const telegramConfigured = fs.existsSync(getNotifyScriptPath());
    const agentPresence = detectAgents();
    panel.webview.html = getHtml(panel.webview, context.extensionUri, {
      isEmpty: probe.isEmpty,
      models,
      gifs,
      hasExistingFiles,
      state: saved,
      telegramConfigured,
      agentPresence,
      modelOptions: AGENT_MODEL_OPTIONS,
      modelDefaults: DEFAULT_AGENT_MODELS
    });
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'generateFiles':
        await this.generate();
        break;
      case 'copyInitPrompt':
        await this.sendInitPrompt(msg.mode === 'clipboard' ? 'clipboard' : 'auto');
        break;
      case 'setupNotifications':
        await vscode.commands.executeCommand('dev-trio.setupNotifications');
        break;
      case 'setupBackupLog':
        await vscode.commands.executeCommand('dev-trio.setupBackupLog');
        break;
      case 'openUpdateProject':
        await vscode.commands.executeCommand('dev-trio.updateProject');
        break;
      case 'persist':
        if (msg.state) {
          WalkthroughPanel.states.set(this.workspaceUri.fsPath, msg.state);
          await this.persistProgress(msg.state);
        }
        break;
      case 'agentSelectionConfirmed': {
        // GHCP gets no model overrides by design. Only store overrides for the selected agents.
        const models: AgentConfig['models'] = {};
        if (msg.claudeCode === true && msg.models?.claudeCode) {
          models.claudeCode = pickModelRoles(msg.models.claudeCode);
        }
        if (msg.codex === true && msg.models?.codex) {
          models.codex = pickModelRoles(msg.models.codex);
        }
        this.agentSelection = {
          agents: {
            ghcp: msg.ghcp === true,
            claudeCode: msg.claudeCode === true,
            codex: msg.codex === true
          },
          setupVersion: '1.0.0',
          models: models.claudeCode || models.codex ? models : undefined
        };
        break;
      }
      default:
        break;
    }
  }

  private async generate(): Promise<void> {
    try {
      const results = await generateDevTrioFiles(this.workspaceUri, this.probe, undefined, this.extensionUri, this.agentSelection);
      // Re-generating overwrites Category A files (incl. AGENTS.md), wiping any baked-in notify /
      // backup-log paths. Immediately re-apply whatever wiring was previously configured so the
      // user never has to manually re-run setup. The extra status lines are appended below the
      // file results, so the user sees the final state after re-wiring already happened.
      const rewire = await this.reWireIntegrations();
      this.log(`Dev-Trio walkthrough generated files: ${results.join(', ')}`);
      void this.panel.webview.postMessage({ type: 'filesGenerated', results, rewire });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Dev-Trio walkthrough file generation failed: ${message}`);
      void this.panel.webview.postMessage({ type: 'filesError', message });
    }
  }

  /**
   * Re-applies previously-configured wiring after a re-generate restored the placeholder templates.
   * Notification wiring is re-applied when notify.ps1 exists in the workspace root; backup-log
   * wiring when a backup log is configured. Mirrors the call pattern in notifySetup.doGenerate.
   *
   * @returns flags for the webview: whether notify/backup were restored and whether anything failed.
   */
  private async reWireIntegrations(): Promise<{ notify: boolean; backup: boolean; failed: boolean }> {
    const result = { notify: false, backup: false, failed: false };
    const projectName = path.basename(this.workspaceUri.fsPath);

    const notifyScriptUri = vscode.Uri.joinPath(this.workspaceUri, 'notify.ps1');
    let notifyExists = false;
    try {
      await vscode.workspace.fs.stat(notifyScriptUri);
      notifyExists = true;
    } catch {
      notifyExists = false;
    }
    if (notifyExists) {
      try {
        await wireNotification(this.workspaceUri, notifyScriptUri.fsPath, projectName);
        result.notify = true;
      } catch (err) {
        result.failed = true;
        this.log(`Dev-Trio re-wire notification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      if (await isBackupLogConfigured()) {
        const logUri = resolveConfiguredLogUri();
        if (logUri) {
          await wireBackupLog(this.workspaceUri, logUri.fsPath, projectName);
          result.backup = true;
        }
      }
    } catch (err) {
      result.failed = true;
      this.log(`Dev-Trio re-wire backup log failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }

  private async sendInitPrompt(mode: 'auto' | 'clipboard'): Promise<void> {
    // workbench.action.chat.open is an internal VS Code command (not in the typings) but is the
    // stable way to drive the GHCP chat panel: isPartialQuery false auto-submits, true pre-fills.
    await this.workspaceState.update(CHAT_SUBMIT_MODE_KEY, mode);
    if (mode === 'auto') {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: INITIALIZATION_PROMPT, isPartialQuery: false });
    } else {
      await vscode.env.clipboard.writeText(INITIALIZATION_PROMPT);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: INITIALIZATION_PROMPT, isPartialQuery: true });
      void vscode.window.showInformationMessage('Initialization prompt copied and pre-filled in Copilot Chat. Review and press Enter to send.');
    }
    void this.panel.webview.postMessage({ type: 'initPromptCopied' });
  }

  /** Writes the .dev-trio/initialized sentinel when the final walkthrough step is completed. */
  private async markInitialized(): Promise<void> {
    try {
      await writeInitializedSentinel(this.workspaceUri);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Dev-Trio walkthrough could not write the initialized sentinel: ${message}`);
    }
    await configureGitignore(this.workspaceUri);
  }

  /**
   * Persists walkthrough progress per workspace so a partial setup resumes after VS Code closes.
   * While steps are in progress the completed step numbers go to wizard-progress.json (and the file
   * is added to .gitignore once). Completion fires only when the final "Finish setup" step is done
   * (kickoffDone): the initialized sentinel is written and the progress file removed.
   */
  private async persistProgress(state: WalkState): Promise<void> {
    try {
      if (state.kickoffDone) {
        await this.markInitialized();
        await deleteWizardProgress(this.workspaceUri);
        this.lastWrittenSteps = '';
        this.onProgressChange();
        return;
      }
      const completed = completedStepNumbers(state);
      if (completed.length === 0) {
        return;
      }
      const signature = completed.join(',');
      if (signature === this.lastWrittenSteps) {
        return; // no change in completed steps — avoid redundant writes
      }
      this.lastWrittenSteps = signature;
      await writeWizardProgress(this.workspaceUri, completed);
      this.onProgressChange();
      if (!this.gitignoreEnsured) {
        this.gitignoreEnsured = true;
        await ensureWizardProgressGitignored(this.workspaceUri);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Dev-Trio walkthrough could not persist wizard progress: ${message}`);
    }
  }
}

async function readModelClasses(extensionUri: vscode.Uri): Promise<ModelClasses> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(extensionUri, 'media', 'model-classes.json')
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ModelClasses>;
    return {
      recommended: Array.isArray(parsed.recommended) ? parsed.recommended : [],
      use_with_caution: Array.isArray(parsed.use_with_caution) ? parsed.use_with_caution : []
    };
  } catch {
    return { recommended: [], use_with_caution: [] };
  }
}

async function resolveGifs(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): Promise<{ modelPicker?: string; autopilot?: string }> {
  const out: { modelPicker?: string; autopilot?: string } = {};
  for (const [key, file] of [
    ['modelPicker', 'model-picker.gif'],
    ['autopilot', 'autopilot.gif']
  ] as const) {
    const uri = vscode.Uri.joinPath(extensionUri, 'media', 'gifs', file);
    try {
      await vscode.workspace.fs.stat(uri);
      out[key] = webview.asWebviewUri(uri).toString();
    } catch {
      // GIF not recorded yet — leave undefined for graceful degradation.
    }
  }
  return out;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

/** Keeps only string per-role model values from a webview-supplied models block. */
function pickModelRoles(raw: AgentModelConfig): AgentModelConfig {
  const out: AgentModelConfig = {};
  if (typeof raw.planner === 'string') { out.planner = raw.planner; }
  if (typeof raw.implementer === 'string') { out.implementer = raw.implementer; }
  if (typeof raw.critic === 'string') { out.critic = raw.critic; }
  return out;
}

interface HtmlData {
  isEmpty: boolean;
  models: ModelClasses;
  gifs: { modelPicker?: string; autopilot?: string };
  hasExistingFiles: boolean;
  state: WalkState;
  telegramConfigured: boolean;
  agentPresence: AgentPresence;
  modelOptions: { claudeCode: string[]; codex: string[] };
  modelDefaults: { claudeCode: Required<AgentModelConfig>; codex: Required<AgentModelConfig> };
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, data: HtmlData): string {
  const nonce = makeNonce();
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'));
  const chatModelPickerUri = webview
    .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'docs', 'images', 'chat-model-picker.png'))
    .toString();
  const autopilotUri = webview
    .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'docs', 'images', 'autopilot-permission-setting.png'))
    .toString();
  const cspSource = webview.cspSource;
  const initial = JSON.stringify({ ...data, chatModelPickerUri, autopilotUri }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';" />
<link href="${codiconUri}" rel="stylesheet" />
<title>Dev-Trio Setup</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); padding: 18px 22px 48px; max-width: 760px; margin: 0 auto; line-height: 1.5; }
h1 { font-size: 1.5em; margin: 0 0 4px; }
.subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
.step { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
.step.future { opacity: 0.55; }
.step.current { border-color: var(--vscode-focusBorder); }
.step-autopilot.current { border-width: 2px; box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.step-header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: default; }
.step.done .step-header, .step.current .step-header { cursor: pointer; }
.badge { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; font-size: 0.85em; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.step.done .badge { background: #4CAF50; color: var(--vscode-button-foreground); }
.step-title { font-weight: 600; flex: 1 1 auto; }
.step-autopilot .step-title { font-size: 1.12em; }
.step-body { padding: 0 14px 16px 48px; display: none; }
.step.show-body .step-body { display: block; }
.muted { color: var(--vscode-descriptionForeground); }
.italic { font-style: italic; }
p { margin: 8px 0; }
ul { margin: 6px 0; padding-left: 20px; }
button { cursor: pointer; padding: 8px 16px; border: none; border-radius: 4px; margin: 6px 0; font-family: inherit; font-size: 1em; background: var(--vscode-button-background); color: var(--vscode-button-foreground); display: inline-flex; align-items: center; gap: 7px; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
label.check { display: flex; align-items: center; gap: 8px; margin: 10px 0 2px; cursor: pointer; }
input[type="checkbox"] { width: 16px; height: 16px; }
input[type="text"], textarea, select { width: 100%; box-sizing: border-box; margin: 4px 0 10px; padding: 7px 9px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; font-family: inherit; font-size: 1em; }
textarea { min-height: 64px; resize: vertical; }
.field-label { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.results { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 8px 10px; margin: 8px 0; white-space: pre-wrap; }
.file-row { display: flex; gap: 8px; align-items: baseline; line-height: 1.7; }
.file-status { flex: 0 0 auto; font-weight: 600; }
.status-created { color: #22c55e; }
.status-updated { color: #60a5fa; }
.status-preserved { color: #64748b; }
.status-merged { color: #60a5fa; }
.status-failed { color: #f87171; }
.status-rewired { color: #22c55e; }
.status-rewire-failed { color: #fbbf24; }
.regen-warning { background: rgba(255, 193, 7, 0.08); border: 1px solid rgba(255, 193, 7, 0.35); border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #fbbf24; margin: 8px 0; }
.preview { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 10px; margin: 8px 0; white-space: pre-wrap; max-height: 220px; overflow: auto; }
.callout { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-focusBorder); padding: 8px 12px; margin: 8px 0; font-size: 0.92em; }
.levels { margin: 8px 0; }
.levels div { margin: 5px 0; }
.gif { max-width: 100%; border-radius: 6px; margin: 8px 0; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
.hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
.walkthrough-img { max-width: 33%; min-width: 120px; border-radius: 6px; margin-top: 8px; }
.img-caption { font-size: 10px; color: var(--vscode-descriptionForeground, #94a3b8); margin: 6px 0 2px 0; font-style: italic; }
.full-width { width: 100%; justify-content: center; }
.or-divider { text-align: center; color: #475569; font-size: 11px; margin: 8px 0; }
.copy-confirm { color: #4CAF50; font-size: 0.9em; margin: 8px 0 2px; }
.btn-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn-secondary { background: transparent; border: 1px solid var(--vscode-button-background); color: var(--vscode-button-background); }
.btn-secondary:hover:not(:disabled) { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
select option { color: var(--vscode-input-foreground); background-color: var(--vscode-input-background); }
.prompt-timing-note { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.10); border-radius: 6px; padding: 10px 12px; font-size: 11px; color: #94a3b8; margin-top: 10px; }
.whats-next { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.whats-next-title { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
.next-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.next-done { color: #22c55e; font-size: 12px; font-weight: 500; white-space: nowrap; }
.next-left { flex: 1 1 auto; }
.next-head { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.next-desc { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.next-row button { margin: 0; flex: 0 0 auto; }
.agent-tiles { display: flex; flex-direction: column; gap: 10px; margin: 10px 0; }
.agent-tile { display: flex; gap: 10px; padding: 12px 14px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; cursor: pointer; align-items: flex-start; }
.agent-tile:hover { border-color: var(--vscode-focusBorder); }
.agent-tile.selected { border-color: var(--vscode-focusBorder); border-width: 2px; }
.agent-tile.muted { opacity: 0.6; }
.agent-tile-check { flex: 0 0 auto; font-size: 18px; margin-top: 1px; }
.agent-tile-main { flex: 1 1 auto; }
.agent-tile-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agent-tile-name { font-weight: 600; }
.agent-tile-badge { font-size: 10px; font-weight: 600; border-radius: 4px; padding: 1px 6px; }
.agent-tile-badge.detected { background: rgba(34,197,94,0.15); color: #4ade80; }
.agent-tile-badge.not-detected { background: rgba(148,163,184,0.15); color: #94a3b8; }
.agent-tile-bullets { margin: 6px 0 0; padding-left: 18px; font-size: 0.88em; color: var(--vscode-descriptionForeground); }
.agent-tile-note { font-size: 0.82em; color: #fbbf24; margin-top: 4px; }
.agent-select-warning { color: #fbbf24; font-size: 0.85em; margin: 6px 0; min-height: 1em; }
.agent-models { margin: -4px 0 6px 30px; }
.agent-models-toggle { background: none; color: var(--vscode-textLink-foreground); border: none; padding: 2px 0; margin: 0; font-size: 0.85em; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.agent-models-toggle:hover { background: none; color: var(--vscode-textLink-activeForeground); }
.agent-models-body { margin: 6px 0 2px; }
.agent-models-body.hidden { display: none; }
.agent-model-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.agent-model-label { flex: 0 0 130px; font-size: 0.82em; color: var(--vscode-descriptionForeground); }
.agent-model-select { flex: 1 1 auto; margin: 0; }
</style>
</head>
<body>
<h1>Dev-Trio Setup</h1>
<p class="subtitle">Six steps to a running Planner–Implementer–Critic loop.</p>
<div id="stepper"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const DATA = ${initial};
let state = DATA.state;
let agentSel = null;
let modelSel = null;
const modelExpanded = new Set();
const expanded = new Set();

function persist() { vscode.postMessage({ type: 'persist', state: state }); }

// Step definitions in display order. Step 4 (intent) only when greenfield.
function steps() {
  const list = [
    { id: 'agents', title: 'Choose your coding agents', done: () => state.agentsSelected },
    { id: 'files', title: 'Generate project files', done: () => state.step1Done },
    { id: 'model', title: 'Select your model', done: () => state.modelChecked },
    { id: 'autopilot', title: 'Set permissions to Autopilot', done: () => state.autopilotChecked, prominent: true }
  ];
  if (DATA.isEmpty) {
    list.push({ id: 'intent', title: 'Project intent', done: () => (state.intent.projectType || '').length > 0 });
  }
  list.push({ id: 'prompt', title: 'Send initialization prompt', done: () => state.initPromptProcessed });
  list.push({ id: 'kickoff', title: 'Optional Integrations', done: () => state.kickoffDone });
  return list;
}

function currentId() {
  for (const s of steps()) { if (!s.done()) { return s.id; } }
  return null; // all done
}

function bodyFor(id) {
  switch (id) {
    case 'agents': return agentsBody();
    case 'files': return filesBody();
    case 'model': return modelBody();
    case 'autopilot': return autopilotBody();
    case 'intent': return intentBody();
    case 'prompt': return promptBody();
    case 'kickoff': return kickoffBody();
    default: return document.createElement('div');
  }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function codicon(name) { const i = document.createElement('i'); i.className = 'codicon codicon-' + name; return i; }

function render() {
  const root = document.getElementById('stepper');
  root.textContent = '';
  const cur = currentId();
  const list = steps();
  list.forEach((s, idx) => {
    const done = s.done();
    const isCurrent = s.id === cur;
    const status = done ? 'done' : (isCurrent ? 'current' : 'future');
    const showBody = isCurrent || (done && expanded.has(s.id));

    const stepDiv = el('div', 'step ' + status + (s.prominent ? ' step-autopilot' : '') + (showBody ? ' show-body' : ''));
    const header = el('div', 'step-header');
    const badge = el('span', 'badge');
    if (done) { badge.appendChild(codicon('check')); } else { badge.textContent = String(idx + 1); }
    header.appendChild(badge);
    header.appendChild(el('span', 'step-title', s.title));
    if (done) { const chev = codicon(expanded.has(s.id) ? 'chevron-down' : 'chevron-right'); header.appendChild(chev); }
    if (done || isCurrent) {
      header.addEventListener('click', () => {
        if (s.done()) { if (expanded.has(s.id)) expanded.delete(s.id); else expanded.add(s.id); render(); }
      });
    }
    stepDiv.appendChild(header);
    const body = el('div', 'step-body');
    body.appendChild(bodyFor(s.id));
    stepDiv.appendChild(body);
    root.appendChild(stepDiv);
  });
}

function advance() { render(); persist(); }

// ---- Step bodies ----
function agentsBody() {
  const w = el('div');
  w.appendChild(el('p', 'muted', 'Choose which coding agents to set up. Detected agents are pre-selected. Pick one, two, or all three — Dev-Trio scaffolds the right files for each.'));
  const presence = DATA.agentPresence || { ghcp: false, claudeCode: false, codex: false };
  if (!agentSel) {
    agentSel = {
      ghcp: presence.ghcp || (!presence.ghcp && !presence.claudeCode && !presence.codex),
      claudeCode: presence.claudeCode,
      codex: presence.codex
    };
  }
  if (!modelSel) {
    const md = DATA.modelDefaults || { claudeCode: {}, codex: {} };
    modelSel = {
      claudeCode: Object.assign({}, md.claudeCode),
      codex: Object.assign({}, md.codex)
    };
  }
  const defs = [
    { key: 'ghcp', name: 'GitHub Copilot (Autopilot mode)', detected: presence.ghcp, bullets: ['Uses .github/agents/ role files', 'Trigger phrases in chat', 'Full tier system + built-in upgrade command'], note: '' },
    { key: 'claudeCode', name: 'Claude Code (Anthropic)', detected: presence.claudeCode, bullets: ['Uses .claude/agents/ role files', 'Native /slash commands (/dt-upgrade)', 'True subagent isolation per tier'], note: '' },
    { key: 'codex', name: 'OpenAI Codex', detected: presence.codex, bullets: ['Uses AGENTS.md + .codex/agents/ subagents', 'Shares AGENTS.md with GitHub Copilot', 'Agent sandbox required on first use'], note: 'Note: Codex prompts you to configure its sandbox the first time you use it.' }
  ];
  const tiles = el('div', 'agent-tiles');
  const warn = el('div', 'agent-select-warning'); warn.id = 'agentWarn';
  function selectedCount() { return (agentSel.ghcp ? 1 : 0) + (agentSel.claudeCode ? 1 : 0) + (agentSel.codex ? 1 : 0); }
  function paint() {
    tiles.textContent = '';
    defs.forEach((d) => {
      const on = agentSel[d.key];
      const tile = el('div', 'agent-tile' + (on ? ' selected' : '') + (d.detected ? '' : ' muted'));
      const chk = el('span', 'agent-tile-check'); chk.appendChild(codicon(on ? 'pass-filled' : 'circle-large-outline'));
      const main = el('div', 'agent-tile-main');
      const head = el('div', 'agent-tile-head');
      head.appendChild(el('span', 'agent-tile-name', d.name));
      head.appendChild(el('span', 'agent-tile-badge ' + (d.detected ? 'detected' : 'not-detected'), d.detected ? 'Detected' : 'Not detected'));
      main.appendChild(head);
      const ul = el('ul', 'agent-tile-bullets');
      d.bullets.forEach((b) => ul.appendChild(el('li', null, b)));
      main.appendChild(ul);
      if (d.note) { main.appendChild(el('div', 'agent-tile-note', d.note)); }
      tile.appendChild(chk); tile.appendChild(main);
      tile.addEventListener('click', () => {
        if (on && selectedCount() === 1) { warn.textContent = 'Select at least one to continue'; return; }
        agentSel[d.key] = !on; warn.textContent = ''; paint();
      });
      tiles.appendChild(tile);
      if ((d.key === 'claudeCode' || d.key === 'codex') && on) {
        tiles.appendChild(buildModelConfig(d.key));
      }
    });
  }
  paint();
  w.appendChild(tiles);
  w.appendChild(warn);
  const btn = el('button', 'full-width'); btn.appendChild(codicon('arrow-right')); btn.appendChild(el('span', null, 'Continue'));
  btn.addEventListener('click', () => {
    if (selectedCount() === 0) { warn.textContent = 'Select at least one to continue'; return; }
    vscode.postMessage({ type: 'agentSelectionConfirmed', ghcp: agentSel.ghcp, claudeCode: agentSel.claudeCode, codex: agentSel.codex, models: { claudeCode: modelSel.claudeCode, codex: modelSel.codex } });
    state.agentsSelected = true; advance();
  });
  w.appendChild(btn);
  return w;
}

function buildModelConfig(agentKey) {
  const wrap = el('div', 'agent-models');
  const toggle = el('button', 'agent-models-toggle');
  const open = modelExpanded.has(agentKey);
  const chev = codicon(open ? 'chevron-down' : 'chevron-right');
  toggle.appendChild(el('span', null, 'Configure models'));
  toggle.appendChild(chev);
  const body = el('div', 'agent-models-body' + (open ? '' : ' hidden'));
  const opts = (DATA.modelOptions && DATA.modelOptions[agentKey]) || [];
  const roles = [['planner', 'Planner model'], ['implementer', 'Implementer model'], ['critic', 'Critic model']];
  roles.forEach((pair) => {
    const role = pair[0];
    const row = el('div', 'agent-model-row');
    row.appendChild(el('label', 'agent-model-label', pair[1]));
    const sel = document.createElement('select');
    sel.className = 'agent-model-select';
    opts.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if (modelSel[agentKey][role] === o) { opt.selected = true; }
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => { modelSel[agentKey][role] = sel.value; });
    row.appendChild(sel);
    body.appendChild(row);
  });
  toggle.addEventListener('click', () => {
    if (modelExpanded.has(agentKey)) { modelExpanded.delete(agentKey); body.classList.add('hidden'); chev.className = 'codicon codicon-chevron-right'; }
    else { modelExpanded.add(agentKey); body.classList.remove('hidden'); chev.className = 'codicon codicon-chevron-down'; }
  });
  wrap.appendChild(toggle); wrap.appendChild(body);
  return wrap;
}

function filesBody() {
  const w = el('div');
  w.appendChild(el('p', 'muted', 'Dev-Trio will create the agent configuration files in your workspace.'));
  if (DATA.hasExistingFiles) {
    w.appendChild(el('div', 'regen-warning', '⚠ Re-generating will update your agent configuration files to the latest templates. A timestamped backup of each file will be created. If you have previously configured notifications or backup logging, those integrations will need to be re-configured after re-generating.'));
  }
  const btn = el('button'); btn.appendChild(codicon('new-file')); btn.appendChild(el('span', null, 'Generate files'));
  btn.addEventListener('click', () => { btn.disabled = true; vscode.postMessage({ type: 'generateFiles' }); });
  w.appendChild(btn);
  if (DATA.hasExistingFiles) {
    w.appendChild(el('p', 'or-divider', '— or —'));
    const upBtn = el('button', 'full-width'); upBtn.appendChild(codicon('cloud-download')); upBtn.appendChild(el('span', null, 'Upgrade to latest version'));
    upBtn.addEventListener('click', () => vscode.postMessage({ type: 'openUpdateProject', action: 'upgrade' }));
    w.appendChild(upBtn);
    const refBtn = el('button', 'full-width'); refBtn.appendChild(codicon('refresh')); refBtn.appendChild(el('span', null, 'Refresh project files'));
    refBtn.addEventListener('click', () => vscode.postMessage({ type: 'openUpdateProject', action: 'refresh' }));
    w.appendChild(refBtn);
  }
  const out = el('div', 'results'); out.id = 'filesResults'; out.style.display = 'none';
  w.appendChild(out);
  return w;
}

function modelBody() {
  const w = el('div');
  w.appendChild(el('p', null, 'In the GitHub Copilot Chat panel, find the model selector in the footer of the chat input area (bottom of the panel, left of the send button). Click it and select a model that supports agent tool use and multi-step orchestration.'));
  if (DATA.models.recommended.length) {
    w.appendChild(el('p', 'field-label', 'Recommended'));
    const ul = el('ul'); DATA.models.recommended.forEach((m) => ul.appendChild(el('li', null, m))); w.appendChild(ul);
  }
  if (DATA.models.use_with_caution.length) {
    w.appendChild(el('p', 'field-label', 'Use with caution'));
    const ul = el('ul'); DATA.models.use_with_caution.forEach((m) => ul.appendChild(el('li', null, m))); w.appendChild(ul);
  }
  const cap = el('p', 'img-caption'); cap.appendChild(el('em', null, 'Example only — this is not interactive')); w.appendChild(cap);
  const img = document.createElement('img'); img.className = 'walkthrough-img'; img.src = DATA.chatModelPickerUri; img.alt = 'Model picker location'; w.appendChild(img);
  w.appendChild(checkbox('modelChecked', "I've selected my model ✓"));
  return w;
}

function autopilotBody() {
  const w = el('div');
  w.appendChild(el('p', null, 'The Autopilot permission selector is in the footer of the GitHub Copilot Chat input area, directly next to the model selector. Click it and set permissions to Autopilot mode to allow agents to run without requiring approval for every file edit, terminal command, and tool call.'));
  const levels = el('div', 'levels');
  const mk = (t, d) => { const row = el('div'); const b = el('strong', null, t); row.appendChild(b); row.appendChild(el('span', null, ' — ' + d)); return row; };
  levels.appendChild(mk('Default Approvals', 'every action needs manual approval. Dev-Trio cannot run autonomously.'));
  levels.appendChild(mk('Bypass Approvals', 'actions auto-approved; the agent can still stall on unexpected input.'));
  levels.appendChild(mk('Autopilot', 'required. Auto-responds to blocking questions, auto-retries errors, enables unattended continuous runs.'));
  w.appendChild(levels);
  const cap = el('p', 'img-caption'); cap.appendChild(el('em', null, 'Example only — this is not interactive')); w.appendChild(cap);
  const img = document.createElement('img'); img.className = 'walkthrough-img'; img.src = DATA.autopilotUri; img.alt = 'Autopilot permission setting'; w.appendChild(img);
  w.appendChild(checkbox('autopilotChecked', "I've set Autopilot ✓"));
  return w;
}

function intentBody() {
  const w = el('div');
  w.appendChild(el('p', 'field-label', 'Project type'));
  const sel = el('select'); sel.id = 'intentType';
  ['', 'Web app', 'CLI tool', 'Script collection', 'API / backend', 'Library / SDK', 'Dashboard', '.NET application', 'Node.js API', 'Monorepo', 'Not sure yet'].forEach((o) => {
    const opt = el('option', null, o === '' ? 'Select a project type…' : o); opt.value = o; sel.appendChild(opt);
  });
  sel.value = state.intent.projectType || '';
  sel.addEventListener('change', () => { state.intent.projectType = sel.value; advance(); });
  w.appendChild(sel);

  w.appendChild(el('p', 'field-label', 'Primary language(s) — comma separated'));
  const lang = el('input'); lang.type = 'text'; lang.placeholder = 'TypeScript, JavaScript, Python, PowerShell, C#, Go, Rust, Java, Other';
  lang.value = state.intent.languages || '';
  lang.addEventListener('input', () => { state.intent.languages = lang.value; persist(); });
  w.appendChild(lang);

  w.appendChild(el('p', 'field-label', 'What are you building?'));
  const desc = el('textarea'); desc.placeholder = 'Brief description of your project';
  desc.value = state.intent.description || '';
  desc.addEventListener('input', () => { state.intent.description = desc.value; persist(); });
  w.appendChild(desc);

  w.appendChild(el('p', 'hint', 'Select a project type to continue.'));
  return w;
}

function promptBody() {
  const w = el('div');
  if (DATA.isEmpty) {
    w.appendChild(el('p', null, 'This sends the Dev-Trio initialization prompt to GitHub Copilot Chat. The Planner will analyze your workspace and set everything up.'));
    const sum = el('div', 'callout');
    sum.appendChild(el('div', null, 'Type: ' + (state.intent.projectType || '(not set)')));
    sum.appendChild(el('div', null, 'Languages: ' + (state.intent.languages || '(not set)')));
    w.appendChild(sum);
  } else {
    w.appendChild(el('p', null, 'This sends the Dev-Trio initialization prompt to GitHub Copilot Chat. The Planner will read the real code and set everything up.'));
  }
  const sendBtn = el('button'); sendBtn.id = 'sendPromptBtn'; sendBtn.appendChild(codicon('send')); sendBtn.appendChild(el('span', null, 'Send to Copilot'));
  sendBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'copyInitPrompt', mode: 'auto' });
  });
  const copyBtn = el('button', 'btn-secondary'); copyBtn.textContent = 'Copy to clipboard';
  copyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'copyInitPrompt', mode: 'clipboard' });
  });
  const btnRow = el('div', 'btn-row'); btnRow.appendChild(sendBtn); btnRow.appendChild(copyBtn);
  w.appendChild(btnRow);
  const confirm = el('div', 'copy-confirm', '\u2713 Opened in Copilot Chat'); confirm.id = 'promptCopiedMsg'; confirm.style.display = 'none';
  w.appendChild(confirm);
  w.appendChild(el('p', 'hint', 'Dev-Trio opens Copilot Chat and submits this for you (or use the link to copy it and paste manually). Copilot will analyze your project and generate your dev-trio configuration.'));
  w.appendChild(el('div', 'prompt-timing-note', 'Note: The initialization prompt is comprehensive and detailed. Expect Copilot to take between 15 and 60 minutes to fully process it depending on your project size and model. Do not interrupt the session while it is running.'));
  w.appendChild(checkbox('initPromptProcessed', 'Copilot has finished processing the initialization prompt and I am ready to configure optional integrations'));
  return w;
}

function kickoffBody() {
  const w = el('div');
  // Step 5 auto-completes the moment the Optional Integrations step actually becomes visible
  // (it is the current step). Guard so the persist fires once, not on every hidden rebuild.
  if (currentId() === 'kickoff' && !state.integrationsViewed) { state.integrationsViewed = true; persist(); }
  w.appendChild(el('p', null, 'Set up notifications and chat backup logging. Both are optional but recommended — they let you step away while the dev-trio runs and return to a full activity record.'));

  const next = el('div', 'whats-next');
  next.appendChild(el('p', 'whats-next-title', "What's next? (optional)"));
  if (DATA.telegramConfigured) {
    next.appendChild(nextRowDone('bell', 'Telegram notifications already configured on this machine (notify.ps1 found)', 'Machine-scoped, not workspace-scoped — all Dev-Trio workspaces share the same settings (on = on for all, off = off for all). No setup needed here.'));
  } else {
    next.appendChild(nextRow('bell', 'Set up Telegram notifications', 'Get notified on your phone when the trio needs you.', 'setupNotifications'));
  }
  next.appendChild(nextRow('output', 'Set up chat backup log', 'Keep a running record of every dev-trio session.', 'setupBackupLog'));
  w.appendChild(next);

  // Completion trigger: integrations are optional, so this button is always available here.
  const finishBtn = el('button', 'full-width'); finishBtn.id = 'finishSetupBtn';
  finishBtn.appendChild(codicon('check')); finishBtn.appendChild(el('span', null, 'Finish setup'));
  finishBtn.addEventListener('click', () => { state.kickoffDone = true; advance(); });
  w.appendChild(finishBtn);
  return w;
}

function nextRow(icon, label, desc, cmd) {
  const row = el('div', 'next-row');
  const left = el('div', 'next-left');
  const head = el('div', 'next-head');
  head.appendChild(codicon(icon));
  head.appendChild(el('span', null, label));
  left.appendChild(head);
  left.appendChild(el('div', 'next-desc', desc));
  const btn = el('button', 'secondary'); btn.appendChild(el('span', null, 'Set up →'));
  btn.addEventListener('click', () => vscode.postMessage({ type: cmd }));
  row.appendChild(left); row.appendChild(btn);
  return row;
}

function nextRowDone(icon, label, desc) {
  const row = el('div', 'next-row');
  const left = el('div', 'next-left');
  const head = el('div', 'next-head');
  head.appendChild(codicon(icon));
  head.appendChild(el('span', null, label));
  left.appendChild(head);
  left.appendChild(el('div', 'next-desc', desc));
  const done = el('span', 'next-done'); done.textContent = '✓ Configured';
  row.appendChild(left); row.appendChild(done);
  return row;
}

// ---- Shared widgets ----
function checkbox(key, labelText) {
  const lab = el('label', 'check');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!state[key];
  cb.addEventListener('change', () => { state[key] = cb.checked; advance(); });
  lab.appendChild(cb); lab.appendChild(el('span', null, labelText));
  return lab;
}
function gifOrText(uri, alt) {
  if (uri) { const img = document.createElement('img'); img.className = 'gif'; img.src = uri; img.alt = alt; return img; }
  return el('p', 'muted italic', '(Screenshot coming — see README for guidance)');
}
function flash(btn, text) {
  const span = btn.querySelector('span'); const icon = btn.querySelector('.codicon');
  const ot = span ? span.textContent : ''; const oi = icon ? icon.className : '';
  if (span) span.textContent = text; if (icon) icon.className = 'codicon codicon-check';
  setTimeout(() => { if (span) span.textContent = ot; if (icon) icon.className = oi; }, 1500);
}

function statusClassFor(tag) {
  switch (tag) {
    case 'created': return 'status-created';
    case 'updated': return 'status-updated';
    case 'preserved': return 'status-preserved';
    case 'merged': return 'status-merged';
    case 'backup-failed': return 'status-failed';
    default: return '';
  }
}

// Renders the "[status] <path>" result lines with a colored status label per file, then any
// integration re-wiring outcome lines.
function renderFileResults(results, rewire) {
  const out = document.getElementById('filesResults');
  if (!out) { return; }
  out.style.display = 'block';
  out.textContent = '';
  for (const line of results) {
    const match = /^\\[([^\\]]+)\\]\\s*(.*)$/.exec(line);
    const row = el('div', 'file-row');
    if (match) {
      row.appendChild(el('span', 'file-status ' + statusClassFor(match[1]), '[' + match[1] + ']'));
      row.appendChild(el('span', null, match[2]));
    } else {
      row.appendChild(el('span', null, line));
    }
    out.appendChild(row);
  }
  if (rewire) {
    if (rewire.failed) {
      const row = el('div', 'file-row');
      row.appendChild(el('span', 'file-status status-rewire-failed', '⚠ Wiring could not be restored — re-configure integrations'));
      out.appendChild(row);
    }
    if (rewire.notify) {
      const row = el('div', 'file-row');
      row.appendChild(el('span', 'file-status status-rewired', '✓ Notification wiring restored (notify.ps1)'));
      out.appendChild(row);
    }
    if (rewire.backup) {
      const row = el('div', 'file-row');
      row.appendChild(el('span', 'file-status status-rewired', '✓ Backup log wiring restored'));
      out.appendChild(row);
    }
  }
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'filesGenerated') {
    state.step1Done = true; advance();
    renderFileResults(m.results, m.rewire);
  } else if (m.type === 'filesError') {
    const out = document.getElementById('filesResults');
    if (out) { out.style.display = 'block'; out.textContent = 'Error: ' + m.message; }
  } else if (m.type === 'initPromptCopied') {
    state.promptCopied = true;
    persist();
    const note = document.getElementById('promptCopiedMsg');
    if (note) {
      note.style.display = 'block';
      setTimeout(function () {
        const later = document.getElementById('promptCopiedMsg');
        if (later) { later.style.display = 'none'; }
      }, 2500);
    }
  }
});

render();
</script>
</body>
</html>`;
}

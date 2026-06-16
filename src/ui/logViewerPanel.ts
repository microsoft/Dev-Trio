import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { resolveConfiguredLogUri, isValidDevTrioLog, backupLogFile } from '../logging/backupLog';
import { enrichLogEntries } from '../credits/creditReader';
import type { CreditData } from '../credits/types';

const EMPTY_MESSAGE =
  'No session log entries yet. Configure backup logging in the Integrations section to start recording sessions.';

/** Lazily-created 'Dev-Trio Session Log' diagnostic channel (one instance, disposed with the extension). */
let sessionLogDiagChannel: vscode.OutputChannel | undefined;
function getSessionLogDiagChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!sessionLogDiagChannel) {
    sessionLogDiagChannel = vscode.window.createOutputChannel('Dev-Trio Session Log');
    context.subscriptions.push(sessionLogDiagChannel);
  }
  return sessionLogDiagChannel;
}

/** Inbound messages from the Session Log webview (header action buttons). */
interface InboundMessage {
  type: string;
  timestamps?: string[];
  url?: string;
  generation?: number;
}

/** A single parsed dev-trio cycle from the backup log. */
export interface LogEntry {
  timestamp: string;
  project: string;
  title: string;
  result: string;
  category: string;
  fields: { label: string; value: string }[];
}

/** Data the Session Log webview renders. `emptyMessage` is non-null when there are no cards to show. */
interface LogViewerData {
  entries: LogEntry[];
  emptyMessage: string | null;
  cleared: boolean;
  errorDetail: string | null;
  logPath: string;
  entryCount: number;
}

/** Matches an entry header line and captures the timestamp (group 1) and project name (group 2). */
const ENTRY_HEADER = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] DEV-TRIO \| (.+?) \(planner-logged/;

/**
 * The field labels recognized inside an entry, ordered longest-first so "PLANNER (close)" is
 * matched before "PLANNER" (the latter is a prefix of the former).
 */
const FIELD_LABELS: readonly string[] = [
  'PROMPT',
  'PLANNER (close)',
  'PLANNER',
  'IMPLEMENTER',
  'CRITIC',
  'TIERS',
  'RESULT',
  'CREDITS'
];

/** Returns the field label a line starts with (e.g. "PROMPT" for "PROMPT: ..."), or undefined. */
function matchFieldLabel(line: string): string | undefined {
  for (const label of FIELD_LABELS) {
    if (line.startsWith(label + ':')) {
      return label;
    }
  }
  return undefined;
}

/** Max length of the PROMPT-derived entry title before truncation. */
const MAX_TITLE_LENGTH = 80;

/** First line of the PROMPT field, truncated to MAX_TITLE_LENGTH with an ellipsis; falls back to `fallback`. */
function deriveTitle(fields: { label: string; value: string }[], fallback: string): string {
  const promptField = fields.find((f) => f.label === 'PROMPT');
  const firstLine = promptField ? promptField.value.split('\n')[0].trim() : '';
  if (!firstLine) {
    return fallback;
  }
  return firstLine.length > MAX_TITLE_LENGTH ? firstLine.slice(0, MAX_TITLE_LENGTH) + '...' : firstLine;
}

/** Maps a RESULT text to a display category used for the card badge color. */
function categorizeResult(result: string): string {
  const upper = result.toUpperCase();
  if (upper.includes('TASK COMPLETE')) {
    return 'complete';
  }
  if (upper.includes('DECISION NEEDED')) {
    return 'progress';
  }
  if (upper.includes('ERROR')) {
    return 'error';
  }
  return 'neutral';
}

/**
 * Parses the raw backup-log text into entries, newest-first (reverse file order).
 *
 * An entry begins at a line matching {@link ENTRY_HEADER}. Within an entry, fields are introduced
 * by a known label prefix at line start; a field's value runs until the next known label line or
 * the next entry header. Field values may span multiple lines (joined with newlines). Pure and
 * side-effect free so it can be unit-tested independently of the webview.
 */
export function parseLogEntries(text: string): LogEntry[] {
  // Normalize line endings first so CRLF (e.g. OneDrive) and lone-CR files parse identically to LF.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  interface RawEntry {
    timestamp: string;
    project: string;
    fields: { label: string; value: string }[];
  }
  const entries: RawEntry[] = [];
  let current: RawEntry | undefined;
  let fieldLabel: string | undefined;
  let fieldLines: string[] = [];

  const flushField = (): void => {
    if (current && fieldLabel !== undefined) {
      current.fields.push({ label: fieldLabel, value: fieldLines.join('\n').trim() });
    }
    fieldLabel = undefined;
    fieldLines = [];
  };

  for (const line of text.split('\n')) {
    const headerMatch = ENTRY_HEADER.exec(line);
    if (headerMatch) {
      flushField();
      if (current) {
        entries.push(current);
      }
      current = { timestamp: headerMatch[1], project: headerMatch[2].trim(), fields: [] };
      continue;
    }
    if (!current) {
      continue; // skip the file header / any preamble before the first entry
    }
    const label = matchFieldLabel(line);
    if (label) {
      flushField();
      fieldLabel = label;
      fieldLines = [line.slice(label.length + 1)];
      continue;
    }
    if (fieldLabel !== undefined) {
      fieldLines.push(line);
    }
  }
  flushField();
  if (current) {
    entries.push(current);
  }

  const parsed: LogEntry[] = entries.map((e) => {
    const resultField = e.fields.find((f) => f.label === 'RESULT');
    const resultText = resultField ? resultField.value : '';
    return {
      timestamp: e.timestamp,
      project: e.project,
      title: deriveTitle(e.fields, e.project),
      result: resultText,
      category: categorizeResult(resultText),
      fields: e.fields
    };
  });
  return parsed.reverse();
}

/**
 * Read-only viewer for the dev-trio session/backup log — a WebviewPanel beside the active editor.
 * Singleton per workspace: re-invoking reveals the existing panel. The log is resolved fresh each
 * time a new panel is created.
 */
export class LogViewerPanel {
  private static readonly panels = new Map<string, LogViewerPanel>();

  private webviewReady = false;
  private renderGeneration = 0;
  private pendingCredits:
    | { generation: number; entries: { timestamp: string; credits: CreditData | null }[]; snapshotMaxMs: number | null }
    | undefined;

  static async createOrShow(
    context: vscode.ExtensionContext,
    workspaceUri: vscode.Uri,
    creditsLog?: (m: string) => void
  ): Promise<void> {
    const diagChannel = getSessionLogDiagChannel(context);
    const diagUri = resolveConfiguredLogUri();
    diagChannel.appendLine('=== SESSION LOG DIAGNOSTIC ===');
    diagChannel.appendLine('workspaceUri: ' + (workspaceUri?.fsPath ?? 'null'));
    diagChannel.appendLine('resolveConfiguredLogUri result: ' + (diagUri?.fsPath ?? 'null'));
    diagChannel.appendLine('timestamp: ' + new Date().toISOString());
    diagChannel.show(true);

    const key = workspaceUri.fsPath;
    const existing = LogViewerPanel.panels.get(key);
    if (existing) {
      await existing.reload();
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const data = await LogViewerPanel.resolveData(workspaceUri, creditsLog);
    const panel = vscode.window.createWebviewPanel(
      'devTrioLogViewer',
      'Session Log',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    new LogViewerPanel(panel, context, key, data, workspaceUri, creditsLog);
  }

  /** Resolves the configured log and parses it, choosing the appropriate empty state when needed. */
  private static async resolveData(
    workspaceUri: vscode.Uri,
    log?: (m: string) => void
  ): Promise<LogViewerData> {
    const logUri = resolveConfiguredLogUri();
    log?.('[LogViewer] resolved log URI: ' + (logUri ? logUri.fsPath : 'null'));
    if (!logUri) {
      return {
        entries: [],
        emptyMessage: null,
        cleared: false,
        errorDetail: 'Backup log not configured. resolveConfiguredLogUri() returned null.',
        logPath: 'not configured',
        entryCount: 0
      };
    }
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(logUri));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log?.('[LogViewer] failed to read ' + logUri.fsPath + ' — ' + detail);
      return {
        entries: [],
        emptyMessage: null,
        cleared: false,
        errorDetail: 'Could not read ' + logUri.fsPath + ' — ' + detail,
        logPath: logUri.fsPath,
        entryCount: 0
      };
    }
    const parsed = parseLogEntries(text);
    const hidden = new Set(await LogViewerPanel.readHiddenArray(workspaceUri));
    const filtered = parsed.filter((e) => !hidden.has(e.timestamp));
    const cleared = hidden.size > 0 && filtered.length === 0 && parsed.length > 0;
    sessionLogDiagChannel?.appendLine('parseLogEntries result: ' + parsed.length + ' entries from ' + text.length + ' chars');
    sessionLogDiagChannel?.appendLine('hidden entries: ' + hidden.size);
    sessionLogDiagChannel?.appendLine('visible entries after filter: ' + filtered.length);
    return {
      entries: filtered,
      emptyMessage: parsed.length === 0 ? EMPTY_MESSAGE : null,
      cleared,
      errorDetail: null,
      logPath: logUri.fsPath,
      entryCount: parsed.length
    };
  }

  /** URI of the per-workspace hidden-entries marker (soft-deleted Session Log timestamps). */
  private static hiddenEntriesUri(workspaceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceUri, '.dev-trio', 'hidden-entries.json');
  }

  /** Reads the hidden-entries timestamp array via workspace.fs; returns [] on any error. */
  private static async readHiddenArray(workspaceUri: vscode.Uri): Promise<string[]> {
    try {
      const decoded = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(LogViewerPanel.hiddenEntriesUri(workspaceUri))
      );
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    key: string,
    data: LogViewerData,
    private readonly workspaceUri: vscode.Uri,
    private readonly creditsLog?: (m: string) => void
  ) {
    LogViewerPanel.panels.set(key, this);
    panel.onDidDispose(() => {
      LogViewerPanel.panels.delete(key);
      this.pendingCredits = undefined;
    });
    panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg), undefined, context.subscriptions);
    const generation = this.renderHtml(data);
    if (data.entries.length > 0) {
      void this.loadCredits(data.entries, generation);
    }
  }

  private renderHtml(data: LogViewerData): number {
    this.renderGeneration += 1;
    this.webviewReady = false;
    this.pendingCredits = undefined;
    this.panel.webview.html = getHtml(this.panel.webview, this.context.extensionUri, data, this.renderGeneration);
    return this.renderGeneration;
  }

  private flushPendingCredits(): void {
    if (!this.webviewReady || !this.pendingCredits) {
      return;
    }
    if (this.pendingCredits.generation !== this.renderGeneration) {
      this.pendingCredits = undefined;
      return;
    }
    const pending = this.pendingCredits;
    this.pendingCredits = undefined;
    void this.panel.webview.postMessage({ type: 'creditsReady', entries: pending.entries, snapshotMaxMs: pending.snapshotMaxMs });
  }

  /**
   * Non-blocking credit enrichment: runs after the panel HTML is already shown, then posts the
   * per-entry credit data to the webview, which swaps each loading pill for a real one.
   */
  private async loadCredits(entries: LogEntry[], generation: number): Promise<void> {
    const { entries: enriched, snapshotMaxMs } = await enrichLogEntries(this.workspaceUri, entries, this.creditsLog);
    if (generation !== this.renderGeneration) {
      return;
    }
    const payload: { timestamp: string; credits: CreditData | null }[] = enriched.map((e) => ({
      timestamp: e.timestamp,
      credits: e.credits
    }));
    if (this.webviewReady) {
      void this.panel.webview.postMessage({ type: 'creditsReady', entries: payload, snapshotMaxMs });
      return;
    }
    this.pendingCredits = { generation, entries: payload, snapshotMaxMs };
  }

  /** Re-resolves the log from disk and rebuilds the entire webview HTML with the fresh data embedded.
   *  Replacing webview.html (instead of postMessage) guarantees a clean render on every Refresh/re-open. */
  private async reload(): Promise<void> {
    const data = await LogViewerPanel.resolveData(this.workspaceUri, this.creditsLog);
    const generation = this.renderHtml(data);
    if (data.entries.length > 0) {
      void this.loadCredits(data.entries, generation);
    }
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'webviewReady':
        if (msg.generation !== this.renderGeneration) {
          return;
        }
        this.webviewReady = true;
        this.flushPendingCredits();
        return;
      case 'exportLog': {
        const logUri = resolveConfiguredLogUri();
        if (!logUri) {
          void vscode.window.showInformationMessage('Backup log not configured or file not found. Set up backup logging in the Integrations section.');
          return;
        }
        try {
          const content = await vscode.workspace.fs.readFile(logUri);
          const dest = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Desktop', 'dev-trio-session-log.md')),
            filters: { Markdown: ['md'], 'PDF (print to PDF)': ['pdf'] },
            title: 'Export Session Log'
          });
          if (!dest) {
            return;
          }
          if (dest.fsPath.toLowerCase().endsWith('.pdf')) {
            void this.panel.webview.postMessage({ type: 'exportPdf' });
            return;
          }
          await vscode.workspace.fs.writeFile(dest, content);
          void vscode.window.showInformationMessage('Session log exported successfully.');
        } catch {
          void vscode.window.showErrorMessage('Export failed — could not write to the selected path.');
        }
        break;
      }
      case 'clearLog': {
        const choice = await vscode.window.showWarningMessage(
          'Clear log view?',
          {
            modal: true,
            detail:
              'This hides all current entries from the Session Log panel. Your backup log file is not modified — all entries remain in _backup/Dev_Trio_Chat_Backup.md and can be restored at any time.'
          },
          'Clear view',
          'Cancel'
        );
        if (choice !== 'Clear view') {
          return;
        }
        const timestamps = Array.isArray(msg.timestamps) ? msg.timestamps : [];
        const existing = await LogViewerPanel.readHiddenArray(this.workspaceUri);
        const union = Array.from(new Set([...existing, ...timestamps]));
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.workspaceUri, '.dev-trio'));
          await vscode.workspace.fs.writeFile(
            LogViewerPanel.hiddenEntriesUri(this.workspaceUri),
            new TextEncoder().encode(JSON.stringify(union, null, 2))
          );
          await this.reload();
        } catch {
          void vscode.window.showErrorMessage('Could not clear the session log view.');
        }
        break;
      }
      case 'restoreEntries': {
        try {
          await vscode.workspace.fs.delete(LogViewerPanel.hiddenEntriesUri(this.workspaceUri));
        } catch {
          // Marker may not exist — nothing to restore from disk, which is fine.
        }
        await this.reload();
        break;
      }
      case 'refreshLog': {
        await this.reload();
        break;
      }
      case 'restoreLog': {
        await this.restoreLog();
        break;
      }
      case 'openLogFile': {
        const logUri = resolveConfiguredLogUri();
        if (!logUri) {
          void vscode.window.showInformationMessage('Backup log not configured or file not found. Set up backup logging in the Integrations section.');
          return;
        }
        void vscode.commands.executeCommand('markdown.showPreview', logUri);
        break;
      }
      case 'openExternal': {
        if (msg.url && msg.url.startsWith('https://github.com/microsoft/')) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      }
      default:
        break;
    }
  }

  /** Restore flow: pick a .md log, validate the sentinel, then append (valid) or offer overwrite (invalid). */
  private async restoreLog(): Promise<void> {
    for (;;) {
      const picked = await vscode.window.showOpenDialog({
        title: 'Select Dev-Trio Session Log to Restore',
        filters: { Markdown: ['md'] },
        canSelectMany: false,
        openLabel: 'Restore'
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const selectedUri = picked[0];
      if (await isValidDevTrioLog(selectedUri)) {
        await this.restoreAppend(selectedUri);
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        'Invalid Dev-Trio Log Format',
        {
          modal: true,
          detail:
            'The selected file does not appear to be a Dev-Trio session log (missing format sentinel on line 1). How would you like to proceed?'
        },
        'Point to a Different File',
        'Overwrite and Start Fresh'
      );
      if (choice === 'Point to a Different File') {
        continue;
      }
      if (choice === 'Overwrite and Start Fresh') {
        await this.restoreOverwrite(selectedUri);
        return;
      }
      return;
    }
  }

  /** Append the selected (validated) log to the configured log, then reload. */
  private async restoreAppend(selectedUri: vscode.Uri): Promise<void> {
    const configuredUri = resolveConfiguredLogUri();
    if (!configuredUri) {
      void vscode.window.showWarningMessage('Backup log not configured. Set up backup logging in the Integrations section first.');
      return;
    }
    try {
      const selected = new TextDecoder().decode(await vscode.workspace.fs.readFile(selectedUri));
      const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(configuredUri));
      await vscode.workspace.fs.writeFile(configuredUri, new TextEncoder().encode(current + '\n' + selected));
      void vscode.window.showInformationMessage('Session log restored successfully. Refreshing...');
      await this.reload();
    } catch (err) {
      void vscode.window.showErrorMessage('Could not restore the session log — ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** Back up the configured log, then overwrite it with the selected file, then reload. */
  private async restoreOverwrite(selectedUri: vscode.Uri): Promise<void> {
    const configuredUri = resolveConfiguredLogUri();
    if (!configuredUri) {
      void vscode.window.showWarningMessage('Backup log not configured. Set up backup logging in the Integrations section first.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      'Replace Current Session Log?',
      {
        modal: true,
        detail:
          'The current log at ' + configuredUri.fsPath + ' will be backed up first, then replaced with the selected file. This cannot be undone. Continue?'
      },
      'Replace'
    );
    if (confirm !== 'Replace') {
      return;
    }
    let backupUri: vscode.Uri;
    try {
      backupUri = await backupLogFile(configuredUri);
    } catch (err) {
      void vscode.window.showErrorMessage('Could not back up the current log — overwrite aborted. ' + (err instanceof Error ? err.message : String(err)));
      return;
    }
    try {
      await vscode.workspace.fs.copy(selectedUri, configuredUri, { overwrite: true });
      void vscode.window.showInformationMessage('Log backed up to ' + backupUri.fsPath + ' and replaced successfully. Refreshing...');
      await this.reload();
    } catch (err) {
      void vscode.window.showErrorMessage('Could not replace the session log — ' + (err instanceof Error ? err.message : String(err)));
    }
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

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, data: LogViewerData, generation: number): string {
  const nonce = makeNonce();
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logViewer.js'));
  const cspSource = webview.cspSource;
  const initial = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}' ${cspSource};" />
<script type="application/json" id="__INIT_DATA__">${initial}</script>
<script nonce="${nonce}">const RENDER_GENERATION = ${generation};</script>
<link href="${codiconUri}" rel="stylesheet" />
<title>Session Log</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #f0f4f8; font-family: var(--vscode-font-family); font-size: 13px; }
.codicon { font-size: 14px; line-height: 1; }
.wrap { max-width: 800px; margin: 0 auto; padding: 20px 16px 40px; }
.card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; cursor: pointer; user-select: none; }
.card-head:hover { background: rgba(255,255,255,0.03); }
.card-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.card-ts { font-size: 11px; color: #64748b; flex: 0 0 auto; font-family: var(--vscode-editor-font-family, monospace); }
.card-sub { font-size: 11px; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); }
.card-proj { font-size: 13px; color: #f0f4f8; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-head-right { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.badge { border-radius: 5px; padding: 3px 9px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
.badge.complete { background: rgba(34,197,94,0.15); color: #4ade80; }
.badge.error { background: rgba(239,68,68,0.15); color: #f87171; }
.badge.progress { background: rgba(245,158,11,0.15); color: #fbbf24; }
.badge.neutral { background: rgba(255,255,255,0.08); color: #94a3b8; }
.card-chev { color: #94a3b8; font-size: 16px; }
.card-body { display: none; padding: 4px 14px 14px; border-top: 1px solid rgba(255,255,255,0.08); }
.card-body.expanded { display: block; }
.field { border-left: 2px solid rgba(96,165,250,0.4); padding: 2px 0 2px 12px; margin-top: 12px; }
.field-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #60a5fa; margin-bottom: 4px; }
.field-value { font-size: 12px; color: #cbd5e1; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.empty { text-align: center; padding: 60px 20px; }
.empty-icon { font-size: 32px; color: #475569; }
.empty-msg { font-size: 13px; color: #94a3b8; margin-top: 14px; line-height: 1.5; max-width: 420px; margin-left: auto; margin-right: auto; }
.panel-header { border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 16px; margin-bottom: 16px; }
.ph-title { font-size: 16px; font-weight: 700; color: #f0f4f8; }
.ph-subtitle { font-size: 12px; color: #94a3b8; line-height: 1.5; margin: 8px 0 0; }
.ph-actions { display: flex; gap: 12px; margin-top: 12px; align-items: center; }
.open-source-link { color: #60a5fa; font-size: 12px; text-decoration: none; cursor: pointer; }
.open-source-link:hover { text-decoration: underline; }
.export-btn { border: 1px solid rgba(255,255,255,0.18); background: transparent; color: #cbd5e1; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
.expand-entries-btn { display: block; width: 100%; margin: 16px 0 4px; border: 1px solid rgba(255,255,255,0.18); background: transparent; color: #cbd5e1; border-radius: 6px; padding: 8px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
.expand-entries-btn:hover { background: rgba(255,255,255,0.06); color: #f0f4f8; }
.tier-row { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 6px 0; }
.tier-item { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.tier-badge { padding: 1px 4px; border-radius: 3px; font-size: 10px; font-weight: normal; letter-spacing: 0.03em; background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.tier-badge-t1, .tier-badge-t2, .tier-badge-t3 { border-color: var(--vscode-panel-border); }
.tier-desc { color: var(--vscode-descriptionForeground); opacity: 0.75; }
.credits-pill { background: rgba(99,102,241,0.15); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3); border-radius: 10px; padding: 2px 8px; font-size: 10px; white-space: nowrap; cursor: default; }
.credits-pill-loading { color: #475569; font-size: 10px; padding: 2px 8px; border-radius: 10px; border: 1px solid transparent; }
.credit-pill-pending { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 2px 8px; font-size: 10px; white-space: nowrap; cursor: default; opacity: 0.5; }
.credits-pills { display: inline-flex; gap: 4px; align-items: center; }
.credit-pill-cc { background: var(--vscode-charts-orange, rgba(200, 130, 0, 0.18)); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-charts-orange, rgba(200, 130, 0, 0.4)); }
.credit-pill-cx { background: var(--vscode-charts-green, rgba(0, 180, 100, 0.18)); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-charts-green, rgba(0, 180, 100, 0.4)); }
.credit-pill-cc, .credit-pill-cx { border-radius: 10px; padding: 2px 8px; font-size: 10px; white-space: nowrap; cursor: default; }
.credits-pill-estimated { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); border-radius: 10px; padding: 2px 8px; font-size: 10px; white-space: nowrap; cursor: default; }
.clear-log-btn { display: inline-flex; align-items: center; gap: 6px; }
.credits-summary-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; background: rgba(99,102,241,0.08); border: 1px solid rgba(99,102,241,0.25); border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; }
.credits-summary-left { display: flex; flex-direction: column; }
.credits-total-number { font-size: 28px; font-weight: 600; color: #a5b4fc; }
.credits-total-label { font-size: 11px; color: #64748b; }
.credits-estimated-note { font-size: 10px; color: #fbbf24; }
.credits-summary-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.date-range-row { display: flex; gap: 10px; }
.date-from, .date-to { display: flex; flex-direction: column; gap: 2px; }
.date-range-label { color: #64748b; font-size: 10px; }
.date-input { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #cbd5e1; font-size: 11px; padding: 4px 8px; }
.clear-dates { color: #60a5fa; font-size: 10px; cursor: pointer; }
.clear-dates:hover { text-decoration: underline; }
.cleared-title { color: #94a3b8; font-size: 14px; }
.cleared-subtitle { color: #64748b; font-size: 12px; margin-top: 8px; }
.restore-entries-link { color: #60a5fa; font-size: 12px; margin-top: 12px; cursor: pointer; display: inline-block; }
.restore-entries-link:hover { text-decoration: underline; }
.attribution { font-size: 0.8em; color: var(--vscode-descriptionForeground); text-align: center; margin: 8px 0 16px; line-height: 1.5; }
.attribution a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
.attribution a:hover { text-decoration: underline; }
.log-error-state { text-align: center; padding: 40px 20px; color: #64748b; }
.log-error-title { font-size: 14px; color: #94a3b8; margin-bottom: 8px; }
.log-error-detail { font-size: 11px; color: #ef4444; margin-bottom: 12px; font-family: monospace; }
.log-error-hint { font-size: 11px; color: #475569; line-height: 1.5; }
</style>
<style media="print" nonce="${nonce}">
body { background: white; color: black; }
.panel-header { display: block; }
.entry-card { page-break-inside: avoid; }
.entry-body { display: block !important; }
.export-btn { display: none; }
.open-source-link { display: none; }
.entry-header { border-bottom: 1px solid #ccc; }
.field-label { color: #333; font-weight: bold; }
.field-value { color: #222; }
.result-badge { border: 1px solid currentColor; }
.credits-pill { display: inline-block; }
.credits-pill-estimated { display: inline-block; }
</style>
</head>
<body>
<div class="wrap">
<div class="panel-header">
  <div class="ph-title">Session Log</div>
  <p class="ph-subtitle">A complete record of every Dev-Trio plan/implement/audit cycle run in this workspace. Each entry captures what was planned, what was built, how it was audited, and the outcome. Use this log to review progress, diagnose issues, or hand off context to another developer.</p>
  <div class="ph-actions"><a class="open-source-link" id="refreshLink">Refresh</a><button class="export-btn" id="restoreLogBtn">Restore log</button><button class="export-btn" id="exportBtn">Export log</button><button class="export-btn" id="openLogFileBtn"><i class="codicon codicon-go-to-file"></i> Open log file</button><button class="export-btn clear-log-btn" id="clearLogBtn"><i class="codicon codicon-trash"></i> Clear log</button></div>
</div>
<div id="creditsSummaryCard"></div>
<div class="attribution">Credit tracking powered by concepts from the <a class="attribution-link">What I Did extension</a> · For full Copilot credit tracking across all workspaces, <a class="attribution-link">install What I Did</a></div>
<div id="root"></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

import * as vscode from 'vscode';
import * as path from 'path';
import { SecretStore } from '../../secrets';
import { TelegramProvider } from '../../notify/TelegramProvider';
import { TeamsProvider } from '../../notify/TeamsProvider';
import { SlackProvider } from '../../notify/SlackProvider';
import { DiscordProvider } from '../../notify/DiscordProvider';
import { CustomWebhookProvider } from '../../notify/CustomWebhookProvider';
import type { NotificationProvider } from '../../notify/Provider';
import {
  generateNotifyScript,
  generateWebhookNotifyScript,
  defaultWebhookScriptPath,
  type WebhookProvider
} from '../../notify/notifyScript';
import { wireNotification } from '../../notify/wireNotification';
import { wireBackupLog } from '../../logging/wireBackupLog';
import { resolveConfiguredLogUri, isBackupLogConfigured } from '../../logging/backupLog';
import { GenerateGate, GENERATE_ANYWAY, SEND_TEST_FIRST } from './generateGate';

/** Static metadata for the four webhook providers shown as accordion sections. */
interface WebhookMeta {
  id: WebhookProvider;
  label: string;
  secretKind: 'teams' | 'slack' | 'discord' | 'custom';
}
const WEBHOOK_META: readonly WebhookMeta[] = [
  { id: 'teams', label: 'Teams', secretKind: 'teams' },
  { id: 'slack', label: 'Slack', secretKind: 'slack' },
  { id: 'discord', label: 'Discord', secretKind: 'discord' },
  { id: 'custom', label: 'Custom', secretKind: 'custom' }
];

interface InboundMessage {
  type: string;
  value?: string;
  provider?: WebhookProvider;
}

export type NotificationSetupTarget = 'telegram' | WebhookProvider;

/**
 * Opens the notification setup wizard (outbound only). Telegram (bot token + chat ID) plus four
 * webhook providers (Teams, Slack, Discord, custom) — each independent, each generating its own
 * self-contained PowerShell notify script and wiring its own block into AGENTS.md.
 */
export function openNotifySetup(
  context: vscode.ExtensionContext,
  secrets: SecretStore,
  log: (message: string) => void,
  initialTarget?: NotificationSetupTarget,
  onSecretsChanged?: () => void
): void {
  const panel = vscode.window.createWebviewPanel(
    'devTrioNotify',
    'Dev-Trio: Notifications',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const provider = new TelegramProvider(secrets, undefined, log);
  const gate = new GenerateGate();
  const webhookProviders: Record<WebhookProvider, NotificationProvider> = {
    teams: new TeamsProvider(secrets, undefined, log),
    slack: new SlackProvider(secrets, undefined, log),
    discord: new DiscordProvider(secrets, undefined, log),
    custom: new CustomWebhookProvider(secrets, undefined, log)
  };
  const webhookGates: Record<WebhookProvider, GenerateGate> = {
    teams: new GenerateGate(),
    slack: new GenerateGate(),
    discord: new GenerateGate(),
    custom: new GenerateGate()
  };
  const nonce = makeNonce();
  panel.webview.html = getHtml(nonce, initialTarget);

  void initState();

  async function initState(): Promise<void> {
    const token = await secrets.getToken();
    const chatId = await secrets.getChatId();
    const webhooks: Record<string, { configured: boolean; masked: string }> = {};
    for (const meta of WEBHOOK_META) {
      const url = await getWebhookSecret(meta.secretKind);
      webhooks[meta.id] = { configured: !!url, masked: url ? maskTail8(url) : '' };
    }
    void panel.webview.postMessage({
      type: 'init',
      hasToken: !!token,
      tokenMasked: token ? maskTail(token) : '',
      hasChatId: !!chatId,
      chatId: chatId ?? '',
      webhooks
    });
  }

  function getWebhookSecret(kind: WebhookMeta['secretKind']): Thenable<string | undefined> {
    switch (kind) {
      case 'teams':
        return secrets.getTeamsWebhook();
      case 'slack':
        return secrets.getSlackWebhook();
      case 'discord':
        return secrets.getDiscordWebhook();
      case 'custom':
        return secrets.getCustomWebhook();
    }
  }

  function setWebhookSecret(kind: WebhookMeta['secretKind'], value: string): Thenable<void> {
    switch (kind) {
      case 'teams':
        return secrets.setTeamsWebhook(value);
      case 'slack':
        return secrets.setSlackWebhook(value);
      case 'discord':
        return secrets.setDiscordWebhook(value);
      case 'custom':
        return secrets.setCustomWebhook(value);
    }
  }

  panel.webview.onDidReceiveMessage(
    async (raw: InboundMessage) => {
      switch (raw.type) {
        case 'saveToken':
          await handleSaveToken(raw.value ?? '');
          break;
        case 'autoDetect':
          await handleAutoDetect();
          break;
        case 'saveChatId':
          await handleSaveChatId(raw.value ?? '');
          break;
        case 'test':
          await handleTest();
          break;
        case 'generate':
          await handleGenerate();
          break;
        case 'saveWebhook':
          if (raw.provider) {
            await handleSaveWebhook(raw.provider, raw.value ?? '');
          }
          break;
        case 'testWebhook':
          if (raw.provider) {
            await handleTestWebhook(raw.provider);
          }
          break;
        case 'generateWebhook':
          if (raw.provider) {
            await handleGenerateWebhook(raw.provider);
          }
          break;
        default:
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  async function handleSaveToken(value: string): Promise<void> {
    const v = value.trim();
    if (!v) {
      void panel.webview.postMessage({ type: 'tokenSaved', masked: '', hasToken: false });
      return;
    }
    await secrets.setToken(v);
    log('Telegram bot token saved to SecretStorage.');
    onSecretsChanged?.();
    void panel.webview.postMessage({ type: 'tokenSaved', masked: maskTail(v), hasToken: true });
  }

  async function handleSaveChatId(value: string): Promise<void> {
    const v = value.trim();
    if (!v) {
      void panel.webview.postMessage({ type: 'chatIdSaved', chatId: '', hasChatId: false });
      return;
    }
    await secrets.setChatId(v);
    log('Telegram chat ID saved to SecretStorage.');
    onSecretsChanged?.();
    void panel.webview.postMessage({ type: 'chatIdSaved', chatId: v, hasChatId: true });
  }

  async function handleAutoDetect(): Promise<void> {
    const result = await provider.autoDetectChatId();
    if (result.ok && result.chatId) {
      await secrets.setChatId(result.chatId);
      log('Telegram chat ID auto-detected and saved to SecretStorage.');
      onSecretsChanged?.();
      void panel.webview.postMessage({
        type: 'chatIdDetected',
        chatId: result.chatId,
        detail: result.detail
      });
    } else {
      void panel.webview.postMessage({ type: 'chatIdError', message: result.detail });
    }
  }

  async function handleTest(): Promise<void> {
    const result = await provider.test();
    gate.markTestResult(result.ok);
    log(`Telegram test ${result.ok ? 'succeeded' : 'failed'}: ${result.detail}`);
    void panel.webview.postMessage({ type: 'testResult', ok: result.ok, detail: result.detail });
  }

  async function handleGenerate(): Promise<void> {
    if (gate.onGenerateClicked() === 'confirm') {
      const choice = await vscode.window.showWarningMessage(
        "You haven't sent a successful test notification. We recommend testing first so a bad " +
          'token is caught now instead of silently failing during an autonomous run. Generate ' +
          'the script anyway?',
        { modal: true },
        GENERATE_ANYWAY,
        SEND_TEST_FIRST
      );
      const resolution = gate.onConfirmChoice(choice);
      if (resolution === 'focusTest') {
        void panel.webview.postMessage({ type: 'focusTest' });
        return;
      }
      if (resolution === 'cancel') {
        return;
      }
    }
    await doGenerate();
  }

  async function doGenerate(): Promise<void> {
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) {
      void panel.webview.postMessage({
        type: 'generateError',
        message: 'Open a workspace folder before generating the notify script.'
      });
      return;
    }
    try {
      const scriptPath = await generateNotifyScript(secrets);
      const hasTilde = scriptPath.includes('~');
      // Project identity is the workspace folder name (NOT memory/MEMORY.md, which is provisional
      // and may not exist yet) — this keeps each workspace's wiring isolated and correct.
      const projectName = path.basename(workspaceUri.fsPath);
      const touched = await wireNotification(workspaceUri, scriptPath, projectName);
      // If a backup log is already provisioned, refresh its wiring (path only; identity travels
      // via the [Project Name] resolution done by wireNotification).
      if (await isBackupLogConfigured()) {
        const logUri = resolveConfiguredLogUri();
        if (logUri) {
          await wireBackupLog(workspaceUri, logUri.fsPath, projectName);
        }
      }
      const wiredNote = touched.length ? ` Wired: ${touched.join(', ')}.` : '';
      log(`Notify script generated at ${scriptPath}.${wiredNote}`);
      void panel.webview.postMessage({ type: 'generated', path: scriptPath, hasTilde, note: undefined });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Notify script generation failed: ${message}`);
      void panel.webview.postMessage({ type: 'generateError', message });
    }
  }

  async function handleSaveWebhook(id: WebhookProvider, value: string): Promise<void> {
    const meta = WEBHOOK_META.find((m) => m.id === id);
    if (!meta) {
      return;
    }
    const v = value.trim();
    if (!v) {
      void panel.webview.postMessage({ type: 'webhookSaved', provider: id, masked: '', configured: false });
      return;
    }
    await setWebhookSecret(meta.secretKind, v);
    log(`${meta.label} webhook URL saved to SecretStorage.`);
    onSecretsChanged?.();
    void panel.webview.postMessage({ type: 'webhookSaved', provider: id, masked: maskTail8(v), configured: true });
  }

  async function handleTestWebhook(id: WebhookProvider): Promise<void> {
    const result = await webhookProviders[id].test();
    webhookGates[id].markTestResult(result.ok);
    log(`${labelFor(id)} webhook test ${result.ok ? 'succeeded' : 'failed'}: ${result.detail}`);
    void panel.webview.postMessage({ type: 'webhookTestResult', provider: id, ok: result.ok, detail: result.detail });
  }

  async function handleGenerateWebhook(id: WebhookProvider): Promise<void> {
    const meta = WEBHOOK_META.find((m) => m.id === id);
    if (!meta) {
      return;
    }
    const url = await getWebhookSecret(meta.secretKind);
    if (!url) {
      // Hard gate: nothing to generate without a URL.
      void panel.webview.postMessage({
        type: 'webhookGenerateError',
        provider: id,
        message: 'Save the webhook URL first.'
      });
      return;
    }
    // Soft gate: recommend testing first, but allow skip via confirm modal.
    if (webhookGates[id].onGenerateClicked() === 'confirm') {
      const choice = await vscode.window.showWarningMessage(
        `You haven't sent a successful ${meta.label} test. We recommend testing first so a bad ` +
          'webhook URL is caught now instead of silently failing during an autonomous run. ' +
          'Generate the script anyway?',
        { modal: true },
        GENERATE_ANYWAY,
        SEND_TEST_FIRST
      );
      const resolution = webhookGates[id].onConfirmChoice(choice);
      if (resolution === 'focusTest') {
        void panel.webview.postMessage({ type: 'webhookFocusTest', provider: id });
        return;
      }
      if (resolution === 'cancel') {
        return;
      }
    }
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) {
      void panel.webview.postMessage({
        type: 'webhookGenerateError',
        provider: id,
        message: 'Open a workspace folder before generating the notify script.'
      });
      return;
    }
    try {
      // Webhook scripts are user-level (shared across projects), written to %LOCALAPPDATA%\Dev-Trio
      // alongside the Telegram notify.ps1 — outside any workspace so they are never committed.
      const scriptPath = defaultWebhookScriptPath(id);
      generateWebhookNotifyScript(id, url, scriptPath);
      const hasTilde = scriptPath.includes('~');
      const projectName = path.basename(workspaceUri.fsPath);
      const touched = await wireNotification(workspaceUri, scriptPath, projectName, meta.label);
      const wiredNote = touched.length ? ` Wired: ${touched.join(', ')}.` : '';
      log(`${meta.label} notify script generated at ${scriptPath}.${wiredNote}`);
      void panel.webview.postMessage({
        type: 'webhookGenerated',
        provider: id,
        path: scriptPath,
        hasTilde,
        note: undefined
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`${meta.label} notify script generation failed: ${message}`);
      void panel.webview.postMessage({ type: 'webhookGenerateError', provider: id, message });
    }
  }

  function labelFor(id: WebhookProvider): string {
    return WEBHOOK_META.find((m) => m.id === id)?.label ?? id;
  }
}

function maskTail(value: string): string {
  return '••••••••' + value.slice(-4);
}

/** Webhook URLs are masked to their last 8 characters for display. */
function maskTail8(value: string): string {
  return '••••••••' + value.slice(-8);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function getHtml(nonce: string, initialTarget?: NotificationSetupTarget): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<title>Dev-Trio Notifications</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 18px 36px; line-height: 1.45; }
h1 { font-size: 1.4em; }
h2 { font-size: 1.05em; margin-top: 0; }
section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 16px; margin: 16px 0; }
input { width: 100%; box-sizing: border-box; margin: 6px 0; padding: 6px 8px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
.row { display: flex; gap: 8px; align-items: center; }
.row input { flex: 1; }
button { cursor: pointer; padding: 6px 14px; border: none; border-radius: 4px; margin: 4px 6px 4px 0;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  font-weight: 600; padding: 9px 20px; font-size: 1.03em; }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.status { font-size: 0.85em; opacity: 0.85; margin-top: 4px; }
.result { margin-top: 8px; font-size: 0.9em; white-space: pre-wrap; }
.result.ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #3fb950)); }
.result.err { color: var(--vscode-errorForeground, #f85149); }
.recommend { background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground); padding: 8px 12px; font-size: 0.9em; }
code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
.provider-group-title { font-size: 1.05em; font-weight: 600; margin: 26px 0 4px; }
.provider { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 10px 0; overflow: hidden; }
.provider-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; user-select: none; }
.provider-header:hover { background: var(--vscode-list-hoverBackground); }
.provider-title { font-weight: 600; flex: 1 1 auto; }
.provider-badge { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
.provider-body { display: none; padding: 0 14px 14px; }
.provider.open .provider-body { display: block; }
.provider-group-copy { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
<h1>Dev-Trio — Notifications</h1>
<p>Outbound only. Dev-Trio messages you when the planner finishes, hits an error, or needs a decision. Nothing listens for replies. Configure Telegram below, and/or any of the webhook providers further down — each is independent.</p>

<h2 class="provider-group-title">Telegram</h2>

<section>
  <h2>1. Create a Telegram bot</h2>
  <ol>
    <li>Open Telegram and start a chat with <strong>@BotFather</strong>.</li>
    <li>Send <code>/newbot</code> and follow the prompts.</li>
    <li>Copy the <strong>bot token</strong> BotFather gives you.</li>
  </ol>
</section>

<section>
  <h2>2. Paste your bot token</h2>
  <input id="tokenInput" type="password" placeholder="123456789:ABC..." autocomplete="off" spellcheck="false" />
  <button id="saveTokenBtn">Save token</button>
  <div id="tokenStatus" class="status">Not saved</div>
</section>

<section>
  <h2>3. Chat ID</h2>
  <p>Send your new bot any message in Telegram first, then auto-detect — or paste your chat ID manually.</p>
  <button id="autoDetectBtn">Auto-detect Chat ID</button>
  <div class="row">
    <input id="chatIdInput" type="text" placeholder="123456789" autocomplete="off" spellcheck="false" />
    <button id="saveChatIdBtn">Save chat ID</button>
  </div>
  <div id="chatIdStatus" class="status"></div>
</section>

<section>
  <h2>4. Send a test notification</h2>
  <p class="recommend">Recommended: send a test before generating the script so you catch a bad token now rather than during a real run.</p>
  <button id="testBtn" class="primary" disabled>Send test notification</button>
  <div id="testResult" class="result"></div>
</section>

<section>
  <h2>5. Generate the notify script</h2>
  <p>Writes the outbound notify script to your user-profile tools folder (outside this repo).</p>
  <button id="generateBtn">Generate notify script</button>
  <div id="generateResult" class="result"></div>
</section>

<h2 class="provider-group-title">Webhook providers</h2>
<p class="provider-group-copy">Each provider uses a simple HTTPS webhook URL. Paste a URL, test, generate — done. Each generates its own self-contained script and wires its own block.</p>

<div class="provider" data-provider="teams">
  <div class="provider-header"><span class="provider-title">Microsoft Teams</span><span class="provider-badge" data-badge="teams">not configured</span></div>
  <div class="provider-body">
    <p>Create an Incoming Webhook connector in your Teams channel. <a href="https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook">How to →</a></p>
    <input type="password" data-url="teams" placeholder="https://outlook.office.com/webhook/..." autocomplete="off" spellcheck="false" />
    <button data-save="teams">Save URL</button>
    <div class="status" data-status="teams">Not saved</div>
    <button class="primary" data-test="teams" disabled>Send test notification</button>
    <button data-gen="teams" disabled>Generate notify script</button>
    <div class="result" data-result="teams"></div>
  </div>
</div>

<div class="provider" data-provider="slack">
  <div class="provider-header"><span class="provider-title">Slack</span><span class="provider-badge" data-badge="slack">not configured</span></div>
  <div class="provider-body">
    <p>Create an Incoming Webhook app for your Slack workspace. <a href="https://api.slack.com/messaging/webhooks">How to →</a></p>
    <input type="password" data-url="slack" placeholder="https://hooks.slack.com/services/..." autocomplete="off" spellcheck="false" />
    <button data-save="slack">Save URL</button>
    <div class="status" data-status="slack">Not saved</div>
    <button class="primary" data-test="slack" disabled>Send test notification</button>
    <button data-gen="slack" disabled>Generate notify script</button>
    <div class="result" data-result="slack"></div>
  </div>
</div>

<div class="provider" data-provider="discord">
  <div class="provider-header"><span class="provider-title">Discord</span><span class="provider-badge" data-badge="discord">not configured</span></div>
  <div class="provider-body">
    <p>In your Discord channel settings, create a Webhook under Integrations. <a href="https://support.discord.com/hc/en-us/articles/228383668">How to →</a></p>
    <input type="password" data-url="discord" placeholder="https://discord.com/api/webhooks/..." autocomplete="off" spellcheck="false" />
    <button data-save="discord">Save URL</button>
    <div class="status" data-status="discord">Not saved</div>
    <button class="primary" data-test="discord" disabled>Send test notification</button>
    <button data-gen="discord" disabled>Generate notify script</button>
    <div class="result" data-result="discord"></div>
  </div>
</div>

<div class="provider" data-provider="custom">
  <div class="provider-header"><span class="provider-title">Custom webhook</span><span class="provider-badge" data-badge="custom">not configured</span></div>
  <div class="provider-body">
    <p>Enter any HTTPS URL that accepts a POST request with a JSON body.</p>
    <input type="password" data-url="custom" placeholder="https://..." autocomplete="off" spellcheck="false" />
    <button data-save="custom">Save URL</button>
    <div class="status" data-status="custom">Not saved</div>
    <button class="primary" data-test="custom" disabled>Send test notification</button>
    <button data-gen="custom" disabled>Generate notify script</button>
    <div class="result" data-result="custom"></div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const byId = (id) => document.getElementById(id);
const initialTarget = ${JSON.stringify(initialTarget ?? null)};
let hasToken = false;
let hasChatId = false;

function refreshTestEnabled() {
  byId('testBtn').disabled = !(hasToken && hasChatId);
}

byId('saveTokenBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveToken', value: byId('tokenInput').value });
});
byId('autoDetectBtn').addEventListener('click', () => {
  byId('chatIdStatus').textContent = 'Detecting...';
  vscode.postMessage({ type: 'autoDetect' });
});
byId('saveChatIdBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveChatId', value: byId('chatIdInput').value });
});
byId('testBtn').addEventListener('click', () => {
  byId('testResult').textContent = 'Sending test...';
  byId('testResult').className = 'result';
  vscode.postMessage({ type: 'test' });
});
byId('generateBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'generate' });
});

// ---- Webhook providers (Teams / Slack / Discord / Custom) ----
const q = (sel) => document.querySelector(sel);
const webhookHasUrl = { teams: false, slack: false, discord: false, custom: false };
function refreshWebhookButtons(p) {
  const has = webhookHasUrl[p];
  const t = q('[data-test="' + p + '"]'); if (t) t.disabled = !has;
  const g = q('[data-gen="' + p + '"]'); if (g) g.disabled = !has;
}
document.querySelectorAll('.provider-header').forEach((h) => {
  h.addEventListener('click', () => { h.parentElement.classList.toggle('open'); });
});
document.querySelectorAll('[data-save]').forEach((b) => {
  b.addEventListener('click', () => {
    const p = b.getAttribute('data-save');
    vscode.postMessage({ type: 'saveWebhook', provider: p, value: q('[data-url="' + p + '"]').value });
  });
});
document.querySelectorAll('[data-test]').forEach((b) => {
  b.addEventListener('click', () => {
    const p = b.getAttribute('data-test');
    const r = q('[data-result="' + p + '"]'); r.textContent = 'Sending test...'; r.className = 'result';
    vscode.postMessage({ type: 'testWebhook', provider: p });
  });
});
document.querySelectorAll('[data-gen]').forEach((b) => {
  b.addEventListener('click', () => {
    vscode.postMessage({ type: 'generateWebhook', provider: b.getAttribute('data-gen') });
  });
});

function focusTelegramSetup() {
  const input = byId('tokenInput');
  if (!input) { return; }
  input.focus();
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function openProviderSection(provider) {
  const card = q('.provider[data-provider="' + provider + '"]');
  if (!card) { return; }
  card.classList.add('open');
  const input = q('[data-url="' + provider + '"]');
  if (input) {
    input.focus();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

if (initialTarget === 'telegram') {
  window.requestAnimationFrame(() => { focusTelegramSetup(); });
} else if (initialTarget) {
  window.requestAnimationFrame(() => { openProviderSection(initialTarget); });
}

window.addEventListener('message', (event) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      hasToken = m.hasToken;
      hasChatId = m.hasChatId;
      if (m.hasToken) { byId('tokenStatus').textContent = 'Saved: ' + m.tokenMasked; }
      if (m.chatId) { byId('chatIdInput').value = m.chatId; }
      refreshTestEnabled();
      if (m.webhooks) {
        ['teams', 'slack', 'discord', 'custom'].forEach((p) => {
          const w = m.webhooks[p];
          if (!w) { return; }
          webhookHasUrl[p] = w.configured;
          if (w.configured) {
            q('[data-status="' + p + '"]').textContent = 'Saved: ' + w.masked;
            q('[data-badge="' + p + '"]').textContent = 'configured';
          }
          refreshWebhookButtons(p);
        });
      }
      break;
    case 'tokenSaved':
      hasToken = m.hasToken;
      byId('tokenInput').value = '';
      byId('tokenStatus').textContent = m.hasToken ? 'Saved: ' + m.masked : 'Not saved';
      refreshTestEnabled();
      break;
    case 'chatIdDetected':
      hasChatId = true;
      byId('chatIdInput').value = m.chatId;
      byId('chatIdStatus').textContent = 'Detected and saved: ' + m.detail;
      refreshTestEnabled();
      break;
    case 'chatIdError':
      byId('chatIdStatus').textContent = 'Could not auto-detect: ' + m.message;
      break;
    case 'chatIdSaved':
      hasChatId = m.hasChatId;
      byId('chatIdStatus').textContent = m.hasChatId ? 'Saved chat ID.' : 'Not saved';
      refreshTestEnabled();
      break;
    case 'testResult':
      byId('testResult').textContent = (m.ok ? 'Success: ' : 'Failed: ') + m.detail;
      byId('testResult').className = m.ok ? 'result ok' : 'result err';
      break;
    case 'generated':
      byId('generateResult').textContent =
        'Script generated at: ' + m.path + (m.hasTilde ? '  [WARNING: path contains "~"]' : '  (no "~" in path)') +
        (m.note ? '\\n' + m.note : '');
      byId('generateResult').className = m.hasTilde ? 'result err' : 'result ok';
      break;
    case 'generateError':
      byId('generateResult').textContent = 'Generation failed: ' + m.message;
      byId('generateResult').className = 'result err';
      break;
    case 'focusTest':
      byId('testResult').textContent = 'Please send a test first (recommended).';
      byId('testResult').className = 'result';
      byId('testBtn').focus();
      byId('testBtn').scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    case 'webhookSaved':
      webhookHasUrl[m.provider] = m.configured;
      q('[data-url="' + m.provider + '"]').value = '';
      q('[data-status="' + m.provider + '"]').textContent = m.configured ? 'Saved: ' + m.masked : 'Not saved';
      q('[data-badge="' + m.provider + '"]').textContent = m.configured ? 'configured' : 'not configured';
      refreshWebhookButtons(m.provider);
      break;
    case 'webhookTestResult': {
      const r = q('[data-result="' + m.provider + '"]');
      r.textContent = (m.ok ? 'Success: ' : 'Failed: ') + m.detail;
      r.className = m.ok ? 'result ok' : 'result err';
      break;
    }
    case 'webhookGenerated': {
      const r = q('[data-result="' + m.provider + '"]');
      r.textContent = 'Script generated at: ' + m.path +
        (m.hasTilde ? '  [WARNING: path contains "~"]' : '  (no "~" in path)') +
        (m.note ? '\\n' + m.note : '');
      r.className = m.hasTilde ? 'result err' : 'result ok';
      break;
    }
    case 'webhookGenerateError': {
      const r = q('[data-result="' + m.provider + '"]');
      r.textContent = 'Generation failed: ' + m.message;
      r.className = 'result err';
      break;
    }
    case 'webhookFocusTest': {
      const t = q('[data-test="' + m.provider + '"]');
      const r = q('[data-result="' + m.provider + '"]');
      r.textContent = 'Please send a test first (recommended).'; r.className = 'result';
      if (t) { t.focus(); t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      break;
    }
    default:
      break;
  }
});
</script>
</body>
</html>`;
}

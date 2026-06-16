import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecretStore } from '../secrets';

/** Project-agnostic default message — never project-specific. */
const DEFAULT_MESSAGE = 'Dev-Trio: Agent needs your input.';

/** The user-level Dev-Trio tools directory: %LOCALAPPDATA%\Dev-Trio (cross-platform via os.homedir). */
export function getNotifyDir(): string {
  return path.join(os.homedir(), 'AppData', 'Local', 'Dev-Trio');
}

/** Absolute path of the user-level Telegram notify script. Shared across all the user's projects. */
export function getNotifyScriptPath(): string {
  return path.join(getNotifyDir(), 'notify.ps1');
}

/**
 * Generates the runtime notify script from the secrets currently in SecretStorage and writes it,
 * by default, to the user-level Dev-Trio directory (%LOCALAPPDATA%\Dev-Trio) as notify.ps1 — a
 * single script shared across all the user's projects, living OUTSIDE any workspace so it is never
 * committed or packaged. The setup wiring bakes this absolute path into AGENTS.md, so the planner
 * finds it regardless of which workspace is open.
 *
 * Node fs is used deliberately (not vscode.workspace.fs): the script is a plain local file written
 * to a real on-disk absolute path outside the workspace.
 *
 * Aborts (throws) if either secret is missing — never writes a script with empty/placeholder
 * credentials.
 *
 * @param targetDir directory to write notify.ps1 into; defaults to the user-level Dev-Trio dir.
 * @returns the resolved ABSOLUTE path of the written script.
 */
export async function generateNotifyScript(
  secrets: SecretStore,
  targetDir: string = getNotifyDir()
): Promise<string> {
  const token = await secrets.getToken();
  const chatId = await secrets.getChatId();
  if (!token || !chatId) {
    throw new Error(
      'Cannot generate the notify script: complete the bot token and chat ID steps first ' +
        '(both must be saved to SecretStorage).'
    );
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const scriptPath = path.join(targetDir, 'notify.ps1');
  fs.writeFileSync(scriptPath, renderNotifyScript(token, chatId), { encoding: 'utf8' });
  return scriptPath;
}

/**
 * Renders the pinned five-line notify body (plus param line), injecting only the credentials and
 * keeping the generic default message and the fire-and-forget SilentlyContinue behavior.
 */
export function renderNotifyScript(token: string, chatId: string): string {
  return [
    `param([string]$Message = "${DEFAULT_MESSAGE}")`,
    `$token = "${token}"`,
    `$chatId = "${chatId}"`,
    `$uri = "https://api.telegram.org/bot$token/sendMessage"`,
    `$body = @{ chat_id = $chatId; text = $Message } | ConvertTo-Json -Compress`,
    `Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json" -ErrorAction SilentlyContinue | Out-Null`,
    ''
  ].join('\n');
}

/** The exact planner command, using the ABSOLUTE script path (never a literal "~"). */
export function buildNotifyCommand(absoluteScriptPath: string): string {
  return `pwsh -NoProfile -File "${absoluteScriptPath}" -Message "msg"`;
}

/** Webhook providers that get a self-contained generated PowerShell notify script. */
export type WebhookProvider = 'teams' | 'slack' | 'discord' | 'custom';

const WEBHOOK_SCRIPT_NAMES: Record<WebhookProvider, string> = {
  teams: 'dev-trio-notify-teams.ps1',
  slack: 'dev-trio-notify-slack.ps1',
  discord: 'dev-trio-notify-discord.ps1',
  custom: 'dev-trio-notify-custom.ps1'
};

/**
 * Resolves the absolute path of a webhook provider's notify script in the user-level Dev-Trio
 * directory (%LOCALAPPDATA%\Dev-Trio), shared across all the user's projects and living OUTSIDE any
 * workspace so it is never committed or packaged. Never returns a literal "~".
 */
export function defaultWebhookScriptPath(provider: WebhookProvider): string {
  return path.join(getNotifyDir(), WEBHOOK_SCRIPT_NAMES[provider]);
}

/**
 * Generates a provider-appropriate webhook notify script at the given ABSOLUTE path. The webhook
 * URL is injected by the caller (already resolved from SecretStorage). Same discipline as the
 * Telegram script: no literal "~", fire-and-forget (-ErrorAction SilentlyContinue | Out-Null).
 *
 * @returns the absolute script path written.
 */
export function generateWebhookNotifyScript(
  provider: WebhookProvider,
  webhookUrl: string,
  absoluteScriptPath: string
): string {
  if (!webhookUrl) {
    throw new Error(`Cannot generate the ${provider} notify script: save the webhook URL first.`);
  }
  fs.mkdirSync(path.dirname(absoluteScriptPath), { recursive: true });
  fs.writeFileSync(absoluteScriptPath, renderWebhookNotifyScript(provider, webhookUrl), {
    encoding: 'utf8'
  });
  return absoluteScriptPath;
}

/** Renders the pinned webhook notify body for the given provider. Exported for unit testing. */
export function renderWebhookNotifyScript(provider: WebhookProvider, webhookUrl: string): string {
  let bodyLine: string;
  if (provider === 'discord') {
    bodyLine = '$body = @{ content = $Message } | ConvertTo-Json -Compress';
  } else if (provider === 'custom') {
    bodyLine = '$body = @{ message = $Message; source = "dev-trio" } | ConvertTo-Json -Compress';
  } else {
    // teams + slack
    bodyLine = '$body = @{ text = $Message } | ConvertTo-Json -Compress';
  }
  return [
    `param([string]$Message = "${DEFAULT_MESSAGE}")`,
    `$uri = "${webhookUrl}"`,
    bodyLine,
    `Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json" -ErrorAction SilentlyContinue | Out-Null`,
    ''
  ].join('\n');
}

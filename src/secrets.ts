import type * as vscode from 'vscode';

/**
 * Typed wrapper over the extension's VS Code SecretStorage.
 *
 * Secrets live ONLY here (context.secrets) — never in settings, never in repo files,
 * never logged. This wrapper deliberately exposes no method that returns or formats a
 * value for display.
 */

const TOKEN_KEY = 'dev-trio.telegram.botToken';
const CHATID_KEY = 'dev-trio.telegram.chatId';
const TEAMS_WEBHOOK_KEY = 'dev-trio.teams.webhookUrl';
const SLACK_WEBHOOK_KEY = 'dev-trio.slack.webhookUrl';
const DISCORD_WEBHOOK_KEY = 'dev-trio.discord.webhookUrl';
const CUSTOM_WEBHOOK_KEY = 'dev-trio.customWebhook.url';

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getToken(): Thenable<string | undefined> {
    return this.secrets.get(TOKEN_KEY);
  }

  setToken(value: string): Thenable<void> {
    return this.secrets.store(TOKEN_KEY, value);
  }

  deleteToken(): Thenable<void> {
    return this.secrets.delete(TOKEN_KEY);
  }

  getChatId(): Thenable<string | undefined> {
    return this.secrets.get(CHATID_KEY);
  }

  setChatId(value: string): Thenable<void> {
    return this.secrets.store(CHATID_KEY, value);
  }

  deleteChatId(): Thenable<void> {
    return this.secrets.delete(CHATID_KEY);
  }

  getTeamsWebhook(): Thenable<string | undefined> {
    return this.secrets.get(TEAMS_WEBHOOK_KEY);
  }

  setTeamsWebhook(value: string): Thenable<void> {
    return this.secrets.store(TEAMS_WEBHOOK_KEY, value);
  }

  deleteTeamsWebhook(): Thenable<void> {
    return this.secrets.delete(TEAMS_WEBHOOK_KEY);
  }

  getSlackWebhook(): Thenable<string | undefined> {
    return this.secrets.get(SLACK_WEBHOOK_KEY);
  }

  setSlackWebhook(value: string): Thenable<void> {
    return this.secrets.store(SLACK_WEBHOOK_KEY, value);
  }

  deleteSlackWebhook(): Thenable<void> {
    return this.secrets.delete(SLACK_WEBHOOK_KEY);
  }

  getDiscordWebhook(): Thenable<string | undefined> {
    return this.secrets.get(DISCORD_WEBHOOK_KEY);
  }

  setDiscordWebhook(value: string): Thenable<void> {
    return this.secrets.store(DISCORD_WEBHOOK_KEY, value);
  }

  deleteDiscordWebhook(): Thenable<void> {
    return this.secrets.delete(DISCORD_WEBHOOK_KEY);
  }

  getCustomWebhook(): Thenable<string | undefined> {
    return this.secrets.get(CUSTOM_WEBHOOK_KEY);
  }

  setCustomWebhook(value: string): Thenable<void> {
    return this.secrets.store(CUSTOM_WEBHOOK_KEY, value);
  }

  deleteCustomWebhook(): Thenable<void> {
    return this.secrets.delete(CUSTOM_WEBHOOK_KEY);
  }
}

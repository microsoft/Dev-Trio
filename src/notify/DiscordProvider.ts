import { SecretStore } from '../secrets';
import { NotificationProvider } from './Provider';
import { HttpClient, HttpResponse, defaultHttpClient } from './TelegramProvider';

const TEST_MESSAGE = 'Dev-Trio: test notification — setup is working.';

/**
 * Discord webhook provider (outbound only). Posts `{ "content": message }` to the channel webhook
 * URL stored in SecretStorage. A plain HTTPS POST — no inbound listener.
 */
export class DiscordProvider implements NotificationProvider {
  readonly id = 'discord';
  readonly label = 'Discord';

  constructor(
    private readonly secrets: SecretStore,
    private readonly http: HttpClient = defaultHttpClient,
    private readonly log?: (message: string) => void
  ) {}

  /** Fire-and-forget send: never throws. */
  async send(message: string): Promise<void> {
    const url = await this.secrets.getDiscordWebhook();
    if (!url) {
      this.log?.('Discord send skipped: webhook URL not configured.');
      return;
    }
    try {
      await this.http.postJson(url, { content: message });
    } catch {
      this.log?.('Discord send failed (suppressed).');
    }
  }

  /** Loud test: a Discord webhook returns HTTP 204 (no body) on success. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    const url = await this.secrets.getDiscordWebhook();
    if (!url) {
      return { ok: false, detail: 'Save the Discord webhook URL first.' };
    }
    let res: HttpResponse;
    try {
      res = await this.http.postJson(url, { content: TEST_MESSAGE });
    } catch (e) {
      return { ok: false, detail: `Network error: ${errMsg(e)}` };
    }
    if (res.statusCode === 204) {
      return { ok: true, detail: 'Discord webhook accepted' };
    }
    return { ok: false, detail: `${res.statusCode}: ${res.body.trim() || '(no body)'}` };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

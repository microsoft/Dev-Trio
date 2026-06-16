import { SecretStore } from '../secrets';
import { NotificationProvider } from './Provider';
import { HttpClient, HttpResponse, defaultHttpClient } from './TelegramProvider';

const TEST_MESSAGE = 'Dev-Trio: test notification — setup is working.';

/**
 * Slack Incoming Webhook provider (outbound only). Posts `{ "text": message }` to the workspace
 * webhook URL stored in SecretStorage. A plain HTTPS POST — no inbound listener.
 */
export class SlackProvider implements NotificationProvider {
  readonly id = 'slack';
  readonly label = 'Slack';

  constructor(
    private readonly secrets: SecretStore,
    private readonly http: HttpClient = defaultHttpClient,
    private readonly log?: (message: string) => void
  ) {}

  /** Fire-and-forget send: never throws. */
  async send(message: string): Promise<void> {
    const url = await this.secrets.getSlackWebhook();
    if (!url) {
      this.log?.('Slack send skipped: webhook URL not configured.');
      return;
    }
    try {
      await this.http.postJson(url, { text: message });
    } catch {
      this.log?.('Slack send failed (suppressed).');
    }
  }

  /** Loud test: a Slack Incoming Webhook returns the body "ok" on success. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    const url = await this.secrets.getSlackWebhook();
    if (!url) {
      return { ok: false, detail: 'Save the Slack webhook URL first.' };
    }
    let res: HttpResponse;
    try {
      res = await this.http.postJson(url, { text: TEST_MESSAGE });
    } catch (e) {
      return { ok: false, detail: `Network error: ${errMsg(e)}` };
    }
    if (res.body.trim() === 'ok') {
      return { ok: true, detail: 'Slack webhook accepted' };
    }
    return { ok: false, detail: `${res.statusCode}: ${res.body.trim() || '(no body)'}` };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

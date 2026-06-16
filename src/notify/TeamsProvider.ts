import { SecretStore } from '../secrets';
import { NotificationProvider } from './Provider';
import { HttpClient, HttpResponse, defaultHttpClient } from './TelegramProvider';

const TEST_MESSAGE = 'Dev-Trio: test notification — setup is working.';

/**
 * Microsoft Teams Incoming Webhook provider (outbound only). Posts `{ "text": message }` to the
 * channel webhook URL stored in SecretStorage. No Bot Framework, no app registration, no inbound
 * listener — a plain HTTPS POST.
 */
export class TeamsProvider implements NotificationProvider {
  readonly id = 'teams';
  readonly label = 'Teams';

  constructor(
    private readonly secrets: SecretStore,
    private readonly http: HttpClient = defaultHttpClient,
    private readonly log?: (message: string) => void
  ) {}

  /** Fire-and-forget send: never throws. */
  async send(message: string): Promise<void> {
    const url = await this.secrets.getTeamsWebhook();
    if (!url) {
      this.log?.('Teams send skipped: webhook URL not configured.');
      return;
    }
    try {
      await this.http.postJson(url, { text: message });
    } catch {
      this.log?.('Teams send failed (suppressed).');
    }
  }

  /** Loud test: a Teams Incoming Webhook returns the body "1" on success. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    const url = await this.secrets.getTeamsWebhook();
    if (!url) {
      return { ok: false, detail: 'Save the Teams webhook URL first.' };
    }
    let res: HttpResponse;
    try {
      res = await this.http.postJson(url, { text: TEST_MESSAGE });
    } catch (e) {
      return { ok: false, detail: `Network error: ${errMsg(e)}` };
    }
    if (res.body.trim() === '1') {
      return { ok: true, detail: 'Teams webhook accepted' };
    }
    return { ok: false, detail: `${res.statusCode}: ${res.body.trim() || '(no body)'}` };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

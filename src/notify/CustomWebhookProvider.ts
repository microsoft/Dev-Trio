import { SecretStore } from '../secrets';
import { NotificationProvider } from './Provider';
import { HttpClient, HttpResponse, defaultHttpClient } from './TelegramProvider';

const TEST_MESSAGE = 'Dev-Trio: test notification — setup is working.';

/**
 * Custom webhook provider (outbound only). Posts `{ "message": message, "source": "dev-trio" }` to
 * any user-supplied HTTPS URL stored in SecretStorage. A plain HTTPS POST — no inbound listener.
 */
export class CustomWebhookProvider implements NotificationProvider {
  readonly id = 'customWebhook';
  readonly label = 'Custom';

  constructor(
    private readonly secrets: SecretStore,
    private readonly http: HttpClient = defaultHttpClient,
    private readonly log?: (message: string) => void
  ) {}

  /** Fire-and-forget send: never throws. */
  async send(message: string): Promise<void> {
    const url = await this.secrets.getCustomWebhook();
    if (!url) {
      this.log?.('Custom webhook send skipped: URL not configured.');
      return;
    }
    try {
      await this.http.postJson(url, { message, source: 'dev-trio' });
    } catch {
      this.log?.('Custom webhook send failed (suppressed).');
    }
  }

  /** Loud test: any 2xx response counts as success. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    const url = await this.secrets.getCustomWebhook();
    if (!url) {
      return { ok: false, detail: 'Save the webhook URL first.' };
    }
    let res: HttpResponse;
    try {
      res = await this.http.postJson(url, { message: TEST_MESSAGE, source: 'dev-trio' });
    } catch (e) {
      return { ok: false, detail: `Network error: ${errMsg(e)}` };
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, detail: `Webhook accepted (${res.statusCode})` };
    }
    return { ok: false, detail: `${res.statusCode}: ${res.body.trim() || '(no body)'}` };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

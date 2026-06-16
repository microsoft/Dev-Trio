import * as https from 'https';
import { SecretStore } from '../secrets';
import { NotificationProvider } from './Provider';

export interface HttpResponse {
  statusCode: number;
  body: string;
}

/** Minimal HTTP surface so the provider can be unit-tested without live network calls. */
export interface HttpClient {
  postJson(url: string, json: unknown): Promise<HttpResponse>;
  get(url: string): Promise<HttpResponse>;
}

export interface AutoDetectResult {
  ok: boolean;
  chatId?: string;
  detail: string;
}

const TEST_MESSAGE = 'Dev-Trio: test notification — setup is working.';

/** Default HTTP client backed by Node's https (a built-in; no runtime dependency added). */
export const defaultHttpClient: HttpClient = {
  postJson(url: string, json: unknown): Promise<HttpResponse> {
    const data = Buffer.from(JSON.stringify(json), 'utf8');
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
          );
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  },
  get(url: string): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = https.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      });
      req.on('error', reject);
    });
  }
};

export class TelegramProvider implements NotificationProvider {
  readonly id = 'telegram';
  readonly label = 'Telegram';

  constructor(
    private readonly secrets: SecretStore,
    private readonly http: HttpClient = defaultHttpClient,
    private readonly log?: (message: string) => void
  ) {}

  /** Runtime-style send: never throws — a notify failure must never halt an autonomous run. */
  async send(message: string): Promise<void> {
    const token = await this.secrets.getToken();
    const chatId = await this.secrets.getChatId();
    if (!token || !chatId) {
      this.log?.('Telegram send skipped: credentials not configured.');
      return;
    }
    try {
      await this.http.postJson(sendUrl(token), { chat_id: chatId, text: message });
    } catch {
      this.log?.('Telegram send failed (suppressed).');
    }
  }

  /** Loud test: surfaces the real Telegram outcome so a bad token fails at setup time. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    const token = await this.secrets.getToken();
    const chatId = await this.secrets.getChatId();
    if (!token || !chatId) {
      return { ok: false, detail: 'Missing bot token or chat ID — save both first.' };
    }
    let res: HttpResponse;
    try {
      res = await this.http.postJson(sendUrl(token), { chat_id: chatId, text: TEST_MESSAGE });
    } catch (e) {
      return { ok: false, detail: `Network error: ${errMsg(e)}` };
    }
    const root = asRecord(safeJson(res.body));
    if (root && root.ok === true) {
      const result = asRecord(root.result);
      const chat = result ? asRecord(result.chat) : undefined;
      const detail = chat
        ? String(chat.title ?? chat.username ?? chat.first_name ?? chat.id)
        : String(chatId);
      return { ok: true, detail };
    }
    const code = root && root.error_code !== undefined ? root.error_code : res.statusCode;
    const desc = root && root.description !== undefined ? root.description : 'Unknown error';
    return { ok: false, detail: `${code}: ${desc}` };
  }

  /** One-shot GET to getUpdates; parses the most recent update's message.chat.id. No polling. */
  async autoDetectChatId(): Promise<AutoDetectResult> {
    const token = await this.secrets.getToken();
    if (!token) {
      return { ok: false, detail: 'Save the bot token first.' };
    }
    let res: HttpResponse;
    try {
      res = await this.http.get(getUpdatesUrl(token));
    } catch (e) {
      return { ok: false, detail: `Network error: ${errMsg(e)}` };
    }
    const root = asRecord(safeJson(res.body));
    if (!root || root.ok !== true) {
      const code = root && root.error_code !== undefined ? root.error_code : res.statusCode;
      const desc = root && root.description !== undefined ? root.description : 'Could not fetch updates';
      return { ok: false, detail: `${code}: ${desc}` };
    }
    const updates = Array.isArray(root.result) ? root.result : [];
    for (let i = updates.length - 1; i >= 0; i--) {
      const update = asRecord(updates[i]);
      const message = update ? asRecord(update.message) : undefined;
      const chat = message ? asRecord(message.chat) : undefined;
      if (chat && chat.id !== undefined) {
        return {
          ok: true,
          chatId: String(chat.id),
          detail: String(chat.title ?? chat.username ?? chat.first_name ?? chat.id)
        };
      }
    }
    return {
      ok: false,
      detail: 'No recent messages found — send your bot a message first, then try again.'
    };
  }
}

function sendUrl(token: string): string {
  return `https://api.telegram.org/bot${token}/sendMessage`;
}

function getUpdatesUrl(token: string): string {
  return `https://api.telegram.org/bot${token}/getUpdates`;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

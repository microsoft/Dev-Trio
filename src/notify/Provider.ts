/**
 * A one-way, outbound notification channel.
 *
 * There is intentionally NO receive method anywhere in this interface or its
 * implementations — Dev-Trio notifications are outbound only.
 */
export interface NotificationProvider {
  /** Stable identifier, e.g. "telegram". */
  id: string;
  /** Human-readable label for UI. */
  label: string;
  /** Runtime-style send. Implementations swallow errors (fire-and-forget). */
  send(message: string): Promise<void>;
  /** Loud test: returns the real outcome so a bad configuration fails at setup time. */
  test(): Promise<{ ok: boolean; detail: string }>;
}

import type { LogEntry } from '../ui/logViewerPanel';

export interface CreditData {
  totalCredits: number | null;
  models: { [modelName: string]: number };
  outputTokensByModel: { [modelName: string]: number };
  source: 'verified' | 'estimated';
  transcriptId: string;
  /** Estimated Claude Code token usage (input + output) in this entry's time window. */
  claudeCodeTokens?: number;
  /** Estimated Codex token usage (input + output) in this entry's time window. */
  codexTokens?: number;
}

export interface EnrichedLogEntry extends LogEntry {
  credits: CreditData | null;
}

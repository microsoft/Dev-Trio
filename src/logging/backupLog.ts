import * as vscode from 'vscode';
import { utcBackupStamp } from '../init/skeletonGenerator';

/** First-line marker stamped into every NEW Dev-Trio log file; used to validate genuine logs. */
export const LOG_FILE_SENTINEL = '<!-- DEV-TRIO-LOG-V1 -->';

/** Exact header written when a new backup log is created (sentinel + header + one trailing blank line). */
const BACKUP_LOG_HEADER =
  LOG_FILE_SENTINEL + '\n' +
  '# Dev-Trio Chat Backup Log\n' +
  '\n' +
  '_Append-only archive of plan/implement/audit cycles. Entries are added by the Dev-Trio Planner; existing content is never modified._\n' +
  '\n';

const NEWLINE = 0x0a;

export interface ProvisionOptions {
  readonly mode: 'create' | 'existing';
  readonly targetUri: vscode.Uri;
}

export interface ProvisionResult {
  readonly path: string;
  readonly created: boolean;
}

/**
 * Provisions the append-only backup log.
 *
 * The ONLY mutation this function ever performs on an existing file is the single-byte
 * newline guard below: when the file is non-empty and does not already end in "\n",
 * exactly one "\n" is appended. Original bytes are never rewritten, reordered, or removed.
 *
 * @returns the resolved absolute path and whether a new file was created.
 */
export async function provisionBackupLog(opts: ProvisionOptions): Promise<ProvisionResult> {
  const { mode, targetUri } = opts;
  const resolvedPath = targetUri.fsPath;

  if (mode === 'create') {
    if (!(await pathExists(targetUri))) {
      const parentUri = vscode.Uri.joinPath(targetUri, '..');
      await vscode.workspace.fs.createDirectory(parentUri);
      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(BACKUP_LOG_HEADER));
      return { path: resolvedPath, created: true };
    }
    // File already exists at the default path: treat as existing — never recreate or overwrite.
    await applyNewlineGuard(targetUri);
    return { path: resolvedPath, created: false };
  }

  // mode === 'existing': newline guard only, never alter existing content.
  await applyNewlineGuard(targetUri);
  return { path: resolvedPath, created: false };
}

/**
 * Builds the exact append-only PowerShell command the planner uses to log one cycle.
 * Uses Add-Content (append) — never Set-Content — and writes one leading blank line,
 * the entry, then one trailing blank line. The planner substitutes <ENTRY>.
 */
export function buildLogAppendCommand(absoluteLogPath: string): string {
  return 'Add-Content -Path "' + absoluteLogPath + '" -Value "`n<ENTRY>`n"';
}

/**
 * Resolves the configured backup-log location: the absolute path stored in
 * `dev-trio.backupLog.defaultPath` if set. Returns undefined when no path is
 * configured — there is no workspace default, so backup logging stays
 * unconfigured until the user explicitly sets it up.
 */
export function resolveConfiguredLogUri(): vscode.Uri | undefined {
  const custom = (
    vscode.workspace.getConfiguration('dev-trio').get<string>('backupLog.defaultPath') ?? ''
  ).trim();
  return custom ? vscode.Uri.file(custom) : undefined;
}

/** True when the effective backup log exists on disk (i.e. has been provisioned). */
export async function isBackupLogConfigured(): Promise<boolean> {
  const uri = resolveConfiguredLogUri();
  if (!uri) {
    return false;
  }
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** One parsed RESULT line from the backup log, newest-first when returned in a list. */
export interface ResultEntry {
  /** The text after "RESULT:" (trimmed). */
  readonly result: string;
  /** Semantic category derived from the result text. */
  readonly category: 'TASK COMPLETE' | 'ERROR' | 'DECISION NEEDED' | 'OTHER';
  /** Timestamp from the most recent "[YYYY-MM-DD HH:MM:SS]" line above this RESULT, if any. */
  readonly timestamp: string | undefined;
  /** Text from the most recent "PROMPT:" line above this RESULT, if any. */
  readonly prompt: string | undefined;
}

/**
 * Reads the backup log and returns up to `limit` of the most recent RESULT entries
 * (newest first). Never throws — a missing/unreadable/empty log yields an empty array.
 */
export async function readRecentResults(logUri: vscode.Uri, limit: number): Promise<ResultEntry[]> {
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(logUri));
  } catch {
    return [];
  }

  const tsPattern = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;
  const entries: ResultEntry[] = [];
  let lastTimestamp: string | undefined;
  let lastPrompt: string | undefined;

  for (const rawLine of text.split('\n')) {
    const tsMatch = tsPattern.exec(rawLine);
    if (tsMatch) {
      lastTimestamp = tsMatch[1];
      lastPrompt = undefined;
      continue;
    }
    const promptMatch = /^\s*PROMPT:\s*(.*\S)\s*$/.exec(rawLine);
    if (promptMatch) {
      lastPrompt = promptMatch[1].trim();
      continue;
    }
    const resultMatch = /^\s*RESULT:\s*(.*\S)\s*$/.exec(rawLine);
    if (resultMatch) {
      const result = resultMatch[1].trim();
      entries.push({ result, category: categorize(result), timestamp: lastTimestamp, prompt: lastPrompt });
    }
  }

  return entries.reverse().slice(0, Math.max(0, limit));
}

function categorize(result: string): ResultEntry['category'] {
  const upper = result.toUpperCase();
  if (upper.includes('TASK COMPLETE')) {
    return 'TASK COMPLETE';
  }
  if (upper.includes('DECISION NEEDED')) {
    return 'DECISION NEEDED';
  }
  if (upper.includes('ERROR')) {
    return 'ERROR';
  }
  return 'OTHER';
}

async function applyNewlineGuard(uri: vscode.Uri): Promise<void> {
  const existing = await vscode.workspace.fs.readFile(uri);
  if (existing.length === 0 || existing[existing.length - 1] === NEWLINE) {
    return;
  }
  const guarded = new Uint8Array(existing.length + 1);
  guarded.set(existing, 0);
  guarded[existing.length] = NEWLINE;
  await vscode.workspace.fs.writeFile(uri, guarded);
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** First-line sentinel string identifying a genuine Dev-Trio session log. */
export async function isValidDevTrioLog(uri: vscode.Uri): Promise<boolean> {
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return text.split('\n')[0].trim() === LOG_FILE_SENTINEL;
  } catch {
    return false;
  }
}

/**
 * Copies the log at `uri` to a timestamped sibling "<name>.<UTC-stamp>.bak" using the same backup
 * filename convention as the skeleton generator (utcBackupStamp). Never overwrites an existing
 * backup. Returns the backup URI; throws on any failure so the caller can abort.
 */
export async function backupLogFile(uri: vscode.Uri): Promise<vscode.Uri> {
  const backupUri = uri.with({ path: uri.path + '.' + utcBackupStamp(new Date()) + '.bak' });
  await vscode.workspace.fs.copy(uri, backupUri, { overwrite: false });
  return backupUri;
}

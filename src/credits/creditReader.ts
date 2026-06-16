import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { LogEntry } from '../ui/logViewerPanel';
import type { CreditData, EnrichedLogEntry } from './types';
import { readAgentConfig } from '../utils/agentDetection';

/**
 * Largest single JSONL line we will parse. VS Code's chatSessions kind:0 snapshot can be tens of MB
 * (it holds every request's token data), so this cap must comfortably exceed it.
 */
const MAX_LINE_BYTES = 200 * 1024 * 1024;

/**
 * Completion-tokens-per-credit by model family (GitHub Copilot usage-based billing approximations,
 * Phase 79). A credit is $0.01; pricier models consume a credit in fewer tokens. Matched by substring
 * so prefixed ids ("copilot/claude-opus-4.8") resolve correctly. Order matters: the more specific gpt
 * variants are tested before the broader gpt-4o family.
 */
function tokensPerCredit(model: string): number {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) {
    return 8;
  }
  if (m.includes('sonnet')) {
    return 33;
  }
  if (m.includes('gpt-4o-mini') || m.includes('gpt-4-turbo')) {
    return 100;
  }
  if (m.includes('gpt-4o')) {
    return 50;
  }
  if (m.includes('gpt-4.5') || m.includes('gpt-5')) {
    return 25;
  }
  return 33;
}

/** Safety cap on object-nodes visited while walking a single parsed line. */
const MAX_WALK_NODES = 40000000;

/** One correlated chat request: absolute ms timestamp, input/output tokens, total, model name. */
interface RequestUsage {
  ts: number;
  inTok: number;
  outTok: number;
  tokens: number;
  model: string;
}

/** Embedded GitHub Copilot AIC pricing for a model (AI Credits per 1,000,000 tokens). */
interface ModelPricing {
  inputCost: number;
  outputCost: number;
}

/**
 * Accumulator for order-based recent-turn attribution (DECISION A, Phase 82). The kind:0 snapshot
 * holds requests[0..snapshotReqCount-1] (all timestamped, captured by the walker). The most recent
 * turns live only in kind:1 completionTokens deltas (request index -> output tokens) and carry NO
 * timestamp, so they cannot be windowed; they are attributed to post-snapshot log entries by order.
 */
interface OrphanData {
  snapshotReqCount: number;
  deltaCt: Map<number, number>;
}

/** Coerces a value to a finite number, else 0. */
function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) ? x : 0;
}

/** Normalizes a workspace URI string for comparison: decoded once, trimmed; raw string on error. */
function normalizeUri(s: string): string {
  try {
    return decodeURIComponent(s).trim();
  } catch {
    return s.trim();
  }
}

/** Parses a backup-log timestamp ("YYYY-MM-DD HH:MM:SS", local time) to absolute ms; NaN on error. */
function parseEntryMs(ts: string): number {
  return new Date(ts.replace(' ', 'T')).getTime();
}

/**
 * Resolves the VS Code workspaceStorage directory for THIS workspace by matching each candidate
 * dir's workspace.json "folder" against the open workspace URI (both normalized with
 * decodeURIComponent because VS Code sometimes percent-encodes the drive colon). Returns the dir
 * only when it contains a chatSessions/ or GitHub.copilot-chat/transcripts/ directory with at least
 * one .jsonl; otherwise null. All filesystem errors are swallowed and logged.
 *
 * Node fs is used deliberately: workspaceStorage lives OUTSIDE any workspace (%APPDATA%), the same
 * established exception used by src/notify/notifyScript.ts for out-of-workspace local files.
 */
export function getWorkspaceStoragePath(workspaceUri: vscode.Uri, log?: (m: string) => void): string | null {
  try {
    const base = path.join(process.env.APPDATA || '', 'Code', 'User', 'workspaceStorage');
    if (!fs.existsSync(base)) {
      log?.('credits: storage not found');
      return null;
    }
    const target = normalizeUri(workspaceUri.toString());
    let subdirs: fs.Dirent[];
    try {
      subdirs = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      log?.('credits: storage not found');
      return null;
    }
    for (const d of subdirs) {
      if (!d.isDirectory()) {
        continue;
      }
      const subdir = path.join(base, d.name);
      try {
        const wjPath = path.join(subdir, 'workspace.json');
        if (!fs.existsSync(wjPath)) {
          continue;
        }
        const wj = JSON.parse(fs.readFileSync(wjPath, 'utf8'));
        const folder = wj && typeof wj.folder === 'string' ? wj.folder : null;
        if (!folder || normalizeUri(folder) !== target) {
          continue;
        }
        const chatSessionsDir = path.join(subdir, 'chatSessions');
        const transcriptsDir = path.join(subdir, 'GitHub.copilot-chat', 'transcripts');
        const hasChat =
          fs.existsSync(chatSessionsDir) && fs.readdirSync(chatSessionsDir).some((n) => n.endsWith('.jsonl'));
        const hasTrans =
          fs.existsSync(transcriptsDir) && fs.readdirSync(transcriptsDir).some((n) => n.endsWith('.jsonl'));
        if (hasChat || hasTrans) {
          log?.('credits: storage matched: ' + d.name);
          return subdir;
        }
      } catch {
        // Unreadable subdir or malformed workspace.json — skip and keep scanning.
      }
    }
    log?.('credits: storage not found');
    return null;
  } catch (err) {
    log?.('credits: getWorkspaceStoragePath error — ' + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}

/** Lists chatSessions/*.jsonl for a storage path, newest-first, capped at 100. Returns [] on error. */
export function findChatSessionFiles(storagePath: string, log?: (m: string) => void): string[] {
  try {
    const dir = path.join(storagePath, 'chatSessions');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const files: { file: string; mtime: number }[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const full = path.join(dir, name);
      try {
        files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        // Unstatable file — skip.
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const result = files.slice(0, 100).map((f) => f.file);
    log?.('credits: found ' + result.length + ' chat session file(s)');
    return result;
  } catch (err) {
    log?.('credits: findChatSessionFiles error — ' + (err instanceof Error ? err.message : String(err)));
    return [];
  }
}

/** Best-effort search for a nested model name within a request node (bounded depth + breadth). */
function findModelDeep(node: unknown): string {
  const stack: { v: any; d: number }[] = [{ v: node, d: 0 }];
  let visited = 0;
  while (stack.length) {
    const top = stack.pop();
    if (!top) {
      continue;
    }
    const v = top.v;
    if (!v || typeof v !== 'object' || top.d > 5 || visited > 4000) {
      continue;
    }
    visited++;
    if (typeof v.model === 'string' && v.model) {
      return v.model;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && i < 50; i++) {
        stack.push({ v: v[i], d: top.d + 1 });
      }
    } else {
      for (const k of Object.keys(v)) {
        const c = v[k];
        if (c && typeof c === 'object') {
          stack.push({ v: c, d: top.d + 1 });
        }
      }
    }
  }
  return '';
}

/** Records a request-usage tuple if `node` is a timestamped request carrying token data. */
function maybeRecord(node: any, byId: Map<string, RequestUsage>): void {
  const ts = num(node.timestamp);
  if (ts <= 0) {
    return;
  }
  const usage = node.usage && typeof node.usage === 'object' ? node.usage : null;
  const inTok = num(node.promptTokens) || (usage ? num(usage.prompt_tokens) : 0);
  const outTok = num(node.outputTokens) || num(node.completionTokens) || (usage ? num(usage.completion_tokens) : 0);
  const total = usage ? num(usage.total_tokens) : 0;
  const tokens = total > 0 ? total : inTok + outTok;
  if (tokens <= 0) {
    return;
  }
  const model =
    typeof node.modelId === 'string' && node.modelId
      ? node.modelId
      : typeof node.model === 'string' && node.model
        ? node.model
        : findModelDeep(node);
  const id = typeof node.requestId === 'string' ? node.requestId : ts + ':' + tokens;
  const existing = byId.get(id);
  if (!existing || tokens > existing.tokens) {
    byId.set(id, { ts, inTok, outTok, tokens, model: model || (existing ? existing.model : '') });
  }
}

/** Normalizes a model id for pricing-map matching: lowercased, with any vendor/ prefix stripped. */
function normModelId(s: string): string {
  return (s || '').toLowerCase().replace(/^.*\//, '').trim();
}

/**
 * Records embedded AIC pricing when `node` is a model-metadata block carrying numeric inputCost +
 * outputCost (VS Code Copilot Chat embeds the currently-selected model's rates at
 * inputState.selectedModel.metadata). Keyed by every id-like field present (id / family /
 * identifier), each normalized, so a request modelId like "copilot/claude-opus-4.8" matches the
 * metadata id "claude-opus-4.8".
 */
function maybeRecordPricing(node: any, pricing: Map<string, ModelPricing>): void {
  const ic = node.inputCost;
  const oc = node.outputCost;
  if (typeof ic !== 'number' || typeof oc !== 'number') {
    return;
  }
  for (const key of [node.id, node.family, node.identifier]) {
    if (typeof key === 'string' && key) {
      pricing.set(normModelId(key), { inputCost: ic, outputCost: oc });
    }
  }
}

/** Looks up embedded pricing for a model id (exact normalized match, then family substring). */
function lookupPricing(pricing: Map<string, ModelPricing>, model: string): ModelPricing | null {
  const k = normModelId(model);
  if (!k) {
    return null;
  }
  const exact = pricing.get(k);
  if (exact) {
    return exact;
  }
  for (const [mk, p] of pricing) {
    if (mk && (k.includes(mk) || mk.includes(k))) {
      return p;
    }
  }
  return null;
}

/** JSON-parses one line and iteratively walks it, recording every timestamped request with tokens. */
async function walkLineForUsage(
  line: string,
  byId: Map<string, RequestUsage>,
  pricing: Map<string, ModelPricing>,
  orphan: OrphanData
): Promise<void> {
  let root: any;
  try {
    root = JSON.parse(line);
  } catch {
    return;
  }
  if (!root || typeof root !== 'object') {
    return;
  }
  // kind:0 snapshot — remember how many requests it already contained (all timestamped).
  if (root.kind === 0 && root.v && Array.isArray(root.v.requests)) {
    orphan.snapshotReqCount = root.v.requests.length;
  }
  // kind:1 completionTokens delta — { kind:1, k:["requests", idx, "completionTokens"], v: tokens }.
  // These carry the recent turns' output tokens but no timestamp (DECISION A handles them).
  if (
    root.kind === 1 &&
    Array.isArray(root.k) &&
    root.k[0] === 'requests' &&
    typeof root.k[1] === 'number' &&
    root.k[2] === 'completionTokens' &&
    typeof root.v === 'number'
  ) {
    orphan.deltaCt.set(root.k[1], root.v);
  }
  const stack: any[] = [root];
  let visited = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') {
      continue;
    }
    visited++;
    if (visited % 500000 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    if (visited > MAX_WALK_NODES) {
      return;
    }
    if (!Array.isArray(node)) {
      if (typeof node.timestamp === 'number') {
        maybeRecord(node, byId);
      }
      if (typeof node.inputCost === 'number' && typeof node.outputCost === 'number') {
        maybeRecordPricing(node, pricing);
      }
    }
    if (Array.isArray(node)) {
      for (const el of node) {
        if (el && typeof el === 'object') {
          stack.push(el);
        }
      }
    } else {
      for (const k of Object.keys(node)) {
        const c = node[k];
        if (c && typeof c === 'object') {
          stack.push(c);
        }
      }
    }
  }
}

/** Streams one chatSessions file, accumulating request-usage tuples into `byId`. Never throws. */
function collectFileUsage(
  file: string,
  byId: Map<string, RequestUsage>,
  pricing: Map<string, ModelPricing>,
  orphan: OrphanData
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const stream = fs.createReadStream(file, { encoding: 'utf8' });
      stream.on('error', () => done());
      const rl = readline.createInterface({ input: stream });
      const lines: string[] = [];
      rl.on('line', (line) => {
        if (line.length <= MAX_LINE_BYTES) {
          lines.push(line);
        }
      });
      rl.on('close', () => {
        void (async () => {
          for (const line of lines) {
            try {
              await walkLineForUsage(line, byId, pricing, orphan);
            } catch {
              // Skip a bad line.
            }
          }
          done();
        })();
      });
    } catch {
      done();
    }
  });
}

// SOURCE 1 (Copilot CLI session-state, ~/.copilot/session-state) is intentionally NOT used for
// GHCP (VS Code Copilot Chat) credit tracking. GHCP writes its usage to the chatSessions snapshot
// (SOURCE 2) that this reader already parses. CLI session-state belongs to the separate terminal
// Copilot CLI product, so reading it here would be the wrong source and waste disk I/O.

/** Reads the workspace credits cache (.dev-trio/credits-cache.json) via workspace.fs; {} on error. */
export async function readCreditsCache(workspaceUri: vscode.Uri): Promise<Record<string, CreditData>> {
  const uri = vscode.Uri.joinPath(workspaceUri, '.dev-trio', 'credits-cache.json');
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, CreditData>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Writes the workspace credits cache via workspace.fs; all errors are swallowed. */
export async function writeCreditsCache(
  workspaceUri: vscode.Uri,
  cache: Record<string, CreditData>
): Promise<void> {
  try {
    const dir = vscode.Uri.joinPath(workspaceUri, '.dev-trio');
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, 'credits-cache.json');
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(cache, null, 2)));
  } catch {
    // Best-effort cache write — never surface an error to the caller.
  }
}

/**
 * Canonical form for matching a Claude Code project directory to a workspace path: lowercased with
 * every run of non-alphanumeric characters collapsed to a single hyphen, then trimmed. This
 * sidesteps Claude Code's exact hyphen-substitution encoding (single vs double hyphen, drive-letter
 * case) and reliably equates e.g. "C:\\Users\\me\\My Proj" with "c--Users-me-My-Proj".
 */
function claudeNormalize(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Collects (timestamp-ms, tokens) usage records from this workspace's Claude Code session JSONL
 * files. Claude Code stores per-project JSONL DIRECTLY under ~/.claude/projects/<hyphen-dir>/ (no
 * sessions/ subdir); assistant entries carry an ISO-8601 "timestamp" and message.usage with
 * input_tokens + output_tokens. The project dir is matched by claudeNormalize equality (then a
 * contains fallback). Node fs is used (out-of-workspace home dir — the established #11 exception).
 * Returns [] on any error or when no project dir matches.
 */
function collectClaudeCodeUsage(workspaceUri: vscode.Uri, log?: (m: string) => void): { ts: number; tokens: number }[] {
  const out: { ts: number; tokens: number }[] = [];
  try {
    const base = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(base)) {
      return out;
    }
    const target = claudeNormalize(workspaceUri.fsPath);
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return out;
    }
    let matched: string | null = null;
    for (const d of dirs) {
      if (d.isDirectory() && claudeNormalize(d.name) === target) {
        matched = path.join(base, d.name);
        break;
      }
    }
    if (!matched) {
      for (const d of dirs) {
        if (!d.isDirectory()) {
          continue;
        }
        const dn = claudeNormalize(d.name);
        if (dn && target && (dn.includes(target) || target.includes(dn))) {
          matched = path.join(base, d.name);
          break;
        }
      }
    }
    if (!matched) {
      log?.('credits: no Claude Code project dir matched this workspace');
      return out;
    }
    let names: string[];
    try {
      names = fs.readdirSync(matched);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(matched, name), 'utf8').split(/\r?\n/);
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line) {
          continue;
        }
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!o || typeof o !== 'object' || o.type !== 'assistant') {
          continue;
        }
        const usage = o.message && o.message.usage && typeof o.message.usage === 'object' ? o.message.usage : null;
        if (!usage) {
          continue;
        }
        const tokens = num(usage.input_tokens) + num(usage.output_tokens);
        if (tokens <= 0) {
          continue;
        }
        const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : num(o.timestamp);
        if (!isFinite(ts) || isNaN(ts) || ts <= 0) {
          continue;
        }
        out.push({ ts, tokens });
      }
    }
    log?.('credits: collected ' + out.length + ' Claude Code usage record(s)');
    return out;
  } catch {
    return out;
  }
}

/**
 * Collects (timestamp-ms, tokens) usage records from Codex session JSONL files (~/.codex/log/).
 *
 * PROVISIONAL: format unverified against real data.
 * Verified once a real ~/.codex/log/session-*.jsonl exists. Update format handling if needed.
 *
 * Handles both message.usage.{input,output}_tokens and usage.{input,output}_tokens, and timestamps
 * as an ISO string (timestamp), ms (ts), or ms/seconds (created_at). Returns [] when ~/.codex/log/
 * is absent or on any error.
 */
function collectCodexUsage(log?: (m: string) => void): { ts: number; tokens: number }[] {
  const out: { ts: number; tokens: number }[] = [];
  try {
    const base = path.join(os.homedir(), '.codex', 'log');
    if (!fs.existsSync(base)) {
      return out;
    }
    let names: string[];
    try {
      names = fs.readdirSync(base);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(base, name), 'utf8').split(/\r?\n/);
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line) {
          continue;
        }
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!o || typeof o !== 'object') {
          continue;
        }
        const usage =
          o.message && o.message.usage && typeof o.message.usage === 'object'
            ? o.message.usage
            : o.usage && typeof o.usage === 'object'
              ? o.usage
              : null;
        if (!usage) {
          continue;
        }
        const tokens = num(usage.input_tokens) + num(usage.output_tokens);
        if (tokens <= 0) {
          continue;
        }
        let ts = NaN;
        if (typeof o.timestamp === 'string') {
          ts = Date.parse(o.timestamp);
        } else if (typeof o.ts === 'number') {
          ts = o.ts;
        } else if (typeof o.created_at === 'number') {
          ts = o.created_at < 1e12 ? o.created_at * 1000 : o.created_at;
        }
        if (!isFinite(ts) || isNaN(ts) || ts <= 0) {
          continue;
        }
        out.push({ ts, tokens });
      }
    }
    log?.('credits: collected ' + out.length + ' Codex usage record(s)');
    return out;
  } catch {
    return out;
  }
}

/**
 * Sums Claude Code assistant token usage (input + output) within the backward window
 * (lowerMs, upperMs]. Pass preCollected (from collectClaudeCodeUsage) to avoid re-scanning files per
 * entry. Returns null when no matching usage. Never throws.
 */
async function readClaudeCodeCredits(
  workspaceUri: vscode.Uri,
  lowerMs: number,
  upperMs: number,
  preCollected?: { ts: number; tokens: number }[]
): Promise<number | null> {
  try {
    const recs = preCollected ?? collectClaudeCodeUsage(workspaceUri);
    let sum = 0;
    let hit = false;
    for (const r of recs) {
      if (r.ts > lowerMs && r.ts <= upperMs) {
        sum += r.tokens;
        hit = true;
      }
    }
    return hit && sum > 0 ? sum : null;
  } catch {
    return null;
  }
}

/**
 * Sums Codex assistant token usage within the backward window (lowerMs, upperMs]. Pass preCollected
 * (from collectCodexUsage) to avoid re-scanning. Returns null when no matching usage. Never throws.
 */
async function readCodexCredits(
  lowerMs: number,
  upperMs: number,
  preCollected?: { ts: number; tokens: number }[]
): Promise<number | null> {
  try {
    const recs = preCollected ?? collectCodexUsage();
    let sum = 0;
    let hit = false;
    for (const r of recs) {
      if (r.ts > lowerMs && r.ts <= upperMs) {
        sum += r.tokens;
        hit = true;
      }
    }
    return hit && sum > 0 ? sum : null;
  } catch {
    return null;
  }
}

/**
 * Per-successful-request AIC estimate by model family. VS Code's Copilot Chat.log records one
 * "ccreq ... | success | <model> | <ms> | [channel]" line per model call but no token/AIC figures,
 * so these per-request rates approximate the credit cost from each model's published per-token
 * pricing applied to a typical request size (roughly 5K input + 500 output tokens). The values are
 * deliberately conservative so a multi-call agent turn totals in a reasonable range rather than
 * over-counting every quick tool call. source 'estimated'.
 */
function aicPerRequest(model: string): number {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) {
    return 8;
  }
  if (m.includes('sonnet')) {
    return 3;
  }
  if (m.includes('haiku')) {
    return 0.5;
  }
  if (m.includes('gpt-5.5')) {
    return 5;
  }
  if (m.includes('gpt-5.4-mini')) {
    return 1;
  }
  return 2;
}

/**
 * True when a ccreq success record is genuine Planner/Implementer/Critic agent work that should be
 * credited. Alongside agent turns, VS Code's Copilot Chat issues many background model calls that
 * are infrastructure rather than Dev-Trio work: helper-model calls (gpt-4o-mini, embeddings,
 * transcription, image generation) and GHCP-internal operations (title/summary generation through
 * the language-model wrapper, progress-message summaries, automatic conversation compaction). Those
 * are excluded so the credit total reflects only agent work.
 *
 * Excluded by MODEL (helper models, in any channel): gpt-4o-mini / gpt-4-mini helpers, embedding
 * models, whisper, dall-e, tts. Excluded by CHANNEL (GHCP-internal background work, with any model):
 * copilotLanguageModelWrapper, progressMessages, summarizeConversationHistory. Keeping only the
 * agent channels (panel/editAgent and tool/runSubagent-*) also enforces the rule that a small coding
 * model such as gpt-5.4-mini is credited only when it is doing edit/agent work, not a wrapper call.
 */
function isCreditedCcreq(model: string, channel: string): boolean {
  const m = (model || '').toLowerCase();
  const c = (channel || '').toLowerCase();
  if (
    m.includes('gpt-4o-mini') ||
    m.includes('gpt-4-mini') ||
    m.includes('embedding') ||
    m.includes('whisper') ||
    m.includes('dall-e') ||
    m.includes('tts-')
  ) {
    return false;
  }
  if (
    c.includes('copilotlanguagemodelwrapper') ||
    c.includes('progressmessages') ||
    c.includes('summarizeconversationhistory')
  ) {
    return false;
  }
  return true;
}

/** One successful Copilot Chat request: absolute ms timestamp + model name (from the ccreq log). */
interface CcreqRecord {
  ts: number;
  model: string;
}

/** Recursively lists every "GitHub Copilot Chat.log" under a VS Code logs root. Bounded; never throws. */
function findChatLogFiles(base: string): string[] {
  const out: string[] = [];
  const stack: string[] = [base];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop();
    if (!dir || visited > 20000) {
      break;
    }
    visited++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name === 'GitHub Copilot Chat.log') {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Reads VS Code's GitHub Copilot Chat.log files (%APPDATA%\Code\logs\...) and collects one record
 * per SUCCESSFUL model request: its exact wall-clock timestamp and model name, parsed from lines of
 * the form "2026-06-15 11:13:20.450 [info] ccreq:<id> | success | <model> -> <alias> | <ms> | [ch]".
 * This is the only locally available source with per-request timestamps (the chatSessions snapshot
 * stops timestamping recent turns). Requests are de-duplicated by ccreq id across the per-window log
 * files. Node fs is used deliberately: the logs live OUTSIDE any workspace (the established #11
 * out-of-workspace exception, same as chatSessions and notifyScript.ts). Returns [] on any error.
 */
function collectCcreqUsage(log?: (m: string) => void): CcreqRecord[] {
  const out: CcreqRecord[] = [];
  try {
    const base = path.join(process.env.APPDATA || '', 'Code', 'logs');
    if (!fs.existsSync(base)) {
      return out;
    }
    const files = findChatLogFiles(base);
    const seen = new Set<string>();
    const lineRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\s+\[\w+\]\s+ccreq:(\S+?)\s+\|\s+success\s+\|\s+([^|]+?)\s+\|/;
    const chanRe = /\[([^\]]+)\]\s*$/;
    let filtered = 0;
    for (const f of files) {
      let lines: string[];
      try {
        lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      } catch {
        continue;
      }
      for (const line of lines) {
        const m = lineRe.exec(line);
        if (!m) {
          continue;
        }
        const id = m[2];
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        const ts = new Date(m[1].replace(' ', 'T')).getTime();
        if (isNaN(ts)) {
          continue;
        }
        let model = m[3].trim();
        const arrow = model.indexOf(' -> ');
        if (arrow !== -1) {
          model = model.slice(0, arrow).trim();
        }
        const cm = chanRe.exec(line);
        const channel = cm ? cm[1].trim() : '';
        if (!isCreditedCcreq(model, channel)) {
          filtered++;
          continue;
        }
        out.push({ ts, model });
      }
    }
    log?.('credits: collected ' + out.length + ' credited ccreq success record(s) (' + filtered + ' background call(s) filtered) from ' + files.length + ' chat log file(s)');
    return out;
  } catch (err) {
    log?.('credits: collectCcreqUsage error — ' + (err instanceof Error ? err.message : String(err)));
    return out;
  }
}

/**
 * Enriches parsed log entries with credit data, per entry time window (previous entry timestamp,
 * entry timestamp]. SOURCE 1 (Phase 83, primary): VS Code Copilot Chat.log ccreq success lines give
 * exact per-request timestamps + models, priced per request by aicPerRequest. SOURCE 2 (fallback,
 * only when SOURCE 1 has no requests in the window): sums chatSessions input/output tokens per model
 * and converts them to GitHub Copilot AI Credits using the model's embedded AIC pricing
 * (inputState.selectedModel.metadata.inputCost/outputCost, AICs per 1M tokens) when present,
 * falling back to the approximate tokensPerCredit divisor for any model without embedded pricing.
 * Entries with no requests in their window -> null (no pill). Returns the enriched entries plus
 * snapshotMaxMs (the latest request timestamp across both sources) so the webview can mark entries
 * that postdate it as pending. Any unexpected error degrades to null credits.
 */
export async function enrichLogEntries(
  workspaceUri: vscode.Uri,
  logEntries: LogEntry[],
  log?: (m: string) => void
): Promise<{ entries: EnrichedLogEntry[]; snapshotMaxMs: number | null }> {
  try {
    const cache = await readCreditsCache(workspaceUri);
    const isCached = (e: LogEntry): boolean =>
      !!cache[e.timestamp] && (cache[e.timestamp].source === 'verified' || cache[e.timestamp].source === 'estimated');
    const needCompute = logEntries.some((e) => !isCached(e));

    // SOURCE 1 (Copilot CLI session-state) is intentionally not used for GHCP (VS Code Copilot
    // Chat) — GHCP writes usage to the chatSessions snapshot (SOURCE 2) parsed below.

    // SOURCE 2: chatSessions request usage + embedded AIC pricing (only parsed when needed).
    let usage: RequestUsage[] = [];
    const pricingMap = new Map<string, ModelPricing>();
    const orphan: OrphanData = { snapshotReqCount: 0, deltaCt: new Map<number, number>() };
    if (needCompute) {
      const storagePath = getWorkspaceStoragePath(workspaceUri, log);
      const files = storagePath ? findChatSessionFiles(storagePath, log) : [];
      const byId = new Map<string, RequestUsage>();
      for (const f of files) {
        await collectFileUsage(f, byId, pricingMap, orphan);
      }
      usage = Array.from(byId.values());
      log?.('credits: collected ' + usage.length + ' request-usage record(s), ' + pricingMap.size + ' embedded model price(s), ' + orphan.deltaCt.size + ' delta token record(s)');
    }

    // Latest request timestamp in the snapshot — entries after this have no data yet (pending).
    const usageMaxMs = usage.reduce((m, u) => (u.ts > m ? u.ts : m), 0);

    // SOURCE 1 (Phase 83): VS Code Copilot Chat.log ccreq success lines — the only local source with
    // exact per-request timestamps. Each successful request is priced per model by aicPerRequest.
    const ccreqRecords: CcreqRecord[] = needCompute ? collectCcreqUsage(log) : [];
    const ccreqMaxMs = ccreqRecords.reduce((m, r) => (r.ts > m ? r.ts : m), 0);

    // Pending threshold spans BOTH sources — an entry is pending only when it postdates everything.
    const snapshotMaxMs = Math.max(usageMaxMs, ccreqMaxMs) || null;

    // SOURCE 3 (Claude Code) + SOURCE 4 (Codex): per-workspace agent selection. Absent agent-config
    // => GHCP-only (these stay empty, backward compatible). Collected once; window-summed per entry.
    const agentCfg = await readAgentConfig(workspaceUri);
    const ccUsage = needCompute && agentCfg?.agents.claudeCode === true ? collectClaudeCodeUsage(workspaceUri, log) : [];
    const cxUsage = needCompute && agentCfg?.agents.codex === true ? collectCodexUsage(log) : [];

    const boundaries = Array.from(
      new Set(logEntries.map((e) => parseEntryMs(e.timestamp)).filter((n) => !isNaN(n)))
    ).sort((a, b) => a - b);

    // APPROACH C (Phase 80): the earliest log entry has no previous boundary, so its backward window
    // would be unbounded (-Infinity) and would sweep the entire JSONL prefix into the first turn.
    // Anchor that first window to the earliest collected chatSessions request timestamp (so it is
    // bounded to the JSONL date range), then cap its backward reach to a typical phase duration
    // (the median gap between consecutive log entries) so the first turn is comparable to the others
    // instead of absorbing every request logged before the Dev-Trio backup log began.
    const minUsageTs = usage.reduce((min, u) => (u.ts < min ? u.ts : min), Infinity);
    let medianGap = 0;
    if (boundaries.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < boundaries.length; i++) {
        gaps.push(boundaries[i] - boundaries[i - 1]);
      }
      gaps.sort((a, b) => a - b);
      medianGap = gaps[Math.floor(gaps.length / 2)];
    }

    let cacheChanged = false;
    const out: EnrichedLogEntry[] = [];
    for (const entry of logEntries) {
      if (isCached(entry)) {
        out.push({ ...entry, credits: cache[entry.timestamp] });
        continue;
      }
      const ms = parseEntryMs(entry.timestamp);
      if (isNaN(ms)) {
        out.push({ ...entry, credits: null });
        continue;
      }
      let lower = -Infinity;
      for (const b of boundaries) {
        if (b < ms) {
          lower = b;
        } else {
          break;
        }
      }
      if (lower === -Infinity && isFinite(minUsageTs)) {
        lower = minUsageTs;
        if (medianGap > 0) {
          lower = Math.max(lower, ms - medianGap);
        }
      }

      let credits: CreditData | null = null;

      // SOURCE 1 (Phase 83) — ccreq exact per-request AIC for this window. Counts successful Copilot
      // Chat requests whose timestamp falls in (lower, ms], priced per model by aicPerRequest.
      {
        const models: { [m: string]: number } = {};
        let totalCredits = 0;
        let count = 0;
        for (const r of ccreqRecords) {
          if (r.ts > lower && r.ts <= ms) {
            count++;
            const key = r.model || 'unknown';
            const aic = aicPerRequest(r.model);
            models[key] = (models[key] || 0) + aic;
            totalCredits += aic;
          }
        }
        if (count > 0 && totalCredits > 0) {
          credits = { totalCredits, models, outputTokensByModel: {}, source: 'estimated', transcriptId: 'ccreq' };
        }
      }

      // SOURCE 2 (fallback) — chatSessions tokens converted to credits via embedded AIC pricing (or
      // the tokensPerCredit divisor fallback), used only when SOURCE 1 found no ccreq requests in
      // this window. Historical snapshot requests carry only completionTokens (output); promptTokens
      // is absent so the input-cost term is 0 for them.
      if (credits === null) {
        const modelIn = new Map<string, number>();
        const modelOut = new Map<string, number>();
        let any = false;
        for (const u of usage) {
          if (u.ts > lower && u.ts <= ms) {
            modelIn.set(u.model, (modelIn.get(u.model) || 0) + u.inTok);
            modelOut.set(u.model, (modelOut.get(u.model) || 0) + u.outTok);
            if (u.inTok + u.outTok > 0) {
              any = true;
            }
          }
        }
        if (any) {
          const models: { [m: string]: number } = {};
          const outputTokensByModel: { [m: string]: number } = {};
          let totalCredits = 0;
          for (const m of new Set([...modelIn.keys(), ...modelOut.keys()])) {
            const key = m || 'unknown';
            const inTok = modelIn.get(m) || 0;
            const outTok = modelOut.get(m) || 0;
            const price = lookupPricing(pricingMap, m);
            const c = price
              ? Math.round((inTok * price.inputCost + outTok * price.outputCost) / 1_000_000)
              : Math.round((inTok + outTok) / tokensPerCredit(m));
            models[key] = c;
            outputTokensByModel[key] = inTok + outTok;
            totalCredits += c;
          }
          credits = { totalCredits, models, outputTokensByModel, source: 'estimated', transcriptId: 'chatSessions' };
        }
      }

      // SOURCE 3 (Claude Code) + SOURCE 4 (Codex): token estimates for this window, attached as
      // separate fields (NOT added to GHCP credits — tokens are a different unit). Builds a credits
      // record if GHCP gave nothing but a token source did. Cached alongside GHCP (no cache-serving
      // change, so the Phase-66 no-recompute rule for cached GHCP entries is preserved).
      const ccTok = await readClaudeCodeCredits(workspaceUri, lower, ms, ccUsage);
      const cxTok = await readCodexCredits(lower, ms, cxUsage);
      if (ccTok !== null || cxTok !== null) {
        if (credits === null) {
          credits = { totalCredits: null, models: {}, outputTokensByModel: {}, source: 'estimated', transcriptId: 'multi-agent' };
        }
        if (ccTok !== null) {
          credits.claudeCodeTokens = ccTok;
        }
        if (cxTok !== null) {
          credits.codexTokens = cxTok;
        }
      }

      if (credits !== null) {
        cache[entry.timestamp] = credits;
        cacheChanged = true;
      }
      out.push({ ...entry, credits });
    }

    // DECISION A (Phase 82): the most recent turns live in kind:1 completionTokens deltas WITHOUT
    // timestamps, so the windowed pass above misses them entirely (those entries show no pill).
    // Attribute these "orphan" turns (request index >= the kind:0 snapshot request count) to the
    // most recent log entries that the windowed pass left empty, by chronological order: the N
    // orphan turns are split into even contiguous groups across the most recent N (or fewer) empty
    // entries, so each gets a proportional share rather than one entry absorbing everything. The
    // carry-forward (session-selected) model + embedded AIC pricing converts tokens to credits.
    // Values are order-approximate — disclosed by the estimated '~' pill — since the deltas carry
    // no per-turn timestamps. Skipped entirely when SOURCE 1 (ccreq) has data, because ccreq already
    // attributes the recent turns by exact timestamp; this replay is only the no-ccreq fallback.
    if (ccreqRecords.length === 0 && orphan.snapshotReqCount > 0) {
      const orphanTokens: number[] = [];
      for (const i of Array.from(orphan.deltaCt.keys()).filter((i) => i >= orphan.snapshotReqCount).sort((a, b) => a - b)) {
        orphanTokens.push(orphan.deltaCt.get(i) || 0);
      }
      if (orphanTokens.length > 0) {
        let orphanModel = 'claude-opus-4.8';
        let orphanRate: ModelPricing | null = null;
        for (const [k, p] of pricingMap) {
          orphanModel = k;
          orphanRate = p;
          break;
        }
        // Empty (no windowed credits, not cached) entries, chronological. Take only the most recent
        // ones, capped at the orphan-turn count, so recent delta usage maps to recent empty entries.
        const empties = out
          .map((e, i) => ({ e, i, ms: parseEntryMs(e.timestamp) }))
          .filter((x) => !isNaN(x.ms) && x.e.credits === null && !isCached(x.e))
          .sort((a, b) => a.ms - b.ms);
        const k = Math.min(empties.length, orphanTokens.length);
        const targets = empties.slice(empties.length - k);
        for (let t = 0; t < targets.length; t++) {
          const start = Math.floor((t * orphanTokens.length) / targets.length);
          const end = Math.floor(((t + 1) * orphanTokens.length) / targets.length);
          let tok = 0;
          for (let j = start; j < end; j++) {
            tok += orphanTokens[j];
          }
          if (tok <= 0) {
            continue;
          }
          const cr = orphanRate
            ? Math.round((tok * orphanRate.outputCost) / 1_000_000)
            : Math.round(tok / tokensPerCredit(orphanModel));
          if (cr <= 0) {
            continue;
          }
          const cd: CreditData = {
            totalCredits: cr,
            models: { [orphanModel]: cr },
            outputTokensByModel: { [orphanModel]: tok },
            source: 'estimated',
            transcriptId: 'chatSessions-delta'
          };
          out[targets[t].i].credits = cd;
          cache[targets[t].e.timestamp] = cd;
          cacheChanged = true;
        }
      }
    }

    if (cacheChanged) {
      await writeCreditsCache(workspaceUri, cache);
    }
    return { entries: out, snapshotMaxMs };
  } catch (err) {
    log?.('credits: enrichLogEntries error — ' + (err instanceof Error ? err.message : String(err)));
    return { entries: logEntries.map((e) => ({ ...e, credits: null })), snapshotMaxMs: null };
  }
}

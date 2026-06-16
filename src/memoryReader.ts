import * as vscode from 'vscode';

/** Parsed, display-ready view of memory/MEMORY.md. All fields degrade gracefully. */
export interface MemoryData {
  /** True when memory/MEMORY.md exists and was read. */
  readonly exists: boolean;
  /** First meaningful line under "## Project", or undefined when not yet set. */
  readonly projectName: string | undefined;
  /** Full text under "## Current Phase", or undefined when not yet set. */
  readonly currentPhase: string | undefined;
  /** Binding constraint texts (the part after "N."), in file order. */
  readonly constraints: readonly string[];
  /** MEMORY.md last-modified time (ms epoch), or undefined when the file is absent. */
  readonly mtime: number | undefined;
}

/** Placeholder the skeleton generator seeds; treated as "not yet filled in" for display. */
const PLACEHOLDER = '(To be filled in.)';

const EMPTY_MEMORY: MemoryData = {
  exists: false,
  projectName: undefined,
  currentPhase: undefined,
  constraints: [],
  mtime: undefined
};

/** True when MEMORY.md has a real Current Phase (i.e. the workspace has been initialized). */
export function isInitialized(memory: MemoryData): boolean {
  const phase = memory.currentPhase?.trim();
  return !!phase && phase.toLowerCase() !== 'not initialized';
}

/** Resolves the workspace-relative location of memory/MEMORY.md. */
export function memoryUri(workspaceUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(workspaceUri, 'memory', 'MEMORY.md');
}

/**
 * Reads and parses memory/MEMORY.md. Never throws — a missing or malformed file yields a
 * fully-defined MemoryData with `exists: false` and empty fields.
 */
export async function readMemory(workspaceUri: vscode.Uri): Promise<MemoryData> {
  const uri = memoryUri(workspaceUri);
  let bytes: Uint8Array;
  let mtime: number | undefined;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    mtime = stat.mtime;
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return EMPTY_MEMORY;
  }

  const text = new TextDecoder().decode(bytes);
  const sections = splitSections(text);

  return {
    exists: true,
    projectName: firstMeaningfulLine(sections.get('Project')),
    currentPhase: firstPhaseLine(sections.get('Current Phase')),
    constraints: parseConstraints(sections.get('Binding Constraints')),
    mtime
  };
}

/** Splits Markdown into a map of "## Heading" -> the lines beneath it (until the next heading). */
function splitSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const rawLine of text.split('\n')) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(rawLine);
    if (headingMatch) {
      current = [];
      sections.set(headingMatch[1], current);
      continue;
    }
    if (current) {
      current.push(rawLine);
    }
  }
  return sections;
}

function firstMeaningfulLine(lines: string[] | undefined): string | undefined {
  if (!lines) {
    return undefined;
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed !== PLACEHOLDER) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Status-annotation prefixes that may lead the Current Phase block but are NOT the phase
 * description. Lines starting with any of these are skipped so a leading issue/decision note never
 * becomes the phase text shown in the sidebar hero and status bar.
 */
const PHASE_MARKER_PREFIXES = ['OPEN CRITICAL ISSUE', 'DECISION NEEDED', 'OPEN ISSUE', 'NOTE:'];

/**
 * The first non-empty, non-placeholder, non-marker line under a section. Used for the phase
 * description so a leading status block never becomes the displayed phase.
 */
function firstPhaseLine(lines: string[] | undefined): string | undefined {
  if (!lines) {
    return undefined;
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed === PLACEHOLDER) {
      continue;
    }
    if (PHASE_MARKER_PREFIXES.some((m) => trimmed.startsWith(m))) {
      continue;
    }
    return trimmed;
  }
  return undefined;
}

function parseConstraints(lines: string[] | undefined): string[] {
  if (!lines) {
    return [];
  }
  const constraints: string[] = [];
  for (const line of lines) {
    const match = /^\s*\d+\.\s+(.*\S)\s*$/.exec(line);
    if (match) {
      constraints.push(match[1].trim());
    }
  }
  return constraints;
}

/** Classifies phase text into a semantic status for the indicator dot. */
export type PhaseStatus = 'amber' | 'green' | 'gray';

export function classifyPhase(phase: string | undefined): PhaseStatus {
  if (!phase) {
    return 'gray';
  }
  const upper = phase.toUpperCase();
  if (upper.includes('DECISION NEEDED') || upper.includes('ERROR') || upper.includes('BLOCKED')) {
    return 'amber';
  }
  if (upper.includes('COMPLETE') || upper.includes('READY') || upper.includes('PASS')) {
    return 'green';
  }
  return 'gray';
}

/** Formats a past timestamp (ms epoch) as a coarse relative string, e.g. "2 minutes ago". */
export function formatRelative(mtime: number, now: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.round((now - mtime) / 1000));
  if (deltaSec < 45) {
    return 'just now';
  }
  const units: ReadonlyArray<readonly [number, string]> = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2592000, 'month'],
    [31536000, 'year']
  ];
  let value = deltaSec;
  let unit = 'second';
  for (let i = units.length - 1; i >= 0; i--) {
    const [secs, name] = units[i];
    if (deltaSec >= secs) {
      value = Math.floor(deltaSec / secs);
      unit = name;
      break;
    }
  }
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

import * as vscode from 'vscode';
import type { ProbeResult } from './workspaceProbe';

/**
 * Sentinel marking a MEMORY.md as a Dev-Trio placeholder/provisional file that the walkthrough
 * may overwrite. Once Copilot replaces MEMORY.md with the real analysis (no marker), it is
 * protected from being clobbered.
 */
export const PROVISIONAL_MARKER = '<!-- DEV-TRIO:PROVISIONAL -->';

/** Legacy placeholder text from the bare skeleton MEMORY.md; also treated as overwritable. */
const SKELETON_PLACEHOLDER = '(To be filled in.)';

/**
 * Writes a probe-seeded provisional memory/MEMORY.md.
 *
 * Overwrites ONLY when the existing file is itself provisional (carries PROVISIONAL_MARKER or the
 * bare-skeleton placeholder) or does not exist. A MEMORY.md authored by Copilot (no marker) is
 * never overwritten.
 */
export async function writeProvisionalMemory(
  workspaceUri: vscode.Uri,
  probe: ProbeResult,
  projectName?: string
): Promise<void> {
  const uri = vscode.Uri.joinPath(workspaceUri, 'memory', 'MEMORY.md');

  const existing = await readText(uri);
  if (existing !== undefined) {
    const overwritable =
      existing.includes(PROVISIONAL_MARKER) || existing.includes(SKELETON_PLACEHOLDER);
    if (!overwritable) {
      return; // Copilot-authored MEMORY.md — protect it.
    }
  }

  const content = renderProvisionalMemory(probe, projectName);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceUri, 'memory'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

/** Renders the provisional MEMORY.md body. Exported for unit testing. */
export function renderProvisionalMemory(probe: ProbeResult, projectName?: string): string {
  const project = projectName && projectName.trim()
    ? projectName.trim()
    : '(To be filled during initialization.)';

  const stackItems = [...probe.languages, ...probe.buildTools];
  const techStack =
    stackItems.length > 0
      ? stackItems.map((s) => `- ${s} (PROVISIONAL)`).join('\n')
      : '- (To be filled during initialization.) (PROVISIONAL)';

  const provisionalLines = [
    `- Languages: ${listOrNone(probe.languages)} (PROVISIONAL)`,
    `- Build tools: ${listOrNone(probe.buildTools)} (PROVISIONAL)`,
    `- Test frameworks: ${listOrNone(probe.testFrameworks)} (PROVISIONAL)`,
    `- Scan confidence: ${probe.confidence} (PROVISIONAL)`,
    `- Markers found: ${listOrNone(probe.markers)} (PROVISIONAL)`
  ].join('\n');

  return `${PROVISIONAL_MARKER}
# Project Memory

## Project

${project}

## Tech Stack

_All entries below are PROVISIONAL — UNVERIFIED until re-derived from the codebase._

${techStack}

## Project Structure

(To be filled during initialization.)

## PROVISIONAL — UNVERIFIED (re-derive from codebase via the init prompt)

The items below were guessed by an offline workspace scan and may be wrong. Replace them by running the initialization prompt in GitHub Copilot Chat.

${provisionalLines}

## Binding Constraints

1. No hardcoded secrets, tokens, or credentials in source, logs, reports, or smoke fixtures.

## Current Phase

Initial setup complete. Ready for first task.

## Session Log
`;
}

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : 'none detected';
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

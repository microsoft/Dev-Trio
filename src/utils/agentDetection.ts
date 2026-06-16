import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Which coding-agent ecosystems are present on this machine / in this workspace. */
export interface AgentPresence {
  ghcp: boolean;
  claudeCode: boolean;
  codex: boolean;
}

/**
 * Detects which agent ecosystems are available. GHCP via installed VS Code extension; Claude Code
 * and Codex via their VS Code extension OR their home-directory config folder. The out-of-workspace
 * home checks use Node fs/os by the established convention (the #11 exception for out-of-workspace reads).
 */
export function detectAgents(): AgentPresence {
  const hasExt = (id: string): boolean => vscode.extensions.getExtension(id) !== undefined;
  const hasExtPrefix = (prefix: string): boolean =>
    vscode.extensions.all.some((ext) => ext.id.toLowerCase().startsWith(prefix));
  const homeHas = (dir: string): boolean => {
    try {
      return fs.existsSync(path.join(os.homedir(), dir));
    } catch {
      return false;
    }
  };
  return {
    ghcp: hasExtPrefix('github.copilot'),
    claudeCode: hasExt('Anthropic.claude-code') || homeHas('.claude'),
    codex: hasExt('openai.chatgpt') || homeHas('.codex')
  };
}

/** Per-role model assignments for a single agent ecosystem (Claude Code or Codex). */
export interface AgentModelConfig {
  planner?: string;
  implementer?: string;
  critic?: string;
}

/** Persisted record of which agents the user selected during setup. */
export interface AgentConfig {
  agents: {
    ghcp: boolean;
    claudeCode: boolean;
    codex: boolean;
  };
  setupVersion: string;
  /**
   * Optional per-role model overrides for Claude Code and Codex. GHCP has NO model overrides by
   * design — its model is chosen in the GitHub Copilot Chat UI, not here.
   */
  models?: {
    claudeCode?: AgentModelConfig;
    codex?: AgentModelConfig;
  };
}

/** Default per-role model assignments (current as of June 2026). The scaffold files ship with these. */
export const DEFAULT_AGENT_MODELS: { claudeCode: Required<AgentModelConfig>; codex: Required<AgentModelConfig> } = {
  claudeCode: { planner: 'claude-opus-4-8', implementer: 'claude-sonnet-4-6', critic: 'claude-sonnet-4-6' },
  codex: { planner: 'gpt-5.5', implementer: 'gpt-5.4-mini', critic: 'gpt-5.4-mini' }
};

/** Selectable model options per agent for the Setup Wizard + Manage Agents dropdowns. */
export const AGENT_MODEL_OPTIONS: { claudeCode: string[]; codex: string[] } = {
  claudeCode: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex: ['gpt-5.5', 'gpt-5.4-mini']
};

const AGENT_CONFIG_DIR = '.dev-trio';
const AGENT_CONFIG_FILE = 'agent-config.json';

/** Reads .dev-trio/agent-config.json. Returns null when absent or on any read/parse error. */
export async function readAgentConfig(workspaceUri: vscode.Uri): Promise<AgentConfig | null> {
  const uri = vscode.Uri.joinPath(workspaceUri, AGENT_CONFIG_DIR, AGENT_CONFIG_FILE);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<AgentConfig>;
    if (!parsed || typeof parsed !== 'object' || !parsed.agents || typeof parsed.agents !== 'object') {
      return null;
    }
    const a = parsed.agents as Partial<AgentConfig['agents']>;
    return {
      agents: {
        ghcp: a.ghcp === true,
        claudeCode: a.claudeCode === true,
        codex: a.codex === true
      },
      setupVersion: typeof parsed.setupVersion === 'string' ? parsed.setupVersion : '1.0.0',
      models: parseModels(parsed.models)
    };
  } catch {
    return null;
  }
}

/** Validates the optional models block, keeping only string role values; undefined when absent. */
function parseModels(raw: unknown): AgentConfig['models'] | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  const pickRoles = (v: unknown): AgentModelConfig | undefined => {
    if (!v || typeof v !== 'object') {
      return undefined;
    }
    const r = v as Record<string, unknown>;
    const out: AgentModelConfig = {};
    if (typeof r.planner === 'string') { out.planner = r.planner; }
    if (typeof r.implementer === 'string') { out.implementer = r.implementer; }
    if (typeof r.critic === 'string') { out.critic = r.critic; }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const claudeCode = pickRoles(src.claudeCode);
  const codex = pickRoles(src.codex);
  if (!claudeCode && !codex) {
    return undefined;
  }
  const models: AgentConfig['models'] = {};
  if (claudeCode) { models.claudeCode = claudeCode; }
  if (codex) { models.codex = codex; }
  return models;
}

/** Writes .dev-trio/agent-config.json, creating .dev-trio/ first. Does not touch other .dev-trio files. */
export async function writeAgentConfig(workspaceUri: vscode.Uri, config: AgentConfig): Promise<void> {
  const dirUri = vscode.Uri.joinPath(workspaceUri, AGENT_CONFIG_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(dirUri, AGENT_CONFIG_FILE);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'));
}

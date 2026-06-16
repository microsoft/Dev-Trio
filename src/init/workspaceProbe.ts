import * as vscode from 'vscode';

/** Result of a deterministic, offline workspace scan used to seed init prompts. */
export interface ProbeResult {
  isEmpty: boolean;
  languages: string[]; // e.g. ["TypeScript", "PowerShell"]
  buildTools: string[]; // e.g. ["esbuild", "msbuild"]
  testFrameworks: string[]; // e.g. ["jest", "vitest", "xunit"]
  markers: string[]; // raw file markers found, e.g. ["package.json", "tsconfig.json"]
  confidence: 'low' | 'medium';
}

const MAX_FILES = 200;

/** Directories never worth scanning (build output, deps, VCS, scratch). */
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'bin',
  'obj',
  'target',
  'vendor',
  '.vscode-test',
  '_temp',
  '_backup',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv'
]);

/** Source file extension → language label. */
const SOURCE_EXT: ReadonlyMap<string, string> = new Map([
  ['.ts', 'TypeScript'],
  ['.tsx', 'TypeScript'],
  ['.js', 'JavaScript'],
  ['.jsx', 'JavaScript'],
  ['.py', 'Python'],
  ['.ps1', 'PowerShell'],
  ['.psm1', 'PowerShell'],
  ['.psd1', 'PowerShell'],
  ['.cs', 'C#/.NET'],
  ['.csproj', 'C#/.NET'],
  ['.sln', 'C#/.NET'],
  ['.go', 'Go'],
  ['.rs', 'Rust'],
  ['.java', 'Java'],
  ['.rb', 'Ruby'],
  ['.php', 'PHP']
]);

/** Files that, alone, do NOT make a workspace "non-empty". */
const IGNORABLE_FILES = new Set(['.gitignore', 'readme.md', 'license', 'license.md', 'license.txt']);

/**
 * Scans the workspace using only vscode.workspace.fs (no network, no command execution, no
 * script evaluation). Reads at most a handful of small manifest files shallowly. Never throws —
 * any failure yields a safe "empty / low confidence" result.
 */
export async function probeWorkspace(workspaceUri: vscode.Uri): Promise<ProbeResult> {
  const languages = new Set<string>();
  const markers: string[] = [];
  const buildTools = new Set<string>();
  const testFrameworks = new Set<string>();

  // --- Sample files (breadth-first, capped) for language detection ---
  let sourceFileSeen = false;
  let meaningfulFileSeen = false;
  try {
    const queue: vscode.Uri[] = [workspaceUri];
    let count = 0;
    while (queue.length > 0 && count < MAX_FILES) {
      const dir = queue.shift() as vscode.Uri;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        continue;
      }
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory) {
          if (!IGNORE_DIRS.has(name)) {
            queue.push(vscode.Uri.joinPath(dir, name));
          }
          continue;
        }
        count++;
        const ext = extOf(name);
        const lang = SOURCE_EXT.get(ext);
        if (lang) {
          languages.add(lang);
          sourceFileSeen = true;
          meaningfulFileSeen = true;
        } else if (!IGNORABLE_FILES.has(name.toLowerCase())) {
          // Tracked only for completeness; non-source files do not flip isEmpty by themselves.
        }
        if (count >= MAX_FILES) {
          break;
        }
      }
    }
  } catch {
    // fall through with whatever was collected
  }

  // --- Root marker scan (build tools, test frameworks, stack markers) ---
  let rootEntries: [string, vscode.FileType][] = [];
  try {
    rootEntries = await vscode.workspace.fs.readDirectory(workspaceUri);
  } catch {
    rootEntries = [];
  }
  const rootFiles = new Set(
    rootEntries.filter(([, t]) => t === vscode.FileType.File).map(([n]) => n)
  );
  const rootFileList = [...rootFiles];

  const addMarker = (name: string): void => {
    if (!markers.includes(name)) {
      markers.push(name);
    }
    meaningfulFileSeen = true;
  };

  // Node / TS / bundlers
  if (rootFiles.has('package.json')) {
    addMarker('package.json');
    buildTools.add('Node');
  }
  if (rootFiles.has('tsconfig.json')) {
    addMarker('tsconfig.json');
  }
  if (rootFiles.has('esbuild.js') || rootFileList.some((f) => /^esbuild\.config\./.test(f))) {
    addMarker(rootFiles.has('esbuild.js') ? 'esbuild.js' : rootFileList.find((f) => /^esbuild\.config\./.test(f)) as string);
    buildTools.add('esbuild');
  }
  if (rootFileList.some((f) => /^vite\.config\./.test(f))) {
    addMarker(rootFileList.find((f) => /^vite\.config\./.test(f)) as string);
    buildTools.add('Vite');
  }
  if (rootFileList.some((f) => /^webpack\.config\./.test(f))) {
    addMarker(rootFileList.find((f) => /^webpack\.config\./.test(f)) as string);
    buildTools.add('webpack');
  }
  // .NET
  const csproj = rootFileList.find((f) => f.toLowerCase().endsWith('.csproj'));
  const sln = rootFileList.find((f) => f.toLowerCase().endsWith('.sln'));
  if (csproj || sln) {
    addMarker((csproj ?? sln) as string);
    buildTools.add('MSBuild/dotnet');
    languages.add('C#/.NET');
  }
  // Other ecosystems
  if (rootFiles.has('pom.xml')) {
    addMarker('pom.xml');
    buildTools.add('Maven');
  }
  if (rootFiles.has('build.gradle') || rootFiles.has('build.gradle.kts')) {
    addMarker(rootFiles.has('build.gradle') ? 'build.gradle' : 'build.gradle.kts');
    buildTools.add('Gradle');
  }
  if (rootFiles.has('Cargo.toml')) {
    addMarker('Cargo.toml');
    buildTools.add('Cargo');
  }
  if (rootFiles.has('go.mod')) {
    addMarker('go.mod');
    buildTools.add('Go modules');
  }
  if (rootFiles.has('Makefile')) {
    addMarker('Makefile');
    buildTools.add('Make');
  }
  if (rootFiles.has('Dockerfile')) {
    addMarker('Dockerfile');
    buildTools.add('Docker');
  }

  // --- Test framework detection ---
  if (rootFiles.has('package.json')) {
    const pkg = await readJson(vscode.Uri.joinPath(workspaceUri, 'package.json'));
    if (pkg) {
      const deps = {
        ...(asRecord(pkg.dependencies) ?? {}),
        ...(asRecord(pkg.devDependencies) ?? {})
      };
      for (const fw of ['jest', 'vitest', 'mocha', 'jasmine', 'karma']) {
        if (fw in deps) {
          testFrameworks.add(fw);
        }
      }
    }
  }
  if (rootFiles.has('pyproject.toml')) {
    addMarker('pyproject.toml');
    testFrameworks.add('pytest');
  }
  if (rootFiles.has('requirements.txt')) {
    addMarker('requirements.txt');
    const req = await readText(vscode.Uri.joinPath(workspaceUri, 'requirements.txt'));
    if (req && /(^|\n)\s*pytest\b/i.test(req)) {
      testFrameworks.add('pytest');
    }
  }
  if (csproj) {
    const content = await readText(vscode.Uri.joinPath(workspaceUri, csproj));
    if (content) {
      if (/PackageReference[^>]*xunit/i.test(content)) {
        testFrameworks.add('xunit');
      }
      if (/PackageReference[^>]*nunit/i.test(content)) {
        testFrameworks.add('nunit');
      }
      if (/PackageReference[^>]*MSTest/i.test(content)) {
        testFrameworks.add('mstest');
      }
    }
  }

  const isEmpty = !sourceFileSeen && !meaningfulFileSeen;
  const confidence: ProbeResult['confidence'] = markers.length >= 2 ? 'medium' : 'low';

  return {
    isEmpty,
    languages: [...languages].sort(),
    buildTools: [...buildTools].sort(),
    testFrameworks: [...testFrameworks].sort(),
    markers,
    confidence
  };
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function readJson(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
  const text = await readText(uri);
  if (!text) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

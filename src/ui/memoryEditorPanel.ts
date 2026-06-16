import * as vscode from 'vscode';

type EditorTab = 'memory' | 'roadmap';

/** Inbound messages from the Memory/Roadmap editor webview. */
interface InboundMessage {
  type: string;
  tab?: string;
  content?: string;
  url?: string;
}

/**
 * Editor WebviewPanel for memory/MEMORY.md and memory/ROADMAP.md. A single panel per workspace with
 * a Memory/Roadmap tab toggle; each tab is edited in an always-on Quill WYSIWYG editor (markdown is
 * converted to HTML on load and back to markdown on save) that writes to disk. Data is embedded via a
 * JSON island and all webview JS lives in the external media/memoryEditor.js (the Phase 47
 * external-script pattern); Quill, marked, and Turndown ship locally under media/vendor/.
 */
export class MemoryEditorPanel {
  private static readonly panels = new Map<string, MemoryEditorPanel>();

  static async createOrShow(
    context: vscode.ExtensionContext,
    workspaceUri: vscode.Uri,
    initialTab: EditorTab
  ): Promise<void> {
    const key = workspaceUri.fsPath;
    const existing = MemoryEditorPanel.panels.get(key);
    if (existing) {
      void existing.panel.webview.postMessage({ type: 'selectTab', tab: initialTab });
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const memoryContent = await MemoryEditorPanel.readFile(workspaceUri, 'memory');
    const roadmapContent = await MemoryEditorPanel.readFile(workspaceUri, 'roadmap');
    const panel = vscode.window.createWebviewPanel(
      'devTrioMemoryEditor',
      'Dev-Trio Memory & Roadmap',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    new MemoryEditorPanel(panel, context, key, workspaceUri, memoryContent, roadmapContent, initialTab);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    key: string,
    private readonly workspaceUri: vscode.Uri,
    memoryContent: string,
    roadmapContent: string,
    initialTab: EditorTab
  ) {
    MemoryEditorPanel.panels.set(key, this);
    panel.onDidDispose(() => {
      MemoryEditorPanel.panels.delete(key);
    });
    panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg), undefined, context.subscriptions);
    panel.webview.html = getHtml(panel.webview, context.extensionUri, memoryContent, roadmapContent, initialTab);
  }

  /** Resolves the workspace URI of the MEMORY.md / ROADMAP.md file for a tab. */
  private static fileUri(workspaceUri: vscode.Uri, tab: EditorTab): vscode.Uri {
    const name = tab === 'roadmap' ? 'ROADMAP.md' : 'MEMORY.md';
    return vscode.Uri.joinPath(workspaceUri, 'memory', name);
  }

  /** Reads a tab's markdown file via workspace.fs; returns '' when missing or unreadable. */
  private static async readFile(workspaceUri: vscode.Uri, tab: EditorTab): Promise<string> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(MemoryEditorPanel.fileUri(workspaceUri, tab)));
    } catch {
      return '';
    }
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'saveFile': {
        const tab: EditorTab = msg.tab === 'roadmap' ? 'roadmap' : 'memory';
        const content = typeof msg.content === 'string' ? msg.content : '';
        try {
          await vscode.workspace.fs.writeFile(
            MemoryEditorPanel.fileUri(this.workspaceUri, tab),
            new TextEncoder().encode(content)
          );
          void vscode.window.showInformationMessage(tab === 'roadmap' ? 'Roadmap saved.' : 'Memory saved.');
          void this.panel.webview.postMessage({ type: 'saveComplete' });
        } catch (err) {
          void vscode.window.showErrorMessage('Could not save — ' + (err instanceof Error ? err.message : String(err)));
        }
        break;
      }
      case 'openExternal': {
        if (msg.url && msg.url.startsWith('https://github.com/microsoft/')) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      }
      default:
        break;
    }
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  memoryContent: string,
  roadmapContent: string,
  initialTab: EditorTab
): string {
  const nonce = makeNonce();
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'memoryEditor.js'));
  const quillJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'quill.min.js'));
  const quillCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'quill.snow.min.css'));
  const markedJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'marked.min.js'));
  const turndownJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'turndown.min.js'));
  const cspSource = webview.cspSource;
  const initial = JSON.stringify({ memory: memoryContent, roadmap: roadmapContent, initialTab }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}' ${cspSource};" />
<script type="application/json" id="__INIT_DATA__">${initial}</script>
<link href="${codiconUri}" rel="stylesheet" />
<link href="${quillCss}" rel="stylesheet" />
<title>Dev-Trio Memory and Roadmap</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: #0d1117; color: #f0f4f8; font-family: var(--vscode-font-family); font-size: 13px; }
.codicon { font-size: 14px; line-height: 1; }
.wrap { display: flex; flex-direction: column; height: 100vh; max-width: 900px; margin: 0 auto; padding: 14px 16px 16px; }
.toolbar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid rgba(255,255,255,0.10); padding-bottom: 10px; margin-bottom: 12px; flex: 0 0 auto; }
.tab { background: transparent; border: 1px solid transparent; color: #94a3b8; border-radius: 7px; padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
.tab:hover { color: #f0f4f8; background: rgba(255,255,255,0.04); }
.tab.active { color: #f0f4f8; background: rgba(99,102,241,0.18); border-color: rgba(99,102,241,0.4); }
.toolbar-spacer { flex: 1 1 auto; }
.btn-primary { background: var(--vscode-button-background, #6366f1); color: var(--vscode-button-foreground, #fff); border: none; border-radius: 6px; padding: 6px 16px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.18); color: #cbd5e1; border-radius: 6px; padding: 6px 16px; cursor: pointer; font-family: inherit; font-size: 12px; }
.btn-secondary:hover { background: rgba(255,255,255,0.06); color: #f0f4f8; }
.edit-actions { display: flex; gap: 8px; }
.content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.editor-area { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
/* Quill editor body */
.ql-container.ql-snow {
  flex: 1; min-height: 0; overflow-y: auto; /* layout (preserved) */
  border: 1px solid var(--vscode-panel-border) !important;
  background: var(--vscode-editor-background) !important;
  color: var(--vscode-editor-foreground) !important;
  font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, sans-serif) !important;
  font-size: 13px !important;
}
.ql-editor {
  background: var(--vscode-editor-background) !important;
  color: var(--vscode-editor-foreground) !important;
  min-height: 300px;
  line-height: 1.6;
}
.ql-editor.ql-blank::before {
  color: var(--vscode-input-placeholderForeground) !important;
}
/* Quill toolbar */
.ql-toolbar.ql-snow {
  flex-shrink: 0; /* layout (preserved) */
  border: 1px solid var(--vscode-panel-border) !important;
  border-bottom: none !important;
  background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)) !important;
}
.ql-toolbar.ql-snow .ql-formats {
  margin-right: 12px;
}
.ql-snow .ql-stroke {
  stroke: var(--vscode-icon-foreground, var(--vscode-editor-foreground)) !important;
}
.ql-snow .ql-fill,
.ql-snow .ql-stroke.ql-fill {
  fill: var(--vscode-icon-foreground, var(--vscode-editor-foreground)) !important;
}
.ql-snow .ql-thin,
.ql-snow .ql-stroke.ql-thin {
  stroke: var(--vscode-icon-foreground, var(--vscode-editor-foreground)) !important;
}
.ql-snow.ql-toolbar button:hover,
.ql-snow .ql-toolbar button:hover,
.ql-snow.ql-toolbar button.ql-active,
.ql-snow .ql-toolbar button.ql-active {
  background: var(--vscode-toolbar-hoverBackground) !important;
  border-radius: 3px;
}
.ql-snow.ql-toolbar button:hover .ql-stroke,
.ql-snow .ql-toolbar button:hover .ql-stroke,
.ql-snow.ql-toolbar button.ql-active .ql-stroke,
.ql-snow .ql-toolbar button.ql-active .ql-stroke {
  stroke: var(--vscode-textLink-foreground) !important;
}
.ql-snow.ql-toolbar button:hover .ql-fill,
.ql-snow .ql-toolbar button:hover .ql-fill,
.ql-snow.ql-toolbar button.ql-active .ql-fill,
.ql-snow .ql-toolbar button.ql-active .ql-fill {
  fill: var(--vscode-textLink-foreground) !important;
}
/* heading picker dropdown */
.ql-snow .ql-picker {
  color: var(--vscode-editor-foreground) !important;
}
.ql-snow .ql-picker-label {
  color: var(--vscode-editor-foreground) !important;
  border-color: var(--vscode-panel-border) !important;
}
.ql-snow .ql-picker-label::before {
  color: var(--vscode-editor-foreground) !important;
}
.ql-snow .ql-picker-options {
  background: var(--vscode-dropdown-background, var(--vscode-editor-background)) !important;
  border-color: var(--vscode-panel-border) !important;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow) !important;
}
.ql-snow .ql-picker-item {
  color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground)) !important;
}
.ql-snow .ql-picker-item:hover {
  background: var(--vscode-list-hoverBackground) !important;
  color: var(--vscode-list-hoverForeground, var(--vscode-editor-foreground)) !important;
}
.ql-snow .ql-picker.ql-expanded .ql-picker-label {
  border-color: var(--vscode-focusBorder) !important;
  color: var(--vscode-editor-foreground) !important;
}
.ql-snow .ql-picker.ql-expanded .ql-picker-options {
  border-color: var(--vscode-focusBorder) !important;
}
.ql-snow .ql-picker-label svg .ql-stroke {
  stroke: var(--vscode-editor-foreground) !important;
}
/* content formatting */
.ql-editor h1, .ql-editor h2, .ql-editor h3 {
  color: var(--vscode-editor-foreground) !important;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 4px;
  margin-top: 16px;
}
.ql-editor strong {
  color: var(--vscode-editor-foreground) !important;
}
.ql-editor a {
  color: var(--vscode-textLink-foreground) !important;
}
.ql-editor a:hover {
  color: var(--vscode-textLink-activeForeground) !important;
}
.ql-editor blockquote {
  border-left: 4px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)) !important;
  background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background)) !important;
  color: var(--vscode-editor-foreground) !important;
  margin: 8px 0;
  padding: 4px 12px;
}
.ql-editor code {
  background: var(--vscode-textCodeBlock-background, var(--vscode-editor-inactiveSelectionBackground)) !important;
  color: var(--vscode-textPreformat-foreground, var(--vscode-editor-foreground)) !important;
  border-radius: 3px !important;
  padding: 1px 4px !important;
  font-family: var(--vscode-editor-font-family, monospace) !important;
  font-size: 0.9em !important;
}
.ql-editor pre.ql-syntax {
  background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)) !important;
  color: var(--vscode-editor-foreground) !important;
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 4px !important;
  padding: 12px !important;
  font-family: var(--vscode-editor-font-family, monospace) !important;
  overflow-x: auto;
}
.ql-editor ol, .ql-editor ul {
  color: var(--vscode-editor-foreground) !important;
  padding-left: 1.5em;
}
.ql-editor li::before {
  color: var(--vscode-editor-foreground) !important;
}
.ql-editor ::selection {
  background: var(--vscode-editor-selectionBackground) !important;
}
.save-status { display: inline-flex; align-items: center; gap: 5px; color: #4ade80; font-size: 12px; }
.hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="toolbar">
    <button class="tab" id="tabMemory" data-tab="memory">Memory</button>
    <button class="tab" id="tabRoadmap" data-tab="roadmap">Roadmap</button>
    <div class="toolbar-spacer"></div>
    <span class="save-status hidden" id="saveStatus"><i class="codicon codicon-check"></i> Saved</span>
    <div class="edit-actions" id="editActions">
      <button class="btn-primary" id="saveBtn">Save</button>
      <button class="btn-secondary" id="discardBtn">Discard</button>
    </div>
  </div>
  <div class="content" id="content">
    <div class="editor-area">
      <div id="editor"></div>
    </div>
  </div>
</div>
<script src="${quillJs}"></script>
<script src="${markedJs}"></script>
<script src="${turndownJs}"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

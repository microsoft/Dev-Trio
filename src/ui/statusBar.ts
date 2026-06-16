import * as vscode from 'vscode';
import { isWorkspaceInitialized, readWizardProgress } from '../init/skeletonGenerator';

/**
 * The "$(dev-trio-logo) Dev-Trio: <state>" status bar item. Left-aligned, priority 100.
 *
 * Three-state model, driven by on-disk setup artifacts (the same ground truth the sidebar uses):
 *   - Ready          — .dev-trio/initialized exists
 *   - Setup in process — .dev-trio/wizard-progress.json exists (and no sentinel)
 *   - Not set up      — neither exists
 *
 * The shared refresh cycle in extension.ts (refreshSurfaces) refreshes this alongside the sidebar.
 */
export class DevTrioStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'dev-trio.focusSidebar';
    this.item.name = 'Dev-Trio';
    this.item.text = '$(dev-trio-logo) Dev-Trio: Not set up';
    this.item.tooltip = 'Click to open Dev-Trio setup wizard';
    this.item.show();
  }

  /** Re-reads the on-disk setup state and updates the text + tooltip. Never throws. */
  async refresh(): Promise<void> {
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceUri && (await isWorkspaceInitialized(workspaceUri))) {
      this.item.text = '$(dev-trio-logo) Dev-Trio: Ready';
      this.item.tooltip = 'Dev-Trio is ready — open the sidebar to get started';
      return;
    }
    const progress = workspaceUri ? await readWizardProgress(workspaceUri) : undefined;
    if (progress) {
      this.item.text = `$(dev-trio-logo) Dev-Trio: Setup in process | Step ${Math.min(progress.completedSteps.length + 1, 5)}/5`;
      this.item.tooltip = 'Setup in progress — click to continue';
      return;
    }
    this.item.text = '$(dev-trio-logo) Dev-Trio: Not set up';
    this.item.tooltip = 'Click to open Dev-Trio setup wizard';
  }

  dispose(): void {
    this.item.dispose();
  }
}

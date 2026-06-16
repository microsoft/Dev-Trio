// Dev-only build helper: copies the @vscode/codicons assets (CSS + font) into media/ so the
// sidebar webview can load them via webview.asWebviewUri. Shipping them under media/ (which is
// in the VSIX) keeps the extension's runtime dependency count at zero — @vscode/codicons is a
// devDependency and node_modules never ships. Run with: npm run codicons:build
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const srcDir = path.join(repoRoot, 'node_modules', '@vscode', 'codicons', 'dist');
const mediaDir = path.join(repoRoot, 'media');

const files = ['codicon.css', 'codicon.ttf'];

fs.mkdirSync(mediaDir, { recursive: true });
for (const f of files) {
  const src = path.join(srcDir, f);
  if (!fs.existsSync(src)) {
    console.error(`Missing ${src} — run "npm install" first.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(mediaDir, f));
  console.log(`copied media/${f}`);
}

# Dev-Trio — Distribution & Publishing Guide

## For internal testers (local .vsix install)

### What to send testers

Send testers the file: `dev-trio-1.0.0.vsix`

This file is self-contained. Testers do not need Node,
npm, or any build tools — just VS Code.

### How testers install it

1. Open VS Code
2. Open the Command Palette (`Ctrl+Shift+P`)
3. Type **Extensions: Install from VSIX...**
4. Select the `dev-trio-1.0.0.vsix` file
5. Reload VS Code when prompted

Or from the terminal:
```
code --install-extension dev-trio-1.0.0.vsix
```
The extension installs under the publisher name shown in
the VSIX (dev-trio-local for tester builds — this is
normal and expected for pre-Marketplace distributions).

### How to build a fresh tester .vsix

From the extension workspace root:

```powershell
# 1. Swap publisher to dev-trio-local (tester build)
#    (edit package.json: "publisher": "dev-trio-local")

# 2. Package
node_modules\.bin\vsce.cmd package --out dev-trio-1.0.0.vsix

# 3. Restore publisher to BrianMiddendorf
#    (edit package.json: "publisher": "BrianMiddendorf")

# 4. Verify publisher is restored before any git commit
```

---

## Publishing to the VS Code Marketplace

### Prerequisites

- A Marketplace publisher account at
  `marketplace.visualstudio.com/manage`
- Publisher ID must match the `"publisher"` field in
  `package.json` — currently `BrianMiddendorf`
- A Personal Access Token (PAT) from Azure DevOps:
  - Go to `dev.azure.com` → User Settings →
    Personal Access Tokens
  - Organization: **All accessible organizations**
  - Scope: **Marketplace → Manage**
  - Copy the token immediately (shown once)

### Publish command

From the extension workspace root, with publisher set
to `BrianMiddendorf` in package.json:

```
node_modules\.bin\vsce.cmd publish --pat <PAT>
```

That's it. `vsce` reads `package.json`, packages the
extension, and pushes it to the Marketplace under
`BrianMiddendorf.dev-trio`. The extension is live at:

`https://marketplace.visualstudio.com/items?itemName=BrianMiddendorf.dev-trio`

within a few minutes.

### After publishing

1. Install from the Marketplace to confirm the end-to-end
   install flow works
2. Add real shields.io badges to `README.md` — the
   placeholder comment is there waiting.
   Suggested badges:
   - Version: `https://img.shields.io/visual-studio-marketplace/v/BrianMiddendorf.dev-trio`
   - Installs: `https://img.shields.io/visual-studio-marketplace/i/BrianMiddendorf.dev-trio`
   - Rating: `https://img.shields.io/visual-studio-marketplace/r/BrianMiddendorf.dev-trio`
3. Push `README.md` update with real badges to git

### Version bump for future releases

Before publishing a new version:

1. Update `"version"` in `package.json`
2. Add a new entry to `CHANGELOG.md`
3. Update `CURRENT_FILE_VERSION` in
   `src/init/skeletonGenerator.ts` to match
4. Create a new `media/prompts/upgrade-vX.X.X.md`
   with upgrade instructions for existing users
5. Run `npm run test:all` — all harnesses must pass
6. Run `node_modules\.bin\vsce.cmd publish --pat <PAT>`

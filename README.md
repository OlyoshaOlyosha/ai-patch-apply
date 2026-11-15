# AI Patch Apply

Apply AI code changes from your chat to your workspace. Copy an AI reply (ChatGPT, Claude, Gemini — any chat) containing structured `BEFORE` / `AFTER` code blocks, paste it in with one shortcut, and review every edit in VS Code's native diff view before accepting it.

## Usage

1. Copy the entire AI response to the clipboard.
2. Press `Ctrl+Alt+V` (`Cmd+Alt+V` on macOS).
3. VS Code opens a native diff tab per file.
4. Step through the diffs: `Ctrl+Alt+W` (`Cmd+Alt+W`) accepts the current diff tab and moves to the next one.
5. Made a mistake? `Ctrl+Alt+Z` (`Cmd+Alt+Z`) undoes the last applied patch.

The **AI Patch** view in the Activity Bar (left sidebar) shows the files waiting in the diff tabs — click one to reopen its diff — plus quick access to every command. Its icon carries a badge with the number of pending files.

If some edits could not be applied, the extension builds a failure report — the exact reason, a diagnostic hint, and the current file content. Copy it back into the chat (`AI Patch: Copy Failed Report`) and the AI can retry against up-to-date code.

Re-running the same clipboard is harmless: edits whose `AFTER` is already in the file are skipped as already applied.

## Troubleshooting

Everything the extension does is logged to the output channel: **View → Output → AI Patch** (match strategy used per block, rejects with reasons, timing). When something applies unexpectedly — check there first, and attach the relevant lines to a bug report.

## Make your AI emit the right format

The extension expects a strict response format. Run the **AI Patch: Copy Prompt** command and paste the copied prompt into any AI chat — the AI will then answer with `BEFORE`/`AFTER` blocks the extension can parse.

## Expected input format

````
**Location:** File: `path/to/file.py` | Function: `func_name`

**BEFORE:**
```python
old code
```

**AFTER:**
```python
new code
```
````

The `Function:` part is optional. Two operational markers are supported:

- `Function: `(new file)`` — creates the file; fails if it already exists.
- `Function: ``(delete file)`` — deletes the file.

## Commands

| Command | Keybinding |
|---|---|
| AI Patch: Apply from Clipboard | `Ctrl+Alt+V` |
| AI Patch: Accept Current Diff and Go to Next | `Ctrl+Alt+W` |
| AI Patch: Undo Last Patch | `Ctrl+Alt+Z` |
| AI Patch: Apply Pending | — |
| AI Patch: Cancel Pending | — |
| AI Patch: Copy Failed Report | — |
| AI Patch: Clear Failed Report | — |
| AI Patch: Copy Prompt | — |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `aiPatch.afterMaxBytes` | `20000` | Largest accepted `AFTER` block, in characters. |
| `aiPatch.fuzzyMatch` | `true` | Ignore tabs vs spaces and trailing whitespace when matching `BEFORE`. |
| `aiPatch.pinDiffTabs` | `true` | Pin diff tabs so they do not replace each other. |
| `aiPatch.focusFirstDiff` | `true` | Focus the first diff tab after preview. |
| `aiPatch.failureThreshold` | `0.4` | Share of failed changes in a file that rejects the whole file (needs ≥2 failures). |

## Languages

The extension UI follows VS Code's display language and falls back to English when no translation exists. Translations ship for: English, Russian, German, Spanish, French, Simplified Chinese, Japanese, Brazilian Portuguese.

## Build & install locally

```bash
npm install
npm run compile
npx @vscode/vsce package
code --install-extension ai-patch-apply-<version>.vsix
```

## Development

Open the folder in VS Code and press `F5`. A second window ("Extension Development Host") opens — test the command there.

Run the unit tests with `npm test`. After changing UI strings, run `npm run check-l10n` to make sure every locale bundle is in sync.

Bug reports and contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup and the few rules the codebase lives by. Found a problem? [Open an issue](https://github.com/OlyoshaOlyosha/ai-patch-apply/issues) (there is a template; a clipboard sample makes it fixable in minutes).

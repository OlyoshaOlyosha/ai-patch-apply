# Contributing to AI Patch Apply

Thanks for your interest in improving the extension. This document covers what you need to build and test it locally, and the few rules the codebase lives by.

## Setup

```bash
npm install
npm run compile   # tsc, outputs to out/
npm test          # vitest, unit tests only
```

To try the extension: open the folder in VS Code and press `F5`. A second window ("Extension Development Host") opens — run `AI Patch: Apply from Clipboard` there with a `BEFORE`/`AFTER` block in the clipboard.

## Architecture rules

- **Pure modules.** `src/parser.ts`, `src/match.ts` and `src/prompt.ts` must not import `vscode` — that is what makes them unit-testable without mocking the extension host. VS Code API code belongs in `applier.ts`, `view.ts`, `decorations.ts`, `extension.ts`.
- **No runtime dependencies.** `dependencies` in `package.json` stays empty; the vsix ships without `node_modules`.
- **Never write outside the workspace folder.** Every AI-provided path passes through `pathIsInside()` before use — keep that guard in place.
- **Every failure mode produces a `Failed` entry** with a canonical English `reason`. Reasons are never translated or localized: they are fed back to the AI verbatim in the failure report, and they surface as-is in the logs. Silent skips are bugs.

## Localization

User-facing strings go through `vscode.l10n.t()` with English source keys. When you add or change a `t('...')` key:

1. Mirror it in **all 7 bundles** (`l10n/bundle.l10n.<locale>.json`) and, for manifest strings, in `package.nls*.json`.
2. Compile and run `npm run check-l10n` — it cross-checks every literal that reaches `t()` against all bundles and fails on missing or dead keys. CI runs the same gate.

Locale follows the VS Code display language; English is the fallback. Logs in the output channel are English (they are developer-facing and English is the common denominator).

## Tests

`tests/parser.test.ts` and `tests/match.test.ts` cover the pure modules. When you fix a parser or matching bug, add a regression test next to the existing ones. The VS Code API layer is verified manually in the Extension Development Host — if your change touches it, say so in the PR and describe how you checked it.

## Commits

Conventional Commits in English (`feat:`, `fix:`, `refactor:`, …), imperative mood. Line endings are LF (`git config core.autocrlf input`); a `.gitattributes` enforces this in the repo.

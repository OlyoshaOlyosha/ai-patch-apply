# Changelog

## Unreleased

- Patch history: every apply attempt is journaled locally (counts, file names, failure reasons, match strategies — never file contents). New command `AI Patch: Show Patch History`.
- The failed-report state now survives a VS Code window reload.
- The live smoke test moved into the repo (`scripts/verify-live.js`, 21 checks) and runs in CI.

## 1.0.0

- Initial release: apply `BEFORE`/`AFTER` blocks from the clipboard as native VS Code diffs, per-file review, undo, failed-report copy-back for the AI.

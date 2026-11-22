# Changelog

## Unreleased

- Editable review: the right side of every diff tab is now editable — touch up the AI's code right in the diff before accepting. `Ctrl+Alt+W` and Apply Pending apply your edited text, and the edit survives a window reload with the rest of the review.

## 1.1.0 (2026-11-15)

- Undo/redo: `Ctrl+Alt+Z` steps back per patch (up to 10 steps), the new `Ctrl+Alt+Y` steps forward after an accidental undo.
- Resumable review: pending diff tabs re-open after a VS Code window reload — the AI's work is no longer lost mid-review.
- Patch history: apply attempts are journaled locally — by default only failed ones (`aiPatch.patchHistory`: `failuresOnly` / `all` / `off`). Failed edits keep truncated `BEFORE`/`AFTER` fragments and the closest matching block, so you can see why the AI's edit misfired; whole file contents are never stored. New command `AI Patch: Show Patch History`.
- The failed-report state now survives a VS Code window reload.
- The live smoke test moved into the repo (`scripts/verify-live.js`, 29 checks) and runs in CI.

## 1.0.0

- Initial release: apply `BEFORE`/`AFTER` blocks from the clipboard as native VS Code diffs, per-file review, undo, failed-report copy-back for the AI.

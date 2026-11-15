import * as vscode from 'vscode';
import { parseClipboard } from './parser';
import {
  prepareChanges,
  previewPrepared,
  commitPrepared,
  PreparedChange,
  Failed,
  LABEL_PREFIXES,
} from './applier';
import { PatchDecorationProvider } from './decorations';
import { PatchViewProvider } from './view';
import { PROMPT_TEMPLATE } from './prompt';
import { buildFailedReport, failureHint } from './report';
import {
  PatchContentProvider,
  makePreviewUri,
  extractFileFromLabel,
  closeOldPreviews,
  getDirtyTargets,
  syncPendingWithTabs,
  getPending,
  getPendingInitialCount,
  getLastPendingHash,
  setLastPendingHash,
  isTabSyncSuppressed,
  setTabSyncSuppressed,
  setOnReviewChanged,
  setReviewContext,
  setPending,
  clearPending,
  removePendingFile,
  notifySameClipboardPending,
  restorePendingReview,
} from './review';
import {
  pushSnapshot,
  getAppliedHash,
  setAppliedHash,
  undoLastPatch,
  redoLastPatch,
} from './undo';
import {
  HISTORY_LIMIT,
  HistoryEntry,
  hasProblems,
  makePrepareEntry,
  makeSimpleEntry,
  trimHistory,
  formatHistory,
  truncateForJournal,
} from './history';

const t = vscode.l10n.t;

// Shared message buttons: the label is compared against the user's choice,
// so both sides must come from the same localized helper.
const btnShowLog = () => t('Show log');
const btnCopyReport = () => t('Copy report for AI');
const btnUndo = () => t('Undo');
const btnClearErrors = () => t('Got it, clear errors');

let output: vscode.OutputChannel;
let decor: PatchDecorationProvider | undefined;
let applyItem: vscode.StatusBarItem | undefined;
let failItem: vscode.StatusBarItem | undefined;
let patchView: PatchViewProvider | undefined;
let lastFailed: Failed[] = [];
let lastProjectRoot: vscode.Uri | undefined;

const HISTORY_KEY = 'aiPatch.patchHistory';
const FAILED_STATE_KEY = 'aiPatch.lastFailedState';

function nowTime(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function log(line: string): void {
  output.appendLine(`[${nowTime()}] ${line}`);
}

function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h.toString(36) + ':' + s.length;
}

// Patch-history journal. Mode comes from `aiPatch.patchHistory`:
// `failuresOnly` (default) keeps just the failed attempts and stale skips,
// `all` also records clean runs (needed for the exact-vs-fuzzy ratio),
// `off` disables the journal entirely. The journal lives in a module-level
// buffer: globalState.update only queues a persistence write, so a
// read-back right after update can still return the old value — the buffer
// is the source of truth for the running session.
type HistoryMode = 'all' | 'failuresOnly' | 'off';

function historyMode(): HistoryMode {
  return vscode.workspace
    .getConfiguration('aiPatch')
    .get<HistoryMode>('patchHistory', 'failuresOnly');
}

let historyCache: HistoryEntry[] | undefined;

function loadHistory(context: vscode.ExtensionContext): HistoryEntry[] {
  if (!historyCache) {
    historyCache = context.globalState.get<HistoryEntry[]>(HISTORY_KEY) ?? [];
  }
  return historyCache;
}

async function recordHistory(
  context: vscode.ExtensionContext,
  entry: HistoryEntry,
): Promise<void> {
  const mode = historyMode();
  if (mode === 'off') return;
  if (mode === 'failuresOnly' && !hasProblems(entry)) return;
  const history = loadHistory(context);
  history.push(entry);
  if (history.length > HISTORY_LIMIT) {
    const trimmed = trimHistory(history);
    history.length = 0;
    history.push(...trimmed);
  }
  await context.globalState.update(HISTORY_KEY, history.slice());
}

// lastFailed survives a window reload: the failure report button and the
// "copy for AI" flow stay usable after restarting VS Code.
async function saveFailedState(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(FAILED_STATE_KEY, {
    failed: lastFailed,
    projectRoot: lastProjectRoot ? lastProjectRoot.fsPath : undefined,
  });
}

function updateStatusBar(): void {
  const pending = getPending();
  const hasPending = pending && pending.length > 0;
  const hasFailed = lastFailed.length > 0;

  if (patchView) patchView.setPending(pending, lastFailed.length);

  if (applyItem) {
    if (hasPending) {
      const total = getPendingInitialCount() || pending!.length;
      applyItem.text =
        total > pending!.length
          ? '$(check) ▶ ' + t('APPLY ({0} of {1})', pending!.length, total)
          : '$(check) ▶ ' + t('APPLY ({0})', pending!.length);
      applyItem.tooltip = t(
        'Click to apply. Close a diff tab to exclude that file.',
      );
      applyItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      applyItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      applyItem.show();
    } else {
      applyItem.hide();
    }
  }

  if (failItem) {
    if (hasFailed) {
      const names = Array.from(new Set(lastFailed.map((f) => f.file)));
      const label =
        names.length === 1
          ? t('ERROR: {0}', names[0])
          : t('ERRORS: {0} files', names.length);
      failItem.text = t('$(error) {0} — report', label);
      failItem.tooltip = t(
        'Some edits failed. Click to copy the report for the AI.',
      );
      failItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      failItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      failItem.show();
    } else {
      failItem.hide();
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('AI Patch');
  context.subscriptions.push(output);
  output.show(true);
  log('extension activated');

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'ai-patch-preview',
      new PatchContentProvider(),
    ),
  );

  decor = new PatchDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decor),
  );

  applyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  applyItem.command = 'aiPatchApply.applyPending';
  context.subscriptions.push(applyItem);

  patchView = new PatchViewProvider();
  context.subscriptions.push(patchView.register('aiPatchApply.view'));

  failItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  failItem.command = 'aiPatchApply.copyFailedReport';
  context.subscriptions.push(failItem);

  setOnReviewChanged(() => {
    updateStatusBar();
    const pending = getPending();
    if (pending && pending.length > 0) void decor?.setFromPrepared(pending);
    else decor?.clear();
  });
  setReviewContext(context);

  // Resume a review interrupted by a window reload: re-open the diff tabs
  // for the persisted pending changes. Also callable as a (hidden) command
  // so the smoke test can exercise the restore path in-session.
  const restoreCmd = vscode.commands.registerCommand(
    'aiPatchApply.restorePendingReview',
    async () => {
      const cfg = vscode.workspace.getConfiguration('aiPatch');
      const restored = await restorePendingReview(context, {
        pinTabs: cfg.get<boolean>('pinDiffTabs', true),
        focusFirst: cfg.get<boolean>('focusFirstDiff', true),
      });
      if (restored > 0) {
        log(`pending review restored: ${restored} file(s)`);
        vscode.window.showInformationMessage(
          t('AI Patch: review restored — {0} pending file(s).', restored),
        );
      }
      return restored;
    },
  );
  context.subscriptions.push(restoreCmd);

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (isTabSyncSuppressed()) return;
      syncPendingWithTabs(() => {
        updateStatusBar();
        const pending = getPending();
        if (pending) void decor?.setFromPrepared(pending);
      });
    }),
  );

  const previewCmd = vscode.commands.registerCommand(
    'aiPatchApply.applyFromClipboard',
    async () => {
      try {
        const text = await vscode.env.clipboard.readText();
        log(`clipboard length: ${text.length}`);
        if (!text || !text.trim()) {
          vscode.window.showInformationMessage(t('AI Patch: clipboard is empty'));
          return;
        }

        const hash = hashText(text);

        const appliedHash = getAppliedHash(context);
        if (
          hash === appliedHash &&
          (!getPending() || getPending()!.length === 0)
        ) {
          log('clipboard matches the last applied patch — skipping');
          void vscode.window
            .showInformationMessage(
              t(
                'AI Patch: this patch is already applied. Ctrl+Alt+Z to undo, or edit the clipboard.',
              ),
              btnUndo(),
            )
            .then((choice) => {
              if (choice === btnUndo()) {
                void vscode.commands.executeCommand('aiPatchApply.undoLastPatch');
              }
            });
          return;
        }

        if (hash === getLastPendingHash() && getPending() && getPending()!.length > 0) {
          log('same clipboard with pending edits — reopening diff tabs');
          await notifySameClipboardPending();
          return;
        }
        setLastPendingHash(hash);

        const cfg = vscode.workspace.getConfiguration('aiPatch');
        const changes = parseClipboard(text, log, {
          afterMaxBytes: cfg.get<number>('afterMaxBytes', 20000),
        });
        if (changes.length === 0) {
          log('no change blocks found');
          vscode.window.showWarningMessage(t('AI Patch: no changes found'));
          return;
        }

        const t0 = Date.now();
        const result = await prepareChanges(changes, log, {
          fuzzyMatch: cfg.get<boolean>('fuzzyMatch', true),
          failureThreshold: cfg.get<number>('failureThreshold', 0.4),
        });
        lastFailed = result.failed;
        lastProjectRoot = result.projectRoot;
        await recordHistory(
          context,
          makePrepareEntry(Date.now(), {
            files: result.prepared.length,
            alreadyApplied: result.alreadyApplied,
            atomicRejections: result.atomicRejections.map((a) => a.file),
            failures: result.failed.map((f) => ({
              file: f.file,
              reason: f.reason,
              before: truncateForJournal(f.before),
              after: truncateForJournal(f.after),
              similar: truncateForJournal(f.similarBlock?.snippet),
              hint: failureHint(f),
            })),
            matchedVia: result.matchedVia,
          }),
        );
        await saveFailedState(context);
        const elapsed = Date.now() - t0;

        log('');
        const alreadyPart =
          result.alreadyApplied > 0
            ? `, already applied ${result.alreadyApplied}`
            : '';
        log(
          `Total: ${result.prepared.length} file(s)${alreadyPart}, failures ${result.failed.length} (${elapsed}ms)`,
        );
        if (result.failed.length > 0) {
          log('');
          for (const f of result.failed) {
            log(`  FAILED ${f.file}`);
            log(`    reason: ${f.reason}`);
          }
        }

        if (result.atomicRejections.length > 0) {
          log('');
          for (const a of result.atomicRejections) {
            log(
              `  ⚠ REJECTED ENTIRELY: ${a.file} (${a.failedChanges} of ${a.totalChanges} edits not found)`,
            );
          }
        }

        if (result.prepared.length === 0) {
          updateStatusBar();
          if (result.alreadyApplied > 0 && result.failed.length === 0) {
            log('all changes already in the files — nothing to apply');
            vscode.window.showInformationMessage(
              t(
                'AI Patch: all changes are already in the files ({0}). Nothing applied.',
                result.alreadyApplied,
              ),
            );
            return;
          }
          const extra =
            result.alreadyApplied > 0
              ? t(', already applied: {0}', result.alreadyApplied)
              : '';
          void vscode.window
            .showWarningMessage(
              t('AI Patch: nothing to apply{0} ({1} failures).', extra, result.failed.length),
              btnCopyReport(),
              btnShowLog(),
            )
            .then((choice) => {
              if (choice === btnCopyReport()) {
                void vscode.commands.executeCommand('aiPatchApply.copyFailedReport');
              } else if (choice === btnShowLog()) {
                output.show();
              }
            });
          return;
        }

        setTabSyncSuppressed(true);
        try {
          await closeOldPreviews();
          await previewPrepared(result.prepared, makePreviewUri, {
            pinTabs: cfg.get<boolean>('pinDiffTabs', true),
            focusFirst: cfg.get<boolean>('focusFirstDiff', true),
          });
          setPending(result.prepared, result.prepared.length, hash);
        } finally {
          setTabSyncSuppressed(false);
        }

        const dirty = getDirtyTargets(result.prepared);
        if (dirty.length > 0) {
          log(`unsaved changes: ${dirty.join(', ')}`);
          void vscode.window.showWarningMessage(
            t(
              'AI Patch: unsaved changes in files ({0}). Preview uses the current state from the editor.',
              dirty.join(', '),
            ),
          );
        }

        if (result.atomicRejections.length > 0) {
          const a = result.atomicRejections;
          const lines = a
            .map((x) => t('  • {0} — {1} of {2}', x.file, x.failedChanges, x.totalChanges))
            .join('\n');
          const header =
            a.length === 1
              ? t('🔴 AI Patch: file rejected entirely — too many failures.')
              : t('🔴 AI Patch: {0} files rejected entirely — too many failures.', a.length);
          const tail = t(
            'The AI seems to have stale file state. RECOMMENDATION: start a new chat.',
          );
          void vscode.window
            .showWarningMessage(`${header}\n${lines}\n\n${tail}`, btnShowLog(), btnCopyReport())
            .then((choice) => {
              if (choice === btnShowLog()) output.show();
              else if (choice === btnCopyReport()) {
                void vscode.commands.executeCommand('aiPatchApply.copyFailedReport');
              }
            });
        }

        const hasFailed = result.failed.length > 0;
        const msg = hasFailed
          ? t(
              'AI Patch: files prepared — {0}, failures — {1}.',
              result.prepared.length,
              result.failed.length,
            )
          : t(
              'AI Patch: files prepared — {0}. Close a tab to exclude it. Click Apply.',
              result.prepared.length,
            );

        const buttons = hasFailed
          ? [t('Apply'), t('Cancel'), btnCopyReport(), btnShowLog()]
          : [t('Apply'), t('Cancel'), btnShowLog()];
        void vscode.window
          .showInformationMessage(msg, ...buttons)
          .then((choice) => {
            if (choice === t('Apply')) {
              void vscode.commands.executeCommand('aiPatchApply.applyPending');
            } else if (choice === t('Cancel')) {
              void vscode.commands.executeCommand('aiPatchApply.cancelPending');
            } else if (choice === btnCopyReport()) {
              void vscode.commands.executeCommand('aiPatchApply.copyFailedReport');
            } else if (choice === btnShowLog()) {
              output.show();
            }
          });
      } catch (err) {
        log(`ERROR: ${err}`);
        vscode.window.showErrorMessage(`AI Patch: ${err}`);
      }
    },
  );

  const applyCmd = vscode.commands.registerCommand(
    'aiPatchApply.applyPending',
    async () => {
      const pending = getPending();
      if (!pending || pending.length === 0) {
        vscode.window.showInformationMessage(t('AI Patch: no pending edits'));
        return;
      }
      // Check whether the files changed since the preview before applying.
      // Otherwise manual edits made after the diff was opened would be overwritten.
      const stale: string[] = [];
      const fresh: PreparedChange[] = [];
      for (const p of pending) {
        try {
          if (p.isNew) {
            let exists = false;
            try {
              await vscode.workspace.fs.stat(p.uri);
              exists = true;
            } catch {
              exists = false;
            }
            if (exists) {
              stale.push(p.file);
              continue;
            }
            fresh.push(p);
          } else {
            const doc = await vscode.workspace.openTextDocument(p.uri);
            if (doc.getText() === p.originalContent) {
              fresh.push(p);
            } else {
              stale.push(p.file);
            }
          }
        } catch {
          stale.push(p.file);
        }
      }

      if (stale.length > 0) {
        log('');
        log('Files changed since preview, skipped:');
        for (const f of stale) log(`  ${f}`);
      }
      if (fresh.length === 0) {
        clearPending();
        updateStatusBar();
        decor?.clear();
        setTabSyncSuppressed(true);
        try {
          await closeOldPreviews();
        } finally {
          setTabSyncSuppressed(false);
        }
        void vscode.window
          .showWarningMessage(
            t(
              'AI Patch: all files changed since preview ({0}). Press Ctrl+Alt+V again.',
              stale.join(', '),
            ),
            btnShowLog(),
          )
          .then((choice) => {
            if (choice === btnShowLog()) output.show();
          });
        return;
      }

      const count = fresh.length;
      try {
        await pushSnapshot(context, fresh, getLastPendingHash());

        log('');
        log(`Applying: ${count} file(s)`);
        const t0 = Date.now();
        await commitPrepared(fresh, log);
        const elapsed = Date.now() - t0;
        log(`Applied in ${elapsed}ms`);
        await recordHistory(
          context,
          makeSimpleEntry(Date.now(), 'apply', fresh.length, stale.length),
        );

        if (getLastPendingHash()) {
          await setAppliedHash(context, getLastPendingHash()!);
          log(`Hash saved: ${getLastPendingHash()}`);
        }

        const hasFailed = lastFailed.length > 0;
        const failedNames = Array.from(new Set(lastFailed.map((f) => f.file)));
        const stalePart =
          stale.length > 0 ? t(' Skipped due to changes: {0}.', stale.join(', ')) : '';
        let msg: string;
        if (hasFailed) {
          const tail =
            t(
              'Failed: {0}.',
              failedNames.length === 1 ? failedNames[0] : failedNames.join(', '),
            ) +
            ' ' +
            t('Copy the report — button below. Undo: Ctrl+Alt+Z.');
          msg = `${t('AI Patch: applied {0}.', count)}${stalePart} ${tail}`;
        } else {
          msg = t('AI Patch: applied {0} file(s).{1} Undo: Ctrl+Alt+Z.', count, stalePart);
        }

        const buttons = hasFailed
          ? [btnCopyReport(), btnShowLog(), btnUndo(), btnClearErrors()]
          : [btnShowLog(), btnUndo()];
        void vscode.window
          .showInformationMessage(msg, ...buttons)
          .then((choice) => {
            if (choice === btnCopyReport()) {
              void vscode.commands.executeCommand('aiPatchApply.copyFailedReport');
            } else if (choice === btnShowLog()) {
              output.show();
            } else if (choice === btnUndo()) {
              void vscode.commands.executeCommand('aiPatchApply.undoLastPatch');
            } else if (choice === btnClearErrors()) {
              void vscode.commands.executeCommand('aiPatchApply.clearFailedReport');
            }
          });
      } catch (err) {
        log(`ERROR: ${err}`);
        vscode.window.showErrorMessage(`AI Patch: ${err}`);
      } finally {
        clearPending();
        updateStatusBar();
        decor?.clear();
        setTabSyncSuppressed(true);
        try {
          await closeOldPreviews();
        } finally {
          setTabSyncSuppressed(false);
        }
      }
    },
  );

  const cancelCmd = vscode.commands.registerCommand(
    'aiPatchApply.cancelPending',
    async () => {
      setTabSyncSuppressed(true);
      try {
        clearPending();
        await closeOldPreviews();
      } finally {
        setTabSyncSuppressed(false);
      }
      updateStatusBar();
      decor?.clear();
      log('pending edits cancelled');
      vscode.window.showInformationMessage(t('AI Patch: pending edits cancelled'));
    },
  );

  const reportCmd = vscode.commands.registerCommand(
    'aiPatchApply.copyFailedReport',
    async () => {
      if (lastFailed.length === 0) {
        vscode.window.showInformationMessage(t('AI Patch: no failures to report'));
        return;
      }
      const md = await buildFailedReport(lastFailed, lastProjectRoot);
      await vscode.env.clipboard.writeText(md);
      const bytes = md.length;
      void vscode.window
        .showInformationMessage(
          t(
            'AI Patch: report copied ({0} failures, {1} chars). Paste it into the AI chat.',
            lastFailed.length,
            bytes,
          ),
          btnShowLog(),
          btnClearErrors(),
        )
        .then((choice) => {
          if (choice === btnShowLog()) {
            output.show();
          } else if (choice === btnClearErrors()) {
            void vscode.commands.executeCommand('aiPatchApply.clearFailedReport');
          }
        });
    },
  );

  const clearFailedCmd = vscode.commands.registerCommand(
    'aiPatchApply.clearFailedReport',
    async () => {
      lastFailed = [];
      await saveFailedState(context);
      updateStatusBar();
      log('failure list cleared');
      vscode.window.showInformationMessage(t('AI Patch: failure list cleared'));
    },
  );

  const showHistoryCmd = vscode.commands.registerCommand(
    'aiPatchApply.showHistory',
    async () => {
      const text =
        historyMode() === 'off'
          ? '# AI Patch Apply — history\n\n' +
            'Patch history is disabled (`aiPatch.patchHistory: "off"`). ' +
            'Set it to `failuresOnly` or `all` to start recording.\n'
          : formatHistory(loadHistory(context));
      const doc = await vscode.workspace.openTextDocument({
        content: text,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);
      log('history shown');
    },
  );

  const copyPromptCmd = vscode.commands.registerCommand(
    'aiPatchApply.copyPrompt',
    async () => {
      await vscode.env.clipboard.writeText(PROMPT_TEMPLATE);
      log(`prompt copied (${PROMPT_TEMPLATE.length} chars)`);
      vscode.window.showInformationMessage(
        t('AI Patch: prompt copied ({0} chars). Paste it into the AI chat.', PROMPT_TEMPLATE.length),
      );
    },
  );

  const undoCmd = vscode.commands.registerCommand(
    'aiPatchApply.undoLastPatch',
    async () => {
      const result = await undoLastPatch(context, log);
      if (!result) {
        vscode.window.showInformationMessage(t('AI Patch: nothing to undo'));
        return;
      }

      await recordHistory(
        context,
        makeSimpleEntry(Date.now(), 'undo', result.restored.length, result.skipped.length),
      );
      updateStatusBar();

      const msg =
        result.skipped.length > 0
          ? t('AI Patch: undone {0}, skipped {1} (changed manually). Redo: Ctrl+Alt+Y.', result.restored.length, result.skipped.length)
          : t('AI Patch: undone {0} file(s). Redo: Ctrl+Alt+Y.', result.restored.length);
      void vscode.window
        .showInformationMessage(msg, btnShowLog())
        .then((choice) => {
          if (choice === btnShowLog()) output.show();
        });
    },
  );

  const redoCmd = vscode.commands.registerCommand(
    'aiPatchApply.redoLastPatch',
    async () => {
      const result = await redoLastPatch(context, log);
      if (!result) {
        vscode.window.showInformationMessage(t('AI Patch: nothing to redo'));
        return;
      }

      await recordHistory(
        context,
        makeSimpleEntry(Date.now(), 'redo', result.restored.length, result.skipped.length),
      );
      updateStatusBar();

      const msg =
        result.skipped.length > 0
          ? t('AI Patch: redone {0}, skipped {1} (changed manually).', result.restored.length, result.skipped.length)
          : t('AI Patch: redone {0} file(s).', result.restored.length);
      void vscode.window
        .showInformationMessage(msg, btnShowLog())
        .then((choice) => {
          if (choice === btnShowLog()) output.show();
        });
    },
  );

  const acceptCurrentDiffCmd = vscode.commands.registerCommand(
    'aiPatchApply.acceptCurrentDiff',
    async () => {
      const pending = getPending();
      if (!pending || pending.length === 0) return;

      const group = vscode.window.tabGroups.activeTabGroup;
      const active = group?.activeTab;
      if (!active) return;
      const label = typeof active.label === 'string' ? active.label : '';
      if (!LABEL_PREFIXES.some((p) => label.startsWith(p))) return;

      const fileName = extractFileFromLabel(label);
      if (!fileName) return;

      const p = pending.find((x) => x.file === fileName);
      if (!p) return;

      // Stale check for this single file — same rule as the batch apply.
      let stale = false;
      try {
        if (p.isNew) {
          let exists = false;
          try {
            await vscode.workspace.fs.stat(p.uri);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists) stale = true;
        } else {
          const doc = await vscode.workspace.openTextDocument(p.uri);
          if (doc.getText() !== p.originalContent) stale = true;
        }
      } catch {
        stale = true;
      }

      if (stale) {
        log(`accept ${p.file}: skipped — file changed since preview`);
        void vscode.window.showWarningMessage(
          t(
            'AI Patch: {0} changed since preview — not applying. Press Ctrl+Alt+V again.',
            p.file,
          ),
        );
        return;
      }

      try {
        await commitPrepared([p], log);
        await pushSnapshot(context, [p], getLastPendingHash());
        log(`accept ${p.file}: applied, ${pending.length - 1} left`);
        await recordHistory(
          context,
          makeSimpleEntry(Date.now(), 'apply', 1, 0),
        );
      } catch (err) {
        log(`ERROR applying ${p.file}: ${err}`);
        vscode.window.showErrorMessage(`AI Patch: ${err}`);
        return;
      }

      removePendingFile(p.file);
      updateStatusBar();
      decor?.clear();
      const remaining = getPending();
      if (remaining && remaining.length > 0) await decor?.setFromPrepared(remaining);

      if (!remaining || remaining.length === 0) {
        const total = getPendingInitialCount();
        log(`all done: files applied this session — ${total}`);
        vscode.window.showInformationMessage(
          t('AI Patch: all done — applied {0} file(s). Undo: Ctrl+Alt+Z.', total),
        );
      }

      setTabSyncSuppressed(true);
      try {
        await vscode.window.tabGroups.close(active, false);
      } finally {
        setTabSyncSuppressed(false);
      }

      // Focus next remaining AI Patch diff.
      for (const g of vscode.window.tabGroups.all) {
        for (const tab of g.tabs) {
          const input = tab.input;
          if (input instanceof vscode.TabInputTextDiff) {
            const l = typeof tab.label === 'string' ? tab.label : '';
            if (LABEL_PREFIXES.some((pfx) => l.startsWith(pfx))) {
              await vscode.commands.executeCommand(
                'vscode.diff',
                input.original,
                input.modified,
                l,
              );
              return;
            }
          }
        }
      }
    },
  );

  // Tree-view click: reopen the diff tab for one pending file. The tab may
  // already be gone (closed manually) — in that case there is nothing to show.
  const openPendingCmd = vscode.commands.registerCommand(
    'aiPatchApply.openPending',
    async (change: PreparedChange) => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (!(input instanceof vscode.TabInputTextDiff)) continue;
          const label = typeof tab.label === 'string' ? tab.label : '';
          if (!LABEL_PREFIXES.some((p) => label.startsWith(p))) continue;
          if (extractFileFromLabel(label) !== change.file) continue;
          await vscode.commands.executeCommand(
            'vscode.diff',
            input.original,
            input.modified,
            label,
          );
          return;
        }
      }
    },
  );

  context.subscriptions.push(
    previewCmd,
    applyCmd,
    cancelCmd,
    reportCmd,
    clearFailedCmd,
    copyPromptCmd,
    undoCmd,
    redoCmd,
    acceptCurrentDiffCmd,
    openPendingCmd,
    showHistoryCmd,
  );

  // The failure state from the previous session keeps the report button
  // working across window reloads — errors fixed manually are exactly the
  // ones a user still needs to report afterwards.
  const savedState = context.globalState.get<{
    failed: Failed[];
    projectRoot?: string;
  }>(FAILED_STATE_KEY);
  if (savedState && Array.isArray(savedState.failed) && savedState.failed.length > 0) {
    lastFailed = savedState.failed;
    if (savedState.projectRoot) {
      lastProjectRoot = vscode.Uri.file(savedState.projectRoot);
    }
    updateStatusBar();
    log(`restored ${lastFailed.length} failure(s) from the previous session`);
  }

  // Resume the pending review, if any (fires after the status bar exists).
  await vscode.commands.executeCommand('aiPatchApply.restorePendingReview');
}

export function deactivate(): void {
  applyItem?.dispose();
  failItem?.dispose();
}

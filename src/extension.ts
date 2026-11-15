import * as vscode from 'vscode';
import { parseClipboard } from './parser';
import {
  prepareChanges,
  previewPrepared,
  commitPrepared,
  resolveFile,
  langFromUri,
  PreparedChange,
  Failed,
  LABEL_PREFIXES,
} from './applier';
import { PatchDecorationProvider } from './decorations';
import { PatchViewProvider } from './view';
import { PROMPT_TEMPLATE } from './prompt';
import {
  HISTORY_LIMIT,
  HistoryEntry,
  makePrepareEntry,
  makeSimpleEntry,
  formatHistory,
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
let pending: PreparedChange[] | null = null;
let pendingInitialCount = 0;
let lastFailed: Failed[] = [];
let lastProjectRoot: vscode.Uri | undefined;
let lastPendingHash: string | null = null;
let suppressTabSync = false;
const patchContents = new Map<string, string>();

const BIG_FILE_LINES = 5000;
const SNAPSHOT_KEY = 'aiPatch.lastSnapshot';
const APPLIED_HASH_KEY = 'aiPatch.lastAppliedHash';
const HISTORY_KEY = 'aiPatch.patchHistory';
const FAILED_STATE_KEY = 'aiPatch.lastFailedState';

interface PatchSnapshot {
  timestamp: number;
  files: Array<{
    uri: string;
    originalContent: string;
    newContent: string;
    isNew: boolean;
    isDelete: boolean;
  }>;
}

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

function extractFileFromLabel(label: string): string | undefined {
  for (const p of LABEL_PREFIXES) {
    if (label.startsWith(p)) {
      const rest = label.slice(p.length);
      // Strip trailing " (+N −M)" / " (+N)" / " (−M)" suffix added by previewPrepared.
      const m = rest.match(/^(.+?) \([+\−\d\s]+\)$/);
      return m ? m[1] : rest;
    }
  }
  return undefined;
}

function getDirtyTargets(prepared: PreparedChange[]): string[] {
  const dirty: string[] = [];
  for (const p of prepared) {
    if (p.isNew) continue;
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === p.uri.toString(),
    );
    if (open && open.isDirty) dirty.push(p.file);
  }
  return dirty;
}

function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h.toString(36) + ':' + s.length;
}

// Patch-history journal: append one entry per apply attempt, evicting the
// oldest past the limit. Contents are never stored — only counts, file
// names and canonical failure reasons. The journal lives in a module-level
// buffer: globalState.update only queues a persistence write, so a
// read-back right after update can still return the old value — the buffer
// is the source of truth for the running session.
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
  const history = loadHistory(context);
  history.push(entry);
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
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

class PatchContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return patchContents.get(uri.toString()) ?? '';
  }
}

function makePreviewUri(file: string, content: string): vscode.Uri {
  const slug = file.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uri = vscode.Uri.parse(
    `ai-patch-preview:/${slug}?ts=${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );
  patchContents.set(uri.toString(), content);
  return uri;
}

function updateStatusBar(): void {
  const hasPending = pending && pending.length > 0;
  const hasFailed = lastFailed.length > 0;

  if (patchView) patchView.setPending(pending, lastFailed.length);

  if (applyItem) {
    if (hasPending) {
      const total = pendingInitialCount || pending!.length;
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

async function closeOldPreviews(): Promise<void> {
  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const label = typeof tab.label === 'string' ? tab.label : '';
      if (LABEL_PREFIXES.some((p) => label.startsWith(p))) {
        toClose.push(tab);
      }
    }
  }
  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose, false);
  }
  patchContents.clear();
}

function syncPendingWithTabs(): void {
  if (!pending || pending.length === 0) return;
  const openFiles = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const label = typeof tab.label === 'string' ? tab.label : '';
      const f = extractFileFromLabel(label);
      if (f) openFiles.add(f);
    }
  }
  const filtered = pending.filter((p) => openFiles.has(p.file));
  if (filtered.length !== pending.length) {
    log(`tab sync: ${pending.length} → ${filtered.length}`);
    pending = filtered;
    updateStatusBar();
    if (decor) void decor.setFromPrepared(pending);
  }
}

// Pointed hint for specific parse/setup reasons. Not a dump of the whole
// prompt — just the one rule the AI tripped over this time.
// Reasons are canonical English strings coming from parser.ts / applier.ts.
function hintForReason(reason: string): string | null {
  if (reason.startsWith('unsupported marker')) {
    return '⚠ Only `(new file)` and `(delete file)` are recognised. For existing files emit a BEFORE/AFTER pair — split large changes into smaller blocks if needed.';
  }
  if (reason === 'missing BEFORE block') {
    return '⚠ BEFORE block is missing. Add it, or use `(new file)` if this is a brand-new file.';
  }
  if (reason === 'missing AFTER block') {
    return '⚠ AFTER block is missing.';
  }
  if (reason === 'empty BEFORE after cleanup') {
    return '⚠ BEFORE contained only filler comments (like `# ... existing code ...`). Replace with the real code.';
  }
  if (reason === 'empty BEFORE block') {
    return '⚠ BEFORE block is empty.';
  }
  if (reason === 'BEFORE contains markdown directives') {
    return '⚠ BEFORE contains markdown directives (e.g. `**Note:**`). Output only code inside the fence.';
  }
  return null;
}

function truncateBefore(
  s: string,
  maxLines: number,
): { text: string; truncated: boolean; totalLines: number } {
  const lines = s.split('\n');
  if (lines.length <= maxLines) {
    return { text: s, truncated: false, totalLines: lines.length };
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
    totalLines: lines.length,
  };
}

async function buildFailedReport(
  failed: Failed[],
  projectRoot?: vscode.Uri,
): Promise<string> {
  const byFile = new Map<string, Failed[]>();
  for (const f of failed) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  const parts: string[] = [];
  parts.push('# Code changes — please regenerate\n');
  parts.push(
    'The changes below could not be applied automatically. ' +
      'For each: please regenerate BEFORE so it exactly matches a fragment of ' +
      'my current file content (shown below), or just rewrite the whole file.',
  );
  parts.push(
    'Note: my files may be in a partially-updated state from earlier edits — ' +
      'rely on the "Current" content below, not on what you remember.',
  );
  if (projectRoot) {
    parts.push(
      `All paths are resolved relative to the project root: \`${projectRoot.fsPath}\`.`,
    );
  }
  parts.push('');

  for (const [file, changes] of byFile) {
    parts.push(`## \`${file}\`\n`);

    const atomicRejected = changes.some((c) => c.atomicRejected);
    if (atomicRejected) {
      const failedCount = changes.length;
      parts.push(
        `⚠️ **This file was rejected entirely.** ` +
          `${failedCount} change(s) failed to find their BEFORE fragment. ` +
          `None of the changes for this file were applied — the file was left untouched ` +
          `to avoid a half-applied, broken state. ` +
          `Your model of this file appears stale. Re-read the current content below ` +
          `and regenerate ALL changes for this file from scratch.\n`,
      );
    }

    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      if (changes.length > 1) {
        parts.push(`### Change ${i + 1} of ${changes.length}\n`);
      }

      // Pointed hint for the specific rule that got broken.
      const hint = hintForReason(c.reason);
      if (hint) {
        parts.push(hint);
        parts.push('');
      }

      // Your BEFORE — only when there is no `similarBlock` to compare
      // against. If a similar block exists, the AI can diff its own
      // message against that snippet; echoing the BEFORE again would just
      // waste context. The BEFORE is also empty for parse errors (we
      // never got that far), so skip those too.
      const hasBefore = !!(c.before && c.before.trim());
      if (!c.similarBlock && hasBefore) {
        const trunc = truncateBefore(c.before!, 30);
        parts.push('**Your BEFORE (did not match):**');
        parts.push('```');
        parts.push(trunc.text);
        parts.push('```');
        if (trunc.truncated) {
          parts.push(
            `_(truncated — original had ${trunc.totalLines} lines)_`,
          );
        }
        parts.push('');
      }

      parts.push('**What I wanted to achieve (AFTER):**');
      parts.push('```');
      parts.push(c.after);
      parts.push('```');
      parts.push('');
      parts.push(`_Reason it failed: ${c.reason}_`);
      parts.push('');

      if (c.similarBlock) {
        const sb = c.similarBlock;
        let diffText: string;
        if (sb.indentDiff === 0) {
          diffText = 'identical indentation — some other character differs';
        } else if (sb.indentDiff < 0) {
          diffText = `your BEFORE has ${-sb.indentDiff} extra leading space(s) — the file uses fewer`;
        } else {
          diffText = `your BEFORE is missing ${sb.indentDiff} leading space(s) — the file uses more`;
        }
        parts.push(`_Hint: a similar block exists at line ${sb.lineNumber} (${diffText})._`);
        parts.push('');

        if (c.charDiff) {
          const d = c.charDiff;
          const beforeDisplay = d.beforeChar === '' ? '(empty)' : `\`${d.beforeChar}\``;
          const fileDisplay = d.fileChar === '' ? '(empty)' : `\`${d.fileChar}\``;
          parts.push(
            `_First divergence at line ${d.lineNumber} of the block, column ${d.colNumber}: ` +
              `your BEFORE has ${beforeDisplay} (${d.beforeCode}), ` +
              `the file has ${fileDisplay} (${d.fileCode})._`,
          );
          parts.push('');
        }

        parts.push(`**Similar block at line ${sb.lineNumber}:**`);
        parts.push('```');
        parts.push(sb.snippet);
        parts.push('```');
        parts.push('');
      }
    }

    const uri = await resolveFile(file, projectRoot);
    if (!uri) {
      const where = projectRoot
        ? `_file does not exist in project root \`${projectRoot.fsPath}\`_`
        : '_file does not exist in workspace_';
      parts.push(`**Current \`${file}\`:** ${where}`);
      parts.push('');
      parts.push('---');
      parts.push('');
      continue;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const content = doc.getText();
      const lineCount = content.split('\n').length;
      const lang = langFromUri(uri);

      if (lineCount > BIG_FILE_LINES) {
        parts.push(
          `> ⚠️ File is large (${lineCount} lines). Consider splitting the change into smaller tasks.`,
        );
        parts.push('');
      }

      parts.push(`**Current \`${file}\`:**`);
      parts.push('```' + lang);
      parts.push(content);
      parts.push('```');
    } catch {
      parts.push(`**Current \`${file}\`:** _could not read file_`);
    }
    parts.push('');
    parts.push('---');
    parts.push('');
  }

  return parts.join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
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

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (suppressTabSync) return;
      syncPendingWithTabs();
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

        const appliedHash = context.globalState.get<string>(APPLIED_HASH_KEY);
        if (hash === appliedHash && (!pending || pending.length === 0)) {
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

        if (hash === lastPendingHash && pending && pending.length > 0) {
          log('same clipboard with pending edits — reopening diff tabs');
          await revealPendingPreviews();
          vscode.window.showInformationMessage(
            t('AI Patch: {0} pending — diff tabs are open.', pending.length),
          );
          return;
        }
        lastPendingHash = hash;

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
            failures: result.failed.map((f) => ({ file: f.file, reason: f.reason })),
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

        suppressTabSync = true;
        try {
          await closeOldPreviews();
          pending = result.prepared;
          pendingInitialCount = pending.length;
          await previewPrepared(pending, makePreviewUri, {
            pinTabs: cfg.get<boolean>('pinDiffTabs', true),
            focusFirst: cfg.get<boolean>('focusFirstDiff', true),
          });
        } finally {
          suppressTabSync = false;
        }
        updateStatusBar();

        if (decor) await decor.setFromPrepared(pending);

        const dirty = getDirtyTargets(pending);
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
              pending.length,
              result.failed.length,
            )
          : t(
              'AI Patch: files prepared — {0}. Close a tab to exclude it. Click Apply.',
              pending.length,
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
        pending = null;
        lastPendingHash = null;
        updateStatusBar();
        decor?.clear();
        suppressTabSync = true;
        try {
          await closeOldPreviews();
        } finally {
          suppressTabSync = false;
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
        await appendToSnapshot(context, fresh);

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

        if (lastPendingHash) {
          await context.globalState.update(APPLIED_HASH_KEY, lastPendingHash);
          log(`Hash saved: ${lastPendingHash}`);
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
        pending = null;
        pendingInitialCount = 0;
        lastPendingHash = null;
        updateStatusBar();
        decor?.clear();
        suppressTabSync = true;
        try {
          await closeOldPreviews();
        } finally {
          suppressTabSync = false;
        }
      }
    },
  );

  const cancelCmd = vscode.commands.registerCommand(
    'aiPatchApply.cancelPending',
    async () => {
      suppressTabSync = true;
      try {
        pending = null;
        pendingInitialCount = 0;
        lastPendingHash = null;
        await closeOldPreviews();
      } finally {
        suppressTabSync = false;
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
      const history = loadHistory(context);
      const doc = await vscode.workspace.openTextDocument({
        content: formatHistory(history),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);
      log(`history shown (${history.length} entries)`);
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
      const snapshot = context.globalState.get<PatchSnapshot>(SNAPSHOT_KEY);
      if (!snapshot || snapshot.files.length === 0) {
        vscode.window.showInformationMessage(t('AI Patch: nothing to undo'));
        return;
      }

      log(`undo: restoring ${snapshot.files.length} file(s)`);
      const restored: string[] = [];
      const skipped: string[] = [];

      for (const file of snapshot.files) {
        try {
          const uri = vscode.Uri.parse(file.uri);

          if (file.isNew) {
            let current = '';
            try {
              const doc = await vscode.workspace.openTextDocument(uri);
              current = doc.getText();
            } catch {
              log(`  skip ${file.uri}: already absent`);
              skipped.push(file.uri);
              continue;
            }
            if (current !== file.newContent) {
              log(`  skip ${file.uri}: content changed after apply`);
              skipped.push(file.uri);
              continue;
            }
            await vscode.workspace.fs.delete(uri);
            log(`  deleted ${file.uri}`);
            restored.push(file.uri);
          } else if (file.isDelete) {
            let exists = false;
            try {
              await vscode.workspace.fs.stat(uri);
              exists = true;
            } catch {
              exists = false;
            }
            if (exists) {
              log(`  skip ${file.uri}: file already exists (created manually)`);
              skipped.push(file.uri);
              continue;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
            edit.insert(uri, new vscode.Position(0, 0), file.originalContent);
            await vscode.workspace.applyEdit(edit);
            const newDoc = await vscode.workspace.openTextDocument(uri);
            await newDoc.save();
            log(`  restored ${file.uri}`);
            restored.push(file.uri);
          } else {
            const doc = await vscode.workspace.openTextDocument(uri);
            if (doc.getText() !== file.newContent) {
              log(`  skip ${file.uri}: content changed after apply`);
              skipped.push(file.uri);
              continue;
            }
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length),
            );
            edit.replace(uri, fullRange, file.originalContent);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            log(`  restored ${file.uri}`);
            restored.push(file.uri);
          }
        } catch (err) {
          log(`  failed to undo ${file.uri}: ${err}`);
          skipped.push(file.uri);
        }
      }

      await context.globalState.update(SNAPSHOT_KEY, undefined);
      await context.globalState.update(APPLIED_HASH_KEY, undefined);
      log('applied patch hash cleared');
      await recordHistory(
        context,
        makeSimpleEntry(Date.now(), 'undo', restored.length, skipped.length),
      );

      const msg =
        skipped.length > 0
          ? t('AI Patch: undone {0}, skipped {1} (changed manually).', restored.length, skipped.length)
          : t('AI Patch: undone {0} file(s).', restored.length);
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
      if (!pending || pending.length === 0) return;

      const group = vscode.window.tabGroups.activeTabGroup;
      const active = group?.activeTab;
      if (!active) return;
      const label = typeof active.label === 'string' ? active.label : '';
      if (!LABEL_PREFIXES.some((p) => label.startsWith(p))) return;

      const fileName = extractFileFromLabel(label);
      if (!fileName) return;

      const idx = pending.findIndex((p) => p.file === fileName);
      if (idx === -1) return;
      const p = pending[idx];

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
        await appendToSnapshot(context, [p]);
        log(`accept ${p.file}: applied, ${pending.length - 1} left`);
      } catch (err) {
        log(`ERROR applying ${p.file}: ${err}`);
        vscode.window.showErrorMessage(`AI Patch: ${err}`);
        return;
      }

      pending.splice(idx, 1);
      lastPendingHash = null;
      updateStatusBar();
      decor?.clear();
      if (pending.length > 0) await decor?.setFromPrepared(pending);

      if (pending.length === 0) {
        const total = pendingInitialCount;
        log(`all done: files applied this session — ${total}`);
        vscode.window.showInformationMessage(
          t('AI Patch: all done — applied {0} file(s). Undo: Ctrl+Alt+Z.', total),
        );
        pendingInitialCount = 0;
      }

      suppressTabSync = true;
      try {
        await vscode.window.tabGroups.close(active, false);
      } finally {
        suppressTabSync = false;
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
}

async function appendToSnapshot(
  context: vscode.ExtensionContext,
  fresh: PreparedChange[],
): Promise<void> {
  const existing = context.globalState.get<PatchSnapshot>(SNAPSHOT_KEY);
  const files = fresh.map((p) => ({
    uri: p.uri.toString(),
    originalContent: p.originalContent,
    newContent: p.newContent,
    isNew: p.isNew,
    isDelete: p.isDelete,
  }));
  const merged: PatchSnapshot = existing
    ? { timestamp: existing.timestamp, files: [...existing.files, ...files] }
    : { timestamp: Date.now(), files };
  await context.globalState.update(SNAPSHOT_KEY, merged);
}

export function deactivate(): void {
  applyItem?.dispose();
  failItem?.dispose();
}

async function revealPendingPreviews(): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff) {
        const label = typeof tab.label === 'string' ? tab.label : '';
        if (LABEL_PREFIXES.some((p) => label.startsWith(p))) {
          await vscode.commands.executeCommand(
            'vscode.diff',
            input.original,
            input.modified,
            label,
          );
        }
      }
    }
  }
}
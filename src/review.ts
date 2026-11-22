// Pending-review state: the prepared changes waiting in the diff tabs,
// the in-memory preview contents, and tab sync. Owns everything that is
// "review in progress"; extension.ts keeps only the UI wiring.
import * as vscode from 'vscode';
import { PreparedChange, LABEL_PREFIXES, previewPrepared } from './applier';
import { MEMFS_SCHEME, clearEditable, makeEditableUri } from './preview-fs';

const t = vscode.l10n.t;

// --- in-memory review state -------------------------------------------------

let pending: PreparedChange[] | null = null;
let pendingInitialCount = 0;
let lastPendingHash: string | null = null;
let suppressTabSync = false;

export function getPending(): PreparedChange[] | null {
  return pending;
}

export function getPendingInitialCount(): number {
  return pendingInitialCount;
}

export function getLastPendingHash(): string | null {
  return lastPendingHash;
}

export function setLastPendingHash(hash: string | null): void {
  lastPendingHash = hash;
}

export function isTabSyncSuppressed(): boolean {
  return suppressTabSync;
}

export function setTabSyncSuppressed(v: boolean): void {
  suppressTabSync = v;
}

// --- preview contents -------------------------------------------------------

const patchContents = new Map<string, string>();

export class PatchContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return patchContents.get(uri.toString()) ?? '';
  }
}

export function makePreviewUri(file: string, content: string): vscode.Uri {
  const slug = file.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uri = vscode.Uri.parse(
    `ai-patch-preview:/${slug}?ts=${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );
  patchContents.set(uri.toString(), content);
  return uri;
}

// --- tab helpers ------------------------------------------------------------

export function extractFileFromLabel(label: string): string | undefined {
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

function isPatchDiffTab(tab: vscode.Tab): boolean {
  const label = typeof tab.label === 'string' ? tab.label : '';
  return LABEL_PREFIXES.some((p) => label.startsWith(p));
}

export async function closeOldPreviews(): Promise<void> {
  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (isPatchDiffTab(tab)) toClose.push(tab);
    }
  }
  // Preview docs are auto-saved as the user types, but a stale doc (closed
  // before its last edit was captured) can linger dirty in textDocuments
  // and would make tabGroups.close raise the native "unsaved changes"
  // prompt. Save them — the provider map already holds the latest text.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === MEMFS_SCHEME && doc.isDirty) void doc.save();
  }
  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose, false);
  }
  patchContents.clear();
  clearEditable();
}

export function getDirtyTargets(prepared: PreparedChange[]): string[] {
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

export function syncPendingWithTabs(onChange: () => void): void {
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
    pending = filtered;
    onChange();
  }
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

export async function reopenPendingTabs(): Promise<void> {
  await revealPendingPreviews();
}

// --- resumable review -------------------------------------------------------

// Pending edits survive a window reload: the prepared changes are
// serialized to globalState when the review starts and cleared when it
// ends (apply / cancel / last accept). Otherwise a reload mid-review — or
// a replaced clipboard — would lose the AI's work with no way back except
// re-copying from the chat.
const PENDING_KEY = 'aiPatch.pendingReview';

/** Cap for persisted review contents (original + new content chars). */
export const PERSIST_MAX_CHARS = 1_000_000;

interface PersistedReview {
  initialCount: number;
  hash: string | null;
  changes: Array<{
    uri: string;
    file: string;
    isNew: boolean;
    isDelete: boolean;
    originalContent: string;
    newContent: string;
  }>;
}

function reviewBytes(changes: PreparedChange[]): number {
  return changes.reduce((n, p) => n + p.originalContent.length + p.newContent.length, 0);
}

// Buffer mirror of the persisted review — globalState read-backs right
// after an update are stale within a session, so the buffer is what
// in-session restores see. After a reload the buffer is empty and the
// real globalState is read.
let persistedReview: PersistedReview | undefined;

async function persistReview(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!pending || pending.length === 0) {
    persistedReview = undefined;
    await context.globalState.update(PENDING_KEY, undefined);
    return;
  }
  if (reviewBytes(pending) > PERSIST_MAX_CHARS) {
    // Too large to serialize — the review still works in this session,
    // it just will not survive a reload.
    persistedReview = undefined;
    await context.globalState.update(PENDING_KEY, undefined);
    return;
  }
  const saved: PersistedReview = {
    initialCount: pendingInitialCount,
    hash: lastPendingHash,
    changes: pending.map((p) => ({
      uri: p.uri.toString(),
      file: p.file,
      isNew: p.isNew,
      isDelete: p.isDelete,
      originalContent: p.originalContent,
      newContent: p.newContent,
    })),
  };
  persistedReview = saved;
  await context.globalState.update(PENDING_KEY, saved);
}

/**
 * Restores a persisted review (called at activate and available as the
 * `aiPatchApply.restorePendingReview` command for tests). Re-opens the
 * diff tabs. Returns the number of restored files, 0 if nothing was saved.
 */
export async function restorePendingReview(
  context: vscode.ExtensionContext,
  options: { pinTabs: boolean; focusFirst: boolean },
): Promise<number> {
  const saved =
    persistedReview ?? context.globalState.get<PersistedReview>(PENDING_KEY);
  if (!saved || !saved.changes || saved.changes.length === 0) return 0;

  pending = saved.changes.map((c) => ({
    uri: vscode.Uri.parse(c.uri),
    file: c.file,
    isNew: c.isNew,
    isDelete: c.isDelete,
    originalContent: c.originalContent,
    newContent: c.newContent,
  }));
  pendingInitialCount = saved.initialCount;
  lastPendingHash = saved.hash;

  setTabSyncSuppressed(true);
  try {
    await closeOldPreviews();
    await previewPrepared(
      pending,
      { preview: makePreviewUri, editable: makeEditableUri },
      options,
    );
  } finally {
    setTabSyncSuppressed(false);
  }
  fireChanged();
  return pending.length;
}

// --- review lifecycle -------------------------------------------------------

// Called by extension.ts after every state change so the status bar, view
// and decorations stay in sync. One hook, set once at activate.
let onChanged: (() => void) | undefined;
let reviewContext: vscode.ExtensionContext | undefined;

export function setOnReviewChanged(cb: () => void): void {
  onChanged = cb;
}

export function setReviewContext(context: vscode.ExtensionContext): void {
  reviewContext = context;
}

function fireChanged(): void {
  onChanged?.();
  // Persist after every lifecycle change; cleared state also clears the
  // stored review. No-op when persistence is not wired up (tests).
  if (reviewContext) void persistReview(reviewContext);
}

export function setPending(prepared: PreparedChange[], initialCount: number, hash: string | null): void {
  pending = prepared;
  pendingInitialCount = initialCount;
  lastPendingHash = hash;
  fireChanged();
}

export function clearPending(): void {
  pending = null;
  pendingInitialCount = 0;
  lastPendingHash = null;
  fireChanged();
}

export function removePendingFile(file: string): void {
  if (!pending) return;
  pending = pending.filter((p) => p.file !== file);
  lastPendingHash = null;
  if (pending.length === 0) pendingInitialCount = 0;
  fireChanged();
}

export async function notifySameClipboardPending(): Promise<void> {
  if (!pending || pending.length === 0) return;
  await reopenPendingTabs();
  vscode.window.showInformationMessage(
    t('AI Patch: {0} pending — diff tabs are open.', pending.length),
  );
}

// --- editable preview --------------------------------------------------------

// Every edit the user makes on the diff's right side (ai-patch-mem:) flows
// into PreparedChange.newContent immediately, so Ctrl+Alt+W, Apply Pending
// and the undo snapshots all pick up the touched-up code. The document is
// saved straight into the memfs provider as the user types — a doc left
// dirty would make every programmatic close (accept, apply, cancel) raise
// the native "unsaved changes" prompt.
// setTimeout/clearTimeout via globalThis — @types/node is deliberately not
// pulled into the compile unit (see applier.ts delay()).
const sched = globalThis as unknown as {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
let persistTimer: unknown;

function schedulePersist(): void {
  if (!reviewContext) return;
  if (persistTimer !== undefined) sched.clearTimeout(persistTimer);
  persistTimer = sched.setTimeout(() => {
    persistTimer = undefined;
    if (reviewContext) void persistReview(reviewContext);
  }, 750);
}

export function wireEditableEdits(): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== MEMFS_SCHEME) return;
    if (e.contentChanges.length === 0) return;
    const p = pending?.find(
      (c) => c.editableUri?.toString() === e.document.uri.toString(),
    );
    if (!p) return;
    p.newContent = e.document.getText();
    // Thenable has no .catch — wrap for a silent degrade if saving fails.
    void Promise.resolve(e.document.save()).catch(() => {});
    schedulePersist();
  });
}

// Pending-review state: the prepared changes waiting in the diff tabs,
// the in-memory preview contents, and tab sync. Owns everything that is
// "review in progress"; extension.ts keeps only the UI wiring.
import * as vscode from 'vscode';
import { PreparedChange, LABEL_PREFIXES, previewPrepared } from './applier';

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
  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose, false);
  }
  patchContents.clear();
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

// --- review lifecycle -------------------------------------------------------

// Called by extension.ts after every state change so the status bar, view
// and decorations stay in sync. One hook, set once at activate.
let onChanged: (() => void) | undefined;

export function setOnReviewChanged(cb: () => void): void {
  onChanged = cb;
}

function fireChanged(): void {
  onChanged?.();
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

// Reopens the diff tabs for the current pending set (same as the "same
// clipboard pressed again" path).
export async function showPendingTabs(options: {
  pinTabs: boolean;
  focusFirst: boolean;
}): Promise<void> {
  if (!pending || pending.length === 0) return;
  setTabSyncSuppressed(true);
  try {
    await closeOldPreviews();
    await previewPrepared(pending, makePreviewUri, options);
  } finally {
    setTabSyncSuppressed(false);
  }
  fireChanged();
}

export async function notifySameClipboardPending(): Promise<void> {
  if (!pending || pending.length === 0) return;
  await reopenPendingTabs();
  vscode.window.showInformationMessage(
    t('AI Patch: {0} pending — diff tabs are open.', pending.length),
  );
}

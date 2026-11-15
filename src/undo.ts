// Snapshot storage for undo/redo. Owns the globalState keys and the
// restore/apply logic; extension.ts keeps the notifications and history
// recording. The stacks are global (not per-workspace) state — they survive
// a window reload, so undo/redo can work across restarts of the host.
//
// A "batch" is one clipboard patch: the apply commit opens a snapshot and
// per-file accepts merge into it while it is still the top of the stack.
import * as vscode from 'vscode';
import { PreparedChange } from './applier';

const UNDO_STACK_KEY = 'aiPatch.undoStack';
const REDO_STACK_KEY = 'aiPatch.redoStack';
const APPLIED_HASH_KEY = 'aiPatch.lastAppliedHash';
// Pre-stack versions stored one snapshot under this key — migrated on read.
const LEGACY_SNAPSHOT_KEY = 'aiPatch.lastSnapshot';

/** Max steps kept per stack. */
export const MAX_STACK_STEPS = 10;
/** Max total stored content bytes per stack (contents, not file paths). */
export const MAX_STACK_BYTES = 2_000_000;

export interface PatchSnapshot {
  timestamp: number;
  /** Clipboard hash that produced this patch — guards "already applied". */
  hash?: string;
  files: Array<{
    uri: string;
    originalContent: string;
    newContent: string;
    isNew: boolean;
    isDelete: boolean;
  }>;
}

function snapshotBytes(s: PatchSnapshot): number {
  return s.files.reduce(
    (n, f) => n + f.originalContent.length + f.newContent.length,
    0,
  );
}

function stackBytes(stack: PatchSnapshot[]): number {
  return stack.reduce((n, s) => n + snapshotBytes(s), 0);
}

/** Trims the stack in place so the module-level cache stays the truth. */
function fitCaps(stack: PatchSnapshot[]): PatchSnapshot[] {
  while (
    stack.length > MAX_STACK_STEPS ||
    (stack.length > 1 && stackBytes(stack) > MAX_STACK_BYTES)
  ) {
    stack.shift();
  }
  return stack;
}

function getStackRaw(context: vscode.ExtensionContext, key: string): PatchSnapshot[] {
  return context.globalState.get<PatchSnapshot[]>(key) ?? [];
}

// The stacks live in module-level buffers: globalState.update only queues
// a persistence write, so a read-back right after it can return the old
// value — the buffer is the source of truth for the running session.
let undoStackCache: PatchSnapshot[] | undefined;
let redoStackCache: PatchSnapshot[] | undefined;

function getUndoStack(context: vscode.ExtensionContext): PatchSnapshot[] {
  if (!undoStackCache) {
    const raw = getStackRaw(context, UNDO_STACK_KEY);
    if (raw.length > 0) {
      undoStackCache = raw;
    } else {
      // Migration: a snapshot saved by a pre-stack version is still undoable.
      const legacy = getStackRaw(context, LEGACY_SNAPSHOT_KEY);
      undoStackCache = legacy.length > 0 ? legacy : [];
    }
  }
  return undoStackCache;
}

function getRedoStack(context: vscode.ExtensionContext): PatchSnapshot[] {
  if (!redoStackCache) {
    redoStackCache = getStackRaw(context, REDO_STACK_KEY);
  }
  return redoStackCache;
}

/**
 * Records applied files. Merges into the top snapshot when it belongs to
 * the same clipboard batch (matching hash, or an accept continuing the
 * open review); otherwise opens a new batch — and a new batch invalidates
 * the redo stack, as any new action does.
 */
export async function pushSnapshot(
  context: vscode.ExtensionContext,
  fresh: PreparedChange[],
  hash?: string | null,
): Promise<void> {
  const stack = getUndoStack(context);
  const top = stack[stack.length - 1];
  const files = fresh.map((p) => ({
    uri: p.uri.toString(),
    originalContent: p.originalContent,
    newContent: p.newContent,
    isNew: p.isNew,
    isDelete: p.isDelete,
  }));

  const continuesBatch =
    top && (hash == null || (top.hash !== undefined && top.hash === hash));
  if (continuesBatch) {
    stack[stack.length - 1] = {
      ...top,
      hash: hash ?? top.hash,
      files: [...top.files, ...files],
    };
  } else {
    stack.push({ timestamp: Date.now(), hash: hash ?? undefined, files });
    // A new action invalidates redo.
    redoStackCache = [];
  }
  await context.globalState.update(REDO_STACK_KEY, redoStackCache ?? []);
  await context.globalState.update(UNDO_STACK_KEY, fitCaps(stack));
}

export function getAppliedHash(context: vscode.ExtensionContext): string | undefined {
  if (appliedHashCache === null) {
    appliedHashCache = context.globalState.get<string>(APPLIED_HASH_KEY);
  }
  return appliedHashCache;
}

// The applied-hash guard is also buffered: globalState read-backs after an
// update are stale within a session (same gotcha as the stacks).
let appliedHashCache: string | undefined | null = null;

export async function setAppliedHash(
  context: vscode.ExtensionContext,
  hash: string,
): Promise<void> {
  appliedHashCache = hash;
  await context.globalState.update(APPLIED_HASH_KEY, hash);
}

async function clearAppliedHash(context: vscode.ExtensionContext): Promise<void> {
  appliedHashCache = undefined;
  await context.globalState.update(APPLIED_HASH_KEY, undefined);
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
  /** Steps left on the undo stack after this operation. */
  undoLeft: number;
  /** Steps available on the redo stack after this operation. */
  redoLeft: number;
}

/** Restore = step back: file goes from newContent to originalContent. */
async function stepBackward(
  snapshot: PatchSnapshot,
  log: (line: string) => void,
): Promise<{ restored: string[]; skipped: string[] }> {
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

  return { restored, skipped };
}

/** Redo = step forward: file goes from originalContent to newContent. */
async function stepForward(
  snapshot: PatchSnapshot,
  log: (line: string) => void,
): Promise<{ restored: string[]; skipped: string[] }> {
  const restored: string[] = [];
  const skipped: string[] = [];

  for (const file of snapshot.files) {
    try {
      const uri = vscode.Uri.parse(file.uri);

      if (file.isNew) {
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
        edit.insert(uri, new vscode.Position(0, 0), file.newContent);
        await vscode.workspace.applyEdit(edit);
        const doc = await vscode.workspace.openTextDocument(uri);
        await doc.save();
        log(`  re-created ${file.uri}`);
        restored.push(file.uri);
      } else if (file.isDelete) {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.getText() !== file.originalContent) {
          log(`  skip ${file.uri}: content changed after undo`);
          skipped.push(file.uri);
          continue;
        }
        await vscode.workspace.fs.delete(uri);
        log(`  deleted ${file.uri}`);
        restored.push(file.uri);
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.getText() !== file.originalContent) {
          log(`  skip ${file.uri}: content changed after undo`);
          skipped.push(file.uri);
          continue;
        }
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length),
        );
        edit.replace(uri, fullRange, file.newContent);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        log(`  re-applied ${file.uri}`);
        restored.push(file.uri);
      }
    } catch (err) {
      log(`  failed to redo ${file.uri}: ${err}`);
      skipped.push(file.uri);
    }
  }

  return { restored, skipped };
}

export async function undoLastPatch(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
): Promise<RestoreResult | undefined> {
  const stack = getUndoStack(context);
  const snapshot = stack[stack.length - 1];
  if (!snapshot || snapshot.files.length === 0) return undefined;

  log(`undo: restoring ${snapshot.files.length} file(s)`);
  const { restored, skipped } = await stepBackward(snapshot, log);

  stack.pop();
  redoStackCache = fitCaps([...getRedoStack(context), snapshot]);
  await context.globalState.update(UNDO_STACK_KEY, stack);
  await context.globalState.update(REDO_STACK_KEY, redoStackCache);
  // Only clear the "already applied" guard if it still belongs to this
  // patch — a newer apply may have overwritten it.
  const appliedHash = getAppliedHash(context);
  if (!snapshot.hash || appliedHash === snapshot.hash) {
    await clearAppliedHash(context);
    log('applied patch hash cleared');
  }

  return { restored, skipped, undoLeft: stack.length, redoLeft: redoStackCache.length };
}

export async function redoLastPatch(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
): Promise<RestoreResult | undefined> {
  const redo = getRedoStack(context);
  const snapshot = redo[redo.length - 1];
  if (!snapshot || snapshot.files.length === 0) return undefined;

  log(`redo: re-applying ${snapshot.files.length} file(s)`);
  const { restored, skipped } = await stepForward(snapshot, log);

  redo.pop();
  const stack = fitCaps(getUndoStack(context));
  stack.push(snapshot);
  fitCaps(stack);
  await context.globalState.update(REDO_STACK_KEY, redo);
  await context.globalState.update(UNDO_STACK_KEY, stack);

  if (snapshot.hash) {
    await setAppliedHash(context, snapshot.hash);
    log(`applied patch hash restored: ${snapshot.hash}`);
  }

  return { restored, skipped, undoLeft: stack.length, redoLeft: redo.length };
}

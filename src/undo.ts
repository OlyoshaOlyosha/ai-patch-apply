// Snapshot storage for undo. Owns the globalState keys and the restore
// logic; extension.ts keeps the notifications and history recording.
// The snapshot is global (not per-workspace) state — it survives a window
// reload, so undo can work across restarts of the host.
import * as vscode from 'vscode';
import { PreparedChange } from './applier';

export const SNAPSHOT_KEY = 'aiPatch.lastSnapshot';
export const APPLIED_HASH_KEY = 'aiPatch.lastAppliedHash';

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

export function getSnapshot(
  context: vscode.ExtensionContext,
): PatchSnapshot | undefined {
  return context.globalState.get<PatchSnapshot>(SNAPSHOT_KEY);
}

export async function appendToSnapshot(
  context: vscode.ExtensionContext,
  fresh: PreparedChange[],
  hash?: string | null,
): Promise<void> {
  const existing = getSnapshot(context);
  const files = fresh.map((p) => ({
    uri: p.uri.toString(),
    originalContent: p.originalContent,
    newContent: p.newContent,
    isNew: p.isNew,
    isDelete: p.isDelete,
  }));
  const merged: PatchSnapshot = existing
    ? { ...existing, files: [...existing.files, ...files] }
    : { timestamp: Date.now(), hash: hash ?? undefined, files };
  await context.globalState.update(SNAPSHOT_KEY, merged);
}

export async function clearAppliedHash(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(APPLIED_HASH_KEY, undefined);
}

export async function setAppliedHash(
  context: vscode.ExtensionContext,
  hash: string,
): Promise<void> {
  await context.globalState.update(APPLIED_HASH_KEY, hash);
}

export function getAppliedHash(context: vscode.ExtensionContext): string | undefined {
  return context.globalState.get<string>(APPLIED_HASH_KEY);
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
}

export async function restoreSnapshot(
  context: vscode.ExtensionContext,
  snapshot: PatchSnapshot,
  log: (line: string) => void,
): Promise<RestoreResult> {
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

/** Undo entry point: restores the snapshot files and clears the slot. */
export async function undoLastPatch(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
): Promise<RestoreResult | undefined> {
  const snapshot = getSnapshot(context);
  if (!snapshot || snapshot.files.length === 0) return undefined;

  log(`undo: restoring ${snapshot.files.length} file(s)`);
  const result = await restoreSnapshot(context, snapshot, log);

  await context.globalState.update(SNAPSHOT_KEY, undefined);
  // Only clear the "already applied" guard if it still belongs to this
  // patch — a newer apply may have overwritten it.
  const appliedHash = getAppliedHash(context);
  if (!snapshot.hash || appliedHash === snapshot.hash) {
    await clearAppliedHash(context);
    log('applied patch hash cleared');
  }

  return result;
}

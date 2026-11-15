import * as vscode from 'vscode';
import { Change } from './parser';
import {
  findUnclaimed,
  findUnclaimedCanonical,
  findUnclaimedFuzzy,
  findUnclaimedFuzzyIndent,
  findSimilarBlock,
  firstCharDiff,
  looksLikeJunk,
  pathIsInside,
  SimilarBlock,
  CharDiff,
  normalizePath,
  preview,
  detectEol,
  normalizeEol,
  langFromPath,
} from './match';

function isInside(parent: vscode.Uri, child: vscode.Uri): boolean {
  return pathIsInside(parent.path, child.path);
}

export const LABEL_MODIFIED = '🟣 ' + vscode.l10n.t('Modified');
export const LABEL_NEW = '🔵 ' + vscode.l10n.t('New file');
export const LABEL_DELETE = '🔴 ' + vscode.l10n.t('Deleted');
export const LABEL_PREFIXES = [
  `${LABEL_MODIFIED}: `,
  `${LABEL_NEW}: `,
  `${LABEL_DELETE}: `,
];

export interface Failed {
  file: string;
  /** Full BEFORE fragment (for the report). Optional — parse errors have none. */
  before?: string;
  after: string;
  reason: string;
  preview: string;
  atomicRejected?: boolean;
  similarBlock?: SimilarBlock;
  charDiff?: CharDiff;
}

export interface PreparedChange {
  uri: vscode.Uri;
  file: string;
  isNew: boolean;
  isDelete: boolean;
  originalContent: string;
  newContent: string;
}

export interface AtomicRejection {
  file: string;
  totalChanges: number;
  failedChanges: number;
}

export interface PrepareResult {
  prepared: PreparedChange[];
  failed: Failed[];
  alreadyApplied: number;
  atomicRejections: AtomicRejection[];
  projectRoot?: vscode.Uri;
}

export interface PrepareOptions {
  fuzzyMatch?: boolean;
  failureThreshold?: number;
}

export async function prepareChanges(
  changes: Change[],
  log: (line: string) => void = () => {},
  options: PrepareOptions = {},
): Promise<PrepareResult> {
  const fuzzyMatch = options.fuzzyMatch ?? true;
  const failureThreshold = options.failureThreshold ?? 0.4;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log('  no workspace folder open');
    return { prepared: [], failed: [], alreadyApplied: 0, atomicRejections: [] };
  }

  const failed: Failed[] = [];
  const validChanges: Change[] = [];

  // Parse errors never had a chance to match — surface them as failed
  // straight away so the report shows the AI why the block was skipped.
  for (const c of changes) {
    if (c.parseError) {
      failed.push({
        file: c.file,
        after: c.after,
        reason: c.parseError,
        preview: preview(c.before),
      });
    } else {
      validChanges.push(c);
    }
  }

  const byFile = new Map<string, Change[]>();
  for (const c of validChanges) {
    const key = normalizePath(c.file);
    const arr = byFile.get(key);
    if (arr) arr.push(c);
    else byFile.set(key, [c]);
  }

  const prepared: PreparedChange[] = [];
  const atomicRejections: AtomicRejection[] = [];
  let alreadyApplied = 0;

  const projectRoot = await findProjectRoot(byFile);
  log(`Project root: ${projectRoot.fsPath}`);
  log('');

  for (const [file, fileChanges] of byFile) {
    const existing = await resolveFile(file, projectRoot);
    const wantsNew = fileChanges.some((c) => c.func.toLowerCase() === '(new file)');

    log(`File: ${file}`);

    if (wantsNew) {
      const uri = resolveNewFilePath(file, projectRoot);
      if (!isInside(projectRoot, uri)) {
        for (const c of fileChanges) {
          failed.push({
            file,
            before: c.before,
            after: c.after,
            reason: 'new file path escapes project root',
            preview: preview(c.before),
          });
        }
        log(`  ⚠ path escapes the project root — skipping: ${uri.fsPath}`);
        continue;
      }
      const junkReason = looksLikeJunk(file);
      if (junkReason) {
        log(`  ⚠ new file in a typically ignored location (${junkReason}): ${file}`);
      }
      const alreadyInRoot = await pathExists(uri);
      log(`  Type: new file`);

      if (alreadyInRoot) {
        for (const c of fileChanges) {
          failed.push({
            file,
            before: c.before,
            after: c.after,
            reason: 'marked as new file, but it already exists — refusing to overwrite',
            preview: preview(c.before),
          });
        }
        continue;
      }
      const after = fileChanges.map((c) => c.after).join('\n');
      log(`  → Will be created (${after.length} chars)`);
      log('');
      prepared.push({
        uri,
        file,
        isNew: true,
        isDelete: false,
        originalContent: '',
        newContent: after,
      });
      continue;
    }

    const wantsDelete = fileChanges.some(
      (c) => c.func.toLowerCase() === '(delete file)',
    );
    if (wantsDelete) {
      if (!existing) {
        for (const c of fileChanges) {
          failed.push({
            file,
            after: '',
            reason: 'delete requested, but file does not exist',
            preview: '',
          });
        }
        continue;
      }
      let delDoc: vscode.TextDocument;
      try {
        delDoc = await vscode.workspace.openTextDocument(existing);
      } catch {
        for (const c of fileChanges) {
          failed.push({
            file,
            after: '',
            reason: 'cannot open file for delete',
            preview: '',
          });
        }
        continue;
      }
      const delText = delDoc.getText();
      log(`  Type: delete`);
      log(`  → Will be deleted (${delText.length} chars)`);
      log('');
      prepared.push({
        uri: existing,
        file,
        isNew: false,
        isDelete: true,
        originalContent: delText,
        newContent: '',
      });
      continue;
    }

    if (!existing) {
      for (const c of fileChanges) {
        failed.push({
          file,
          before: c.before,
          after: c.after,
          reason: 'file not found in workspace',
          preview: preview(c.before),
        });
      }
      continue;
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(existing);
    } catch {
      for (const c of fileChanges) {
        failed.push({
          file,
          before: c.before,
          after: c.after,
          reason: 'cannot open file',
          preview: preview(c.before),
        });
      }
      continue;
    }

    const text = doc.getText();
    const eol = detectEol(text);
    const matches: Array<{ idx: number; before: string; after: string }> = [];
    const fileFailed: Failed[] = [];

    for (const c of fileChanges) {
      if (c.after.trim() === '') {
        log(`    ⚠ empty AFTER — the fragment will be deleted without replacement`);
      }
      if (c.before.trim().length > 0 && c.before.trim().length < 5) {
        log(
          `    ⚠ short BEFORE (${c.before.trim().length} chars) — high false-match risk`,
        );
      }
      if (c.before.trim() === '') {
        fileFailed.push({
          file,
          before: c.before,
          after: c.after,
          reason: 'empty BEFORE fragment',
          preview: preview(c.after),
        });
        continue;
      }

      const claimed = matches.map(
        (m) => [m.idx, m.idx + m.before.length] as [number, number],
      );

      const beforeN = normalizeEol(c.before, eol);
      const afterN = normalizeEol(c.after, eol);

      let idx = findUnclaimed(text, beforeN, claimed);
      let usedBefore = beforeN;
      let usedAfter = afterN;

      if (idx === -1 && c.before !== beforeN) {
        idx = findUnclaimed(text, c.before, claimed);
        usedBefore = c.before;
        usedAfter = c.after;
      }

      // Typographic-vs-ASCII punctuation (em-dash, NBSP, etc.). Positions
      // map 1:1, so we can still slice from the original text.
      if (idx === -1) {
        const canonIdx = findUnclaimedCanonical(text, beforeN, claimed);
        if (canonIdx !== -1) {
          log(`    → canonical match (punctuation/whitespace differed)`);
          idx = canonIdx;
          usedBefore = text.slice(canonIdx, canonIdx + beforeN.length);
          usedAfter = afterN;
        }
      }

      if (idx === -1 && fuzzyMatch) {
        const fuzzy = findUnclaimedFuzzy(text, beforeN, claimed);
        if (fuzzy) {
          log(
            `    → fuzzy match at position ${fuzzy.idx} (length ${fuzzy.len}, whitespace-insensitive)`,
          );
          idx = fuzzy.idx;
          usedBefore = text.slice(fuzzy.idx, fuzzy.idx + fuzzy.len);
          usedAfter = afterN;
        }
      }

      if (idx === -1 && fuzzyMatch) {
        const fuzzy2 = findUnclaimedFuzzyIndent(text, beforeN, claimed);
        if (fuzzy2) {
          log(
            `    → fuzzy match (different indent) at position ${fuzzy2.idx}`,
          );
          idx = fuzzy2.idx;
          usedBefore = text.slice(fuzzy2.idx, fuzzy2.idx + fuzzy2.len);
          usedAfter = afterN;
        }
      }

      // BEFORE not found — the edit may already be applied.
      // Search AFTER as a substring; if it is already in the file,
      // the edit is already in the code. Not an error — skip, so the
      // failed report stays clean.
      if (idx === -1 && c.after.trim() !== '') {
        const afterN2 = normalizeEol(c.after, eol);
        if (text.includes(afterN2)) {
          log(`    → already applied (AFTER found in file)`);
          alreadyApplied++;
          continue;
        }
      }

      if (idx === -1) {
        const hint = findSimilarBlock(text, c.before);
        let charDiff: CharDiff | undefined;
        if (hint) {
          log(
            `    → similar block at line ${hint.lineNumber} (indent differs by ${hint.indentDiff})`,
          );
          // If indent matches (diff === 0) but content still differs,
          // pinpoint the first divergent character so the report can tell
          // the AI exactly what to fix.
          if (hint.indentDiff === 0) {
            const d = firstCharDiff(c.before, hint.snippet);
            if (d) {
              charDiff = d;
              log(
                `    → first divergence: line ${d.lineNumber}, column ${d.colNumber} — BEFORE has ${d.beforeChar} (${d.beforeCode}), file has ${d.fileChar} (${d.fileCode})`,
              );
            }
          }
        }
        fileFailed.push({
          file,
          before: c.before,
          after: c.after,
          reason: 'BEFORE not found in file',
          preview: preview(c.before),
          similarBlock: hint || undefined,
          charDiff,
        });
        continue;
      }

      matches.push({ idx, before: usedBefore, after: usedAfter });
    }

    // Atomic decision: if a file has ≥2 failures and the failure ratio
    // exceeds the threshold, drop all changes for this file — a stale
    // mental model of the file corrupts a half-applied result worse than
    // losing a few valid changes.
    const totalChanges = fileChanges.length;
    const failedChanges = fileFailed.length;
    const rejectWholeFile =
      failedChanges >= 2 &&
      totalChanges > 0 &&
      failedChanges / totalChanges >= failureThreshold;

    if (rejectWholeFile && matches.length > 0) {
      log(
        `  ⚠ REJECTED ENTIRELY: ${failedChanges} of ${totalChanges} edits not found`,
      );
      log('');
      atomicRejections.push({ file, totalChanges, failedChanges });
      for (const f of fileFailed) {
        failed.push({ ...f, atomicRejected: true });
      }
      continue;
    }

    for (const f of fileFailed) failed.push(f);

    if (matches.length === 0) continue;

    matches.sort((a, b) => b.idx - a.idx);
    let newContent = text;
    for (const m of matches) {
      newContent =
        newContent.slice(0, m.idx) + m.after + newContent.slice(m.idx + m.before.length);
    }

    if (newContent !== text) {
      const n = fileChanges.length;
      log(`  Type: modify (${n} ${n === 1 ? 'edit' : 'edits'})`);
      log(`  → Will be overwritten (${text.length} → ${newContent.length} chars)`);
      log('');
      prepared.push({
        uri: existing,
        file,
        isNew: false,
        isDelete: false,
        originalContent: text,
        newContent,
      });
    } else {
      log(`  → Skipped: no changes`);
      log('');
    }
  }

  return { prepared, failed, alreadyApplied, atomicRejections, projectRoot };
}

export interface PreviewOptions {
  pinTabs?: boolean;
  focusFirst?: boolean;
}

export async function previewPrepared(
  prepared: PreparedChange[],
  makePreviewUri: (file: string, content: string) => vscode.Uri,
  options: PreviewOptions = {},
): Promise<void> {
  const pinTabs = options.pinTabs ?? true;
  const focusFirst = options.focusFirst ?? true;

  const opened: Array<{
    original: vscode.Uri;
    modified: vscode.Uri;
    label: string;
  }> = [];

  for (const p of prepared) {
    const previewUri = makePreviewUri(p.file, p.newContent);
    let originalUri: vscode.Uri;
    let baseLabel: string;
    let stat: string;

    if (p.isDelete) {
      originalUri = p.uri;
      baseLabel = `${LABEL_DELETE}: ${p.file}`;
      stat = diffStat(p.originalContent, '');
    } else if (p.isNew) {
      originalUri = makePreviewUri(`${p.file}__empty`, '');
      baseLabel = `${LABEL_NEW}: ${p.file}`;
      stat = diffStat('', p.newContent);
    } else {
      originalUri = p.uri;
      baseLabel = `${LABEL_MODIFIED}: ${p.file}`;
      stat = diffStat(p.originalContent, p.newContent);
    }

    const label = stat ? `${baseLabel} (${stat})` : baseLabel;
    await vscode.commands.executeCommand('vscode.diff', originalUri, previewUri, label);

    if (pinTabs) {
      // Give VS Code a tick to finish opening the preview tab, then convert
      // it into a permanent tab so the next diff does not evict it.
      await delay(120);
      await vscode.commands.executeCommand('workbench.action.keepEditor');
    }
    opened.push({ original: originalUri, modified: previewUri, label });
  }

  if (focusFirst && opened.length > 0) {
    const t = opened[0];
    await vscode.commands.executeCommand(
      'vscode.diff',
      t.original,
      t.modified,
      t.label,
    );
  }
}

export function diffStat(before: string, after: string): string {
  if (before === '' && after === '') return '';
  if (before === '') {
    const lines = after.split('\n').filter((l) => l.trim().length > 0).length;
    return lines > 0 ? `+${lines}` : '';
  }
  if (after === '') {
    const lines = before.split('\n').filter((l) => l.trim().length > 0).length;
    return lines > 0 ? `−${lines}` : '';
  }

  const beforeSet = new Map<string, number>();
  const afterSet = new Map<string, number>();
  for (const l of before.split('\n')) beforeSet.set(l, (beforeSet.get(l) ?? 0) + 1);
  for (const l of after.split('\n')) afterSet.set(l, (afterSet.get(l) ?? 0) + 1);

  let added = 0;
  let removed = 0;
  for (const [l, c] of afterSet) {
    const b = beforeSet.get(l) ?? 0;
    if (c > b) added += c - b;
  }
  for (const [l, c] of beforeSet) {
    const a = afterSet.get(l) ?? 0;
    if (c > a) removed += c - a;
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  return parts.join(' ');
}

export async function commitPrepared(
  prepared: PreparedChange[],
  log: (line: string) => void = () => {},
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();

  for (const p of prepared) {
    if (p.isDelete) {
      log(`  ${p.file} — delete`);
      edit.deleteFile(p.uri, { recursive: false });
      continue;
    }
    if (p.isNew) {
      log(`  ${p.file} — create`);
      await ensureParentDir(p.uri);
      edit.createFile(p.uri, { overwrite: false, ignoreIfExists: true });
      edit.insert(p.uri, new vscode.Position(0, 0), p.newContent);
      continue;
    }
    log(`  ${p.file} — overwrite`);
    const doc = await vscode.workspace.openTextDocument(p.uri);
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    );
    edit.replace(p.uri, fullRange, p.newContent);
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    throw new Error('applyEdit failed');
  }

  for (const p of prepared) {
    if (p.isDelete) continue;
    try {
      const doc = await vscode.workspace.openTextDocument(p.uri);
      if (doc.isDirty && !doc.isUntitled) {
        await doc.save();
      }
    } catch (err) {
      log(`  ERROR saving ${p.file}: ${err}`);
      throw err;
    }
  }
}

async function ensureParentDir(fileUri: vscode.Uri): Promise<void> {
  const parent = vscode.Uri.joinPath(fileUri, '..');
  try {
    await vscode.workspace.fs.stat(parent);
  } catch {
    await vscode.workspace.fs.createDirectory(parent);
  }
}

function resolveNewFilePath(file: string, root: vscode.Uri): vscode.Uri {
  const normalized = normalizePath(file);
  const firstSeg = normalized.split('/')[0];
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (firstSeg && folders.some((f) => f.name === firstSeg)) {
    return vscode.Uri.joinPath(root, normalized.slice(firstSeg.length + 1));
  }
  return vscode.Uri.joinPath(root, normalized);
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function findProjectRoot(byFile: Map<string, Change[]>): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) throw new Error('No workspace folder');
  if (folders.length === 1) return folders[0].uri;

  for (const [file] of byFile) {
    const normalized = normalizePath(file);
    const firstSeg = normalized.split('/')[0];
    if (!firstSeg) continue;
    const match = folders.find((f) => f.name === firstSeg);
    if (match) return match.uri;
  }

  for (const [file, changes] of byFile) {
    const isNew = changes.some((c) => c.func.toLowerCase() === '(new file)');
    if (isNew) continue;
    const uri = await resolveFile(file);
    if (!uri) continue;
    for (const folder of folders) {
      if (
        uri.path === folder.uri.path ||
        uri.path.startsWith(folder.uri.path + '/')
      ) {
        return folder.uri;
      }
    }
  }

  return folders[0].uri;
}

export function langFromUri(uri: vscode.Uri): string {
  return langFromPath(uri.path);
}

function delay(ms: number): Promise<void> {
  // `setTimeout` is a Node.js global; declared via globalThis to avoid
  // pulling in @types/node into the compile unit.
  return new Promise<void>((resolve) => {
    const t = (
      globalThis as unknown as {
        setTimeout: (cb: () => void, ms: number) => unknown;
      }
    ).setTimeout;
    t(resolve, ms);
  });
}

export async function resolveFile(
  file: string,
  preferredRoot?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const normalized = normalizePath(file);
  const candidates: string[] = [normalized];

  const firstSeg = normalized.split('/')[0];
  if (firstSeg && folders.some((f) => f.name === firstSeg)) {
    const stripped = normalized.slice(firstSeg.length + 1);
    if (stripped) candidates.push(stripped);
  }

  if (preferredRoot) {
    for (const cand of candidates) {
      const uri = vscode.Uri.joinPath(preferredRoot, cand);
      if (!isInside(preferredRoot, uri)) continue;
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // try next
      }
    }
    // Do not fall back to other folders: if the AI pointed to a file that
    // should be in the project root but is not, resolving it elsewhere is
    // almost always wrong (e.g. calc/README.md missing, ai-patch-apply/README.md exists).
    return undefined;
  }

  for (const folder of folders) {
    for (const cand of candidates) {
      const uri = vscode.Uri.joinPath(folder.uri, cand);
      if (!isInside(folder.uri, uri)) continue;
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // try next
      }
    }
  }
  return undefined;
}

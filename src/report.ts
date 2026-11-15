// Builds the Markdown failed-report copied back to the AI chat. VS Code API
// is used only to read the current file contents; the assembly itself is
// plain text work.
import * as vscode from 'vscode';
import { resolveFile, langFromUri, Failed } from './applier';

const BIG_FILE_LINES = 5000;

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

// One-line pointer to the closest matching block — the full diagnostics
// live in this report; the patch history only needs enough context to see
// why the match failed at a glance.
export function failureHint(f: Failed): string | undefined {
  if (!f.similarBlock) return undefined;
  let hint = `closest block at line ${f.similarBlock.lineNumber}`;
  if (f.similarBlock.indentDiff !== 0) {
    hint += ` (indent differs by ${f.similarBlock.indentDiff})`;
  }
  if (f.charDiff) {
    hint += `; first divergence at line ${f.charDiff.lineNumber}, column ${f.charDiff.colNumber}`;
  }
  return hint;
}

export async function buildFailedReport(
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

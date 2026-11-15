export interface Change {
  file: string;
  func: string;
  before: string;
  after: string;
  isDelete: boolean;
  /** If set, this block could not be parsed and must be surfaced to the user / report. */
  parseError?: string;
}

const LOCATION_RE =
  /\*\*Location:\*\*\s*File:\s*`([^`]+)`(?:\s*\|\s*Function:\s*`([^`]+)`)?/g;

export interface ParseOptions {
  afterMaxBytes?: number;
}

export function parseClipboard(
  text: string,
  log: (line: string) => void = () => {},
  options: ParseOptions = {},
): Change[] {
  const afterMaxBytes = options.afterMaxBytes ?? 20000;
  const markers: Array<{ file: string; func: string; index: number }> = [];
  let m: RegExpExecArray | null;
  LOCATION_RE.lastIndex = 0;
  while ((m = LOCATION_RE.exec(text)) !== null) {
    markers.push({
      file: m[1].trim(),
      func: (m[2] ?? '').trim(),
      index: m.index,
    });
  }

  const changes: Change[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const chunk = text.slice(start, end);

    const funcLower = markers[i].func.toLowerCase();
    const isNew = funcLower === '(new file)';
    const isDelete = funcLower === '(delete file)';
    const fname = markers[i].file;
    const ffunc = markers[i].func;

    // Every error path below pushes a Change with `parseError` set. That
    // way the extension surfaces the failure to the user and report,
    // instead of silently dropping the block — which used to happen and
    // made real problems invisible.
    const fail = (reason: string): void => {
      log(`  failed ${fname}: ${reason}`);
      changes.push({
        file: fname,
        func: ffunc,
        before: '',
        after: '',
        isDelete: false,
        parseError: reason,
      });
    };

    if (!isNew && !isDelete) {
      const b = extractBlock(chunk, '**BEFORE:**');
      const a = extractBlock(chunk, '**AFTER:**');

      // Only when BEFORE is absent do we treat a bracketed Function value
      // as a possible unsupported operation marker. If BEFORE exists, the
      // block is a normal change regardless of what is inside `(...)` —
      // the AI often writes descriptive hints there like `(before foo)`.
      if (b === null && isOperationalMarker(ffunc)) {
        // Capture whatever code block the AI did send, so the failed
        // report can show it back to the AI. Otherwise the report says
        // "unsupported marker" with an empty body and the AI has no idea
        // what content to re-emit.
        const a = extractBlock(chunk, '**AFTER:**') ?? extractFirstBlock(chunk);
        log(`  failed ${fname}: unsupported marker ${ffunc}`);
        changes.push({
          file: fname,
          func: ffunc,
          before: '',
          after: a ?? '',
          isDelete: false,
          parseError: `unsupported marker: ${ffunc}`,
        });
        continue;
      }
      if (b === null) { fail('missing BEFORE block'); continue; }
      if (b.trim() === '') { fail('empty BEFORE block'); continue; }
      if (a === null) { fail('missing AFTER block'); continue; }
      // [A-Za-z] so all-caps markers (**BEFORE:**, **AFTER:**) are caught
      // too — a BEFORE that swallowed the next marker means the AI emitted
      // an unclosed fence.
      if (/\*\*[A-Za-z]+:\*\*/m.test(b)) {
        fail('BEFORE contains markdown directives');
        continue;
      }
      if (a.length > afterMaxBytes) {
        fail(`AFTER too large (${a.length} chars)`);
        continue;
      }
      const cleanB = stripFiller(b);
      if (cleanB.trim() === '') { fail('empty BEFORE after cleanup'); continue; }

      changes.push({
        file: fname,
        func: ffunc,
        before: cleanB,
        after: a,
        isDelete: false,
      });
    } else if (isNew) {
      // Prefer the explicit AFTER marker when present — otherwise the first
      // fence in the chunk might be illustrative code the AI showed before
      // the actual file content.
      let a = extractBlock(chunk, '**AFTER:**');
      if (a === null) a = extractFirstBlock(chunk);
      if (a === null) { fail('new file has no code block'); continue; }

      changes.push({
        file: fname,
        func: ffunc,
        before: '',
        after: a,
        isDelete: false,
      });
    } else {
      // isDelete — blocks not required.
      changes.push({
        file: fname,
        func: ffunc,
        before: '',
        after: '',
        isDelete: true,
      });
    }
  }

  return changes;
}

// Narrow list of bracketed values that request a whole-file operation we
// do not support. Anything not in this set — `(imports + helper)`,
// `(before get_all_tasks)`, `(section table)` — is treated as a positional
// hint, not an operation. Those blocks keep their BEFORE/AFTER and are
// parsed like normal changes.
const OPERATIONAL_MARKERS = new Set([
  'full rewrite',
  'rewrite',
  'rewrite file',
  'append',
  'insert',
  'insert after',
  'insert before',
  'move',
  'rename',
  'replace file',
]);

function isOperationalMarker(func: string): boolean {
  const f = func.trim().toLowerCase();
  if (!f.startsWith('(') || !f.endsWith(')')) return false;
  const inner = f.slice(1, -1).trim();
  return OPERATIONAL_MARKERS.has(inner);
}

// Opening fence: a run of >= 3 backticks, optional language, newline. The
// run length is returned so the closing fence must match it — otherwise a
// ``` line inside a ```` block (markdown examples) would end the block early.
const OPEN_FENCE = /(`{3,})[a-zA-Z0-9_+-]*[ \t]*\r?\n/;

function extractFencedBlock(tail: string): string | null {
  const openMatch = tail.match(OPEN_FENCE);
  if (!openMatch || openMatch.index === undefined) return null;

  const codeStart = openMatch.index + openMatch[0].length;
  const fenceLen = openMatch[1].length;
  const rest = tail.slice(codeStart);

  // Closing fence: a run of the same length at the start of a line.
  const closeMatch = rest.match(new RegExp('\r?\n`{' + fenceLen + '}'));
  if (!closeMatch || closeMatch.index === undefined) return null;

  return rest.slice(0, closeMatch.index);
}

function extractBlock(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  return extractFencedBlock(text.slice(idx + marker.length));
}

// For `(new file)` blocks: the AI does not emit a `**BEFORE:**` marker,
// and `**AFTER:**` is optional. The file body is simply the first fenced
// code block in the chunk.
function extractFirstBlock(text: string): string | null {
  return extractFencedBlock(text);
}

function stripFiller(code: string): string {
  return code
    .split('\n')
    .filter(
      (line) =>
        !/^\s*(\/\/|#|\/\*|\*)\s*\.\.\.\s*(existing|rest|остальной|unchanged)/i.test(
          line,
        ),
    )
    .join('\n');
}
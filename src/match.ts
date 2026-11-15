// Pure text-matching utilities. No VS Code API — kept separate so they can
// be unit-tested without mocking the extension host.

export function findUnclaimed(
  text: string,
  needle: string,
  claimed: Array<[number, number]>,
): number {
  let from = 0;
  while (from <= text.length) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return -1;
    const overlaps = claimed.some(
      ([s, e]) => idx < e && idx + needle.length > s,
    );
    if (!overlaps) return idx;
    from = idx + 1;
  }
  return -1;
}

export function findUnclaimedFuzzy(
  text: string,
  needle: string,
  claimed: Array<[number, number]>,
): { idx: number; len: number } | null {
  const textLines = text.split('\n');
  const needleLines = needle.split('\n');
  if (needleLines.length === 0) return null;

  // Normalize: tabs → 4 spaces, strip trailing whitespace.
  const norm = (s: string) => s.replace(/\t/g, '    ').replace(/\s+$/g, '');
  const normNeedle = needleLines.map(norm);

  // Precompute line start offsets in original text.
  const lineStarts: number[] = [0];
  for (let i = 0; i < textLines.length - 1; i++) {
    lineStarts.push(lineStarts[i] + textLines[i].length + 1);
  }

  for (let i = 0; i + needleLines.length <= textLines.length; i++) {
    let match = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (norm(textLines[i + j]) !== normNeedle[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const startIdx = lineStarts[i];
    const endIdx =
      lineStarts[i + needleLines.length - 1] +
      textLines[i + needleLines.length - 1].length;

    const overlaps = claimed.some(([s, e]) => startIdx < e && endIdx > s);
    if (!overlaps) return { idx: startIdx, len: endIdx - startIdx };
  }
  return null;
}

export function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/').trim();
}

export function preview(s: string): string {
  const firstLine = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
}

export function detectEol(text: string): string {
  const idx = text.indexOf('\n');
  if (idx === -1) return '\n';
  if (idx > 0 && text[idx - 1] === '\r') return '\r\n';
  return '\n';
}

export function normalizeEol(s: string, eol: string): string {
  return s.replace(/\r\n|\r|\n/g, eol);
}

export function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascriptreact',
    tsx: 'typescriptreact',
    html: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    toml: 'toml',
  };
  return map[ext] ?? '';
}

// ── Indent-tolerant fuzzy matching ─────────────────────────────
//
// Solves the common failure mode when the AI copies a code fragment from
// chat: every line is shifted left or right by a constant number of
// spaces (usually because the AI saw a different indentation level in its
// training context). The existing findUnclaimedFuzzy already handles tabs
// vs spaces and trailing whitespace — this one goes further and normalises
// the *leading* common indent before comparing.
//
// Safety: a match is only accepted when it is UNIQUE in the file. If two
// or more windows look identical after normalisation, we bail out rather
// than risk replacing the wrong block.

function stripTrailTabs(s: string): string {
  return s.replace(/\t/g, "    ").replace(/[ \t]+$/g, "");
}

function baseIndent(lines: string[]): number {
  let min = Infinity;
  for (const l of lines) {
    const t = stripTrailTabs(l);
    if (!t) continue;
    const m = t.match(/^ */);
    const indent = m ? m[0].length : 0;
    if (indent < min) min = indent;
  }
  return min === Infinity ? 0 : min;
}

function normalizeLines(lines: string[]): string[] {
  const base = baseIndent(lines);
  return lines.map((l) => {
    const t = stripTrailTabs(l);
    return t.length >= base ? t.slice(base) : "";
  });
}

export function findUnclaimedFuzzyIndent(
  text: string,
  needle: string,
  claimed: Array<[number, number]>,
): { idx: number; len: number } | null {
  const textLines = text.split("\n");
  const needleLines = needle.split("\n");
  if (needleLines.length === 0) return null;
  if (needleLines.length > textLines.length) return null;

  const normNeedle = normalizeLines(needleLines);

  const lineStarts: number[] = [0];
  for (let i = 0; i < textLines.length - 1; i++) {
    lineStarts.push(lineStarts[i] + textLines[i].length + 1);
  }

  let found: { idx: number; len: number } | null = null;

  for (let i = 0; i + needleLines.length <= textLines.length; i++) {
    const window = textLines.slice(i, i + needleLines.length);
    const normWindow = normalizeLines(window);

    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (normWindow[j] !== normNeedle[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const startIdx = lineStarts[i];
    const endIdx =
      lineStarts[i + needleLines.length - 1] +
      textLines[i + needleLines.length - 1].length;

    const overlaps = claimed.some(([s, e]) => startIdx < e && endIdx > s);
    if (overlaps) continue;

    // Second independent match → ambiguous. Bail out entirely.
    if (found !== null) return null;
    found = { idx: startIdx, len: endIdx - startIdx };
  }

  return found;
}

export interface SimilarBlock {
  lineNumber: number;
  snippet: string;
  indentDiff: number;
}

export interface CharDiff {
  lineNumber: number;
  colNumber: number;
  beforeChar: string;
  beforeCode: string;
  fileChar: string;
  fileCode: string;
}

// Locate the first character that differs between two strings of the same
// line-structure. Returns null if lengths differ (a structural mismatch,
// not a single-char substitution). Positions are 1-based.
export function firstCharDiff(a: string, b: string): CharDiff | null {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.min(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    const lineA = la[i];
    const lineB = lb[i];
    if (lineA.length !== lineB.length) return null;
    for (let j = 0; j < lineA.length; j++) {
      if (lineA[j] !== lineB[j]) {
        return {
          lineNumber: i + 1,
          colNumber: j + 1,
          beforeChar: lineA[j],
          beforeCode: charCode(lineA[j]),
          fileChar: lineB[j],
          fileCode: charCode(lineB[j]),
        };
      }
    }
  }
  return null;
}

function charCode(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

// Diagnostic helper used when the fuzzy match fails: finds the closest
// block in the file and reports how its leading indent differs. Feeds
// the failed-report so the AI can see what it did wrong.
export function findSimilarBlock(
  text: string,
  needle: string,
): SimilarBlock | null {
  const textLines = text.split("\n");
  const needleLines = needle.split("\n");
  if (needleLines.length === 0) return null;
  if (needleLines.length > textLines.length) return null;

  // Canonicalise as well — this function is a diagnostic, meant to find
  // the block even when typographic chars (em-dash, «quotes», NBSP) differ.
  const normNeedle = normalizeLines(needleLines).map(canonicalize);
  const needleBase = baseIndent(needleLines);

  for (let i = 0; i + needleLines.length <= textLines.length; i++) {
    const window = textLines.slice(i, i + needleLines.length);
    const normWindow = normalizeLines(window).map(canonicalize);

    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (normWindow[j] !== normNeedle[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const windowBase = baseIndent(window);
    return {
      lineNumber: i + 1,
      snippet: window.join("\n"),
      indentDiff: windowBase - needleBase,
    };
  }

  return null;
}

// Common paths that typically belong in .gitignore. Warn softly when a new
// file is about to be created at such a path — the AI may have hallucinated
// a build artifact, a cache file, or an env file. We don't block, only flag.

const JUNK_PATTERNS: Array<{ rx: RegExp; reason: string }> = [
  { rx: /(^|\/)__pycache__\//, reason: 'Python cache' },
  { rx: /(^|\/)node_modules\//, reason: 'Node dependencies' },
  { rx: /(^|\/)\.pytest_cache\//, reason: 'pytest cache' },
  { rx: /(^|\/)\.mypy_cache\//, reason: 'mypy cache' },
  { rx: /(^|\/)\.venv\//, reason: 'virtualenv' },
  { rx: /(^|\/)venv\//, reason: 'virtualenv' },
  { rx: /(^|\/)env\//, reason: 'virtualenv' },
  { rx: /(^|\/)dist\//, reason: 'build output' },
  { rx: /(^|\/)build\//, reason: 'build output' },
  { rx: /(^|\/)\.idea\//, reason: 'IDE config' },
  { rx: /(^|\/)\.vscode\//, reason: 'IDE config' },
  { rx: /\.pyc$/, reason: 'Python bytecode' },
  { rx: /\.pyo$/, reason: 'Python bytecode' },
  { rx: /\.log$/, reason: 'log file' },
  { rx: /(^|\/)\.DS_Store$/, reason: 'macOS junk' },
  { rx: /(^|\/)Thumbs\.db$/, reason: 'Windows junk' },
  { rx: /(^|\/)\.env$/, reason: 'env file with secrets' },
  { rx: /(^|\/)\.env\./, reason: 'env file with secrets' },
];

export function looksLikeJunk(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { rx, reason } of JUNK_PATTERNS) {
    if (rx.test(normalized)) return reason;
  }
  return null;
}

// Path containment check used as a security guard: reject any AI-provided
// path that escapes the workspace folder. String-prefix comparison after
// normalising the trailing slash on the parent. Does not resolve `..` —
// the caller is expected to pass already-normalised paths (vscode.Uri
// normalises on joinPath).
export function pathIsInside(parentPath: string, childPath: string): boolean {
  const parent = parentPath.endsWith('/') ? parentPath : parentPath + '/';
  return childPath === parentPath || childPath.startsWith(parent);
}

// ── Canonical punctuation matching ─────────────────────────────
//
// The AI sometimes pastes typographic characters into BEFORE that are
// visually identical to ASCII but have different code points: `—`
// (em-dash) instead of `-`, NBSP instead of a regular space, etc. The
// file was written with ASCII, the AI's BEFORE has the fancy variant,
// the exact match fails.
//
// This helper canonicalises both sides (1:1 char swaps) and searches the
// canonicalised file for the canonicalised BEFORE. All replacements are
// 1:1, so positions in the canonical text map exactly to positions in the
// original — no offset table needed.
//
// Safety: ambiguous matches are rejected (return -1). If the canonical
// form appears in two places, we can't tell which one the AI meant.

const CANONICAL_MAP: Record<string, string> = {
  // Typographic dashes → hyphen
  '\u2010': '-', // hyphen
  '\u2011': '-', // non-breaking hyphen
  '\u2012': '-', // figure dash
  '\u2013': '-', // en-dash
  '\u2014': '-', // em-dash
  '\u2015': '-', // horizontal bar
  '\u2212': '-', // minus sign
  // Fancy spaces → regular space
  '\u00A0': ' ', // no-break space
  '\u2007': ' ', // figure space
  '\u2008': ' ', // punctuation space
  '\u2009': ' ', // thin space
  '\u200A': ' ', // hair space
  '\u202F': ' ', // narrow no-break space
  // Typographic double quotes → straight double quote
  '\u00AB': '"', // « left-pointing guillemet
  '\u00BB': '"', // » right-pointing guillemet
  '\u201C': '"', // " left double quotation mark
  '\u201D': '"', // " right double quotation mark
  '\u201E': '"', // „ low double quotation mark
  '\u201F': '"', // ‟ high double quotation mark
  // Typographic single quotes → straight apostrophe
  '\u2018': "'", // ' left single quotation mark
  '\u2019': "'", // ' right single quotation mark
  '\u201A': "'", // ‚ low single quotation mark
  '\u201B': "'", // ‛ high single quotation mark
};

const CANONICAL_CHARS = Object.keys(CANONICAL_MAP);

function canonicalize(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const r = CANONICAL_MAP[ch];
    out += r !== undefined ? r : ch;
  }
  return out;
}

function containsCanonical(s: string): boolean {
  for (const ch of CANONICAL_CHARS) {
    if (s.includes(ch)) return true;
  }
  return false;
}

// Returns the index in the ORIGINAL text where BEFORE matches after
// canonicalisation, or -1 if not found or ambiguous.
export function findUnclaimedCanonical(
  text: string,
  needle: string,
  claimed: Array<[number, number]>,
): number {
  if (!containsCanonical(text) && !containsCanonical(needle)) return -1;

  const canonText = canonicalize(text);
  const canonNeedle = canonicalize(needle);

  let found = -1;
  let from = 0;
  while (from <= canonText.length) {
    const idx = canonText.indexOf(canonNeedle, from);
    if (idx === -1) break;

    const overlaps = claimed.some(
      ([s, e]) => idx < e && idx + canonNeedle.length > s,
    );
    if (!overlaps) {
      if (found !== -1) return -1; // ambiguous
      found = idx;
    }
    from = idx + 1;
  }
  return found;
}
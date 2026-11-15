import { describe, it, expect } from 'vitest';
import {
  findUnclaimed,
  findUnclaimedFuzzy,
  findUnclaimedFuzzyIndent,
  findSimilarBlock,
  looksLikeJunk,
  pathIsInside,
  normalizePath,
  preview,
  detectEol,
  normalizeEol,
  langFromPath,
} from '../src/match';

describe('findUnclaimed', () => {
  it('finds exact match', () => {
    expect(findUnclaimed('hello world', 'world', [])).toBe(6);
  });

  it('returns -1 when missing', () => {
    expect(findUnclaimed('hello', 'xyz', [])).toBe(-1);
  });

  it('skips claimed ranges', () => {
    const text = 'foo bar foo baz foo';
    // First `foo` at 0-3 is claimed, so we should find the one at 8-11.
    expect(findUnclaimed(text, 'foo', [[0, 3]])).toBe(8);
  });

  it('skips overlapping ranges and finds next', () => {
    const text = 'abc abc abc';
    expect(findUnclaimed(text, 'abc', [[0, 3], [4, 7]])).toBe(8);
  });

  it('returns -1 when all matches are claimed', () => {
    const text = 'x x x';
    expect(findUnclaimed(text, 'x', [[0, 1], [2, 3], [4, 5]])).toBe(-1);
  });
});

describe('findUnclaimedFuzzy', () => {
  it('matches despite tab vs space difference', () => {
    const text = 'def f():\n    return 1\n';
    const needle = 'def f():\n\treturn 1';
    const result = findUnclaimedFuzzy(text, needle, []);
    expect(result).not.toBeNull();
    expect(text.slice(result!.idx, result!.idx + result!.len)).toBe(
      'def f():\n    return 1',
    );
  });

  it('ignores trailing whitespace', () => {
    const text = 'line one\nline two\n';
    const needle = 'line one   \nline two';
    expect(findUnclaimedFuzzy(text, needle, [])).not.toBeNull();
  });

  it('returns null when no match', () => {
    expect(findUnclaimedFuzzy('abc', 'xyz', [])).toBeNull();
  });

  it('skips claimed ranges', () => {
    const text = 'same\nsame\n';
    const needle = 'same';
    const first = findUnclaimedFuzzy(text, needle, []);
    expect(first).not.toBeNull();
    const second = findUnclaimedFuzzy(text, needle, [[first!.idx, first!.idx + first!.len]]);
    expect(second).not.toBeNull();
    expect(second!.idx).toBeGreaterThan(first!.idx);
  });
});

describe('normalizePath', () => {
  it('strips leading ./', () => {
    expect(normalizePath('./src/main.ts')).toBe('src/main.ts');
  });
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('src\\main.ts')).toBe('src/main.ts');
  });
  it('trims whitespace', () => {
    expect(normalizePath('  src/main.ts  ')).toBe('src/main.ts');
  });
});

describe('preview', () => {
  it('returns first non-empty line, trimmed', () => {
    expect(preview('\n\n  hello world\nsecond')).toBe('hello world');
  });
  it('truncates long lines with ellipsis', () => {
    const long = 'x'.repeat(100);
    const out = preview(long);
    expect(out.length).toBe(81);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns empty for whitespace-only input', () => {
    expect(preview('   \n  \n')).toBe('');
  });
});

describe('detectEol', () => {
  it('detects LF', () => {
    expect(detectEol('a\nb\n')).toBe('\n');
  });
  it('detects CRLF', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
  });
  it('returns LF for text without newlines', () => {
    expect(detectEol('single line')).toBe('\n');
  });
});

describe('normalizeEol', () => {
  it('converts LF to CRLF', () => {
    expect(normalizeEol('a\nb', '\r\n')).toBe('a\r\nb');
  });
  it('converts CRLF to LF', () => {
    expect(normalizeEol('a\r\nb', '\n')).toBe('a\nb');
  });
  it('leaves already-correct input unchanged', () => {
    expect(normalizeEol('a\nb', '\n')).toBe('a\nb');
  });
});

describe('langFromPath', () => {
  it('recognises common extensions', () => {
    expect(langFromPath('src/main.py')).toBe('python');
    expect(langFromPath('app.js')).toBe('javascript');
    expect(langFromPath('x.tsx')).toBe('typescriptreact');
    expect(langFromPath('README.md')).toBe('markdown');
  });
  it('returns empty for unknown extension', () => {
    expect(langFromPath('file.xyz')).toBe('');
    expect(langFromPath('noext')).toBe('');
  });
});

describe('findUnclaimedFuzzy — extra edge cases', () => {
  it('matches when needle equals text entirely', () => {
    const result = findUnclaimedFuzzy('hello', 'hello', []);
    expect(result).toEqual({ idx: 0, len: 5 });
  });

  it('returns null when needle is longer than text', () => {
    expect(findUnclaimedFuzzy('a', 'a\nb', [])).toBeNull();
  });

  it('handles CRLF in text with LF in needle', () => {
    const text = 'foo\r\nbar';
    const needle = 'foo\nbar';
    const result = findUnclaimedFuzzy(text, needle, []);
    expect(result).not.toBeNull();
    expect(text.slice(result!.idx, result!.idx + result!.len)).toBe('foo\r\nbar');
  });

  it('returns null when line count fits but content does not', () => {
    const text = 'alpha\nbeta\n';
    const needle = 'alpha\ngamma';
    expect(findUnclaimedFuzzy(text, needle, [])).toBeNull();
  });
});

describe('findUnclaimed — extra edge cases', () => {
  it('finds match at position 0', () => {
    expect(findUnclaimed('foo bar', 'foo', [])).toBe(0);
  });

  it('handles empty needle gracefully', () => {
    // Empty needle matches at 0 — degenerate but well-defined.
    expect(findUnclaimed('abc', '', [])).toBe(0);
  });

  it('handles claimed range that ends exactly where match begins', () => {
    const text = 'foo bar';
    // Claimed range [0, 3] ends right before 'foo' at index 4? No: 'foo bar',
    // index 4 is 'b'. Put a second 'foo' at index 4 by using different text.
    const t2 = 'foofoo';
    // Claimed [0, 3] covers first 'foo'. Next candidate at index 3 doesn't
    // overlap (3 < 3 is false). So it should be found.
    expect(findUnclaimed(t2, 'foo', [[0, 3]])).toBe(3);
    // Sanity: original text has nothing to find after 0.
    expect(findUnclaimed(text, 'foo', [[0, 3]])).toBe(-1);
  });
});

// ── pathIsInside ────────────────────────────────────────────────

describe('pathIsInside', () => {
  it('same path is inside', () => {
    expect(pathIsInside('/a/b', '/a/b')).toBe(true);
  });

  it('direct child is inside', () => {
    expect(pathIsInside('/a/b', '/a/b/c')).toBe(true);
  });

  it('deep descendant is inside', () => {
    expect(pathIsInside('/a/b', '/a/b/c/d/e.py')).toBe(true);
  });

  it('parent with trailing slash still works', () => {
    expect(pathIsInside('/a/b/', '/a/b/c')).toBe(true);
  });

  it('sibling prefix is NOT inside (key edge)', () => {
    // /a/bc is not inside /a/b, even though the string starts with it.
    expect(pathIsInside('/a/b', '/a/bc')).toBe(false);
  });

  it('parent of the parent is NOT inside', () => {
    expect(pathIsInside('/a/b', '/a')).toBe(false);
  });

  it('.. in child string does not silently resolve to inside', () => {
    // Not normalised here — the caller is supposed to pass resolved paths.
    // This test documents that raw `..` strings are treated literally.
    expect(pathIsInside('/a/b', '/a/b/../etc')).toBe(true);
  });
});

// ── looksLikeJunk ───────────────────────────────────────────────

describe('looksLikeJunk', () => {
  it('flags __pycache__ directories', () => {
    expect(looksLikeJunk('src/__pycache__/foo.pyc')).toBe('Python cache');
  });

  it('flags standalone .pyc files', () => {
    expect(looksLikeJunk('foo.pyc')).toBe('Python bytecode');
  });

  it('flags node_modules', () => {
    expect(looksLikeJunk('node_modules/foo/bar.js')).toBe('Node dependencies');
  });

  it('flags pytest cache', () => {
    expect(looksLikeJunk('.pytest_cache/v/cache/lastfailed')).toBe('pytest cache');
  });

  it('flags virtualenvs', () => {
    expect(looksLikeJunk('.venv/lib/python3.12/site-packages/foo.py')).toBe('virtualenv');
    expect(looksLikeJunk('venv/bin/activate')).toBe('virtualenv');
  });

  it('flags build outputs', () => {
    expect(looksLikeJunk('dist/bundle.js')).toBe('build output');
    expect(looksLikeJunk('build/obj/main.o')).toBe('build output');
  });

  it('flags IDE config folders', () => {
    expect(looksLikeJunk('.vscode/settings.json')).toBe('IDE config');
    expect(looksLikeJunk('.idea/workspace.xml')).toBe('IDE config');
  });

  it('flags .env files', () => {
    expect(looksLikeJunk('.env')).toBe('env file with secrets');
    expect(looksLikeJunk('project/.env')).toBe('env file with secrets');
    expect(looksLikeJunk('.env.local')).toBe('env file with secrets');
  });

  it('flags log files', () => {
    expect(looksLikeJunk('debug.log')).toBe('log file');
    expect(looksLikeJunk('logs/app.log')).toBe('log file');
  });

  it('flags OS junk', () => {
    expect(looksLikeJunk('.DS_Store')).toBe('macOS junk');
    expect(looksLikeJunk('Thumbs.db')).toBe('Windows junk');
  });

  it('handles Windows path separators', () => {
    expect(looksLikeJunk('src\\__pycache__\\foo.pyc')).toBe('Python cache');
    expect(looksLikeJunk('project\\node_modules\\foo.js')).toBe('Node dependencies');
  });

  it('returns null for normal source files', () => {
    expect(looksLikeJunk('src/main.py')).toBeNull();
    expect(looksLikeJunk('README.md')).toBeNull();
    expect(looksLikeJunk('app/templates/index.html')).toBeNull();
  });
});

// ── findUnclaimedFuzzyIndent ────────────────────────────────────

describe('findUnclaimedFuzzyIndent', () => {
  it('matches despite 4 leading spaces of shift', () => {
    // File has zero indent, needle has 4 extra leading spaces on every line.
    const text = 'def foo():\n    x = 1\n    return x\n';
    const needle = '    def foo():\n        x = 1\n        return x';
    const result = findUnclaimedFuzzyIndent(text, needle, []);
    expect(result).not.toBeNull();
    expect(text.slice(result!.idx, result!.idx + result!.len)).toBe(
      'def foo():\n    x = 1\n    return x',
    );
  });

  it('matches despite tab vs space difference plus indent shift', () => {
    const text = 'def f():\n\treturn 1\n';
    const needle = '        def f():\n            return 1';
    const result = findUnclaimedFuzzyIndent(text, needle, []);
    expect(result).not.toBeNull();
  });

  it('returns null when block does not exist', () => {
    const text = 'x = 1\ny = 2\n';
    const needle = '    something_else\n    entirely';
    expect(findUnclaimedFuzzyIndent(text, needle, [])).toBeNull();
  });

  it('returns null when block appears twice (ambiguous)', () => {
    // Safety: refuse to guess. User must add more context.
    const text = 'foo\nfoo\n';
    expect(findUnclaimedFuzzyIndent(text, 'foo', [])).toBeNull();
  });

  it('skips claimed ranges and matches unclaimed copy', () => {
    const text = 'foo\nfoo\n';
    const first = [0, 3] as [number, number];
    const result = findUnclaimedFuzzyIndent(text, 'foo', [first]);
    expect(result).toEqual({ idx: 4, len: 3 });
  });

  it('preserves relative indentation inside the block', () => {
    // Same shape, but internal lines keep their relative indent.
    const text = 'def g():\n    if True:\n        return 1\n';
    const needle = '  def g():\n      if True:\n          return 1';
    const result = findUnclaimedFuzzyIndent(text, needle, []);
    expect(result).not.toBeNull();
  });
});

// ── findSimilarBlock ────────────────────────────────────────────

describe('findSimilarBlock', () => {
  it('finds block and reports indent difference (needle has MORE)', () => {
    const text = 'def foo():\n    x = 1\n';
    const needle = '    def foo():\n        x = 1';
    const sb = findSimilarBlock(text, needle);
    expect(sb).not.toBeNull();
    expect(sb!.lineNumber).toBe(1);
    // needle base is 4, window base is 0 → diff = -4
    expect(sb!.indentDiff).toBe(-4);
  });

  it('reports positive indentDiff when needle has LESS', () => {
    const text = '    def foo():\n        x = 1\n';
    const needle = 'def foo():\n    x = 1';
    const sb = findSimilarBlock(text, needle);
    expect(sb).not.toBeNull();
    expect(sb!.indentDiff).toBe(4);
  });

  it('returns snippet that matches the file, not the needle', () => {
    const text = 'def foo():\n    x = 1\n';
    const needle = '        def foo():\n            x = 1';
    const sb = findSimilarBlock(text, needle);
    expect(sb!.snippet).toBe('def foo():\n    x = 1');
  });

  it('finds block at non-zero line number', () => {
    const text = 'a = 1\nb = 2\nc = 3\ndef foo():\n    pass\n';
    const needle = '        def foo():\n            pass';
    const sb = findSimilarBlock(text, needle);
    expect(sb).not.toBeNull();
    expect(sb!.lineNumber).toBe(4);
  });

  it('returns null when nothing similar exists', () => {
    const text = 'x = 1\ny = 2\n';
    const needle = 'def totally_different():\n    pass';
    expect(findSimilarBlock(text, needle)).toBeNull();
  });

  it('reports indentDiff = 0 when only trailing whitespace differs', () => {
    // Note: stripTrailTabs normalises trailing whitespace, so this matches.
    const text = 'def f():\n    return 1   \n';
    const needle = 'def f():\n    return 1';
    const sb = findSimilarBlock(text, needle);
    // The window [def f(), return 1   ] normalises both lines;
    // base indent is the same (0), so indentDiff should be 0.
    expect(sb).not.toBeNull();
    expect(sb!.indentDiff).toBe(0);
  });
});

// ── findUnclaimedCanonical ──────────────────────────────────────

import { findUnclaimedCanonical, firstCharDiff } from '../src/match';

describe('findUnclaimedCanonical', () => {
  it('matches em-dash vs hyphen', () => {
    expect(findUnclaimedCanonical('foo - bar', 'foo — bar', [])).toBe(0);
  });

  it('matches en-dash vs hyphen', () => {
    expect(findUnclaimedCanonical('a - b', 'a – b', [])).toBe(0);
  });

  it('matches minus sign vs hyphen', () => {
    expect(findUnclaimedCanonical('x - y', 'x − y', [])).toBe(0);
  });

  it('matches NBSP vs regular space', () => {
    expect(findUnclaimedCanonical('hello world', 'hello\u00A0world', [])).toBe(0);
  });

  it('matches thin space vs regular space', () => {
    expect(findUnclaimedCanonical('a b', 'a\u2009b', [])).toBe(0);
  });

  it('returns -1 when neither side has canonical chars', () => {
    expect(findUnclaimedCanonical('foo bar', 'baz', [])).toBe(-1);
  });

  it('returns -1 when needle not found', () => {
    expect(findUnclaimedCanonical('foo - bar', 'x — y', [])).toBe(-1);
  });

  it('returns -1 when match is ambiguous', () => {
    const text = 'a - b\na – b'; // both canonicalize to "a - b"
    const needle = 'a — b';     // canonicalizes to "a - b"
    expect(findUnclaimedCanonical(text, needle, [])).toBe(-1);
  });

  it('skips claimed range and finds next match', () => {
    const text = 'a - b xx a – b';
    const needle = 'a — b';
    // claimed range covers first match [0,5)
    expect(findUnclaimedCanonical(text, needle, [[0, 5]])).toBe(9);
  });

  it('matches when only NBSP differs in a longer block', () => {
    const text = 'line one\nline two\nline three';
    const needle = 'line\u00A0one\nline two\nline three';
    expect(findUnclaimedCanonical(text, needle, [])).toBe(0);
  });

  it('does not touch EOL differences (that is normalizeEol’s job)', () => {
    // No canonical chars → early exit even though text differs.
    expect(findUnclaimedCanonical('foo\nbar', 'foo\r\nbar', [])).toBe(-1);
  });
});

// ── canonical quotes ────────────────────────────────────────────

describe('findUnclaimedCanonical — quotes', () => {
  it('matches guillemets vs straight quotes', () => {
    expect(findUnclaimedCanonical('say "hi"', 'say «hi»', [])).toBe(0);
  });

  it('matches curly double quotes vs straight', () => {
    const text = 'a "b" c';
    const needle = 'a \u201Cb\u201D c';
    expect(findUnclaimedCanonical(text, needle, [])).toBe(0);
  });

  it('matches curly single quote vs straight apostrophe', () => {
    const text = "don't stop";
    const needle = 'don\u2019t stop';
    expect(findUnclaimedCanonical(text, needle, [])).toBe(0);
  });

  it('matches guillemets inside a longer Russian sentence', () => {
    const text = 'Раздел «Экспорт в Markdown» описан ниже.';
    const needle = 'Раздел "Экспорт в Markdown" описан ниже.';
    expect(findUnclaimedCanonical(text, needle, [])).toBe(0);
  });

  it('does not match when quotes are different but structure also differs', () => {
    expect(findUnclaimedCanonical('a "b" c', 'x «y» z', [])).toBe(-1);
  });
});

// ── firstCharDiff ──────────────────────────────────────────────

describe('firstCharDiff', () => {
  it('finds first differing char in same-line pair', () => {
    const d = firstCharDiff('abc\u2014def', 'abc-def');
    expect(d).not.toBeNull();
    expect(d!.lineNumber).toBe(1);
    expect(d!.colNumber).toBe(4);
    expect(d!.beforeChar).toBe('\u2014');
    expect(d!.beforeCode).toBe('U+2014');
    expect(d!.fileChar).toBe('-');
    expect(d!.fileCode).toBe('U+002D');
  });

  it('finds divergence on a later line', () => {
    const d = firstCharDiff(
      'line one\nline two\nfoo\u00ABbar',
      'line one\nline two\nfoo"bar',
    );
    expect(d).not.toBeNull();
    expect(d!.lineNumber).toBe(3);
    expect(d!.colNumber).toBe(4);
  });

  it('returns null when lengths differ on a line (structural mismatch)', () => {
    expect(firstCharDiff('abc', 'abcd')).toBeNull();
  });

  it('returns null when strings are identical', () => {
    expect(firstCharDiff('same', 'same')).toBeNull();
  });
});
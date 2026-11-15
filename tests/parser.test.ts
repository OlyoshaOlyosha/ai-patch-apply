import { describe, it, expect } from 'vitest';
import { parseClipboard } from '../src/parser';

describe('parseClipboard', () => {
  it('parses a single ordinary change', () => {
    const text = [
      '**Location:** File: `calc/main.py` | Function: `foo`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe('calc/main.py');
    expect(changes[0].func).toBe('foo');
    expect(changes[0].before).toBe('x = 1');
    expect(changes[0].after).toBe('x = 2');
    expect(changes[0].isDelete).toBe(false);
  });

  it('parses a new file with no BEFORE block', () => {
    const text = [
      '**Location:** File: `calc/new.py` | Function: `(new file)`',
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe('calc/new.py');
    expect(changes[0].before).toBe('');
    expect(changes[0].after).toBe('print("hi")');
    expect(changes[0].isDelete).toBe(false);
  });

  it('parses a new file that also contains an AFTER marker (regression)', () => {
    // Some AI outputs put a **AFTER:** header even for new files.
    // We must take the first fenced block, not choke on the marker.
    const text = [
      '**Location:** File: `calc/new.py` | Function: `(new file)`',
      '',
      '**AFTER:**',
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].after).toBe('print("hi")');
  });

  it('parses a delete file', () => {
    const text = [
      '**Location:** File: `calc/old.py` | Function: `(delete file)`',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe('calc/old.py');
    expect(changes[0].isDelete).toBe(true);
    expect(changes[0].before).toBe('');
    expect(changes[0].after).toBe('');
  });

  it('keeps Python comments starting with # in BEFORE (regression)', () => {
    // Previously we dropped any BEFORE containing a line starting with `#`,
    // which broke every Python change that included a comment.
    const text = [
      '**Location:** File: `calc/main.py` | Function: `foo`',
      '',
      '**BEFORE:**',
      '```python',
      '# --- header ---',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      '# --- header ---',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toContain('# --- header ---');
  });

  it('strips filler lines like "# ... existing code ..."', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      '# ... existing code ...',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe('x = 1');
  });

  it('flags BEFORE containing markdown headers as parseError', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      '**Note:** something went wrong',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('markdown');
  });

  it('flags AFTER larger than 20000 chars as parseError', () => {
    const big = 'x'.repeat(20001);
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      'old',
      '```',
      '',
      '**AFTER:**',
      '```python',
      big,
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('too large');
  });

  it('parses multiple changes in one message', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
      '',
      '**Location:** File: `b.py` | Function: `g`',
      '',
      '**BEFORE:**',
      '```python',
      'y = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'y = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(2);
    expect(changes[0].file).toBe('a.py');
    expect(changes[1].file).toBe('b.py');
  });

  it('returns empty array on empty input', () => {
    expect(parseClipboard('')).toEqual([]);
    expect(parseClipboard('   ')).toEqual([]);
  });

  it('ignores garbage between change blocks', () => {
    const text = [
      'Here is some explanation the AI wrote.',
      '',
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
      '',
      'More commentary.',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe('a.py');
  });

  it('works without a Function field', () => {
    const text = [
      '**Location:** File: `a.py`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe('a.py');
    expect(changes[0].func).toBe('');
  });

  it('parses two (new file) blocks in one message', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `(new file)`',
      '',
      '```python',
      'x = 1',
      '```',
      '',
      '**Location:** File: `b.py` | Function: `(new file)`',
      '',
      '```python',
      'y = 1',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(2);
    expect(changes[0].file).toBe('a.py');
    expect(changes[1].file).toBe('b.py');
  });

  it('parses two changes to the same file', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `foo`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
      '',
      '**Location:** File: `a.py` | Function: `bar`',
      '',
      '**BEFORE:**',
      '```python',
      'y = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'y = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(2);
    expect(changes[0].file).toBe('a.py');
    expect(changes[1].file).toBe('a.py');
    expect(changes[0].before).toBe('x = 1');
    expect(changes[1].before).toBe('y = 1');
  });

  it('handles CRLF line endings', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\r\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe('x = 1');
    expect(changes[0].after).toBe('x = 2');
  });

  it('handles fence without language tag', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe('x = 1');
    expect(changes[0].after).toBe('x = 2');
  });

  it('flags BEFORE that is only filler lines as parseError', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      '# ... existing code ...',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('after cleanup');
  });

  it('trims whitespace around the Function value', () => {
    const text = [
      '**Location:** File: `a.py` | Function:    `foo`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].func).toBe('foo');
  });
});

describe('parseClipboard — unsupported markers', () => {
  it('flags (full rewrite) as parseError', () => {
    const text = [
      '**Location:** File: `foo.py` | Function: `(full rewrite)`',
      '',
      '```python',
      'x = 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe('foo.py');
    expect(changes[0].parseError).toContain('unsupported marker');
    expect(changes[0].parseError).toContain('(full rewrite)');
  });

  it('flags (append) as parseError', () => {
    const text = '**Location:** File: `foo.py` | Function: `(append)`';
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('(append)');
  });

  it('flags (insert) as parseError', () => {
    const text = '**Location:** File: `foo.py` | Function: `(insert)`';
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('(insert)');
  });

  it('does not flag (new file)', () => {
    const text = [
      '**Location:** File: `foo.py` | Function: `(new file)`',
      '',
      '```python',
      'x = 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
    expect(changes[0].after).toBe('x = 1');
  });

  it('does not flag (delete file)', () => {
    const text = '**Location:** File: `foo.py` | Function: `(delete file)`';
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
    expect(changes[0].isDelete).toBe(true);
  });

  it('does not flag a real function name', () => {
    const text = [
      '**Location:** File: `foo.py` | Function: `my_func`',
      '',
      '**BEFORE:**',
      '```python',
      'old',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'new',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
  });

  it('marks missing BEFORE as parseError', () => {
    const text = [
      '**Location:** File: `foo.py` | Function: `my_func`',
      '',
      '```python',
      'x = 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('BEFORE');
  });

  it('prefers AFTER marker over first fence for new files', () => {
    // Regression: an illustrative code block before the real content must
    // not become the file body.
    const text = [
      '**Location:** File: `foo.py` | Function: `(new file)`',
      '',
      'Here is an example of what we will write:',
      '',
      '```python',
      '# illustrative only',
      '```',
      '',
      '**AFTER:**',
      '',
      '```python',
      'real_content = 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].after).toContain('real_content');
    expect(changes[0].after).not.toContain('illustrative');
  });
});

describe('parseClipboard — descriptive Function markers', () => {
  it('accepts (imports + helper) when BEFORE is present', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `(imports + helper)`',
      '',
      '**BEFORE:**',
      '```python',
      'import json',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'import json',
      'import math',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
    expect(changes[0].before).toContain('import json');
    expect(changes[0].after).toContain('import math');
  });

  it('accepts (before get_all_tasks) when BEFORE is present', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `(before get_all_tasks)`',
      '',
      '**BEFORE:**',
      '```python',
      'def helper(): pass',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'def helper(): return 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
  });

  it('accepts Cyrillic-in-parens Function when BEFORE is present', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `(раздел «Экспорт»)`',
      '',
      '**BEFORE:**',
      '```python',
      'old',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'new',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
  });

  it('still flags (full rewrite) when BEFORE is absent', () => {
    const text = [
      '**Location:** File: `foo.py` | Function: `(full rewrite)`',
      '',
      '```python',
      'x = 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('unsupported marker');
    expect(changes[0].parseError).toContain('full rewrite');
  });

  it('flags (append) when BEFORE is absent', () => {
    const text = '**Location:** File: `foo.py` | Function: `(append)`';
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('append');
  });

  it('flags (rewrite) when BEFORE is absent', () => {
    const text = '**Location:** File: `foo.py` | Function: `(rewrite)`';
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('rewrite');
  });

  it('treats unknown bracketed Function without BEFORE as missing BEFORE', () => {
    const text = [
      '**Location:** File: `foo.py` | Function: `(strange thing)`',
      '',
      '```python',
      'x = 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('missing BEFORE');
  });
});

describe('parseClipboard — unsupported marker preserves content', () => {
  it('captures AFTER content from (full rewrite)', () => {
    const text = [
      '**Location:** File: `foo.py` | Function: `(full rewrite)`',
      '',
      '**AFTER:**',
      '```python',
      'x = 1',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('unsupported marker');
    expect(changes[0].after).toBe('x = 1');
  });

  it('captures first fence when no AFTER marker for (append)', () => {
    const text = [
      '**Location:** File: `notes.md` | Function: `(append)`',
      '',
      '```markdown',
      'new entry',
      '```',
    ].join('\n');
    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toContain('unsupported marker');
    expect(changes[0].after).toBe('new entry');
  });
});
describe('parseClipboard — fence length handling', () => {
  const MARKDOWN_BODY = [
    '# Example',
    '',
    '```python',
    "print('old')",
    '```',
  ].join('\n');

  it('quadruple fence closes on matching run, not inner triple backticks', () => {
    const text = [
      '**Location:** File: `README.md` | Function: `docs`',
      '',
      '**BEFORE:**',
      '````',
      MARKDOWN_BODY,
      '````',
      '',
      '**AFTER:**',
      '````',
      MARKDOWN_BODY.replace("'old'", "'new'"),
      '````',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
    expect(changes[0].before).toBe(MARKDOWN_BODY);
    expect(changes[0].after).toBe(MARKDOWN_BODY.replace("'old'", "'new'"));
  });

  it('new file body extracted from quadruple fence with inner triple backticks', () => {
    const text = [
      '**Location:** File: `docs/guide.md` | Function: `(new file)`',
      '',
      '````markdown',
      '# Guide',
      '',
      '```python',
      'print(1)',
      '```',
      '````',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].parseError).toBeUndefined();
    expect(changes[0].after).toBe(
      ['# Guide', '', '```python', 'print(1)', '```'].join('\n'),
    );
  });

  it('triple fence still closes on the first triple run', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '```python',
      'x = 1',
      '```',
      '',
      '**AFTER:**',
      '```python',
      'x = 2',
      '```',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe('x = 1');
    expect(changes[0].after).toBe('x = 2');
  });

  it('unterminated quadruple fence is a parse error', () => {
    const text = [
      '**Location:** File: `a.py` | Function: `f`',
      '',
      '**BEFORE:**',
      '````',
      'x = 1',
      '',
      '**AFTER:**',
      '````',
      'x = 2',
      '````',
    ].join('\n');

    const changes = parseClipboard(text);
    expect(changes).toHaveLength(1);
    // The unterminated BEFORE fence swallows the tail up to the AFTER
    // block's opening fence, so the block reports markdown directives —
    // the canonical signal for an unclosed fence.
    expect(changes[0].parseError).toContain('markdown directives');
  });
});

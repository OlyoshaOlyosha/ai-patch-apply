import { describe, it, expect } from 'vitest';
import {
  makePrepareEntry,
  makeSimpleEntry,
  countMatchedVia,
  trimHistory,
  truncateForJournal,
  hasProblems,
  aggregate,
  formatHistory,
  formatTs,
  HistoryEntry,
} from '../src/history';

// Fixed local timestamp so formatTs output is deterministic.
const T = new Date(2026, 10, 15, 14, 3, 22).getTime();

function prepareEntry(overrides: Partial<Parameters<typeof makePrepareEntry>[1]> = {}): HistoryEntry {
  return makePrepareEntry(T, {
    files: 2,
    alreadyApplied: 1,
    atomicRejections: ['a.ts'],
    failures: [
      { file: 'a.ts', reason: 'BEFORE not found in file' },
      { file: 'b.ts', reason: 'BEFORE not found in file' },
    ],
    matchedVia: { exact: 3, fuzzy: 1 },
    ...overrides,
  });
}

describe('formatTs', () => {
  it('formats a local timestamp', () => {
    expect(formatTs(T)).toBe('2026-11-15 14:03:22');
  });
});

describe('countMatchedVia', () => {
  it('tallies strategies and skips undefined', () => {
    expect(
      countMatchedVia([
        { matchedVia: 'exact' },
        { matchedVia: 'fuzzy' },
        { matchedVia: 'exact' },
        {},
        { matchedVia: undefined },
      ]),
    ).toEqual({ exact: 2, fuzzy: 1 });
  });
});

describe('makePrepareEntry', () => {
  it('maps failure count into skipped', () => {
    const e = prepareEntry();
    expect(e.kind).toBe('prepare');
    expect(e.skipped).toBe(2);
    expect(e.files).toBe(2);
    expect(e.atomicRejections).toEqual(['a.ts']);
  });
});

describe('makeSimpleEntry', () => {
  it('leaves prepare-only fields empty', () => {
    const e = makeSimpleEntry(T, 'apply', 3, 1);
    expect(e.kind).toBe('apply');
    expect(e.files).toBe(3);
    expect(e.skipped).toBe(1);
    expect(e.failures).toEqual([]);
    expect(e.matchedVia).toEqual({});
  });
});

describe('trimHistory', () => {
  it('returns the array unchanged under the limit', () => {
    const entries = [prepareEntry(), makeSimpleEntry(T, 'apply', 1, 0)];
    expect(trimHistory(entries, 10)).toBe(entries);
  });

  it('keeps only the newest entries over the limit', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeSimpleEntry(T + i, 'apply', i, 0));
    const trimmed = trimHistory(entries, 3);
    expect(trimmed).toHaveLength(3);
    expect(trimmed.map((e) => e.files)).toEqual([2, 3, 4]);
  });

  it('evicts clean entries before problem ones', () => {
    // 3 clean + 2 problem entries, limit 2 → only the problem ones survive.
    const problem = (offset: number, file: string): HistoryEntry =>
      makePrepareEntry(T + offset, {
        files: 1,
        alreadyApplied: 0,
        atomicRejections: [],
        failures: [{ file, reason: 'r' }],
        matchedVia: {},
      });
    const entries: HistoryEntry[] = [
      makeSimpleEntry(T, 'apply', 1, 0),
      makeSimpleEntry(T + 1, 'apply', 1, 0),
      problem(2, 'a.ts'),
      makeSimpleEntry(T + 3, 'apply', 1, 0),
      problem(4, 'b.ts'),
    ];
    const trimmed = trimHistory(entries, 2);
    expect(trimmed).toHaveLength(2);
    expect(trimmed.every(hasProblems)).toBe(true);
    expect(trimmed.map((e) => e.failures[0].file)).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to oldest-first eviction when everything is a problem', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      prepareEntry({
        files: i,
        alreadyApplied: 0,
        atomicRejections: [],
        failures: [{ file: `f${i}`, reason: 'r' }],
        matchedVia: {},
      }),
    );
    const trimmed = trimHistory(entries, 2);
    expect(trimmed.map((e) => e.files)).toEqual([3, 4]);
  });
});

describe('truncateForJournal', () => {
  it('keeps short fragments as-is', () => {
    expect(truncateForJournal('abc')).toBe('abc');
  });

  it('marks long fragments with the truncated size', () => {
    const long = 'x'.repeat(900);
    const out = truncateForJournal(long)!;
    expect(out.startsWith('x'.repeat(800))).toBe(true);
    expect(out).toContain('+100 chars truncated');
  });

  it('maps empty to undefined', () => {
    expect(truncateForJournal(undefined)).toBeUndefined();
    expect(truncateForJournal('')).toBeUndefined();
  });
});

describe('hasProblems', () => {
  it('flags failures, atomic rejections and stale skips', () => {
    expect(hasProblems(prepareEntry())).toBe(true);
    expect(
      hasProblems(makePrepareEntry(T, { files: 1, alreadyApplied: 0, atomicRejections: [], failures: [], matchedVia: {} })),
    ).toBe(false);
    expect(hasProblems(makeSimpleEntry(T, 'apply', 1, 1))).toBe(true);
    expect(hasProblems(makeSimpleEntry(T, 'apply', 1, 0))).toBe(false);
    expect(hasProblems(makeSimpleEntry(T, 'undo', 1, 0))).toBe(false);
  });
});

describe('aggregate', () => {
  it('sums totals and sorts tallies by count', () => {
    const entries = [
      prepareEntry(),
      makeSimpleEntry(T + 1, 'apply', 2, 0),
      makeSimpleEntry(T + 2, 'undo', 2, 1),
      prepareEntry({
        files: 1,
        alreadyApplied: 0,
        atomicRejections: [],
        failures: [{ file: 'c.ts', reason: 'empty BEFORE fragment' }],
        matchedVia: { exact: 1 },
      }),
    ];
    const a = aggregate(entries);
    expect(a.totalEntries).toBe(4);
    expect(a.prepareRuns).toBe(2);
    expect(a.applyRuns).toBe(1);
    expect(a.undoRuns).toBe(1);
    expect(a.preparedFiles).toBe(3);
    expect(a.appliedFiles).toBe(2);
    expect(a.failedChanges).toBe(3);
    expect(a.alreadyApplied).toBe(1);
    expect(a.atomicRejectedFiles).toBe(1);
    expect(a.byReason).toEqual([
      { reason: 'BEFORE not found in file', count: 2 },
      { reason: 'empty BEFORE fragment', count: 1 },
    ]);
    expect(a.byMatchedVia).toEqual([
      { strategy: 'exact', count: 4 },
      { strategy: 'fuzzy', count: 1 },
    ]);
  });

  it('handles an empty journal', () => {
    const a = aggregate([]);
    expect(a.totalEntries).toBe(0);
    expect(a.byReason).toEqual([]);
    expect(a.byMatchedVia).toEqual([]);
  });
});

describe('formatHistory', () => {
  it('explains itself when the journal is empty', () => {
    const md = formatHistory([]);
    expect(md).toContain('No patch history yet');
  });

  it('includes totals, reasons, strategies and entries', () => {
    const md = formatHistory([prepareEntry(), makeSimpleEntry(T + 1000, 'apply', 2, 0)]);
    expect(md).toContain('2026-11-15 14:03:22');
    expect(md).toContain('## Totals');
    expect(md).toContain('`BEFORE not found in file` — 2');
    expect(md).toContain('`exact` — 3');
    expect(md).toContain('rejected entirely: a.ts');
    expect(md).toContain('matched: exact ×3, fuzzy ×1');
    expect(md).toContain('apply: 2 file(s) applied, 0 skipped');
  });

  it('renders failure fragments and hints', () => {
    const e = makePrepareEntry(T, {
      files: 1,
      alreadyApplied: 0,
      atomicRejections: [],
      failures: [
        {
          file: 'a.ts',
          reason: 'BEFORE not found in file',
          before: 'const x = 1;',
          after: 'const x = 2;',
          similar: 'const x =  1;',
          hint: 'closest block at line 5 (indent differs by 2)',
        },
      ],
      matchedVia: {},
    });
    const md = formatHistory([e]);
    expect(md).toContain('_closest block at line 5 (indent differs by 2)_');
    expect(md).toContain('**BEFORE that did not match**');
    expect(md).toContain('````');
    expect(md).toContain('const x = 1;');
    expect(md).toContain('**Closest block in the file**');
    expect(md).toContain('**Wanted AFTER**');
  });
});

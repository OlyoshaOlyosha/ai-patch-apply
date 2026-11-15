// Pure helpers for the patch-history journal: entries, aggregation and
// Markdown formatting. No `vscode` import — same rule as parser.ts and
// match.ts, so the logic stays unit-testable.
//
// The journal answers "who errored — the AI or the extension": each apply
// attempt is recorded with the canonical failure reasons and with which
// match-strategy step landed the AI's BEFORE blocks. Content itself is
// never stored — only counts, file names and reasons.

export type MatchStrategy =
  | 'exact'
  | 'canonical'
  | 'fuzzy'
  | 'fuzzy-indent'
  | 'new'
  | 'delete';

export type HistoryKind = 'prepare' | 'apply' | 'undo';

export interface FailureRecord {
  file: string;
  /** Canonical English reason, as it appears in the logs and AI report. */
  reason: string;
}

export interface HistoryEntry {
  ts: number;
  kind: HistoryKind;
  /** Prepared files (prepare), applied files (apply) or restored files (undo). */
  files: number;
  /** Failed changes (prepare) or files skipped as stale (apply / undo). */
  skipped: number;
  /** Changes already present in the files (prepare entries only). */
  alreadyApplied: number;
  /** Files rejected entirely by the atomic-rejection rule (prepare only). */
  atomicRejections: string[];
  /** Canonical failure reasons (prepare only). */
  failures: FailureRecord[];
  /** Match-strategy histogram over the prepared changes (prepare only). */
  matchedVia: Partial<Record<MatchStrategy, number>>;
}

/** Journal capacity — older entries are evicted, newest kept. */
export const HISTORY_LIMIT = 200;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local timestamp "YYYY-MM-DD HH:MM:SS" for the history document. */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Tallies a match-strategy histogram from anything carrying `matchedVia`. */
export function countMatchedVia(
  items: ReadonlyArray<{ matchedVia?: MatchStrategy }>,
): Partial<Record<MatchStrategy, number>> {
  const out: Partial<Record<MatchStrategy, number>> = {};
  for (const it of items) {
    if (!it.matchedVia) continue;
    out[it.matchedVia] = (out[it.matchedVia] ?? 0) + 1;
  }
  return out;
}

export function makePrepareEntry(
  ts: number,
  params: {
    files: number;
    alreadyApplied: number;
    atomicRejections: string[];
    failures: FailureRecord[];
    matchedVia: Partial<Record<MatchStrategy, number>>;
  },
): HistoryEntry {
  return {
    ts,
    kind: 'prepare',
    files: params.files,
    skipped: params.failures.length,
    alreadyApplied: params.alreadyApplied,
    atomicRejections: params.atomicRejections,
    failures: params.failures,
    matchedVia: params.matchedVia,
  };
}

export function makeSimpleEntry(
  ts: number,
  kind: 'apply' | 'undo',
  files: number,
  skipped: number,
): HistoryEntry {
  return {
    ts,
    kind,
    files,
    skipped,
    alreadyApplied: 0,
    atomicRejections: [],
    failures: [],
    matchedVia: {},
  };
}

/** Keeps the newest `limit` entries; the input may already be sorted. */
export function trimHistory(
  entries: HistoryEntry[],
  limit: number = HISTORY_LIMIT,
): HistoryEntry[] {
  if (entries.length <= limit) return entries;
  return entries.slice(entries.length - limit);
}

export interface HistoryAggregate {
  totalEntries: number;
  prepareRuns: number;
  applyRuns: number;
  undoRuns: number;
  /** Files prepared across all prepare runs. */
  preparedFiles: number;
  /** Files actually committed (apply runs). */
  appliedFiles: number;
  /** Failed changes across all prepare runs. */
  failedChanges: number;
  /** Changes skipped because they were already in the file. */
  alreadyApplied: number;
  /** Files rejected entirely by the atomic-rejection rule. */
  atomicRejectedFiles: number;
  /** Failure reason → count, sorted by count descending. */
  byReason: Array<{ reason: string; count: number }>;
  /** Match strategy → prepared changes, sorted by count descending. */
  byMatchedVia: Array<{ strategy: string; count: number }>;
}

function tally<T extends string>(
  counts: Map<T, number>,
): Array<{ key: T; count: number }> {
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function aggregate(entries: HistoryEntry[]): HistoryAggregate {
  const byReason = new Map<string, number>();
  const byStrategy = new Map<string, number>();
  const agg: HistoryAggregate = {
    totalEntries: entries.length,
    prepareRuns: 0,
    applyRuns: 0,
    undoRuns: 0,
    preparedFiles: 0,
    appliedFiles: 0,
    failedChanges: 0,
    alreadyApplied: 0,
    atomicRejectedFiles: 0,
    byReason: [],
    byMatchedVia: [],
  };

  for (const e of entries) {
    if (e.kind === 'prepare') {
      agg.prepareRuns++;
      agg.preparedFiles += e.files;
      agg.failedChanges += e.skipped;
      agg.alreadyApplied += e.alreadyApplied;
      agg.atomicRejectedFiles += e.atomicRejections.length;
      for (const f of e.failures) {
        byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
      }
      for (const [s, n] of Object.entries(e.matchedVia)) {
        byStrategy.set(s, (byStrategy.get(s) ?? 0) + (n ?? 0));
      }
    } else if (e.kind === 'apply') {
      agg.applyRuns++;
      agg.appliedFiles += e.files;
    } else {
      agg.undoRuns++;
    }
  }

  agg.byReason = tally(byReason).map(({ key, count }) => ({ reason: key, count }));
  agg.byMatchedVia = tally(byStrategy).map(({ key, count }) => ({
    strategy: key,
    count,
  }));
  return agg;
}

/**
 * Renders the journal as a Markdown document (opened by `Show History`).
 * English on purpose: this is diagnostic data, same audience as the logs
 * and the failed report.
 */
export function formatHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return (
      '# AI Patch Apply — history\n\n' +
      'No patch history yet.\n\n' +
      'Apply a patch (Ctrl+Alt+V) and every attempt — successful or failed — ' +
      'will be recorded here, with the failure reasons and which match ' +
      'strategy landed each edit.\n'
    );
  }

  const a = aggregate(entries);
  const parts: string[] = [];
  parts.push('# AI Patch Apply — history\n');
  parts.push(
    `${a.totalEntries} entries, ` +
      `${formatTs(entries[0].ts)} — ${formatTs(entries[entries.length - 1].ts)}\n`,
  );

  parts.push('## Totals\n');
  parts.push(
    `- Prepare runs: ${a.prepareRuns} — files prepared ${a.preparedFiles}, ` +
      `failed changes ${a.failedChanges}, already applied ${a.alreadyApplied}, ` +
      `files rejected entirely ${a.atomicRejectedFiles}`,
  );
  parts.push(`- Apply runs: ${a.applyRuns} — files applied ${a.appliedFiles}`);
  parts.push(`- Undo runs: ${a.undoRuns}\n`);

  if (a.byReason.length > 0) {
    parts.push('## Failure reasons\n');
    for (const { reason, count } of a.byReason) {
      parts.push(`- \`${reason}\` — ${count}`);
    }
    parts.push('');
  }

  if (a.byMatchedVia.length > 0) {
    parts.push('## Match strategies\n');
    parts.push(
      'How the AI\'s BEFORE blocks were located: `exact` means the AI quoted ' +
        'the file precisely; `canonical`/`fuzzy` mean formatting drifted ' +
        '(punctuation, whitespace, indentation); `new`/`delete` are file-level ' +
        'operations.\n',
    );
    for (const { strategy, count } of a.byMatchedVia) {
      parts.push(`- \`${strategy}\` — ${count}`);
    }
    parts.push('');
  }

  parts.push('## Entries (oldest first)\n');
  for (const e of entries) {
    const line =
      e.kind === 'prepare'
        ? `prepare: ${e.files} file(s) prepared, ${e.skipped} failed, ` +
          `${e.alreadyApplied} already applied`
        : e.kind === 'apply'
          ? `apply: ${e.files} file(s) applied, ${e.skipped} skipped (changed since preview)`
          : `undo: ${e.files} file(s) restored, ${e.skipped} skipped (changed after apply)`;
    parts.push(`- ${formatTs(e.ts)} — ${line}`);
    for (const r of e.atomicRejections) {
      parts.push(`  - rejected entirely: ${r}`);
    }
    for (const f of e.failures) {
      parts.push(`  - ${f.file} — ${f.reason}`);
    }
    const strat = Object.entries(e.matchedVia)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([s, n]) => `${s} ×${n}`);
    if (strat.length > 0) {
      parts.push(`  - matched: ${strat.join(', ')}`);
    }
  }

  return parts.join('\n') + '\n';
}

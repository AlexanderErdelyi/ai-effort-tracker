/**
 * Lines really added and deleted between two document states (#160). Common
 * prefix and suffix lines are ignored and unchanged lines that merely shifted
 * are matched, so a whole-file rewrite that preserves 100 lines and adds one
 * counts as one added line, and an unchanged rewrite counts as nothing.
 */
export function lineDiff(before: string[], after: string[]): { added: number; deleted: number } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let bi = before.length - 1, ai = after.length - 1;
  while (bi >= start && ai >= start && before[bi] === after[ai]) { bi--; ai--; }
  const a = before.slice(start, bi + 1);
  const b = after.slice(start, ai + 1);
  if (a.length === 0 || b.length === 0) return { added: b.length, deleted: a.length };

  // LCS recognizes unchanged lines that merely shifted after an insertion/deletion.
  // Cap quadratic work; large replacement blocks fall back to unique-line matching.
  let retained = 0;
  if (a.length * b.length <= 1_000_000) {
    let prev = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      const cur = new Uint32Array(b.length + 1);
      for (let j = 1; j <= b.length; j++) {
        cur[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    retained = prev[b.length];
  } else {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of b) {
      const n = counts.get(line) ?? 0;
      if (n > 0) { retained++; counts.set(line, n - 1); }
    }
  }
  return { added: b.length - retained, deleted: a.length - retained };
}

/**
 * Count meaningful line versions between two document states: lines really
 * added plus lines really deleted (see {@link lineDiff}).
 */
export function meaningfulLineVersions(before: string[], after: string[]): number {
  const d = lineDiff(before, after);
  return d.added + d.deleted;
}

import type { FileEditStat } from './debugExport';

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' ? v : '';

export function toolResultFailed(result: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (typeof result === 'string') {
    try { return toolResultFailed(JSON.parse(result), depth + 1); } catch {
      return /^(?:error\b|failed\b|patch failed\b|no changes (?:were )?made\b)/i.test(result.trim());
    }
  }
  if (Array.isArray(result)) return result.some(r => toolResultFailed(r, depth + 1));
  if (!object(result)) return false;
  if (result.isError === true || result.success === false || result.error === true ||
      (typeof result.error === 'string' && result.error.trim()) || object(result.error)) return true;
  return ['node', 'children', 'content', 'text', 'result'].some(k =>
    result[k] !== undefined && toolResultFailed(result[k], depth + 1));
}

/** Accept both serialized arguments and the character-indexed legacy export shape. */
export function toolArguments(value: unknown): Record<string, unknown> {
  if (object(value)) {
    const keys = Object.keys(value);
    if (!keys.length || !keys.every(k => /^\d+$/.test(k))) return value;
    value = keys.sort((a, b) => Number(a) - Number(b)).map(k => (value as Record<string, unknown>)[k]).join('');
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return object(parsed) ? parsed : {};
  } catch { return {}; }
}

function lines(value: string): string[] {
  if (!value) return [];
  const result = value.split(/\r\n|\r|\n/);
  if (result[result.length - 1] === '') result.pop();
  return result;
}

/** Exact Myers line diff, with a bounded work budget; null means unknown, not zero. */
export function countLineDiff(before: string, after: string): { added: number; removed: number } | null {
  const a = lines(before), b = lines(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (!n || !m) return { added: m, removed: n };
  const limit = Math.min(n + m, 2000), offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3);
  let work = 0;
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      if (++work > 2_000_000) return null;
      const i = offset + k;
      let x = k === -d || (k !== d && frontier[i - 1] < frontier[i + 1])
        ? frontier[i + 1] : frontier[i - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        if (++work > 2_000_000) return null;
        x++; y++;
      }
      frontier[i] = x;
      if (x >= n && y >= m) return { added: (d + m - n) / 2, removed: (d + n - m) / 2 };
    }
  }
  return null;
}

function stat(path: string, added = 0, removed = 0, created = false): FileEditStat {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return { path, ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : 'unknown',
    added, removed, edits: 1, ...(created ? { created: true } : {}) };
}

function patchImpact(patch: string): { files: FileEditStat[]; diagnostics: string[] } {
  const rows = lines(patch);
  const files: FileEditStat[] = [], diagnostics: string[] = [];
  if (rows[0] !== '*** Begin Patch' || rows[rows.length - 1] !== '*** End Patch') {
    return { files, diagnostics: ['Incomplete or invalid apply_patch payload; edit counts omitted.'] };
  }
  let current: FileEditStat | undefined;
  let mode = '', hunk = false;
  for (const line of rows.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      mode = header[1]; hunk = mode === 'Add';
      current = stat(header[2].trim(), 0, 0, mode === 'Add');
      files.push(current);
      if (mode === 'Delete') diagnostics.push('Deleted file contents unavailable; removed-line count unknown.');
    } else if (current && line.startsWith('*** Move to: ')) {
      current.path = line.slice(13).trim();
      current.ext = stat(current.path).ext;
    } else if (current && mode === 'Update' && line.startsWith('@@')) {
      hunk = true;
    } else if (line === '*** End of File' || line === '\\ No newline at end of file') {
      continue;
    } else if (current && hunk && line.startsWith('+')) {
      current.added++;
    } else if (current && hunk && mode === 'Update' && line.startsWith('-')) {
      current.removed++;
    } else if (current && hunk && line.startsWith(' ')) {
      continue;
    } else {
      return { files: [], diagnostics: ['Invalid apply_patch hunk; edit counts omitted.'] };
    }
  }
  return { files, diagnostics };
}

/** Only counts and paths escape this function; code and tool results are discarded. */
export function toolEditImpact(tool: string, value: unknown): { files: FileEditStat[]; diagnostics: string[] } {
  const args = toolArguments(value);
  if (/(?:^|[.:/])apply_patch$/.test(tool)) return patchImpact(text(args.input) || text(args.patch));
  const files: FileEditStat[] = [], diagnostics: string[] = [];
  if (!/replace|edit|create|new_file|insert/.test(tool.toLowerCase())) return { files, diagnostics };
  const edits = Array.isArray(args.replacements) ? args.replacements
    : Array.isArray(args.edits) ? args.edits : [args];
  for (const edit of edits) {
    if (!object(edit)) continue;
    const path = (text(edit.filePath) || text(edit.file) || text(edit.path)).trim();
    if (!path) continue;
    const created = /create|new_file/.test(tool.toLowerCase());
    if (created || /insert/.test(tool.toLowerCase())) {
      const content = [edit.content, edit.code, edit.newString].find(v => typeof v === 'string');
      if (typeof content === 'string') files.push(stat(path, lines(content).length, 0, created));
    } else if (typeof edit.oldString === 'string' && typeof edit.newString === 'string') {
      const diff = countLineDiff(edit.oldString, edit.newString);
      if (diff) files.push(stat(path, diff.added, diff.removed));
      else diagnostics.push('Replacement diff exceeded work budget; edit counts omitted.');
    }
  }
  return { files, diagnostics };
}

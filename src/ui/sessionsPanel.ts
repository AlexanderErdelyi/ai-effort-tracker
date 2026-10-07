import * as path from 'path';
import * as vscode from 'vscode';
import type { Database } from '../store/database';
import { querySessions, sessionDetail, sessionsCsv, type SessionQuery, type SessionSortKey } from '../analysis/usageInsights';
import { promptExcerpts, SessionTitleResolver } from '../util/sessionTitles';

/** Dashboard "Sessions" tab backend (issue #95). Titles are read on demand and kept in memory only. */

const SORT_KEYS: SessionSortKey[] = ['end', 'start', 'durationMin', 'turns', 'calls', 'credits', 'creditsPerTurn',
  'cacheHitPct', 'maxInputTokens', 'linesChanged', 'avoidableCacheBreaks'];
const DAY = 86_400_000;

let resolver: SessionTitleResolver | undefined;

export function titleResolver(context: vscode.ExtensionContext): SessionTitleResolver {
  const userDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
  return resolver ??= new SessionTitleResolver([path.join(userDir, 'workspaceStorage')]);
}

const showTitles = () => vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('sessions.showTitles', true);

type Msg = Record<string, unknown>;
const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const date = (v: unknown, endOfDay = false) => {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isFinite(t) ? t + (endOfDay && s.length === 10 ? DAY - 1 : 0) : undefined;
};

export function parseSessionQuery(m: Msg): SessionQuery {
  const days = num(m.days);
  const from = date(m.from), to = date(m.to, true);
  const filter: SessionQuery['filter'] = {
    ...(from !== undefined ? { from } : { days: days && days > 0 ? Math.min(days, 3650) : 30 }),
    ...(to !== undefined ? { to } : {}),
    ...(str(m.workItemId) ? { workItemId: str(m.workItemId) } : {}),
    ...(str(m.projectId) ? { projectId: str(m.projectId) } : {}),
    ...(str(m.branch) ? { branch: str(m.branch) } : {})
  };
  const sort = SORT_KEYS.includes(m.sort as SessionSortKey) ? m.sort as SessionSortKey : 'end';
  return {
    filter, sort, descending: m.descending !== false,
    ...(str(m.model) ? { model: str(m.model) } : {}),
    ...(num(m.minCredits) ? { minCredits: num(m.minCredits) } : {}),
    ...(m.lowOutputOnly === true ? { lowOutputOnly: true } : {}),
    offset: Math.max(0, num(m.offset) ?? 0),
    limit: Math.max(10, Math.min(num(m.limit) ?? 50, 200))
  };
}

/** Handle a Sessions-tab webview message; returns false when the message is not ours. */
export async function handleSessionsMessage(m: Msg, db: Database, context: vscode.ExtensionContext,
  post: (msg: unknown) => void): Promise<boolean> {
  if (m.type === 'sessions') {
    try {
      const result = querySessions(db.getUsageData(), parseSessionQuery(m));
      const titles = showTitles() ? titleResolver(context).titlesFor(result.rows.map(r => r.sessionId)) : {};
      post({ type: 'sessionsData', ...result, titles, showTitles: showTitles() });
    } catch (error) {
      post({ type: 'sessionsData', error: `Cannot list sessions: ${String(error)}` });
    }
    return true;
  }
  if (m.type === 'sessionDetail') {
    const id = str(m.sessionId) ?? '';
    const detail = id ? sessionDetail(db.getUsageData(), id) : undefined;
    let prompts: Record<string, string> = {};
    if (detail && showTitles()) {
      const file = titleResolver(context).logFile(id);
      if (file) prompts = Object.fromEntries(promptExcerpts(file, 160));
    }
    post({ type: 'sessionDetailData', sessionId: id, detail: detail ?? null, prompts });
    return true;
  }
  if (m.type === 'sessionsCsv') {
    const q = parseSessionQuery(m);
    const result = querySessions(db.getUsageData(), { ...q, offset: 0, limit: 500 });
    let rows = result.rows;
    for (let offset = 500; offset < result.total; offset += 500) {
      rows = rows.concat(querySessions(db.getUsageData(), { ...q, offset, limit: 500 }).rows);
    }
    const titles = showTitles() ? titleResolver(context).titlesFor(rows.map(r => r.sessionId)) : {};
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`copilot-sessions-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: { CSV: ['csv'] }
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('\ufeff' + sessionsCsv(rows, titles), 'utf8'));
      vscode.window.showInformationMessage(`${rows.length} chat sessions exported to ${uri.fsPath}`);
    }
    return true;
  }
  return false;
}

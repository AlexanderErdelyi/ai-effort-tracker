import * as vscode from 'vscode';
import type { Database } from '../store/database';
import { buildHandoff } from '../analysis/handoff';
import { querySessions } from '../analysis/usageInsights';
import { GitTracker } from '../trackers/gitTracker';
import { promptExcerpts, readChatTitle } from '../util/sessionTitles';
import { titleResolver } from './sessionsPanel';

/**
 * "New Chat with Handoff" (issue #100): build a summary of a (large) chat and
 * open a new chat with it pre-filled, not sent. Prompt excerpts are read from
 * the local debug log on demand and never stored.
 */
export async function newChatWithHandoff(db: Database, context: vscode.ExtensionContext, arg?: unknown): Promise<void> {
  const data = db.getUsageData();
  let sessionId = typeof arg === 'string' && arg ? arg : undefined;
  const resolver = titleResolver(context);
  if (!sessionId) {
    const rows = querySessions(data, { filter: { days: 7 }, sort: 'end', descending: true, offset: 0, limit: 15 }).rows;
    if (!rows.length) {
      vscode.window.showInformationMessage('AI Effort Tracker: no Copilot chat sessions recorded in the last 7 days.');
      return;
    }
    const titles = resolver.titlesFor(rows.map(r => r.sessionId));
    const pick = await vscode.window.showQuickPick(rows.map(r => ({
      label: titles[r.sessionId] ?? r.sessionId.slice(0, 8),
      description: `${r.turns} turns \u00b7 ${Math.round(r.credits)} credits \u00b7 ${Math.round(r.maxInputTokens / 1000)}K context`,
      detail: `Last activity ${r.end.slice(0, 16).replace('T', ' ')}${r.workItems.length ? ' \u00b7 #' + r.workItems.join(', #') : ''}`,
      id: r.sessionId
    })), { placeHolder: 'Hand off which chat to a new chat?' });
    if (!pick) return;
    sessionId = pick.id;
  }

  const includePrompts = vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('handoff.includePrompts') ?? true;
  let first: string | undefined, last: string | undefined, title: string | undefined;
  if (includePrompts) {
    const log = resolver.logFile(sessionId);
    if (log) {
      const excerpts = [...promptExcerpts(log, 400).values()];
      first = excerpts[0];
      last = excerpts[excerpts.length - 1];
    }
    title = resolver.title(sessionId);
  } else {
    const chat = resolver.files(sessionId).chat;
    title = chat ? readChatTitle(chat) : undefined;
  }
  const handoff = buildHandoff(data, {
    sessionId,
    title,
    branch: await GitTracker.getCurrentBranch(),
    commits: await GitTracker.getRecentCommits(5),
    firstPrompt: first,
    lastPrompt: last,
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  });

  await vscode.env.clipboard.writeText(handoff.prompt);
  try {
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: handoff.prompt, isPartialQuery: true });
    vscode.window.showInformationMessage('AI Effort Tracker: handoff prompt is ready in a new chat (also on the clipboard). Finish the last line and send it.');
  } catch {
    vscode.window.showInformationMessage('AI Effort Tracker: handoff prompt copied to the clipboard \u2013 paste it into a new chat.');
  }
}

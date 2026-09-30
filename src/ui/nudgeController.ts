import * as vscode from 'vscode';
import type { Database } from '../store/database';
import {
  DEFAULT_NUDGE_SETTINGS,
  evaluateNudges,
  liveChatLabel,
  liveChatStatus,
  normalizeNudgeState,
  pruneNudgeState,
  type Nudge,
  type NudgeSettings,
  type NudgeState,
  type NudgeType
} from '../analysis/liveNudges';

const STATE_KEY = 'aiEffortTracker.nudgeState';
const LIVE_WINDOW_MS = 30 * 60_000;
const DONT_SHOW = "Don't show again for this chat";
const MUTE = 'Mute this nudge';
const OPEN = 'Open Optimize';

const TYPE_SETTING: Record<NudgeType, string> = {
  'model-switch': 'nudges.modelSwitch',
  'idle-cache': 'nudges.idleCache',
  'context-growth': 'nudges.contextGrowth',
  'light-premium': 'nudges.lightTurns',
  'tool-bloat': 'nudges.toolBloat'
};

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function readNudgeSettings(): NudgeSettings {
  const c = vscode.workspace.getConfiguration('aiEffortTracker');
  const d = DEFAULT_NUDGE_SETTINGS;
  const types = { ...d.types };
  for (const t of Object.keys(types) as NudgeType[]) types[t] = c.get<boolean>(TYPE_SETTING[t]) ?? true;
  return {
    enabled: c.get<boolean>('nudges.enabled') ?? true,
    types,
    contextTokens: positive(c.get('nudges.contextTokens'), d.contextTokens),
    cacheMinTokens: positive(c.get('nudges.cacheMinTokens'), d.cacheMinTokens),
    toolCount: positive(c.get('nudges.toolCount'), d.toolCount),
    lightTurns: Math.max(1, Math.round(positive(c.get('nudges.lightTurnCount'), d.lightTurns))),
    cooldownMinutes: positive(c.get('nudges.cooldownMinutes'), d.cooldownMinutes),
    minGapMinutes: d.minGapMinutes
  };
}

/**
 * Live nudges and running chat cost (issue #93). Evaluated after each debug-log
 * poll that recorded new turns; state (mutes, rate limits, cursors) lives in
 * globalState so it survives reloads without touching the synced store.
 */
export class NudgeController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
  private readonly timer = setInterval(() => this.updateStatus(), 60_000);
  private pending: ReturnType<typeof setTimeout> | undefined;
  private queued = new Set<string>();
  private current: string | undefined;

  constructor(private readonly db: Database, private readonly context: vscode.ExtensionContext) {}

  /** Called after live usage was recorded for these sessions; debounced. */
  onUsage(sessionIds: string[]): void {
    if (!sessionIds.length) return;
    sessionIds.forEach(id => this.queued.add(id));
    this.current = sessionIds[sessionIds.length - 1];
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.pending = undefined; this.evaluate(); }, 1500);
  }

  private state(): NudgeState {
    return normalizeNudgeState(this.context.globalState.get(STATE_KEY));
  }

  private async save(state: NudgeState): Promise<void> {
    await this.context.globalState.update(STATE_KEY, pruneNudgeState(state, Date.now()));
  }

  private evaluate(): void {
    const ids = [...this.queued];
    this.queued.clear();
    try {
      const data = this.db.getUsageData();
      const settings = readNudgeSettings();
      const now = Date.now();
      let state = this.state();
      const shown: Nudge[] = [];
      for (const id of ids) {
        const r = evaluateNudges(data, id, state, settings, now);
        state = r.state;
        if (r.nudge) shown.push(r.nudge);
      }
      void this.save(state);
      for (const n of shown) void this.show(n);
    } catch (error) {
      console.error('AI Effort Tracker: nudge evaluation failed', error);
    }
    this.updateStatus();
  }

  private async show(n: Nudge): Promise<void> {
    const pick = await vscode.window.showInformationMessage(`\u{1F4A1} ${n.title}. ${n.message}`, DONT_SHOW, MUTE, OPEN);
    if (pick === DONT_SHOW || pick === MUTE) {
      const state = this.state();
      if (pick === DONT_SHOW && !state.mutedSessions.includes(n.sessionId)) state.mutedSessions.push(n.sessionId);
      if (pick === MUTE && !state.mutedTypes.includes(n.type)) state.mutedTypes.push(n.type);
      await this.save(state);
      if (pick === MUTE) {
        vscode.window.showInformationMessage(`Nudge muted. Re-enable it with "AI Effort Tracker: Reset Nudge Mutes" or the aiEffortTracker.${TYPE_SETTING[n.type]} setting.`);
      }
    } else if (pick === OPEN) {
      await vscode.commands.executeCommand('aiEffortTracker.openDashboardTab', 'optimize');
    }
  }

  /** Clear every mute and "don't show again" choice. */
  async resetMutes(): Promise<void> {
    const state = this.state();
    state.mutedSessions = [];
    state.mutedTypes = [];
    await this.save(state);
  }

  updateStatus(): void {
    const enabled = vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('nudges.showLiveChatCost') ?? true;
    const chat = enabled && this.current ? liveChatStatus(this.db.getUsageData(), this.current) : null;
    if (!chat || Date.now() - chat.lastAt > LIVE_WINDOW_MS) { this.item.hide(); return; }
    this.item.text = `$(pulse) ${liveChatLabel(chat)}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown('**Current chat (Copilot debug log)**\n\n');
    md.appendMarkdown(`- ${chat.credits} credits over ${chat.turns} turns / ${chat.calls} model calls\n`);
    md.appendMarkdown(`- Recent calls: ${chat.creditsPerCall} credits each on ${chat.model}\n`);
    md.appendMarkdown(`- Context: ${Math.round(chat.contextTokens / 1000)}K tokens, ${chat.cacheHitPct}% from cache\n`);
    md.appendMarkdown(`- Started ${new Date(chat.startedAt).toLocaleTimeString()}\n\nClick to open the Sessions tab.`);
    this.item.tooltip = md;
    this.item.command = { title: 'Open sessions', command: 'aiEffortTracker.openDashboardTab', arguments: ['sessions'] };
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.item.dispose();
  }
}

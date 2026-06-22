import * as https from 'https';
import * as vscode from 'vscode';

export interface CopilotDaySummary {
  date: string;
  totalSuggestionsCount: number;
  totalAcceptancesCount: number;
  totalLinesSuggested: number;
  totalLinesAccepted: number;
  totalActiveUsers: number;
  byLanguage: LanguageBreakdown[];
  // IDE chat / premium requests (Claude, GPT-4, etc.)
  chatTurns: number;
  chatByModel: { model: string; turns: number }[];
}

export interface LanguageBreakdown {
  name: string;
  totalSuggestionsCount: number;
  totalAcceptancesCount: number;
  totalLinesSuggested: number;
  totalLinesAccepted: number;
}

export interface CopilotMetrics {
  days: CopilotDaySummary[];
  fetchedAt: number;
  source: 'org' | 'repo' | 'user';
  scopeName: string;
  error?: string;
  errorDetail?: string;
}

type FetchResult =
  | { ok: true; metrics: CopilotMetrics }
  | { ok: false; status: number; message: string };

export class GitHubService {
  private cache: CopilotMetrics | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  async getCopilotMetrics(forceRefresh = false): Promise<CopilotMetrics | null> {
    if (!forceRefresh && this.cache && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    // 1. Try manual token setting first
    let token = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubToken') ?? '';

    // 2. Fall back to VS Code's built-in GitHub authentication (same account as Copilot)
    if (!token) {
      try {
        const session = await vscode.authentication.getSession(
          'github', ['read:org', 'repo'], { createIfNone: false }
        );
        token = session?.accessToken ?? '';
      } catch { /* auth extension not available */ }
    }

    if (!token) return null;

    let org = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubOrg') ?? '';
    let repo = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubRepo') ?? '';

    // 3. Auto-detect org/repo from workspace git remote if not manually configured
    if (!org && !repo) {
      const detected = await this.detectGitHubRemote();
      if (detected) {
        org = detected.owner;
        repo = `${detected.owner}/${detected.repo}`;
      }
    }

    const since = this.daysAgo(28);
    const until = this.daysAgo(0);
    let result: CopilotMetrics | null = null;
    let lastFail: { status: number; message: string } | null = null;

    if (org && repo) {
      const r = await this.fetchMetrics(
        `/repos/${org}/${repo}/copilot/metrics?since=${since}&until=${until}`,
        token, 'repo', `${org}/${repo}`
      );
      if (r.ok) result = r.metrics; else lastFail = r;
    }
    if (!result && org) {
      const r = await this.fetchMetrics(
        `/orgs/${org}/copilot/metrics?since=${since}&until=${until}`,
        token, 'org', org
      );
      if (r.ok) result = r.metrics; else lastFail = r;
    }

    // Token is set but neither org nor repo was provided
    if (!result && !org && !repo) {
      const isAdo = await this.isAzureDevOpsRemote();
      return {
        days: [], fetchedAt: Date.now(), source: 'user', scopeName: '',
        error: isAdo ? 'needs-scope-ado' : 'needs-scope'
      };
    }

    // Token+scope set but API returned an error — surface the real status/message
    if (!result) {
      return {
        days: [], fetchedAt: Date.now(), source: org ? 'org' : 'repo', scopeName: org || repo,
        error: 'api-error',
        errorDetail: lastFail ? this.explainStatus(lastFail.status, lastFail.message) : undefined
      };
    }
    this.cache = result;
    this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
    return result;
  }

  /** Turn an HTTP status + GitHub message into an actionable explanation. */
  private explainStatus(status: number, message: string): string {
    const base = message ? ` GitHub said: "${message}".` : '';
    switch (status) {
      case 401:
        return `401 Unauthorized — the token is invalid or expired.${base} Generate a new token and paste it into aiEffortTracker.githubToken.`;
      case 403:
        return `403 Forbidden — the token lacks permission, or SSO isn't authorized for this org. For a classic PAT add the manage_billing:copilot scope; for a fine-grained PAT grant the org "GitHub Copilot Business: Read" permission, then authorize the token for the org (SSO).${base}`;
      case 404:
        return `404 Not Found — the org wasn't found, you're not an owner/billing-manager, or the Copilot Metrics API isn't enabled for this org (an org owner must enable the "Copilot Metrics API access" policy in org settings → Copilot).${base}`;
      case 422:
        return `422 — the metrics API needs at least 5 members with active Copilot in the period; smaller orgs return no data.${base}`;
      default:
        return `HTTP ${status}.${base}`;
    }
  }

  private fetchMetrics(
    path: string,
    token: string,
    source: 'org' | 'repo' | 'user',
    scopeName: string
  ): Promise<FetchResult> {
    return new Promise(resolve => {
      const options = {
        hostname: 'api.github.com',
        path,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ai-effort-tracker-vscode'
        }
      };

      const req = https.request(options, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            let message = '';
            try { message = (JSON.parse(body) as { message?: string }).message ?? ''; } catch { /* non-JSON */ }
            resolve({ ok: false, status, message });
            return;
          }
          try {
            const raw: RawMetricsDay[] = JSON.parse(body);
            resolve({
              ok: true,
              metrics: {
                source,
                scopeName,
                fetchedAt: Date.now(),
                days: raw.map(d => this.mapDay(d))
              }
            });
          } catch {
            resolve({ ok: false, status: 200, message: 'Response was not valid JSON.' });
          }
        });
      });
      req.on('error', err => resolve({ ok: false, status: 0, message: err.message }));
      req.end();
    });
  }

  private mapDay(d: RawMetricsDay): CopilotDaySummary {
    // Support both old and new API response shapes
    const editors = d.copilot_ide_code_completions?.editors ?? [];
    let totalSugg = 0, totalAcc = 0, totalLinesSugg = 0, totalLinesAcc = 0;
    const langMap: Record<string, LanguageBreakdown> = {};

    for (const editor of editors) {
      for (const model of (editor.models ?? [])) {
        for (const lang of (model.languages ?? [])) {
          totalSugg += lang.total_code_suggestions ?? 0;
          totalAcc += lang.total_code_acceptances ?? 0;
          totalLinesSugg += lang.total_code_lines_suggested ?? 0;
          totalLinesAcc += lang.total_code_lines_accepted ?? 0;
          const name = lang.name ?? 'unknown';
          if (!langMap[name]) {
            langMap[name] = { name, totalSuggestionsCount: 0, totalAcceptancesCount: 0, totalLinesSuggested: 0, totalLinesAccepted: 0 };
          }
          langMap[name].totalSuggestionsCount += lang.total_code_suggestions ?? 0;
          langMap[name].totalAcceptancesCount += lang.total_code_acceptances ?? 0;
          langMap[name].totalLinesSuggested += lang.total_code_lines_suggested ?? 0;
          langMap[name].totalLinesAccepted += lang.total_code_lines_accepted ?? 0;
        }
      }
    }

    // Extract IDE chat / premium requests per model
    const chatModelMap: Record<string, number> = {};
    let chatTurns = 0;
    for (const editor of (d.copilot_ide_chat?.editors ?? [])) {
      for (const model of (editor.models ?? [])) {
        const turns = model.total_chat_turns ?? 0;
        chatTurns += turns;
        const name = model.name ?? 'unknown';
        chatModelMap[name] = (chatModelMap[name] ?? 0) + turns;
      }
    }
    const chatByModel = Object.entries(chatModelMap)
      .map(([model, turns]) => ({ model, turns }))
      .sort((a, b) => b.turns - a.turns);

    return {
      date: d.date,
      totalSuggestionsCount: d.total_suggestions_count ?? totalSugg,
      totalAcceptancesCount: d.total_acceptances_count ?? totalAcc,
      totalLinesSuggested: d.total_lines_suggested ?? totalLinesSugg,
      totalLinesAccepted: d.total_lines_accepted ?? totalLinesAcc,
      totalActiveUsers: d.total_active_users ?? 0,
      byLanguage: Object.values(langMap).sort((a, b) => b.totalLinesAccepted - a.totalLinesAccepted),
      chatTurns,
      chatByModel
    };
  }

  private async detectGitHubRemote(): Promise<{ owner: string; repo: string } | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return null; }
    const cwd = folders[0].uri.fsPath;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { exec } = require('child_process') as typeof import('child_process');
    return new Promise(resolve => {
      exec('git remote get-url origin', { cwd }, (_err: Error | null, stdout: string) => {
        if (_err || !stdout) { resolve(null); return; }
        const url = stdout.trim();
        const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
        resolve(m ? { owner: m[1], repo: m[2] } : null);
      });
    });
  }

  async isAzureDevOpsRemote(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return false; }
    const cwd = folders[0].uri.fsPath;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { exec } = require('child_process') as typeof import('child_process');
    return new Promise(resolve => {
      exec('git remote get-url origin', { cwd }, (_err: Error | null, stdout: string) => {
        resolve(!_err && /dev\.azure\.com|visualstudio\.com/.test(stdout));
      });
    });
  }

  private daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }
}

// Raw GitHub API response types
interface RawMetricsDay {
  date: string;
  total_suggestions_count?: number;
  total_acceptances_count?: number;
  total_lines_suggested?: number;
  total_lines_accepted?: number;
  total_active_users?: number;
  copilot_ide_code_completions?: {
    editors?: Array<{
      name?: string;
      models?: Array<{
        name?: string;
        languages?: Array<{
          name?: string;
          total_code_suggestions?: number;
          total_code_acceptances?: number;
          total_code_lines_suggested?: number;
          total_code_lines_accepted?: number;
        }>;
      }>;
    }>;
  };
  copilot_ide_chat?: {
    editors?: Array<{
      name?: string;
      models?: Array<{
        name?: string;
        total_chat_turns?: number;
        total_chat_copy_events?: number;
        total_chat_insertion_events?: number;
      }>;
    }>;
  };
}

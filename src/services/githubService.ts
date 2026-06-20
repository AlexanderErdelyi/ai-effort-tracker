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
}

export class GitHubService {
  private cache: CopilotMetrics | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  async getCopilotMetrics(forceRefresh = false): Promise<CopilotMetrics | null> {
    if (!forceRefresh && this.cache && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    const token = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubToken') ?? '';
    if (!token) return null;

    const org = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubOrg') ?? '';
    const repo = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubRepo') ?? '';

    // Try repo-level first, then org-level
    const since = this.daysAgo(28);
    const until = this.daysAgo(0);

    let result: CopilotMetrics | null = null;

    if (org && repo) {
      result = await this.fetchMetrics(
        `/repos/${org}/${repo}/copilot/metrics?since=${since}&until=${until}`,
        token, 'repo', `${org}/${repo}`
      );
    }
    if (!result && org) {
      result = await this.fetchMetrics(
        `/orgs/${org}/copilot/metrics?since=${since}&until=${until}`,
        token, 'org', org
      );
    }

    if (result) {
      this.cache = result;
      this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
    }
    return result;
  }

  private fetchMetrics(
    path: string,
    token: string,
    source: 'org' | 'repo' | 'user',
    scopeName: string
  ): Promise<CopilotMetrics | null> {
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
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            const raw: RawMetricsDay[] = JSON.parse(body);
            resolve({
              source,
              scopeName,
              fetchedAt: Date.now(),
              days: raw.map(d => this.mapDay(d))
            });
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
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

    return {
      date: d.date,
      totalSuggestionsCount: d.total_suggestions_count ?? totalSugg,
      totalAcceptancesCount: d.total_acceptances_count ?? totalAcc,
      totalLinesSuggested: d.total_lines_suggested ?? totalLinesSugg,
      totalLinesAccepted: d.total_lines_accepted ?? totalLinesAcc,
      totalActiveUsers: d.total_active_users ?? 0,
      byLanguage: Object.values(langMap).sort((a, b) => b.totalLinesAccepted - a.totalLinesAccepted)
    };
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
}

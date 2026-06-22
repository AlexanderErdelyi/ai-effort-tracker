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

export interface BillingItem {
  sku: string;
  quantity: number;
  unit: string;
  grossUsd: number;
  netUsd: number;
}

export interface BillingUsage {
  ok: boolean;
  scope: string;
  period: string;
  premiumRequests: number;
  grossUsd: number;
  netUsd: number;
  items: BillingItem[];
  fetchedAt: number;
  error?: 'no-token' | 'http' | 'no-copilot';
  errorDetail?: string;
}

type FetchResult =
  | { ok: true; metrics: CopilotMetrics }
  | { ok: false; status: number; message: string };

export class GitHubService {
  private cache: CopilotMetrics | null = null;
  private cacheExpiresAt = 0;
  private billingCache: BillingUsage | null = null;
  private billingExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /** Resolve a token: manual setting first, then VS Code's GitHub session. */
  private async resolveToken(): Promise<string> {
    let token = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubToken') ?? '';
    if (!token) {
      try {
        const session = await vscode.authentication.getSession(
          'github', ['read:org', 'repo'], { createIfNone: false }
        );
        token = session?.accessToken ?? '';
      } catch { /* auth extension not available */ }
    }
    return token;
  }

  /** Raw authenticated GET returning status + parsed/!parsed body. */
  private apiGet(path: string, token: string): Promise<{ status: number; body: string }> {
    return new Promise(resolve => {
      const req = https.request({
        hostname: 'api.github.com', path, method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ai-effort-tracker-vscode'
        }
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', err => resolve({ status: 0, body: JSON.stringify({ message: err.message }) }));
      req.end();
    });
  }

  /**
   * Pull real Copilot premium-request usage from the enhanced billing API.
   * Personal scope: /users/{login}/settings/billing/usage.
   * Falls back to the configured org if the personal call fails.
   */
  async getBillingUsage(forceRefresh = false): Promise<BillingUsage> {
    if (!forceRefresh && this.billingCache && Date.now() < this.billingExpiresAt) {
      return this.billingCache;
    }
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const fail = (error: BillingUsage['error'], detail?: string): BillingUsage => ({
      ok: false, scope: '', period, premiumRequests: 0, grossUsd: 0, netUsd: 0,
      items: [], fetchedAt: Date.now(), error, errorDetail: detail
    });

    const token = await this.resolveToken();
    if (!token) return fail('no-token');

    // Resolve the authenticated user's login.
    let login = '';
    const me = await this.apiGet('/user', token);
    if (me.status === 200) {
      try { login = (JSON.parse(me.body) as { login?: string }).login ?? ''; } catch { /* ignore */ }
    }

    const org = vscode.workspace.getConfiguration('aiEffortTracker').get<string>('githubOrg') ?? '';
    const attempts: { path: string; scope: string }[] = [];
    if (login) attempts.push({ path: `/users/${login}/settings/billing/usage?year=${year}&month=${month}`, scope: `user:${login}` });
    if (org) attempts.push({ path: `/organizations/${org}/settings/billing/usage?year=${year}&month=${month}`, scope: `org:${org}` });
    if (!attempts.length) return fail('no-token', 'Could not resolve your GitHub login from the token.');

    let lastStatus = 0, lastMsg = '';
    for (const a of attempts) {
      const r = await this.apiGet(a.path, token);
      if (r.status === 200) {
        const usage = this.parseBilling(r.body, a.scope, period);
        if (usage.error === 'no-copilot') { lastStatus = 200; lastMsg = 'no copilot items'; continue; }
        this.billingCache = usage;
        this.billingExpiresAt = Date.now() + this.CACHE_TTL_MS;
        return usage;
      }
      lastStatus = r.status;
      try { lastMsg = (JSON.parse(r.body) as { message?: string }).message ?? ''; } catch { /* ignore */ }
    }
    return fail('http', this.explainBilling(lastStatus, lastMsg));
  }

  private parseBilling(body: string, scope: string, period: string): BillingUsage {
    let items: RawUsageItem[] = [];
    try {
      const parsed = JSON.parse(body) as { usageItems?: RawUsageItem[] };
      items = parsed.usageItems ?? [];
    } catch { /* ignore */ }
    const copilot = items.filter(i => /copilot/i.test(i.product ?? '') || /copilot/i.test(i.sku ?? ''));
    if (!copilot.length) {
      return { ok: false, scope, period, premiumRequests: 0, grossUsd: 0, netUsd: 0, items: [], fetchedAt: Date.now(), error: 'no-copilot' };
    }
    const bySku: Record<string, BillingItem> = {};
    let premiumRequests = 0, grossUsd = 0, netUsd = 0;
    for (const i of copilot) {
      const sku = i.sku ?? i.product ?? 'Copilot';
      if (!bySku[sku]) bySku[sku] = { sku, quantity: 0, unit: i.unitType ?? '', grossUsd: 0, netUsd: 0 };
      bySku[sku].quantity += i.quantity ?? 0;
      bySku[sku].grossUsd += i.grossAmount ?? 0;
      bySku[sku].netUsd += i.netAmount ?? 0;
      grossUsd += i.grossAmount ?? 0;
      netUsd += i.netAmount ?? 0;
      if (/premium|request/i.test(sku)) premiumRequests += i.quantity ?? 0;
    }
    if (premiumRequests === 0) {
      premiumRequests = copilot.reduce((a, i) => a + (i.quantity ?? 0), 0);
    }
    return {
      ok: true, scope, period, premiumRequests,
      grossUsd: +grossUsd.toFixed(2), netUsd: +netUsd.toFixed(2),
      items: Object.values(bySku).sort((a, b) => b.quantity - a.quantity),
      fetchedAt: Date.now()
    };
  }

  private explainBilling(status: number, message: string): string {
    const base = message ? ` GitHub said: "${message}".` : '';
    switch (status) {
      case 401: return `401 Unauthorized — token invalid/expired.${base}`;
      case 403: return `403 Forbidden — the token can't read billing. Use a fine-grained PAT with the "Plan: Read-only" account permission (for org usage: the org's "Administration: Read"), set it as aiEffortTracker.githubToken, and authorize SSO if required.${base}`;
      case 404: return `404 Not Found — the billing usage endpoint isn't available for this account, or the login/org is wrong.${base}`;
      default: return `HTTP ${status}.${base}`;
    }
  }

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
interface RawUsageItem {
  date?: string;
  product?: string;
  sku?: string;
  quantity?: number;
  unitType?: string;
  pricePerUnit?: number;
  grossAmount?: number;
  discountAmount?: number;
  netAmount?: number;
  organizationName?: string;
  repositoryName?: string;
}

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

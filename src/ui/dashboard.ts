import type { BranchSummary, ProjectSummary, WorkItemSummary, LedgerEntry, ManualEffortEntry, ReassignmentRecord } from '../store/database';
import { CATEGORY_LABELS } from '../util/fileTypes';
import type { CopilotMetrics, BillingUsage } from '../services/githubService';
import type { NetLineChange } from '../trackers/gitTracker';
import type { CreditOverview } from '../analysis/creditOverview';
import type { CalendarData } from '../analysis/calendar';
import { DEFAULT_FILTER, type DashboardFilter } from '../analysis/dashboardFilter';

export interface InsightsConfig {
  baselineLocPerMinute: number;
  hourlyRateUsd: number;
  usdPerCredit: number;
  dailyActiveGoalMinutes: number;
}

export interface DashboardAnalytics {
  daily: { date: string; humanCoding: number; aiGenerating: number; reviewing: number; idle: number; linesHuman: number; linesAi: number }[];
  heatmap: number[][];
  focus: {
    sessionsToday: number; sessionsWeek: number;
    totalFocusMsToday: number; totalFocusMsWeek: number;
    longestMs: number; avgMs: number; goalProgressPct: number;
  };
  streak?: { current: number; longest: number };
  week?: { thisWeek: { activeMs: number; lines: number; aiShare: number }; lastWeek: { activeMs: number; lines: number; aiShare: number } };
  todayActiveMs?: number;
  topFiles?: { path: string; human: number; ai: number; edits: number; total: number; aiShare: number; lastTs: number }[];
  timeline?: { humanCoding: number[]; aiGenerating: number[]; reviewing: number[] };
  credits?: CreditOverview;
  calendar?: CalendarData;
}

export function renderDashboardHtml(
  summaries: BranchSummary[],
  currentBranch: string,
  nonce: string,
  ghMetrics: CopilotMetrics | null = null,
  config: InsightsConfig = { baselineLocPerMinute: 5, hourlyRateUsd: 80, usdPerCredit: 0.04, dailyActiveGoalMinutes: 240 },
  analytics: DashboardAnalytics = { daily: [], heatmap: [], focus: { sessionsToday: 0, sessionsWeek: 0, totalFocusMsToday: 0, totalFocusMsWeek: 0, longestMs: 0, avgMs: 0, goalProgressPct: 0 } },
  billing: BillingUsage | null = null,
  projectSummaries: ProjectSummary[] = [],
  workItemSummaries: WorkItemSummary[] = [],
  ledger: LedgerEntry[] = [],
  manualEffort: ManualEffortEntry[] = [],
  reassignments: ReassignmentRecord[] = [],
  netChange: NetLineChange | null = null,
  filter: DashboardFilter = DEFAULT_FILTER
): string {
  const data = JSON.stringify(summaries);
  const gfData = JSON.stringify(filter).replace(/</g, '\\u003c');
  const current = JSON.stringify(currentBranch);
  const catLabels = JSON.stringify(CATEGORY_LABELS);
  const ghData = JSON.stringify(ghMetrics);
  const cfgData = JSON.stringify(config);
  const anData = JSON.stringify(analytics);
  const blData = JSON.stringify(billing);
  const projData = JSON.stringify(projectSummaries);
  const wiData = JSON.stringify(workItemSummaries);
  const ledData = JSON.stringify(ledger).replace(/</g, '\\u003c');
  const meData = JSON.stringify(manualEffort);
  const reData = JSON.stringify(reassignments);
  const netData = JSON.stringify(netChange);

  // CSS and HTML are built with string concatenation to avoid backtick nesting issues.
  const css = `
  :root{--human:#4ec9b0;--ai:#c586c0;--review:#dcdcaa;--idle:#4d4d4d;--cost:#f4a261;--added:#4ec9b0;--deleted:#f47174;
    --muted:var(--vscode-descriptionForeground);--border:var(--vscode-panel-border,rgba(128,128,128,.35));
    --surface:var(--vscode-editor-inactiveSelectionBackground,rgba(128,128,128,.1));--surface-2:rgba(128,128,128,.06);
    --focus:var(--vscode-focusBorder);--good:var(--vscode-charts-green,#89d185);--warn:var(--vscode-editorWarning-foreground,#cca700);
    --bad:var(--vscode-errorForeground,#f48771);--info:var(--vscode-charts-blue,#3794ff);
    --sp1:4px;--sp2:8px;--sp3:12px;--sp4:16px;--sp5:24px;--r-sm:4px;--r:6px;--r-lg:8px;
    --fs-xs:.75em;--fs-sm:.8em;--fs-md:.85em;--fs-lg:1.1em;}
  body.vscode-light{--human:#0f7b6c;--ai:#9b3d97;--review:#8a6d00;--cost:#b35c00;--added:#0f7b6c;--deleted:#c4314b;--idle:#b0b0b0;}
  body.vscode-high-contrast,body.vscode-high-contrast-light{--border:var(--vscode-contrastBorder,#6fc3df);--surface:transparent;--surface-2:transparent;}
  body.vscode-high-contrast-light{--human:#0f7b6c;--ai:#9b3d97;--review:#7a5f00;--cost:#a35200;--added:#0f7b6c;--deleted:#b5200d;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;}
  h1{font-size:1.3em;margin-bottom:4px;}
  .sub{color:var(--muted);font-size:.85em;margin-bottom:20px;}
  .tabs{display:flex;flex-wrap:wrap;gap:0 8px;margin-bottom:20px;border-bottom:1px solid var(--border);}
  .tab{white-space:nowrap;padding:6px 14px;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted);background:none;border-top:none;border-left:none;border-right:none;font-family:inherit;font-size:inherit;}
  .tab.active{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-foreground);}
  .view{display:none;}.view.active{display:block;}
  .cr{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:24px;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;}
  .card h3{font-size:.9em;margin-bottom:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}
  .cw{position:relative;height:200px;}
  .bud{height:6px;background:rgba(128,128,128,.2);border-radius:3px;overflow:hidden;min-width:70px;}
  .budf{height:100%;border-radius:3px;}
  table{width:100%;border-collapse:collapse;font-size:.9em;}
  th{text-align:left;padding:8px 10px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:normal;font-size:.85em;text-transform:uppercase;letter-spacing:.04em;}
  td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle;}
  thead th{position:sticky;top:0;z-index:1;background:var(--vscode-editor-background);}
  th.num,td.num{text-align:right;font-variant-numeric:tabular-nums;}
  tbody tr:nth-child(even)>td{background:var(--surface-2);}
  tbody tr:hover>td{background:var(--vscode-list-hoverBackground);cursor:pointer;}
  tbody tr.cur>td{background:var(--vscode-editor-lineHighlightBackground);}
  tbody tr.empty-row>td,tbody tr.empty-row:hover>td{background:none;cursor:default;color:var(--muted);text-align:center;padding:18px 10px;font-style:italic;}
  .badge{display:inline-block;padding:2px 6px;border-radius:3px;font-size:.8em;}
  .ba{background:rgba(197,134,192,.2);color:var(--ai);}
  .bh{background:rgba(78,201,176,.2);color:var(--human);}
  .bp{background:rgba(78,201,176,.15);color:var(--added);}
  .bd{background:rgba(244,113,116,.15);color:var(--deleted);}
  .mb{display:flex;height:6px;border-radius:3px;overflow:hidden;width:80px;}
  .mb span{display:block;}
  .sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px;}
  .st{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;}
  .st .lbl{font-size:.75em;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;}
  .st.tip{cursor:help;}
  .st .lbl .ti{opacity:.55;text-transform:none;}
  .st .val{font-size:1.4em;font-weight:700;letter-spacing:-.02em;}
  .cf{display:inline-block;margin-left:4px;cursor:help;text-transform:none;font-weight:400;letter-spacing:0;}
  .cf-exact{color:var(--added);}
  .cf-mixed{color:var(--cost);}
  .cf-estimated{color:var(--muted);}
  .cf-manual{color:var(--review);}
  .cfl{font-size:.78em;color:var(--muted);margin:4px 0 12px;}
  .cfl .cf{margin:0 2px 0 0;}
  .ovh{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:16px;}
  .ovt{font-size:1.25em;font-weight:600;}
  .ovb{display:flex;gap:6px;flex-wrap:wrap;}
  .sec{border:1px solid var(--border);border-radius:8px;margin-bottom:16px;background:rgba(128,128,128,.04);overflow:hidden;}
  .sec>summary{list-style:none;cursor:pointer;user-select:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;font-size:.8em;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.08));border-left:3px solid transparent;}
  .sec[open]>summary{border-left-color:var(--vscode-focusBorder);}
  .sec>summary::-webkit-details-marker{display:none;}
  .sec>summary::before{content:'\\25B8';display:inline-block;transition:transform .15s;}
  .sec[open]>summary::before{transform:rotate(90deg);}
  .sec .sm{margin-left:auto;font-weight:normal;text-transform:none;letter-spacing:0;color:var(--muted);}
  .sec>.sb{padding:14px;overflow-x:auto;}
  .sec>.sb>.sg:last-child,.sec>.sb>.cr:last-child{margin-bottom:0;}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px;}
  .kpi{padding:12px 14px;border-radius:8px;background:var(--surface);border:1px solid var(--border);}
  .kl{font-size:.72em;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px;}
  .kv{font-size:1.6em;font-weight:700;letter-spacing:-.02em;line-height:1.15;}
  .kv small{font-size:.5em;font-weight:500;color:var(--muted);margin-left:4px;letter-spacing:0;}
  .ks{font-size:.78em;color:var(--muted);margin-top:3px;}
  .dup{color:var(--cost);}.ddown{color:var(--added);}
  .lnk{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none;}
  .lnk:hover{text-decoration:underline;}
  .bgt{padding:12px 14px;border-radius:8px;border:1px solid var(--border);margin-bottom:14px;}
  .bgt.none{border-style:dashed;color:var(--muted);font-size:.88em;}
  .bgh{display:flex;justify-content:space-between;align-items:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
  .ptrack{height:8px;border-radius:4px;background:rgba(128,128,128,.2);overflow:hidden;position:relative;}
  .pfill{height:100%;border-radius:4px;}
  .pmark{position:absolute;top:0;bottom:0;width:2px;background:var(--vscode-foreground);opacity:.55;}
  .pills{display:inline-flex;gap:2px;background:rgba(128,128,128,.12);border-radius:6px;padding:2px;}
  .pill{border:none;background:none;color:var(--muted);padding:3px 10px;border-radius:4px;cursor:pointer;font:inherit;font-size:.8em;white-space:nowrap;}
  .pill.active{background:var(--vscode-editor-background);color:var(--vscode-foreground);box-shadow:0 1px 2px rgba(0,0,0,.25);}
  .chd{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
  .insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;margin-bottom:14px;}
  .ins{padding:9px 12px;border-radius:6px;background:rgba(128,128,128,.08);border-left:3px solid var(--muted);}
  .ins-warn{border-left-color:var(--vscode-editorWarning-foreground,#cca700);}
  .ins-info{border-left-color:var(--vscode-charts-blue,#3794ff);}
  .ins-good{border-left-color:var(--vscode-charts-green,#89d185);}
  .ins .it{font-weight:600;font-size:.88em;margin-bottom:2px;}
  .ins .ib{font-size:.82em;color:var(--muted);line-height:1.4;}
  .bdg{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;}
  .bdc{padding:12px 14px;border-radius:8px;background:var(--surface);border:1px solid var(--border);min-width:0;}
  .bdc h4{font-size:.72em;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px;font-weight:600;}
  .brow{display:grid;grid-template-columns:minmax(60px,38%) 1fr auto;gap:8px;align-items:center;font-size:.85em;padding:3px 0;}
  .brow .bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .btrack{height:6px;border-radius:3px;background:rgba(128,128,128,.15);overflow:hidden;}
  .bfill{height:100%;border-radius:3px;background:var(--ai);}
  .brow .bv{font-size:.92em;white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums;}
  .back{background:none;border:1px solid var(--border);color:var(--vscode-foreground);padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:.85em;margin-bottom:16px;}
  .back:hover{background:var(--vscode-list-hoverBackground);}
  .ld{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ec9b0;margin-right:6px;animation:pulse 2s infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
  .dtabs{display:flex;gap:6px;margin-bottom:16px;}
  .dtab{padding:4px 12px;cursor:pointer;border:1px solid var(--border);border-radius:4px;background:none;color:var(--muted);font-family:inherit;font-size:.85em;}
  .dtab:hover{color:var(--vscode-foreground);}
  .dtab.active{background:var(--vscode-editor-lineHighlightBackground);color:var(--vscode-foreground);border-color:var(--vscode-focusBorder);}
  .ds{display:none;}.ds.active{display:block;}
  .extb{display:inline-block;padding:1px 5px;border-radius:3px;font-size:.8em;font-family:monospace;background:rgba(128,128,128,.15);margin-right:4px;}
  .dc{font-family:monospace;}
  .rng{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:16px;}
  .rng .dtab{white-space:nowrap;flex:none;}
  .rng label{font-size:.85em;display:inline-flex;gap:4px;align-items:center;white-space:nowrap;}
  .gf{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:-8px 0 16px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:rgba(128,128,128,.05);font-size:.9em;}
  .gf .dtab{white-space:nowrap;flex:none;padding:2px 10px;}
  .gf .gfl{font-weight:600;margin-right:2px;}
  .gf .gfsep{width:1px;align-self:stretch;background:var(--border);margin:0 4px;}
  .gf .gfchip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:.85em;}
  .gf .gfchip button{background:none;border:none;color:inherit;cursor:pointer;padding:0;font-size:1em;}
  .gf .gfnote{flex-basis:100%;font-size:.85em;color:var(--muted);}
  .sesin{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-dropdown-border);padding:2px 6px;}
  select.sesin{max-width:240px;text-overflow:ellipsis;}
  .hm{display:grid;grid-template-columns:auto repeat(24,1fr);gap:2px;font-size:.7em;}
  .calw{overflow-x:auto;padding-bottom:4px;}
  .cal{display:grid;gap:3px;font-size:.68em;min-width:640px;}
  .cal .cml{color:var(--muted);white-space:nowrap;overflow:visible;}
  .cal .cwl{color:var(--muted);padding-right:4px;line-height:1;align-self:center;}
  .cal-c{aspect-ratio:1;border-radius:2px;cursor:pointer;background:rgba(128,128,128,.12);border:1px solid transparent;padding:0;}
  .cal-c.l1{background:color-mix(in srgb,var(--calc) 30%,transparent);}
  .cal-c.l2{background:color-mix(in srgb,var(--calc) 52%,transparent);}
  .cal-c.l3{background:color-mix(in srgb,var(--calc) 75%,transparent);}
  .cal-c.l4{background:var(--calc);}
  .cal-c:hover{border-color:var(--vscode-foreground);}
  .cal-c.sel{border-color:var(--vscode-focusBorder);outline:1px solid var(--vscode-focusBorder);}
  .cal-c:focus-visible{outline:2px solid var(--vscode-focusBorder);}
  body.vscode-high-contrast .cal-c,body.vscode-high-contrast-light .cal-c{border-color:var(--vscode-contrastBorder,#6fc3df);}
  .calk{display:flex;align-items:center;gap:3px;font-size:.75em;color:var(--muted);}
  .calk .cal-c{width:10px;cursor:default;}
  .cald{margin-top:14px;padding-top:12px;border-top:1px solid var(--border);}
  .hm .hc{width:100%;padding-top:100%;border-radius:2px;position:relative;background:rgba(128,128,128,.08);}
  .hm .hl{color:var(--muted);display:flex;align-items:center;justify-content:flex-end;padding-right:6px;}
  .hm .hh{color:var(--muted);text-align:center;font-size:.9em;}
  .ring{position:relative;width:150px;height:150px;margin:0 auto;}
  .ring svg{transform:rotate(-90deg);}
  .ring .rt{position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .ring .rt .rp{font-size:1.6em;font-weight:bold;}
  .ring .rt .rl{font-size:.7em;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}
  .muted{color:var(--muted);}.nw{white-space:nowrap;}.dim{opacity:.72;}.ptr{cursor:pointer;}.w100{width:100%;}.ox{overflow-x:auto;}.ta-r{text-align:right;}
  .t-xs{font-size:var(--fs-xs);}.t-sm{font-size:var(--fs-sm);}.t-md{font-size:var(--fs-md);}
  .mono{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--fs-md);}
  .m0{margin:0;}.my1{margin:var(--sp1) 0;}.my3{margin:var(--sp3) 0;}
  .mt1{margin-top:var(--sp1);}.mt2{margin-top:var(--sp2);}.mt3{margin-top:var(--sp3);}.mt4{margin-top:var(--sp4);}
  .mb2{margin-bottom:var(--sp2);}.mb3{margin-bottom:var(--sp3);}.mb4{margin-bottom:var(--sp4);}
  .c-add{color:var(--added);}.c-del{color:var(--deleted);}.c-ai{color:var(--ai);}.c-human{color:var(--human);}.c-cost{color:var(--cost);}.c-rev{color:var(--review);}
  .hbar{display:flex;justify-content:space-between;align-items:center;gap:var(--sp2);flex-wrap:wrap;}
  .hrow{display:flex;align-items:center;gap:6px;}
  .kvrow{display:flex;justify-content:space-between;gap:var(--sp2);padding:var(--sp2) var(--sp3);background:var(--surface);border-radius:var(--r-sm);}
  .dtab:hover,.back:hover{background:var(--vscode-list-hoverBackground);}
  .dtab:disabled{opacity:.5;cursor:default;}
  .dtab.btn-sm,.btn-sm{padding:1px 8px;}
  .dtab.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent;}
  .dtab.primary:hover{background:var(--vscode-button-hoverBackground);}
  button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:1px solid var(--focus);outline-offset:1px;}
  .b-good{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good);}
  .b-warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn);}
  .b-bad{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad);}
  .b-info{background:color-mix(in srgb,var(--info) 18%,transparent);color:var(--info);}
  .b-muted{background:var(--surface-2);color:var(--muted);}
  .set-row{display:grid;grid-template-columns:minmax(200px,300px) 1fr;gap:var(--sp2) var(--sp4);padding:var(--sp3) 0;border-top:1px solid var(--border);}
  .card>h3+.set-row{border-top:none;padding-top:0;}
  .set-row .sd{font-size:var(--fs-sm);color:var(--muted);margin-top:2px;line-height:1.4;}
  .set-ed{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}
  .set-ed textarea{width:100%;min-height:72px;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--fs-md);}
  .set-rows{display:grid;gap:4px;width:100%;}
  .set-kv input[type=text]{flex:1;min-width:120px;}
  .set-msg:empty{display:none;}
  .set-err{color:var(--bad);font-size:var(--fs-sm);margin-top:4px;}
  .set-ok{color:var(--good);font-size:var(--fs-sm);margin-top:4px;}
  .set-adv>summary{cursor:pointer;color:var(--muted);margin-top:var(--sp3);}
  @media (max-width:700px){.set-row{grid-template-columns:1fr;}}
  body.vscode-high-contrast .badge,body.vscode-high-contrast-light .badge,body.vscode-high-contrast .pill.active,body.vscode-high-contrast-light .pill.active{outline:1px solid var(--border);}
  .tip{cursor:help;}abbr.tip,span.tip{text-decoration:underline dotted;text-underline-offset:2px;}
  .empty{padding:var(--sp5) var(--sp4);text-align:center;border:1px dashed var(--border);border-radius:var(--r-lg);color:var(--muted);}
  .empty .et{font-weight:600;color:var(--vscode-foreground);margin-bottom:var(--sp1);}
  .empty .eh{font-size:var(--fs-md);line-height:1.45;max-width:560px;margin:0 auto;}
  .skel{display:grid;gap:var(--sp2);}
  .skel .sk{height:12px;border-radius:var(--r-sm);background:linear-gradient(90deg,rgba(128,128,128,.10),rgba(128,128,128,.22),rgba(128,128,128,.10));background-size:200% 100%;animation:skel 1.2s ease-in-out infinite;}
  .skel .sk.k{height:54px;}
  .skel .sk:nth-child(5){width:80%;}.skel .sk:nth-child(6){width:60%;}
  .skel .skl{font-size:var(--fs-sm);color:var(--muted);}
  @keyframes skel{0%{background-position:100% 0;}100%{background-position:-100% 0;}}
  @media (prefers-reduced-motion:reduce){.skel .sk,.ld{animation:none;}}`;

  const js = `
const vscode=acquireVsCodeApi();
let allData=${data};
let currentBranch=${current};
const CAT=${catLabels};
let ghMetrics=${ghData};
let CFG=${cfgData};
let AN=${anData};
let BL=${blData};
let PROJ=${projData};
let WI=${wiData};
let LEDGER=${ledData};
let ME=${meData};
let RE=${reData};
let NET=${netData};
let GF=${gfData};
const charts={};

// #146 Global filter bar: one date range + project + work item for every tab.
var GF_NOTE={
  overview:'Credits follow the date range, project and work item. Branch totals follow the project and work item but are all-time; streak and week figures are never filtered.',
  trends:'Follows the date range. Daily activity is not split by project or work item.',
  ledger:'Follows the date range, project and work item.',
  optimize:'Follows the date range, project and work item.',
  sessions:'Follows the date range, project and work item.',
  estimates:'Follows the project and work item. The date range does not apply: accuracy uses every finished item.',
  timesheet:'Follows the project and work item. Use the week buttons for dates.',
  corrections:'Follows the date range, project and work item (episodes without a work item count as \u201cNo project\u201d).'
};
function gfIso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function gfDayOf(ts){var d=new Date(ts);return isNaN(d.getTime())?'':gfIso(d);}
function gfWindow(){
  if(GF.range==='all')return{from:'',to:''};
  if(GF.range==='custom')return{from:GF.from||'',to:GF.to||''};
  if(GF.range==='period'&&AN&&AN.credits&&AN.credits.period)return{from:AN.credits.period.start,to:''};
  var n=parseInt(GF.range,10)||30,d=new Date();d.setDate(d.getDate()-(n-1));return{from:gfIso(d),to:''};
}
function gfInDay(day){var w=gfWindow();return!!day&&(!w.from||day>=w.from)&&(!w.to||day<=w.to);}
function gfInTs(ts){return gfInDay(gfDayOf(ts));}
function gfProjOf(wid){if(!wid)return'';var w=(WI||[]).find(function(x){return String(x.workItemId)===String(wid);});return w&&w.projectId||'';}
function gfScope(pid,wid){
  if(GF.workItemId&&String(wid||'')!==GF.workItemId)return false;
  if(!GF.projectId)return true;
  var p=pid||gfProjOf(wid);
  return GF.projectId==='__none__'?!p:p===GF.projectId;
}
function gfActive(){return GF.range!=='30'||!!GF.projectId||!!GF.workItemId;}
function gfQuery(){var w=gfWindow(),q={};if(w.from)q.from=w.from;else q.days=3650;if(w.to)q.to=w.to;if(GF.projectId)q.projectId=GF.projectId;if(GF.workItemId)q.workItemId=GF.workItemId;return q;}
function gfRangeLabel(){
  var L={'7':'Last 7 days','30':'Last 30 days','90':'Last 90 days','period':'This billing period','all':'All time'};
  if(GF.range!=='custom')return L[GF.range]||GF.range;
  return(GF.from?fday(GF.from,true):'start')+' \\u2013 '+(GF.to?fday(GF.to,true):'today');
}
function gfProjName(id){if(id==='__none__')return'No project';var p=(PROJ||[]).find(function(x){return x.projectId===id;});return p?p.name:id;}
function gfWiName(id){var w=(WI||[]).find(function(x){return String(x.workItemId)===String(id);});return'#'+id+(w&&w.title?' \\u2013 '+w.title:'');}
function gfActiveTab(){var v=document.querySelector('.view.active');return v?v.id:'overview';}
function renderFilterBar(){
  var el=document.getElementById('gf');if(!el)return;
  var tab=gfActiveTab(),note=GF_NOTE[tab];
  if(!note){el.style.display='none';return;}
  el.style.display='';
  var rg=[['7','7d'],['30','30d'],['90','90d'],['period','Period'],['all','All'],['custom','Custom']].map(function(o){return'<button class="dtab'+(GF.range===o[0]?' active':'')+'" data-action="gfRange" data-value="'+o[0]+'">'+o[1]+'</button>';}).join('');
  var cust=GF.range==='custom'?'<label>From <input type="date" id="gfFrom" class="sesin" value="'+esc(GF.from)+'"></label><label>To <input type="date" id="gfTo" class="sesin" value="'+esc(GF.to)+'"></label>':'';
  var po=['<option value="">All projects</option>'].concat((PROJ||[]).map(function(p){return'<option value="'+esc(p.projectId)+'"'+(p.projectId===GF.projectId?' selected':'')+'>'+esc(p.name)+'</option>';}))
    .concat(['<option value="__none__"'+(GF.projectId==='__none__'?' selected':'')+'>No project</option>']).join('');
  var wis=(WI||[]).filter(function(w){var p=w.projectId||'';return!GF.projectId||(GF.projectId==='__none__'?!p:p===GF.projectId)||String(w.workItemId)===GF.workItemId;});
  var wo=['<option value="">All work items</option>'].concat(wis.map(function(w){return'<option value="'+esc(w.workItemId)+'"'+(String(w.workItemId)===GF.workItemId?' selected':'')+'>'+esc(gfWiName(w.workItemId))+'</option>';})).join('');
  var chips=[];
  if(GF.projectId)chips.push('<span class="gfchip">'+esc(gfProjName(GF.projectId))+' <button data-action="gfClear" data-value="projectId" title="Remove">\\u00d7</button></span>');
  if(GF.workItemId)chips.push('<span class="gfchip">'+esc(gfWiName(GF.workItemId))+' <button data-action="gfClear" data-value="workItemId" title="Remove">\\u00d7</button></span>');
  var h='<span class="gfl">\\uD83D\\uDD0E Filter</span>'+rg+cust+'<span class="gfsep"></span>'
    +'<select id="gfProj" class="sesin" title="Project">'+po+'</select><select id="gfWi" class="sesin" title="Work item">'+wo+'</select>'
    +chips.join('')+(gfActive()?'<button class="dtab" data-action="gfClear" data-value="all" title="Back to the last 30 days, all projects">Clear</button>':'')
    +'<span class="gfnote">'+esc(gfRangeLabel())+' \\u00b7 '+esc(note)+'</span>';
  if(el._h===h)return;
  el._h=h;el.innerHTML=h;
  var on=function(id,fn){var x=document.getElementById(id);if(x)x.addEventListener('change',fn);};
  on('gfProj',function(){gfSet({projectId:this.value});});
  on('gfWi',function(){gfSet({workItemId:this.value});});
  on('gfFrom',function(){gfSet({from:this.value});});
  on('gfTo',function(){gfSet({to:this.value});});
}
function gfSet(patch){
  Object.assign(GF,patch);
  if(GF.range==='custom'){
    if(!GF.from&&!GF.to){var d=new Date();GF.to=gfIso(d);d.setDate(d.getDate()-29);GF.from=gfIso(d);}
    if(GF.from&&GF.to&&GF.from>GF.to){var t=GF.from;GF.from=GF.to;GF.to=t;}
  }else{GF.from='';GF.to='';}
  if(patch.projectId!==undefined&&GF.workItemId&&GF.projectId){var p=gfProjOf(GF.workItemId);if(GF.projectId==='__none__'?p:p!==GF.projectId)GF.workItemId='';}
  if(typeof sesQ!=='undefined')sesQ.offset=0;
  vscode.postMessage({type:'filter',filter:GF});
  gfApply();
}
function gfApply(){
  renderFilterBar();
  var tab=gfActiveTab();
  if(tab==='timesheet'){renderTimesheet();return;}
  if(tab==='corrections'){renderCorrections();return;}
  if(GF_NOTE[tab])showTab(tab);
}

const fg=()=>getComputedStyle(document.body).getPropertyValue('--vscode-foreground');
const dfg=()=>getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground');
const gc='rgba(128,128,128,0.15)';

function fmt(ms){const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return h>0?h+'h '+m+'m':m>0?m+'m '+sec+'s':sec+'s';}
function aiPct(d){const h=d.effectiveLinesHuman??d.linesHumanAdded,a=d.effectiveLinesAi??d.linesAiAdded,t=h+a;return t>0?((a/t)*100).toFixed(0):0;}
function tms(d){return d.humanCodingMs+d.aiGeneratingMs+d.reviewingMs;}
function pp(n,c){return n>0?'<span class="badge '+c+'">+'+n+'</span>':'';}
function pm(n){return n>0?'<span class="badge bd">-'+n+'</span>':'';}
function dc(k){if(charts[k]){charts[k].destroy();delete charts[k];}}
function insights(d){
  var activeMs=d.humanCodingMs+d.aiGeneratingMs+d.reviewingMs;
  var activeMin=activeMs/60000;
  var aiNet=d.effectiveLinesAi??d.linesAiAdded??0, humanNet=d.effectiveLinesHuman??d.linesHumanAdded??0;
  var totalNet=aiNet+humanNet;
  var aiShare=totalNet>0?(aiNet/totalNet*100):0;
  var velocity=activeMin>0?(totalNet/activeMin):0;
  var base=CFG.baselineLocPerMinute>0?CFG.baselineLocPerMinute:5;
  var manualEquivMin=totalNet/base;
  var timeSavedMin=manualEquivMin-activeMin;
  var credits=d.creditsTotal||0;
  // Money now comes from the economic model resolved server-side on d.roi
  // (issue #45): project effective rates, ledger cost wins, project currency.
  var R=roiOf(d);
  var aiCost=(R.creditCost!=null)?R.creditCost:null;   // credit spend, nullable
  var savedValue=(R.soldValue!=null)?R.soldValue:null; // value produced via sell rate
  var roi=(R.netValue!=null)?R.netValue:null;          // net ROI, nullable
  var currency=R.currency||'USD';
  // #46: billable ('could-charge') hours decoupled from actual worked hours.
  var actualHours=(typeof R.actualHours==='number')?R.actualHours:null;
  var billableHours=(typeof R.chargeableHours==='number')?R.chargeableHours:null;
  var invoiceValue=(R.invoiceValue!=null)?R.invoiceValue:null;   // billable*sell
  var netGain=(R.netGain!=null)?R.netGain:null;                  // headline AI gain
  var profit=(R.profit!=null)?R.profit:null;                     // needs cost rate
  return {activeMin:activeMin,totalNet:totalNet,aiNet:aiNet,humanNet:humanNet,aiShare:aiShare,velocity:velocity,manualEquivMin:manualEquivMin,timeSavedMin:timeSavedMin,credits:credits,aiCost:aiCost,savedValue:savedValue,roi:roi,currency:currency,actualHours:actualHours,billableHours:billableHours,invoiceValue:invoiceValue,netGain:netGain,profit:profit,chatTurns:d.chatTurnsHuman||0,chatChars:d.chatCharsHuman||0};
}
function fmtMin(m){if(m>=60)return(m/60).toFixed(1)+'h';if(m<=0)return'0m';return m.toFixed(0)+'m';}
function sc(lbl,val,color,tip){return'<div class="st'+(tip?' tip':'')+'"'+(tip?' title="'+esc(tip)+'"':'')+'><div class="lbl">'+lbl+(tip?' <span class="ti">\\u24D8</span>':'')+'</div><div class="val" style="color:'+(color||'inherit')+'">'+val+'</div></div>';}
function tH(x){return x==null?'\\u2014':(Math.round(x*100)/100)+'h';}
// Data confidence markers (issue #143). Levels and splits are computed in
// analysis/confidence.ts; these only render them.
var CF_SYM={exact:'\\u25CF',mixed:'\\u25D0',estimated:'\\u25CB',manual:'\\u270E'};
var CF_NAME={exact:'Exact',mixed:'Mixed',estimated:'Estimated',manual:'Manual'};
var CF_HINT={exact:'measured',mixed:'part measured, part estimated or entered by hand',estimated:'estimated, not measured',manual:'entered or corrected by hand'};
function cfVal(v,unit){if(unit==='ms')return fmt(v);if(unit==='credits')return cr(v)+' credits';return Math.round(v).toLocaleString()+' lines';}
function cfTip(c,what,unit){
  var t=what+': '+CF_NAME[c.level]+' ('+CF_HINT[c.level]+')';
  if(c.inputs&&c.inputs.length)t+='\\nBased on: '+c.inputs.map(function(i){return i.label+' '+CF_NAME[i.level].toLowerCase();}).join(', ');
  (c.parts||[]).forEach(function(p){t+='\\n\\u2022 '+p.label+': '+cfVal(p.value,unit)+(c.total>0?' ('+Math.round(p.value/c.total*100)+'%)':'');});
  if(c.note)t+='\\n'+c.note;
  return t;
}
function confBadge(c,what,unit){if(!c||!c.level||c.level==='none')return'';return'<span class="cf cf-'+c.level+'" title="'+esc(cfTip(c,what,unit))+'">'+CF_SYM[c.level]+'</span>';}
function cfLegend(){return'<div class="cfl">'+['exact','mixed','estimated','manual'].map(function(k){return'<span class="cf cf-'+k+'">'+CF_SYM[k]+'</span>'+CF_NAME[k].toLowerCase();}).join(' \\u00b7 ')+' \\u2014 hover a marker to see how the number was captured</div>';}
// Mirrors creditKind() in analysis/confidence.ts for single ledger rows.
function cfKind(e){var d=e.debugUsage;if(e.source==='manual'||(d&&d.creditsOverridden))return'manual';if(e.exact===true)return'exact';if(d)return(d.unpricedRequests>0||d.logWarnings>0)?'partial':'exact';return'estimated';}
var CF_ROW={exact:['exact','Exact: the real per-request charge'],partial:['estimated','Partial: some model calls had no charge, so this is a lower bound'],estimated:['estimated','Estimated from token counts and model rates'],manual:['manual','Entered or adjusted by hand']};
function cfRowBadge(e){var r=CF_ROW[cfKind(e)];return'<span class="cf cf-'+r[0]+'" title="'+esc(r[1])+'">'+CF_SYM[r[0]]+'</span>';}
function tR(v,cur){return v==null?'not set':fmtMoney(v,cur)+'/h';}
var RATES_HINT='Rates come from the project (\\u270E Edit Rates).';
function aiSpendTip(R,credits,cur){
  if(R.creditCost==null)return'Money spent on Copilot credits. Needs a credit price: set it with Edit Rates on the project.';
  var derived=R.creditCostPerUnit!=null&&Math.abs(credits*R.creditCostPerUnit-R.creditCost)<0.005;
  return'Money spent on Copilot credits.\\n'+(derived
    ?'= '+credits.toFixed(1)+' credits \\u00d7 '+fmtMoney(R.creditCostPerUnit,cur,4)+' per credit = '+fmtMoney(R.creditCost,cur)
    :'= the cost recorded on the credit ledger entries: '+fmtMoney(R.creditCost,cur));
}
// #130 correction rate: corrected AI lines per 100 AI lines written, shown as a percentage.
function rpct(v){return v==null?'\\u2014':(Math.round(v*10)/10)+'%';}
function rateDelta(cur,prev){
  if(cur==null||prev==null||!(prev>0))return'';
  var d=(cur-prev)/prev*100;if(Math.abs(d)<1)return'= vs before';
  return'<span class="'+(d>0?'dup':'ddown')+'">'+(d>0?'\\u25B2':'\\u25BC')+' '+Math.abs(d).toFixed(0)+'%</span> vs before';
}
var TREND_ICON={up:['\\u25B2','var(--deleted)','More corrections than before'],down:['\\u25BC','var(--added)','Fewer corrections than before'],flat:['=','var(--muted)','About the same'],'new':['new','var(--deleted)','Not corrected in the weeks before'],gone:['\\u2714','var(--added)','Not corrected any more in the recent weeks']};
function trendHtml(t){var x=TREND_ICON[t]||TREND_ICON.flat;return'<span style="color:'+x[1]+'" title="'+x[2]+'">'+x[0]+'</span>';}
function reworkStat(w,I){
  var rw=w.rework;if(!rw||!rw.episodes)return'';
  var R=roiOf(w),rate=R.hourlyCostRate!=null?R.hourlyCostRate:R.hourlySellRate,h=rw.ms/3600000;
  var cost=rate!=null?h*rate:null;
  var tip='Estimated time spent fixing AI-written code on this work item: '+rw.episodes+' correction episode'+(rw.episodes===1?'':'s')+' ('+rw.corrections+' changes, '+rw.correctedLines+' AI lines).'
    +'\\nEach episode counts from the rework prompt (or first edit) to the last edit, at least 1 and at most 30 minutes.'
    +(cost==null?'\\nSet the project\\u2019s hourly cost or sell rate to see the cost. '+RATES_HINT:'\\n= '+tH(h)+' \\u00d7 '+tR(rate,I.currency)+(R.hourlyCostRate!=null?' (cost rate)':' (sell rate)')+' = '+fmtMoney(cost,I.currency))
    +(rw.rate!=null?'\\nCorrection rate: '+rpct(rw.rate)+' of the '+rw.aiLines+' AI lines written since correction capture started.':'')
    +'\\nRequirement changes and progress updates do not count.';
  return sc('Rework',fmt(rw.ms)+(cost==null?'':' <span style="font-size:.7em;color:var(--muted)">'+fmtMoney(cost,I.currency)+'</span>'),'var(--deleted)',tip);
}
function wiTips(w,I){
  var R=roiOf(w),cur=I.currency,m=function(v){return fmtMoney(v,cur);};
  var G=w.generated||{},A=R.actualHours,B=R.chargeableHours,sell=R.hourlySellRate,cost=R.hourlyCostRate,credit=R.creditCost||0;
  var lines=I.totalNet,base=CFG.baselineLocPerMinute>0?CFG.baselineLocPerMinute:5;
  var gen=(typeof G.equivalentHours==='number')?G.equivalentHours:null;
  var man=w.manual||{};var manMs=(man.humanCodingMs||0)+(man.aiGeneratingMs||0)+(man.reviewingMs||0);
  var genLine=lines+' effective changed lines \\u00f7 '+base+' lines/min \\u00f7 60 = '+tH(gen);
  var src=w.billableSource==='set'?'You set them with \\uD83D\\uDCB5 Set Billable Hours.'
    :w.billableSource==='estimate'?'Taken from the estimate, because no billable hours are set. Change them with \\uD83D\\uDCB5 Set Billable Hours, or use \\u26A1 Use as Billable Hours to take the generated hours.'
    :'Taken from the actual hours, because there is no hour estimate and no billable hours are set.';
  return{
    estimate:'Your estimate for this work item (the sum of its category breakdown when you split it). Click \\u270E to change it.',
    actual:'Active time on all branches of this work item: coding, Copilot generating and reviewing, plus manual effort and time-log entries. Idle time does not count.\\nAuto-tracked '+fmt(Math.max(0,activeMsOf(w)-manMs))+' + manual '+fmt(manMs)+'.',
    netGain:sell==null?'What AI earned you. Needs the project\\u2019s sell rate. '+RATES_HINT
      :'What AI earned you: what you can bill, minus what the hours you really worked are worth, minus the AI cost.\\n= invoice '+m(I.invoiceValue)+' \\u2212 '+tH(A)+' \\u00d7 '+tR(sell,cur)+' \\u2212 AI '+m(credit)+'\\n= '+m(I.netGain)+'\\nPositive means you deliver more than the time you spent.',
    invoice:sell==null?'Billable hours \\u00d7 sell rate. Needs the project\\u2019s sell rate. '+RATES_HINT
      :'What you can bill: billable hours \\u00d7 sell rate.\\n= '+tH(B)+' \\u00d7 '+tR(sell,cur)+' = '+m(I.invoiceValue),
    profit:(sell==null||cost==null)?'Invoice value minus your internal cost. Needs the project\\u2019s sell rate and hourly cost rate. '+RATES_HINT
      :'Invoice value minus your internal cost (your hours at the cost rate, plus AI).\\n= '+m(I.invoiceValue)+' \\u2212 '+tH(A)+' \\u00d7 '+tR(cost,cur)+' \\u2212 AI '+m(credit)+'\\n= '+m(I.profit),
    actualHrs:'Hours you actually worked (same as Actual): '+tH(A)+'.'+(gen==null?'':'\\n\\u2248 '+tH(gen)+' generated: how long the same output would take by hand.\\n'+genLine+' (setting aiEffortTracker.baselineLocPerMinute).'),
    billable:'Hours you can bill for this work item: '+tH(B)+'.\\n'+src+'\\nThey drive Invoice value, Net ROI and Profit.',
    generated:G.generatedValue==null?'Generated hours \\u00d7 sell rate. Needs the project\\u2019s sell rate. '+RATES_HINT
      :'What the produced lines are worth: generated hours \\u00d7 sell rate.\\n'+genLine+'\\n= '+tH(gen)+' \\u00d7 '+tR(sell,cur)+' = '+m(G.generatedValue)+'\\nCompare it with Invoice value to see if your estimate covers what was produced.',
    aiShare:'Share of effective changed lines written by Copilot.\\n= '+I.aiNet+' AI \\u00f7 '+lines+' total. Human: '+I.humanNet+'.',
    credits:'Copilot credits (premium requests) used for this work item, summed over all its branches and the entries you logged.',
    aiSpend:aiSpendTip(R,I.credits,cur),
    timeSaved:'Generated hours minus actual hours: how much longer the same output would take by hand.\\n= '+fmtMin(I.manualEquivMin)+' \\u2212 '+fmtMin(I.activeMin)+' = '+fmtMin(I.timeSavedMin)+'\\nBased on '+base+' lines/min (aiEffortTracker.baselineLocPerMinute).',
    auto:'Time recorded automatically while you coded, Copilot generated code, or you reviewed.',
    manual:'Time you added yourself with \\uFF0B Add Effort.',
    manLines:'Lines you added yourself with \\uFF0B Add Effort (human and AI).',
    manEntries:'Number of \\uFF0B Add Effort entries.'
  };
}
function budgetTip(k,d,b,R,cur){
  var m=function(v){return fmtMoney(v,cur);};
  var head=budVal(k,d.used,cur)+' used of '+budVal(k,d.budget,cur)+' = '+d.pct+'%.\\n';
  if(k==='time')return head+'Actual hours on all branches, manual effort and time-log entries, against the hour estimate.';
  if(k==='credits')return head+'Credits used, against '+(d.source==='explicit'?'the credit budget you set with Set Budget.':'estimate \\u00d7 credits per estimated hour (project setting or aiEffortTracker.budget.creditsPerEstimatedHour).');
  var used='Used = your hours \\u00d7 cost rate + AI spend\\n= '+tH(R.actualHours)+' \\u00d7 '+tR(R.hourlyCostRate,cur)+(R.laborCost!=null?' ('+m(R.laborCost)+')':'')+' + AI '+m(R.creditCost||0)+' = '+m(d.used);
  if(d.source==='explicit')return head+'Budget: the money budget you set with Set Budget.\\n'+used;
  var est=b.dims.time?b.dims.time.budget:null;
  var cb=b.dims.credits;
  var budget='Budget = estimate \\u00d7 cost rate'+(cb&&R.creditCostPerUnit?' + credit budget \\u00d7 credit price':'')+'\\n= '+tH(est)+' \\u00d7 '+tR(R.hourlyCostRate,cur)
    +(cb&&R.creditCostPerUnit?' + '+budVal('credits',cb.budget)+' \\u00d7 '+fmtMoney(R.creditCostPerUnit,cur,4):'')+' = '+m(d.budget);
  var note=(cb&&R.creditCostPerUnit)?'':'\\nAI credits are not part of this budget because there is no credit budget, but AI spend counts as used. Set a credit or money budget with Set Budget to plan for AI.';
  return head+budget+'\\n'+used+note;
}
function emptyState(title,hint){return'<div class="empty" role="status"><div class="et">'+title+'</div>'+(hint?'<div class="eh">'+hint+'</div>':'')+'</div>';}
function loadingState(label){return'<div class="skel" role="status" aria-busy="true"><div class="skl">'+(label||'Loading\\u2026')+'</div><div class="sk k"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>';}
function isNumText(x){if(/\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}/.test(x))return false;x=x.replace(/(\\d)\\s*(h|m|min|k|cr|credits?|lines?|pts|SP|x)\\b/g,'$1').replace(/\\b[A-Z]{3}\\b/g,'');return /^[^A-Za-z]*\\d[^A-Za-z]*$/.test(x);}
function alignNums(){document.querySelectorAll('table:not([data-al])').forEach(function(tb){tb.setAttribute('data-al','1');var body=tb.tBodies[0];if(!body)return;var rows=Array.prototype.slice.call(body.rows),head=tb.tHead&&tb.tHead.rows[0],n=head?head.cells.length:(rows[0]?rows[0].cells.length:0);if(!n)return;rows=rows.filter(function(r){return r.cells.length===n;});for(var c=0;c<n;c++){var num=0,bad=0;rows.forEach(function(r){var x=(r.cells[c].textContent||'').trim();if(!x||x==='\\u2014'||x==='\\u2013'||x==='-'||x==='\\u2212')return;if(isNumText(x))num++;else bad++;});if(num&&!bad){if(head&&head.cells[c])head.cells[c].classList.add('num');rows.forEach(function(r){r.cells[c].classList.add('num');});}}});}
var alignQueued=false;if(typeof MutationObserver!=='undefined')new MutationObserver(function(){if(alignQueued)return;alignQueued=true;requestAnimationFrame(function(){alignQueued=false;alignNums();});}).observe(document.body,{childList:true,subtree:true});
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function activeMsOf(x){return(x.humanCodingMs||0)+(x.aiGeneratingMs||0)+(x.reviewingMs||0);}
function reviewCardHtml(w){
  var r=w&&w.review;if(!r)return'';
  var col=r.complete?'var(--added)':r.openIssues?'var(--deleted)':'var(--cost)';
  var files=(r.filesLeft||[]).map(function(f){return'<tr><td>'+esc(f.path)+'</td><td>'+(f.total-f.unreviewed)+'/'+f.total+'</td><td>'+f.unreviewed+' left</td></tr>';}).join('');
  var issues=(r.issues||[]).map(function(i){return'<tr><td class="c-del">\\u2691 '+esc(i.note||'Issue')+'</td><td>'+esc(i.path)+':'+i.line+'</td><td>'+esc(i.branch)+'</td></tr>';}).join('');
  var branches=(r.branches||[]).length>1?'<p class="mt2 t-sm muted">'+r.branches.map(function(b){return esc(b.branch)+': '+b.reviewed+'/'+b.total;}).join(' \\u00b7 ')+'</p>':'';
  return'<div class="mt3 card"><div class="hbar"><h3>\\uD83D\\uDD0D Code review</h3><button class="dtab" data-action="cmd" data-value="review.showProgress">Open Review view</button></div>'
    +'<div class="mt2 sg">'+sc('Reviewed',r.pct+'%',col)+sc('Lines reviewed',r.reviewed+' / '+r.total)+sc('Left to review',String(r.unreviewed),r.unreviewed?'var(--cost)':'var(--added)')+sc('Open issues',String(r.openIssues),r.openIssues?'var(--deleted)':'inherit')+'</div>'
    +(r.complete?'<p class="mt2 c-add">\\u2713 Every changed line on the branches of this work item is reviewed and no issues are open.</p>':'')
    +(issues?'<table class="mt2"><thead><tr><th>Open issue</th><th>Where</th><th>Branch</th></tr></thead><tbody>'+issues+'</tbody></table>':'')
    +(files?'<table class="mt2"><thead><tr><th>File</th><th>Reviewed</th><th></th></tr></thead><tbody>'+files+'</tbody></table>':'')
    +branches
    +'<p class="mt2 t-sm muted">Changed lines since the merge-base, as last evaluated '+(r.asOf?esc(new Date(r.asOf).toLocaleString()):'')+' when each branch was checked out. Mark lines with the CodeLens or editor context menu (\\u201cMark Selection Reviewed\\u201d / \\u201cFlag Issue\\u201d).</p></div>';
}
function translationSummaryHtml(x){
  var t=x&&x.effectiveByCategory&&x.effectiveByCategory.translation;
  if(!t||!(t.human+t.ai))return'';
  return'<div class="my3 card"><h3>Translations (separate)</h3><div class="sg">'
    +sc('Translation effective lines',String(t.human+t.ai))
    +sc('Human',String(t.human),'var(--human)')+sc('AI',String(t.ai),'var(--ai)')
    +'</div><p class="mt2 t-md muted">Excluded from productivity effective lines, velocity, manual-equivalent time and generated value. Tracked time and credit costs remain included. Translation line counts are not translated-word counts.</p></div>';
}

function billingHtml(){
  var imp='<button class="mt3 dtab" data-action="cmd" data-value="importCredits">\\u21bb Import / refresh usage</button>';
  if(!BL){
    return'<div class="mt4 card"><h3>\\uD83D\\uDCB3 Copilot Premium Requests &mdash; real usage</h3><p class="mt2 muted">Pull your real billed premium-request usage from GitHub\\u2019s billing API.</p>'+imp+'</div>';
  }
  if(!BL.ok){
    var msg=BL.error==='no-token'?'No GitHub token \\u2014 set one in <button class="dtab btn-sm" data-action="tab" data-value="settings">\u2699 Settings \u2192 Integrations</button> (fine-grained PAT with <strong>Plan: Read-only</strong>) or sign in to GitHub.':BL.error==='no-copilot'?'No Copilot premium-request usage found for '+BL.period+' yet.':(BL.errorDetail||'Could not load billing usage.');
    return'<div class="mt4 card"><h3>\\uD83D\\uDCB3 Copilot Premium Requests &mdash; real usage</h3><p class="mt2 muted">'+msg+'</p>'+imp+'</div>';
  }
  var rows=(BL.items||[]).map(function(i){return'<tr><td>'+i.sku+'</td><td>'+i.quantity.toLocaleString()+(i.unit?' '+i.unit:'')+'</td><td>$'+i.grossUsd.toFixed(2)+'</td><td>$'+i.netUsd.toFixed(2)+'</td></tr>';}).join('')||'<tr class="empty-row"><td colspan="4">No line items</td></tr>';
  return'<div class="mt4 card"><h3>\\uD83D\\uDCB3 Copilot Premium Requests &mdash; real usage ('+BL.period+' \\u00b7 '+BL.scope+')</h3>'
    +'<div class="sg" style="grid-template-columns:repeat(3,1fr);margin-top:8px">'
    +'<div class="st"><div class="lbl">Premium Requests</div><div class="c-ai val">'+BL.premiumRequests.toLocaleString()+'</div></div>'
    +'<div class="st"><div class="lbl">Gross</div><div class="val">$'+BL.grossUsd.toFixed(2)+'</div></div>'
    +'<div class="st"><div class="lbl">Net (billed)</div><div class="c-cost val">$'+BL.netUsd.toFixed(2)+'</div></div>'
    +'</div>'
    +'<table class="mt2"><thead><tr><th>SKU</th><th>Quantity</th><th>Gross</th><th>Net</th></tr></thead><tbody>'+rows+'</tbody></table>'
    +'<p class="mt2 t-sm muted">Net = amount billed beyond your included allowance. This is GitHub\\u2019s authoritative usage, unlike the heuristic estimates on the Overview tab.</p>'+imp+'</div>';
}
function renderGhMetrics(){
  const el=document.getElementById('ghview');
  var bh=billingHtml();
  if(!ghMetrics){
    el.innerHTML=bh+'<div class="mt4 card"><h3>GitHub Copilot Metrics API</h3><p class="muted mt2">Configure your GitHub token in settings to load official Copilot metrics.</p><p class="mt2 t-md muted">Set a token in <button class="dtab btn-sm" data-action="tab" data-value="settings">\u2699 Settings \u2192 Integrations</button> (needs <code>manage_billing:copilot</code> scope); it is kept in secure storage.</p></div>';
    return;
  }
  if(ghMetrics.error==='needs-scope-ado'){
    el.innerHTML=bh+'<div class="mt4 card"><h3>GitHub Copilot Metrics API</h3>'
      +'<p class="mt2">&#x2705; Signed in &nbsp;|&nbsp; &#x1F4E6; Azure DevOps repo detected</p>'
      +'<p style="margin-top:10px;font-size:.9em;color:var(--muted)">Copilot metrics live on <strong>GitHub</strong>, not Azure DevOps. Set your <strong>GitHub org name</strong> in settings:</p>'
      +'<p style="margin-top:8px;font-family:monospace;font-size:.9em">aiEffortTracker.githubOrg = <em>your-github-org</em></p>'
      +'<p class="mt2 t-md muted">(This is the GitHub organisation where your Copilot licences are managed &mdash; not your Azure DevOps org.)</p></div>';
    return;
  }
  if(ghMetrics.error==='needs-scope'){
    el.innerHTML=bh+'<div class="mt4 card"><h3>GitHub Copilot Metrics API</h3><p class="mt2">&#x2705; Signed in to GitHub! Could not detect a GitHub remote in the current workspace.</p><p style="margin-top:10px;font-size:.9em;color:var(--muted)">Open a GitHub repository in VS Code, or manually set <code>aiEffortTracker.githubOrg</code> or <code>aiEffortTracker.githubRepo</code> in settings.</p></div>';
    return;
  }
  if(ghMetrics.error==='api-error'){
    var detail=ghMetrics.errorDetail?'<p style="margin-top:10px;padding:10px;background:rgba(244,113,116,.1);border-left:3px solid var(--deleted);border-radius:4px;font-size:.85em;line-height:1.5">'+ghMetrics.errorDetail+'</p>':'';
    el.innerHTML=bh+'<div class="mt4 card"><h3>GitHub Copilot Metrics API</h3><p class="mt2">&#x26A0;&#xFE0F; Could not load metrics for <strong>'+ghMetrics.scopeName+'</strong>.</p>'+detail+'<p class="mt3 t-md muted">Note: this endpoint is <strong>org/enterprise only</strong> &mdash; personal Copilot subscriptions have no metrics API.</p></div>';
    return;
  }
  var days=ghMetrics.days.slice(-14);
  var totSugg=days.reduce(function(a,d){return a+d.totalSuggestionsCount;},0);
  var totAcc=days.reduce(function(a,d){return a+d.totalAcceptancesCount;},0);
  var totLinesAcc=days.reduce(function(a,d){return a+d.totalLinesAccepted;},0);
  var totLinesSugg=days.reduce(function(a,d){return a+d.totalLinesSuggested;},0);
  var totChat=days.reduce(function(a,d){return a+(d.chatTurns||0);},0);
  var accRate=totSugg>0?((totAcc/totSugg)*100).toFixed(1):0;
  var lineAccRate=totLinesSugg>0?((totLinesAcc/totLinesSugg)*100).toFixed(1):0;

  // Aggregate chat by model across all days
  var modelMap={};
  days.forEach(function(d){(d.chatByModel||[]).forEach(function(m){modelMap[m.model]=(modelMap[m.model]||0)+m.turns;});});
  var modelRows=Object.entries(modelMap).sort(function(a,b){return b[1]-a[1];}).map(function(e){return'<tr><td><span class="extb">'+e[0]+'</span></td><td>'+e[1]+'</td></tr>';}).join('')||'<tr class="empty-row"><td colspan="2">No chat data yet</td></tr>';

  // Combine local tracker totals for comparison
  var localAiLines=allData.reduce(function(a,d){return a+d.linesAiAdded;},0);

  // Top languages from last 14 days
  var langMap={};
  days.forEach(function(d){d.byLanguage.forEach(function(l){if(!langMap[l.name])langMap[l.name]={sugg:0,acc:0,linesSugg:0,linesAcc:0};langMap[l.name].sugg+=l.totalSuggestionsCount;langMap[l.name].acc+=l.totalAcceptancesCount;langMap[l.name].linesSugg+=l.totalLinesSuggested;langMap[l.name].linesAcc+=l.totalLinesAccepted;});});
  var topLangs=Object.entries(langMap).sort(function(a,b){return b[1].linesAcc-a[1].linesAcc;}).slice(0,8);

  var langRows=topLangs.map(function(e){var n=e[0],s=e[1],r=s.sugg>0?((s.acc/s.sugg)*100).toFixed(0):0;return'<tr><td><span class="extb">'+n+'</span></td><td>'+s.sugg+'</td><td>'+s.acc+'</td><td><span class="badge '+(r>50?'ba':'bh')+'">'+r+'%</span></td><td>+'+s.linesAcc+'</td></tr>';}).join('');

  el.innerHTML=bh+'<div class="sg" style="grid-template-columns:repeat(5,1fr)">'
    +'<div class="st"><div class="lbl">Suggestions (14d)</div><div class="val">'+totSugg+'</div></div>'
    +'<div class="st"><div class="lbl">Acceptances (14d)</div><div class="c-human val">'+totAcc+'</div></div>'
    +'<div class="st"><div class="lbl">Acceptance Rate</div><div class="c-ai val">'+accRate+'%</div></div>'
    +'<div class="st"><div class="lbl">Lines Accepted (14d)</div><div class="c-ai val">'+totLinesAcc+'</div></div>'
    +'<div class="st"><div class="lbl">&#x1F4AC; Chat Turns (14d)</div><div class="c-rev val">'+totChat+'</div></div>'
    +'</div>'
    +'<div class="cr">'
    +'<div class="card"><h3>Daily Accepted Lines (14d)</h3><div class="cw"><canvas id="cGhDaily"></canvas></div></div>'
    +'<div class="card"><h3>Local Heuristic vs Official</h3>'
    +'<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">'
    +'<div class="kvrow"><span>Official lines accepted (14d)</span><strong class="c-ai">'+totLinesAcc+'</strong></div>'
    +'<div class="kvrow"><span>Our heuristic AI lines</span><strong class="c-rev">'+localAiLines+'</strong></div>'
    +'<div class="kvrow"><span>Line acceptance rate</span><strong class="c-human">'+lineAccRate+'%</strong></div>'
    +'<div class="kvrow"><span>Source</span><strong>'+ghMetrics.scopeName+' ('+ghMetrics.source+')</strong></div>'
    +'</div></div></div>'
    +'<div class="cr">'
    +'<div class="card"><h3>&#x1F4AC; Chat Turns by Model (14d) &mdash; Premium Requests</h3>'
    +'<table><thead><tr><th>Model</th><th>Chat Turns</th></tr></thead>'
    +'<tbody>'+modelRows+'</tbody></table></div>'
    +'<div class="card"><h3>By Language (14d)</h3>'
    +'<table><thead><tr><th>Language</th><th>Suggestions</th><th>Accepted</th><th>Accept %</th><th>Lines Accepted</th></tr></thead>'
    +'<tbody>'+langRows+'</tbody></table></div>'
    +'</div>';

  dc('ghDaily');
  charts.ghDaily=new Chart(document.getElementById('cGhDaily'),{type:'bar',
    data:{labels:days.map(function(d){return d.date.slice(5);}),
      datasets:[
        {label:'Lines Accepted',data:days.map(function(d){return d.totalLinesAccepted;}),backgroundColor:'rgba(197,134,192,.7)',yAxisID:'y'},
        {label:'Accept Rate %',data:days.map(function(d){return d.totalSuggestionsCount>0?((d.totalAcceptancesCount/d.totalSuggestionsCount)*100).toFixed(1):0;}),backgroundColor:'rgba(78,201,176,.4)',type:'line',yAxisID:'y2',borderColor:'rgba(78,201,176,.9)',borderWidth:2,pointRadius:3}
      ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},
      scales:{x:{ticks:{color:dfg()},grid:{color:gc}},
        y:{ticks:{color:dfg()},grid:{color:gc},title:{display:true,text:'lines',color:dfg()},position:'left'},
        y2:{ticks:{color:dfg(),callback:function(v){return v+'%';}},grid:{display:false},max:100,position:'right'}}}});
}
function aiSplitHtml(){
  var sF=function(k){return allData.reduce(function(a,d){return a+(d[k]||0);},0);};
  var inC=sF('aiInlineChars'),chC=sF('aiChatChars'),inL=sF('aiInlineLines'),chL=sF('aiChatLines');
  var nf=function(n){return Math.round(n).toLocaleString();};
  var tot=inC+chC;
  if(tot===0)return'';
  var iP=tot>0?inC/tot*100:0,cP=tot>0?chC/tot*100:0;
  return'<div style="margin-top:6px;padding-top:14px;border-top:1px solid var(--border)">'
    +'<div style="font-size:.8em;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px">\\uD83E\\uDD16 AI source split \\u2014 inline completions vs chat / agent</div>'
    +'<div class="mb" style="width:100%;height:10px;margin-bottom:8px"><span style="width:'+iP+'%;background:var(--ai)" title="Inline completions"></span><span style="width:'+cP+'%;background:var(--review)" title="Chat / agent"></span></div>'
    +'<div style="display:flex;gap:18px;font-size:.85em;flex-wrap:wrap">'
    +'<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--ai);margin-right:5px"></span>Inline completions: <strong>'+iP.toFixed(0)+'%</strong> \\u00b7 '+nf(inC)+' chars \\u00b7 +'+nf(inL)+' lines</span>'
    +'<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--review);margin-right:5px"></span>Chat / agent: <strong>'+cP.toFixed(0)+'%</strong> \\u00b7 '+nf(chC)+' chars \\u00b7 +'+nf(chL)+' lines</span>'
    +'</div></div>';
}
// Overview credit hero (issue #120): KPIs, monthly budget pace, daily spend,
// insights and breakdowns from AN.credits (analysis/creditOverview.ts).
var ovSt=(vscode.getState&&vscode.getState())||{};
var ovOpen=ovSt.ovOpen||{};
function ovSave(){if(vscode.setState)vscode.setState(Object.assign({},vscode.getState&&vscode.getState()||{},{ovOpen:ovOpen}));}
document.addEventListener('toggle',function(e){var d=e.target;if(d&&d.dataset&&d.dataset.sec){ovOpen[d.dataset.sec]=d.open;ovSave();}},true);
function ovSec(id,title,meta,body,defOpen){
  var open=ovOpen[id]===undefined?defOpen:ovOpen[id];
  return'<details class="sec" data-sec="'+id+'"'+(open?' open':'')+'><summary>'+title+(meta?'<span class="sm">'+meta+'</span>':'')+'</summary><div class="sb">'+body+'</div></details>';
}
function cr(n){n=n||0;return n>=1000?Math.round(n).toLocaleString():(Math.round(n*10)/10).toLocaleString(undefined,{minimumFractionDigits:n>=100?0:1,maximumFractionDigits:1});}
function usd(n){return'$'+((n||0)*(CFG.usdPerCredit||0)).toFixed(2);}
function fday(d,y){var x=new Date(d+'T00:00:00');return x.toLocaleDateString(undefined,y?{month:'short',day:'numeric',year:'numeric'}:{month:'short',day:'numeric'});}
function dSpend(cur,prev,what){
  if(!(prev>0))return cur>0?'<span class="dup">new</span> vs '+what:'';
  var d=(cur-prev)/prev*100;if(Math.abs(d)<1)return'= '+what;
  return'<span class="'+(d>0?'dup':'ddown')+'">'+(d>0?'\\u25B2':'\\u25BC')+' '+Math.abs(d).toFixed(0)+'%</span> vs '+what;
}
function kpi(label,val,sub){return'<div class="kpi"><div class="kl">'+label+'</div><div class="kv">'+val+'</div><div class="ks">'+(sub||'&nbsp;')+'</div></div>';}
function pills(action,cur,opts){return'<span class="pills">'+opts.map(function(o){return'<button class="pill'+(o[0]===cur?' active':'')+'" data-action="'+action+'" data-value="'+o[0]+'">'+o[1]+'</button>';}).join('')+'</span>';}
var OV_COLORS=['rgba(197,134,192,.85)','rgba(78,201,176,.85)','rgba(86,156,214,.85)','rgba(220,220,170,.85)','rgba(206,145,120,.85)','rgba(128,128,128,.6)'];
function ovBudgetHtml(C){
  var B=C.budget;
  if(!B)return'<div class="bgt none">No monthly credit budget set. <a class="lnk" data-action="cmd" data-value="setMonthlyCreditBudget">Set a budget</a> to see how this period is pacing.</div>';
  var col=B.state==='over'?'var(--deleted)':B.state==='will-exceed'?'var(--cost)':'var(--added)';
  var even=C.period.totalDays>0?Math.min(100,C.period.elapsedDays/C.period.totalDays*100):0;
  var msg=B.state==='over'?'Over budget by <strong>'+cr(B.used-B.budget)+'</strong> credits.'
    :B.state==='will-exceed'?'At '+cr(B.avgDaily)+' credits a day the budget runs out around <strong>'+fday(B.exceedDate)+'</strong> (projected '+cr(B.projected)+').'
    :'Projected <strong>'+cr(B.projected)+'</strong> credits by the end of the period \\u2014 '+cr(B.budget-B.used)+' left.';
  return'<div class="bgt"><div class="bgh"><div><div class="kl">Monthly budget'+(GF.projectId||GF.workItemId?' \\u00b7 all projects':'')+'</div><div class="kv">'+cr(B.used)+'<small>/ '+cr(B.budget)+' credits \\u00b7 '+usd(B.used)+'</small></div></div>'
    +'<div class="ta-r t-sm muted"><strong style="color:'+col+'">'+B.pct+'%</strong> used \\u00b7 resets '+fday(B.resetDate)+' ('+B.daysLeft+' days)<br><a class="lnk" data-action="cmd" data-value="setMonthlyCreditBudget">Edit budget</a></div></div>'
    +'<div class="ptrack"><div class="pfill" style="width:'+Math.min(100,B.pct)+'%;background:'+col+'"></div><div class="pmark" style="left:'+even.toFixed(1)+'%" title="Even pace: where spend would be today if spread evenly over the period"></div></div>'
    +'<div style="margin-top:8px;font-size:.85em;color:'+col+'">'+msg+'</div></div>';
}
function ovBars(rows,total,label,max){
  if(!rows.length)return'<div class="t-md muted">No credits in this window.</div>';
  var top=rows.reduce(function(m,r){return Math.max(m,r.credits);},0)||1;
  return rows.slice(0,max||rows.length).map(function(r){
    var l=label(r),pct=total>0?Math.round(r.credits/total*100):0;
    return'<div class="ptr brow"'+(l.action?' data-action="'+l.action+'" data-value="'+esc(r.key)+'"':'')+' title="'+esc(l.title||l.text)+' \\u2014 '+cr(r.credits)+' credits, '+r.entries+' entries"><span class="muted bl"'+(l.muted?'':'')+'>'+esc(l.text)+'</span><span class="btrack"><span class="bfill" style="display:block;width:'+(r.credits/top*100).toFixed(1)+'%;background:'+(l.color||'var(--ai)')+'"></span></span><span class="bv">'+cr(r.credits)+' \\u00b7 '+pct+'%</span></div>';
  }).join('');
}
function ovCorrHtml(){
  var K=AN&&AN.corrections;if(!K)return'';
  var r=K.recent,p=K.previous,wk=K.trendWeeks;
  var kp='<div class="kpis">'
    +kpi('Correction rate, last '+wk+' weeks',rpct(r.rate),rateDelta(r.rate,p.rate)+(p.rate!=null?' ('+rpct(p.rate)+')':''))
    +kpi('Corrected AI lines',String(r.correctedLines),'of '+r.aiLines+' AI lines \\u00b7 '+r.episodes+' episodes')
    +kpi('Rework time',fmt(r.reworkMs),p.reworkMs?dSpend(r.reworkMs,p.reworkMs,'before'):'&nbsp;')
    +kpi('Since capture started',rpct(K.total.rate),K.total.correctedLines+' of '+K.total.aiLines+' AI lines')+'</div>';
  var top=K.weeks.reduce(function(m,w){return Math.max(m,w.rate||0);},0)||1;
  var bars=K.weeks.map(function(w){return'<div class="brow" title="Week of '+esc(fday(w.week,true))+': '+w.correctedLines+' of '+w.aiLines+' AI lines corrected"><span class="bl">'+esc(fday(w.week))+'</span><span class="btrack"><span class="bfill" style="display:block;width:'+((w.rate||0)/top*100).toFixed(1)+'%;background:var(--deleted)"></span></span><span class="bv">'+rpct(w.rate)+'</span></div>';}).join('');
  var cats=K.categories.length?'<table class="mt3"><thead><tr><th>Category</th><th>Corrected lines</th><th title="Corrected lines per 100 AI lines in the last '+wk+' weeks">Last '+wk+' wk</th><th>Before</th><th>Trend</th></tr></thead><tbody>'
    +K.categories.map(function(c){return'<tr><td>'+esc(c.category)+'</td><td>'+c.correctedLines+'</td><td>'+rpct(c.recent)+'</td><td>'+rpct(c.previous)+'</td><td>'+trendHtml(c.trend)+'</td></tr>';}).join('')+'</tbody></table>':'';
  var help='<p class="mt2 t-sm muted">Correction rate = AI-written lines that you or Copilot changed later, per 100 AI lines written. Lower is better. Requirement changes and progress updates do not count; unlabelled corrections do. <a class="lnk" data-action="tab" data-value="corrections" data-rate="1">Open the corrections</a></p>';
  return ovSec('corrections','\\uD83D\\uDD01 Corrections of AI code',rpct(r.rate)+' last '+wk+' weeks',kp+'<div class="mt3">'+bars+'</div>'+cats+help,false);
}
function ovCreditsHtml(){
  var C=AN&&AN.credits;
  if(!C)return'';
  var anyCredits=(C.breakdown['90'].entries||0)>0||C.period.credits>0||(C.breakdown.custom&&C.breakdown.custom.entries>0);
  var P=C.period,endDay=new Date(P.end+'T00:00:00');endDay.setDate(endDay.getDate()-1);
  var periodLbl=fday(P.start)+' \\u2013 '+endDay.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  var head='<div class="kpis">'
    +kpi('Today',cr(C.today)+'<small>credits</small>',usd(C.today)+' \\u00b7 '+dSpend(C.today,C.yesterday,'yesterday'))
    +kpi('Last 7 days',cr(C.last7)+'<small>credits</small>',usd(C.last7)+' \\u00b7 '+dSpend(C.last7,C.prev7,'prior 7 days'))
    +kpi('This period'+confBadge(C.breakdown.period&&C.breakdown.period.confidence,'Credits this period','credits'),cr(P.credits)+'<small>credits</small>',periodLbl+' \\u00b7 '+dSpend(P.credits,P.prevCredits,'same point last period'))
    +kpi('Avg per active day',cr(C.avgPerActiveDay)+'<small>credits</small>',C.activeDays30+' active day'+(C.activeDays30===1?'':'s')+' in the last 30')
    +'</div>';
  var ins=(C.insights||[]).length?'<div class="insights">'+C.insights.map(function(i){return'<div class="ins ins-'+i.level+'"><div class="it">'+esc(i.title)+'</div><div class="ib">'+esc(i.body)+'</div></div>';}).join('')+'</div>':'';
  var chart='<div class="mb3 card"><div class="chd"><h3 class="m0">Daily spend</h3><span id="ovMeta" class="t-sm muted"></span>'
    +'<span class="t-sm muted">'+esc(gfRangeLabel())+'</span></div><div class="cw" style="height:220px"><canvas id="cCredits"></canvas></div></div>';
  var B=(GF.range==='all'||GF.range==='custom'?C.breakdown.custom:C.breakdown[GF.range])||C.breakdown['30'];
  var wiTitle=function(id){var w=(WI||[]).find(function(x){return String(x.workItemId)===String(id);});return w&&w.title?w.title:'';};
  var srcLbl={auto:'Automatic capture',manual:'Manual entry',import:'Imported'};
  var wiRows=B.byWorkItem.slice(0,6);
  if(B.unattributed>0)wiRows=wiRows.concat([{key:'',credits:B.unattributed,entries:0}]);
  var bd='<div class="chd"><span class="t-md muted">'+cr(B.total)+' credits \\u00b7 '+usd(B.total)+' \\u00b7 '+B.entries+' entries'+confBadge(B.confidence,'Credits','credits')+'</span><span class="t-sm muted">'+esc(gfRangeLabel())+'</span></div>'
    +'<div class="bdg">'
    +'<div class="bdc"><h4>By model</h4>'+ovBars(B.byModel,B.total,function(r){var i=C.models.indexOf(r.key);return{text:r.key,color:i>=0&&i<5?OV_COLORS[i]:OV_COLORS[5]};},6)+'</div>'
    +'<div class="bdc"><h4>By work item</h4>'+ovBars(wiRows,B.total,function(r){if(!r.key)return{text:'No work item',muted:true,color:'rgba(128,128,128,.5)'};var t=wiTitle(r.key);return{text:'#'+r.key+(t?' \\u2013 '+t:''),action:'ovWi'};})+'</div>'
    +'<div class="bdc"><h4>By weekday</h4>'+ovBars(B.total>0?B.byDayOfWeek:[],B.total,function(r){return{text:r.key,color:'var(--review)'};})+'</div>'
    +'<div class="bdc"><h4>By source</h4>'+ovBars(B.bySource,B.total,function(r){return{text:srcLbl[r.key]||r.key,color:'var(--human)'};})+'</div>'
    +'</div>';
  if(!anyCredits){
    return ovSec('credits','\\uD83D\\uDCB3 Copilot credits','','<p class="muted mb3">No Copilot credits recorded in the last 90 days. Credits are captured automatically from chat sessions; you can also add or import them.</p><button class="dtab" data-action="cmd" data-value="logCredits">\\uFF0B Add Entry</button> <button class="dtab" data-action="cmd" data-value="importRealCredits">\\u2B07 Import Real Credits</button>',true);
  }
  return ovSec('credits','\\uD83D\\uDCB3 Copilot credits',usd(P.credits)+' this period \\u00b7 <a class="lnk" data-action="tab" data-value="ledger">Ledger</a>',head+ovBudgetHtml(C)+ins+chart,true)
    +ovSec('breakdown','\\uD83D\\uDCCA Where the credits went','',bd,true);
}
function renderOvChart(){
  dc('credits');
  var C=AN&&AN.credits,cv=document.getElementById('cCredits');
  if(!C||!cv)return;
  var w=gfWindow();
  var days=C.daily.filter(function(d){return(!w.from||d.date>=w.from)&&(!w.to||d.date<=w.to);});
  if(!w.from&&!w.to){var fi=days.findIndex(function(d){return d.credits>0;});days=fi>0?days.slice(fi):days;}
  var ds=C.models.map(function(m,i){return{label:m,data:days.map(function(d){return +(d.byModel[m]||0).toFixed(2);}),backgroundColor:OV_COLORS[Math.min(i,5)],stack:'c',yAxisID:'y',borderRadius:2,order:2};});
  var cum=0,cumData=days.map(function(d){cum+=d.credits;return +cum.toFixed(2);});
  ds.push({label:'Cumulative',type:'line',data:cumData,borderColor:'rgba(244,162,97,.9)',backgroundColor:'rgba(244,162,97,.15)',borderWidth:2,pointRadius:0,tension:.25,yAxisID:'y2',order:1});
  if(GF.range==='period'&&C.budget&&!GF.projectId&&!GF.workItemId)ds.push({label:'Budget',type:'line',data:days.map(function(){return C.budget.budget;}),borderColor:'rgba(244,113,116,.7)',borderDash:[6,4],borderWidth:1.5,pointRadius:0,yAxisID:'y2',order:0});
  var total=days.reduce(function(a,d){return a+d.credits;},0),peak=days.reduce(function(m,d){return d.credits>m.credits?d:m;},{credits:0,date:''});
  var meta=document.getElementById('ovMeta');
  if(meta)meta.textContent=days.length?cr(total)+' credits \\u00b7 '+usd(total)+(peak.credits>0?' \\u00b7 peak '+cr(peak.credits)+' on '+fday(peak.date):''):'';
  charts.credits=new Chart(cv,{type:'bar',data:{labels:days.map(function(d){return fday(d.date);}),datasets:ds},
    options:{animation:false,responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'bottom',labels:{color:fg(),boxWidth:10,boxHeight:10}},tooltip:{callbacks:{label:function(c){return c.dataset.label+': '+cr(c.parsed.y)+' credits';},footer:function(items){var i=items[0]&&items[0].dataIndex;return i==null?'':'Day total: '+cr(days[i].credits)+' credits \\u00b7 '+usd(days[i].credits);}}}},
      scales:{x:{stacked:true,ticks:{color:dfg(),maxTicksLimit:12,maxRotation:0},grid:{display:false}},
        y:{stacked:true,beginAtZero:true,ticks:{color:dfg()},grid:{color:gc},title:{display:true,text:'credits / day',color:dfg()}},
        y2:{beginAtZero:true,position:'right',ticks:{color:dfg()},grid:{drawOnChartArea:false},title:{display:true,text:'cumulative',color:dfg()}}}}});
}
var ovSig='';
function ovConfHtml(){
  var A=AN&&AN.confidence;if(!A)return'';
  return'<div class="cfl">Data confidence: time '+(confBadge(A.time,'Active time','ms')||'\\u2014')+' \\u00b7 lines '+(confBadge(A.lines,'Lines','lines')||'\\u2014')+' \\u00b7 credits '+(confBadge(A.credits,'Credits','credits')||'\\u2014')+' \\u2014 \\u25CF exact \\u00b7 \\u25D0 mixed \\u00b7 \\u25CB estimated \\u00b7 \\u270E manual; hover a marker for the split</div>';
}
function renderOverview(){
  const el=document.getElementById('overview');
  var sig=JSON.stringify([allData,AN,CFG,currentBranch,GF,(WI||[]).map(function(w){return w.workItemId+':'+(w.title||'');})]);
  if(sig===ovSig&&el.firstChild)return;
  ovSig=sig;
  var OD=allData.filter(function(d){return gfScope('',d.workItemId);});
  const T=OD.reduce(function(a,d){return{human:a.human+d.humanCodingMs,ai:a.ai+d.aiGeneratingMs,review:a.review+d.reviewingMs,lhA:a.lhA+d.linesHumanAdded,lhD:a.lhD+d.linesHumanDeleted,laA:a.laA+d.linesAiAdded,laD:a.laD+d.linesAiDeleted,cost:a.cost+d.estimatedCostUsd};},{human:0,ai:0,review:0,lhA:0,lhD:0,laA:0,laD:0,cost:0});
  var rows=OD.map(function(d){
    var tot=tms(d),hp=tot>0?d.humanCodingMs/tot*100:0,ap=tot>0?d.aiGeneratingMs/tot*100:0,rp=tot>0?d.reviewingMs/tot*100:0,isCur=d.branch===currentBranch;
    return '<tr class="ptr '+(isCur?'cur':'')+'" data-action="detail" data-value="'+d.branch+'"><td>'+(isCur?'\\u25b6 ':'')+'<strong>'+d.branch+'</strong></td><td>'+(d.workItemId?'<span class="badge ba">#'+d.workItemId+'</span>':'\\u2014')+'</td><td>'+fmt(tot)+'</td><td><div class="mb"><span style="width:'+hp+'%;background:var(--human)"></span><span style="width:'+ap+'%;background:var(--ai)"></span><span style="width:'+rp+'%;background:var(--review)"></span></div></td><td class="dc">'+pp(d.linesHumanAdded,'bp')+' '+pm(d.linesHumanDeleted)+'</td><td class="dc">'+pp(d.linesAiAdded,'ba')+' '+pm(d.linesAiDeleted)+'</td><td><span class="badge '+(aiPct(d)>50?'ba':'bh')+'">'+aiPct(d)+'%</span></td><td>$'+d.estimatedCostUsd.toFixed(4)+'</td></tr>';
  }).join('');
  var AS=AN||{};var stk=AS.streak||{current:0,longest:0};var wk=AS.week||{thisWeek:{activeMs:0,lines:0,aiShare:0},lastWeek:{activeMs:0,lines:0,aiShare:0}};
  function dlt(n,p){if(p===0)return n>0?'<span class="c-add">\\u25b2 new</span>':'';var d=(n-p)/p*100;var up=d>=0;return'<span style="color:'+(up?'var(--added)':'var(--deleted)')+'">'+(up?'\\u25b2':'\\u25bc')+' '+Math.abs(d).toFixed(0)+'%</span>';}
  function scd(lbl,val,sub,color){return'<div class="st"><div class="lbl">'+lbl+'</div><div class="val" style="color:'+(color||'inherit')+'">'+val+'</div><div style="font-size:.75em;margin-top:2px">'+sub+'</div></div>';}
  var weekK='<div class="sg">'
    +scd('\\uD83D\\uDD25 Streak',stk.current+'d','longest '+stk.longest+'d','var(--cost)')
    +scd('This Week Active',fmt(wk.thisWeek.activeMs),dlt(wk.thisWeek.activeMs,wk.lastWeek.activeMs)+' vs last','var(--review)')
    +scd('This Week Lines','+'+wk.thisWeek.lines,dlt(wk.thisWeek.lines,wk.lastWeek.lines)+' vs last','var(--human)')
    +scd('This Week AI Share',wk.thisWeek.aiShare.toFixed(0)+'%',dlt(wk.thisWeek.aiShare,wk.lastWeek.aiShare)+' vs last','var(--ai)')
    +'</div>';
  var tf=(AN&&AN.topFiles)||[];
  var hotRows=tf.map(function(f){
    var p=f.path.length>48?'\\u2026'+f.path.slice(-46):f.path;
    var pct=f.aiShare.toFixed(0);
    return'<tr><td title="'+f.path+'" class="mono">'+p+'</td><td>'+f.edits+'</td><td class="dc">'+pp(f.human,'bp')+'</td><td class="dc">'+pp(f.ai,'ba')+'</td><td><span class="badge '+(pct>50?'ba':'bh')+'">'+pct+'%</span></td></tr>';
  }).join('')||'<tr class="empty-row"><td colspan="5">No file edits recorded yet</td></tr>';
  var hot='<table><thead><tr><th>File</th><th>Edits</th><th>Human +</th><th>AI +</th><th>AI %</th></tr></thead><tbody>'+hotRows+'</tbody></table>';
  var sumF=function(k){return OD.reduce(function(a,d){return a+(d[k]||0);},0);};
  var hC=sumF('humanChars'),aC=sumF('aiChars'),ks=sumF('humanKeystrokes'),chC=sumF('chatCharsHuman');
  var nf=function(n){return Math.round(n).toLocaleString();};
  var CPT=4;
  var aiTok=aC/CPT,huTok=hC/CPT,chTok=chC/CPT,totTok=aiTok+huTok+chTok;
  var ratio=hC>0?aC/hC:0;
  var ratioTxt=hC>0?(ratio>=1?ratio.toFixed(1)+'\\u00d7 AI vs typed':(1/ratio).toFixed(1)+'\\u00d7 typed vs AI'):(aC>0?'100% AI':'\\u2014');
  var totC=hC+aC,hPct=totC>0?hC/totC*100:0,aPct=totC>0?aC/totC*100:0;
  var kt='<div class="sg">'
    +scd('\\u2328\\ufe0f Keystrokes',nf(ks),'hand-typed edits','var(--human)')
    +scd('Human chars typed',nf(hC),'into code','var(--human)')
    +scd('\\uD83E\\uDD16 AI chars',nf(aC),'inserted','var(--ai)')
    +scd('AI : Human',ratioTxt,'character ratio','var(--cost)')
    +'</div>'
    +'<div class="my3 mb"><span style="width:'+hPct+'%;background:var(--human)" title="Human typed"></span><span style="width:'+aPct+'%;background:var(--ai)" title="AI inserted"></span></div>'
    +'<div class="t-sm muted mb3">'+hPct.toFixed(0)+'% of characters typed by you \\u00b7 '+aPct.toFixed(0)+'% inserted by AI</div>'
    +'<div class="sg">'
    +scd('\\uD83E\\uDD16 AI tokens','~'+nf(aiTok),'code generated','var(--ai)')
    +scd('\\u2328\\ufe0f Human tokens','~'+nf(huTok),'code typed','var(--human)')
    +scd('\\uD83D\\uDCAC Chat tokens','~'+nf(chTok),'prompts typed','var(--review)')
    +scd('\\uD83D\\uDD22 Total tokens','~'+nf(totTok),'~'+CPT+' chars/token','var(--cost)')
    +'</div>'
    +aiSplitHtml()
    +'<p class="mt2 t-sm muted">Token estimates use a ~'+CPT+'-chars-per-token heuristic on inserted text \\u2014 a rough proxy for prompt/output size, not billed credits.</p>';
  var timeK='<div class="sg"><div class="st"><div class="lbl">\\u2328\\ufe0f Human Coding</div><div class="c-human val">'+fmt(T.human)+'</div></div><div class="st"><div class="lbl">\\uD83E\\uDD16 AI Generating</div><div class="c-ai val">'+fmt(T.ai)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDC40 Reviewing</div><div class="c-rev val">'+fmt(T.review)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDCB0 Est. Cost</div><div class="c-cost val">$'+T.cost.toFixed(4)+'</div></div></div>'+ovConfHtml();
  var top='<div class="ovh"><div><div class="ovt">Overview</div><div class="sub" style="margin:2px 0 0">Copilot credits, time and code across every branch</div></div>'
    +'<div class="ovb"><button class="dtab" data-action="cmd" data-value="assignBranchToWorkItem">\\uD83D\\uDD17 Assign Work Item</button><button class="dtab" data-action="cmd" data-value="weeklyReport">\\uD83D\\uDCC4 Weekly Report</button><button class="dtab" data-action="cmd" data-value="exportCsv">\\u2B07 Export CSV</button></div></div>';
  el.innerHTML=top+ovCreditsHtml()
    +ovSec('activity','\\u23F1 Activity','this week vs last week \\u00b7 streak \\u00b7 totals',weekK+timeK+'<div class="cr"><div class="card"><h3>Time per Branch</h3><div class="cw"><canvas id="cBar"></canvas></div></div><div class="card"><h3>AI % per Branch</h3><div class="cw"><canvas id="cAi"></canvas></div></div></div>',true)
    +ovSec('branches','\\uD83C\\uDF3F Branches',(OD.length===allData.length?OD.length:OD.length+' of '+allData.length)+' tracked','<div class="ox"><table><thead><tr><th>Branch</th><th>Work Item</th><th>Active</th><th>Split</th><th>Human +/-</th><th>AI +/-</th><th>AI %</th><th>Cost</th></tr></thead><tbody>'+rows+'</tbody></table></div>',true)
    +ovCorrHtml()
    +ovSec('hotspots','\\uD83D\\uDD25 Most-edited files',tf.length?tf.length+' files':'','<div class="ox">'+hot+'</div>',false)
    +ovSec('keys','\\u2328\\ufe0f Keystrokes vs AI \\u00b7 token estimate','',kt,false);
  renderOvChart();
  var labels=OD.map(function(d){return d.branch.length>16?d.branch.slice(0,14)+'\\u2026':d.branch;});
  dc('bar');
  charts.bar=new Chart(document.getElementById('cBar'),{type:'bar',data:{labels:labels,datasets:[{label:'Human',data:OD.map(function(d){return Math.round(d.humanCodingMs/60000);}),backgroundColor:'rgba(78,201,176,.7)'},{label:'AI Gen',data:OD.map(function(d){return Math.round(d.aiGeneratingMs/60000);}),backgroundColor:'rgba(197,134,192,.7)'},{label:'Review',data:OD.map(function(d){return Math.round(d.reviewingMs/60000);}),backgroundColor:'rgba(220,220,170,.7)'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},scales:{x:{ticks:{color:dfg()},grid:{color:gc},stacked:true},y:{ticks:{color:dfg()},grid:{color:gc},stacked:true,title:{display:true,text:'min',color:dfg()}}}}});
  dc('ai');
  charts.ai=new Chart(document.getElementById('cAi'),{type:'bar',data:{labels:labels,datasets:[{label:'AI %',data:OD.map(function(d){return aiPct(d);}),backgroundColor:OD.map(function(d){return aiPct(d)>50?'rgba(197,134,192,.8)':'rgba(78,201,176,.8)';}),borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:dfg()},grid:{color:gc}},y:{ticks:{color:dfg()},grid:{color:gc},max:100,title:{display:true,text:'%',color:dfg()}}}}});
}

function renderTrends(){
  var el=document.getElementById('trends');
  var all=AN.daily||[];
  var tw=gfWindow();
  var days=all.filter(function(d){return(!tw.from||d.date>=tw.from)&&(!tw.to||d.date<=tw.to);});
  if(!tw.from&&!tw.to){var tfi=days.findIndex(function(d){return(d.humanCoding+d.aiGenerating+d.reviewing+d.linesHuman+d.linesAi)>0;});days=tfi>0?days.slice(tfi):days;}
  var sum=days.reduce(function(a,d){return{h:a.h+d.humanCoding,ai:a.ai+d.aiGenerating,r:a.r+d.reviewing,lh:a.lh+d.linesHuman,la:a.la+d.linesAi};},{h:0,ai:0,r:0,lh:0,la:0});
  var activeMs=sum.h+sum.ai+sum.r;
  var activeDays=days.filter(function(d){return(d.humanCoding+d.aiGenerating+d.reviewing)>0;}).length;
  var avgMs=activeDays>0?activeMs/activeDays:0;
  var totLines=sum.lh+sum.la;
  el.innerHTML=''
    +'<div class="mb4 card" id="calCard"></div>'
    +'<div class="sg">'
    +sc('Active Time ('+gfRangeLabel()+')',fmt(activeMs),'var(--review)')
    +sc('Daily Average',fmt(avgMs),'var(--human)')
    +sc('Active Days',String(activeDays),'var(--vscode-foreground)')
    +sc('Lines ('+gfRangeLabel()+')','+'+totLines,'var(--ai)')
    +'</div>'
    +'<div class="mt2 card"><h3>Daily Activity &mdash; Human vs AI vs Review</h3><div class="cw" style="height:240px"><canvas id="cTrend"></canvas></div></div>'
    +'<div class="mt4 card"><h3>\\uD83E\\uDD16 AI Dependency Trend &mdash; AI % of lines per day</h3><div class="cw" style="height:200px"><canvas id="cTrendAi"></canvas></div></div>'
    +'<div class="mt4 card"><h3>\\uD83D\\uDD25 Activity Heatmap &mdash; when you work (all history)</h3><div id="heat" class="mt3"></div><p class="mt3 t-sm muted">Darker = more active minutes in that hour. Local time.</p></div>';
  dc('trend');
  charts.trend=new Chart(document.getElementById('cTrend'),{type:'bar',
    data:{labels:days.map(function(d){return d.date.slice(5);}),
      datasets:[
        {label:'Human',data:days.map(function(d){return +(d.humanCoding/60000).toFixed(1);}),backgroundColor:'rgba(78,201,176,.7)',stack:'t',yAxisID:'y'},
        {label:'AI Gen',data:days.map(function(d){return +(d.aiGenerating/60000).toFixed(1);}),backgroundColor:'rgba(197,134,192,.7)',stack:'t',yAxisID:'y'},
        {label:'Review',data:days.map(function(d){return +(d.reviewing/60000).toFixed(1);}),backgroundColor:'rgba(220,220,170,.7)',stack:'t',yAxisID:'y'},
        {label:'Lines',data:days.map(function(d){return d.linesHuman+d.linesAi;}),type:'line',borderColor:'rgba(244,162,97,.9)',backgroundColor:'rgba(244,162,97,.3)',borderWidth:2,pointRadius:2,yAxisID:'y2'}
      ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},
      scales:{x:{ticks:{color:dfg()},grid:{color:gc},stacked:true},
        y:{ticks:{color:dfg()},grid:{color:gc},stacked:true,title:{display:true,text:'min',color:dfg()},position:'left'},
        y2:{ticks:{color:dfg()},grid:{display:false},title:{display:true,text:'lines',color:dfg()},position:'right'}}}});
  dc('trendAi');
  charts.trendAi=new Chart(document.getElementById('cTrendAi'),{type:'line',
    data:{labels:days.map(function(d){return d.date.slice(5);}),
      datasets:[{label:'AI % of lines',data:days.map(function(d){var l=d.linesHuman+d.linesAi;return l>0?+((d.linesAi/l)*100).toFixed(0):null;}),borderColor:'rgba(197,134,192,.9)',backgroundColor:'rgba(197,134,192,.25)',borderWidth:2,pointRadius:2,fill:true,spanGaps:true,tension:.25}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:dfg()},grid:{color:gc}},y:{ticks:{color:dfg(),callback:function(v){return v+'%';}},grid:{color:gc},min:0,max:100,title:{display:true,text:'AI share',color:dfg()}}}}});
  renderHeatmap();
  renderCalendar();
}
var calMetric='time',calSel=null;
var CAL_METRICS={time:{label:'Active time',color:'var(--vscode-charts-green,#4ec9b0)'},credits:{label:'AI credits',color:'var(--vscode-charts-purple,#c586c0)'},lines:{label:'Lines',color:'var(--vscode-charts-orange,#f4a261)'}};
function calDate(s){var p=s.split('-');return new Date(+p[0],+p[1]-1,+p[2],12);}
function calKey(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function calVal(d,m){if(!d)return 0;return m==='credits'?d.credits:m==='lines'?(d.linesHuman+d.linesAi):d.activeMs;}
function calFmtCr(n){return(Math.round(n*10)/10).toLocaleString()+' cr';}
function calTip(key,d){
  var wd=calDate(key).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  if(!d)return wd+' \\u2014 no activity';
  return wd+' \\u2014 '+fmt(d.activeMs)+' active \\u00b7 '+calFmtCr(d.credits)+' \\u00b7 +'+(d.linesHuman+d.linesAi)+' lines';
}
function renderCalendar(){
  var el=document.getElementById('calCard');if(!el)return;
  var C=AN.calendar;
  if(!C){el.innerHTML='<h3>\\uD83D\\uDCC5 Year at a glance</h3>'+emptyState('No calendar data yet','Each day you track time, code or credits fills a square here.');return;}
  var byDate={};C.days.forEach(function(d){byDate[d.date]=d;});
  var vals=C.days.map(function(d){return calVal(d,calMetric);}).filter(function(v){return v>0;}).sort(function(a,b){return a-b;});
  var q=function(p){return vals.length?vals[Math.min(vals.length-1,Math.floor(p*vals.length))]:0;};
  var q1=q(.25),q2=q(.5),q3=q(.75);
  var lvl=function(v){return v<=0?0:v<=q1?1:v<=q2?2:v<=q3?3:4;};
  var start=calDate(C.start),end=calDate(C.end);
  var weeks=Math.round((end-start)/86400000/7)+1;
  var html='<div class="cal" style="grid-template-columns:30px repeat('+weeks+',minmax(9px,1fr))">';
  var wdl=['','Mon','','Wed','','Fri',''];
  for(var r=0;r<7;r++)html+='<div class="cwl" style="grid-column:1;grid-row:'+(r+2)+'">'+wdl[r]+'</div>';
  var lastMonth=-1;
  for(var w=0;w<weeks;w++){
    var first=new Date(start.getTime());first.setDate(first.getDate()+w*7);
    if(first.getMonth()!==lastMonth&&(w>0||first.getDate()<=7)&&w<weeks-2){
      html+='<div class="cml" style="grid-column:'+(w+2)+'/span 3;grid-row:1">'+first.toLocaleDateString(undefined,{month:'short'})+'</div>';
    }
    lastMonth=first.getMonth();
    for(var k=0;k<7;k++){
      var day=new Date(first.getTime());day.setDate(day.getDate()+k);
      if(day>end)break;
      var key=calKey(day),d=byDate[key];
      html+='<button class="cal-c l'+lvl(calVal(d,calMetric))+(key===calSel?' sel':'')+'" style="grid-column:'+(w+2)+';grid-row:'+(k+2)+'" data-action="calDay" data-value="'+key+'" title="'+esc(calTip(key,d))+'" aria-label="'+esc(calTip(key,d))+'"></button>';
    }
  }
  html+='</div>';
  var T=C.totals;
  var legend='<span class="calk">Less<span class="cal-c l0"></span><span class="cal-c l1"></span><span class="cal-c l2"></span><span class="cal-c l3"></span><span class="cal-c l4"></span>More</span>';
  el.style.setProperty('--calc',CAL_METRICS[calMetric].color);
  el.innerHTML='<div class="chd"><h3 class="m0">\\uD83D\\uDCC5 Year at a glance</h3>'
    +pills('calMetric',calMetric,[['time','Active time'],['credits','AI credits'],['lines','Lines']])+'</div>'
    +'<p class="mb3 sub">'+T.activeDays+' active days \\u00b7 '+fmt(T.activeMs)+' \\u00b7 '+calFmtCr(T.credits)+' \\u00b7 +'+T.lines.toLocaleString()+' lines in the last 12 months. Click a day for its breakdown.</p>'
    +'<div class="calw">'+html+'</div>'
    +'<div style="display:flex;justify-content:flex-end;margin-top:6px">'+legend+'</div>'
    +'<div id="calDetail">'+(calSel?calDayHtml(calSel,byDate):'')+'</div>';
}
function calBar(label,ms,total,color){
  var pct=total>0?Math.round(ms/total*100):0;
  return'<div class="brow"><span class="bl">'+label+'</span><div class="btrack"><div class="bfill" style="width:'+pct+'%;background:'+color+'"></div></div><span class="bv">'+fmt(ms)+'</span></div>';
}
function calDayHtml(key,byDate){
  var d=byDate[key];
  var C=AN.calendar,keys=C.days.map(function(x){return x.date;});
  var i=keys.indexOf(key);
  var prev=i>0?keys[i-1]:null;
  if(i<0){prev=null;for(var j=keys.length-1;j>=0;j--){if(keys[j]<key){prev=keys[j];break;}}}
  var next=null;for(var n=0;n<keys.length;n++){if(keys[n]>key){next=keys[n];break;}}
  var title=calDate(key).toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  var nav='<span class="pills">'
    +(prev?'<button class="pill" data-action="calDay" data-value="'+prev+'" title="Previous active day">\\u2039 '+prev.slice(5)+'</button>':'')
    +(next?'<button class="pill" data-action="calDay" data-value="'+next+'" title="Next active day">'+next.slice(5)+' \\u203a</button>':'')
    +'<button class="pill" data-action="calDay" data-value="" title="Close">\\u2715</button></span>';
  var head='<div class="chd"><strong>'+esc(title)+'</strong>'+nav+'</div>';
  if(!d)return'<div class="cald">'+head+'<p class="sub">Nothing tracked on this day.</p></div>';
  var lines=d.linesHuman+d.linesAi;
  var cost=(CFG.usdPerCredit||0)*d.credits;
  var k='<div class="kpis">'
    +'<div class="kpi"><div class="kl">Active time</div><div class="kv">'+fmt(d.activeMs)+'</div>'+(d.manualMs?'<div class="ks">incl. '+fmt(d.manualMs)+' logged manually</div>':'')+'</div>'
    +'<div class="kpi"><div class="kl">AI credits</div><div class="kv">'+(Math.round(d.credits*10)/10)+'</div><div class="ks">\\u2248 $'+cost.toFixed(2)+'</div></div>'
    +'<div class="kpi"><div class="kl">Lines added</div><div class="kv">+'+lines+'</div><div class="ks">'+d.linesHuman+' you \\u00b7 '+d.linesAi+' AI'+(lines?' ('+Math.round(d.linesAi/lines*100)+'% AI)':'')+'</div></div>'
    +'</div>';
  var tot=d.activeMs;
  var modes='<div class="bdc"><h4>Time by mode</h4>'
    +calBar('\\u2328\\ufe0f Coding',d.humanMs,tot,'var(--human)')
    +calBar('\\uD83E\\uDD16 AI generating',d.aiMs,tot,'var(--ai)')
    +calBar('\\uD83D\\uDC40 Reviewing',d.reviewMs,tot,'var(--review)')
    +(d.manualMs?calBar('\\u270D\\ufe0f Logged manually',d.manualMs,tot,'var(--cost)'):'')
    +'</div>';
  var cats;
  if(d.categories){
    var rows=Object.keys(d.categories).map(function(c){var v=d.categories[c];return{c:c,h:v.human,a:v.ai,t:v.human+v.ai};}).sort(function(a,b){return b.t-a.t;});
    cats='<div class="bdc"><h4>Lines by category</h4><table><thead><tr><th>Category</th><th>You</th><th>AI</th><th>AI %</th></tr></thead><tbody>'
      +rows.map(function(r){return'<tr><td>'+esc(CAT[r.c]||r.c)+'</td><td>+'+r.h+'</td><td>+'+r.a+'</td><td>'+(r.t?Math.round(r.a/r.t*100):0)+'%</td></tr>';}).join('')
      +'</tbody></table></div>';
  }else{
    cats='<div class="bdc"><h4>Lines by category</h4><p class="m0 sub">'+(lines?'This day was tracked before the category split was recorded, so only totals are known.':'No lines on this day.')+'</p></div>';
  }
  var items=d.items.map(function(it){
    var w=it.workItemId?(WI||[]).find(function(x){return String(x.workItemId)===String(it.workItemId);}):null;
    var wl=it.workItemId?'<a class="lnk" data-action="ovWi" data-value="'+esc(it.workItemId)+'">#'+esc(it.workItemId)+(w&&w.title?' '+esc(w.title):'')+'</a>':'<span class="sub">unassigned</span>';
    var bl=it.branch?'<span class="lnk" data-action="detail" data-value="'+esc(it.branch)+'">'+esc(it.branch)+'</span>':'<span class="sub">\\u2014</span>';
    return'<tr><td>'+bl+'</td><td>'+wl+'</td><td>'+fmt(it.activeMs)+'</td><td>+'+it.lines+'</td><td>'+(Math.round(it.credits*10)/10)+'</td></tr>';
  }).join('');
  var work='<div class="bdc" style="grid-column:1/-1"><h4>Worked on</h4><div class="ox"><table><thead><tr><th>Branch</th><th>Work item</th><th>Time</th><th>Lines</th><th>Credits</th></tr></thead><tbody>'+items+'</tbody></table></div></div>';
  return'<div class="cald">'+head+k+'<div class="bdg">'+modes+cats+work+'</div></div>';
}
function renderHeatmap(){
  var el=document.getElementById('heat');if(!el)return;
  var heat=AN.heatmap||[];
  var wd=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var max=0;
  heat.forEach(function(row){row.forEach(function(v){if(v>max)max=v;});});
  var html='<div class="hm"><div class="hl"></div>';
  for(var h=0;h<24;h++){html+='<div class="hh">'+(h%3===0?h:'')+'</div>';}
  for(var d=0;d<7;d++){
    html+='<div class="hl">'+wd[d]+'</div>';
    for(var hr=0;hr<24;hr++){
      var v=(heat[d]&&heat[d][hr])||0;
      var a=max>0?(0.08+(v/max)*0.92):0.08;
      var min=Math.round(v/60000);
      html+='<div class="hc" style="background:rgba(78,201,176,'+a.toFixed(3)+')" title="'+wd[d]+' '+hr+':00 \\u2014 '+min+'m"></div>';
    }
  }
  html+='</div>';
  el.innerHTML=html;
}
function renderFocus(){
  var el=document.getElementById('focus');
  var f=AN.focus||{};
  var goal=(CFG.dailyActiveGoalMinutes||240);
  var pct=Math.round(f.goalProgressPct||0);
  var goalDoneMin=Math.round((f.totalFocusMsToday||0)/60000);
  var R=64,C=2*Math.PI*R,off=C*(1-Math.min(100,pct)/100);
  var ringColor=pct>=100?'var(--added)':'var(--human)';
  var ring='<div class="ring"><svg width="150" height="150">'
    +'<circle cx="75" cy="75" r="'+R+'" fill="none" stroke="rgba(128,128,128,.18)" stroke-width="12"/>'
    +'<circle cx="75" cy="75" r="'+R+'" fill="none" stroke="'+ringColor+'" stroke-width="12" stroke-linecap="round" stroke-dasharray="'+C.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'"/>'
    +'</svg><div class="rt"><div class="rp" style="color:'+ringColor+'">'+pct+'%</div><div class="rl">of goal</div></div></div>';
  el.innerHTML='<div class="sg">'
    +sc('\\uD83C\\uDFAF Focus Today',fmt(f.totalFocusMsToday||0),'var(--human)')
    +sc('Sessions Today',String(f.sessionsToday||0),'var(--vscode-foreground)')
    +sc('Longest Session',fmt(f.longestMs||0),'var(--ai)')
    +sc('Avg Session',fmt(f.avgMs||0),'var(--review)')
    +'</div>'
    +'<div class="mt2 cr"><div class="card" style="display:flex;flex-direction:column;align-items:center;justify-content:center"><h3>Daily Focus Goal</h3>'+ring
    +'<p style="margin-top:14px;text-align:center;font-size:.9em">'+goalDoneMin+' min of '+goal+' min goal</p></div>'
    +'<div class="card"><h3>Most Productive Hours (all history)</h3><div class="cw" style="height:200px"><canvas id="cHours"></canvas></div></div></div>'
    +'<div class="mt4 card"><h3>\\uD83D\\uDCC5 Today\\u2019s Timeline &mdash; activity by hour</h3><div class="cw" style="height:160px"><canvas id="cTimeline"></canvas></div><p class="mt2 t-sm muted">Active minutes per hour today, split by Human / AI / Review.</p></div>'
    +'<div class="mt4 card"><h3>This Week</h3><div class="mt1 sg">'
    +sc('Focus Time (7d)',fmt(f.totalFocusMsWeek||0),'var(--human)')
    +sc('Sessions (7d)',String(f.sessionsWeek||0),'var(--vscode-foreground)')
    +'</div><p class="mt3 t-sm muted">A focus session = continuous active work (no break longer than your idle threshold). Set your goal with <code>aiEffortTracker.dailyActiveGoalMinutes</code>.</p></div>';
  var heat=AN.heatmap||[];
  var byHour=new Array(24).fill(0);
  heat.forEach(function(row){for(var h=0;h<24;h++){byHour[h]+=(row[h]||0);}});
  dc('hours');
  charts.hours=new Chart(document.getElementById('cHours'),{type:'bar',
    data:{labels:byHour.map(function(_,h){return h;}),
      datasets:[{label:'Active min',data:byHour.map(function(v){return +(v/60000).toFixed(1);}),backgroundColor:'rgba(78,201,176,.7)',borderRadius:3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:dfg()},grid:{display:false},title:{display:true,text:'hour of day',color:dfg()}},
        y:{ticks:{color:dfg()},grid:{color:gc},title:{display:true,text:'min',color:dfg()}}}}});
  var tl=AN.timeline||{humanCoding:[],aiGenerating:[],reviewing:[]};
  var toMin=function(arr){return(arr||[]).map(function(v){return +((v||0)/60000).toFixed(1);});};
  dc('timeline');
  charts.timeline=new Chart(document.getElementById('cTimeline'),{type:'bar',
    data:{labels:Array.from({length:24},function(_,h){return h;}),
      datasets:[{label:'Human',data:toMin(tl.humanCoding),backgroundColor:'rgba(78,201,176,.8)'},
        {label:'AI',data:toMin(tl.aiGenerating),backgroundColor:'rgba(197,134,192,.8)'},
        {label:'Review',data:toMin(tl.reviewing),backgroundColor:'rgba(220,220,170,.8)'}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},
      scales:{x:{stacked:true,ticks:{color:dfg()},grid:{display:false},title:{display:true,text:'hour of day',color:dfg()}},
        y:{stacked:true,ticks:{color:dfg()},grid:{color:gc},title:{display:true,text:'min',color:dfg()}}}}});
}

var projView='list',selProj=null,selWi=null;
var ROI_NONE='\\u2014';
function wiOfProject(pid){
  if(pid==='__none__')return WI.filter(function(w){return!w.projectId;});
  return WI.filter(function(w){return w.projectId===pid;});
}
var CUR_SYM={USD:'$',EUR:'\\u20ac',GBP:'\\u00a3',JPY:'\\u00a5',CHF:'CHF ',CAD:'CA$',AUD:'A$',INR:'\\u20b9',CNY:'\\u00a5',SEK:'kr ',NOK:'kr ',DKK:'kr ',PLN:'z\\u0142 '};
function curSym(cur){return CUR_SYM[String(cur||'USD').toUpperCase()]||null;}
// Format money in the subject's effective currency (issue #45): symbol when known,
// else the currency code. null means a required rate was unconfigured -> ROI_NONE.
function fmtMoney(v,cur,dp){if(v==null)return ROI_NONE;var n=Number(v).toFixed(dp==null?2:dp);var s=curSym(cur);return s?s+n:(cur||'USD')+' '+n;}
function moneyColor(v){return v==null?'inherit':(v>=0?'var(--added)':'var(--deleted)');}
// Effective ROI figures for a branch/work item, always an object (never crashes
// if an older payload lacks .roi). All money already resolved server-side.
function roiOf(x){return (x&&x.roi)?x.roi:{currency:'USD',creditCost:null,netValue:null,soldValue:null,creditCostPerUnit:null,actualHours:null,chargeableHours:null,invoiceValue:null,netGain:null,profit:null};}
// Currency an attributed ledger row should render in: its project's effective
// currency when resolvable, else USD (issue #45 — no hardcoded '$').
function projCurrency(pid){var p=pid&&PROJ.find(function(x){return x.projectId===pid;});return (p&&p.roi&&p.roi.currency)||'USD';}
function aiPctOf(x){return Number(aiPct(x));}
function projToolbar(){
  return'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">'
    +'<button class="dtab" data-action="cmd" data-value="createProject">\\uFF0B New Project</button>'
    +'<button class="dtab" data-action="cmd" data-value="linkRepoToProject">\\uD83D\\uDD17 Link This Repo</button>'
    +'<button class="dtab" data-action="cmd" data-value="createWorkItem">\\uFF0B New Work Item</button>'
    +'<button class="dtab" data-action="cmd" data-value="editWorkItem">\\u270E Edit Work Item</button>'
    +'<button class="dtab" data-action="cmd" data-value="assignWorkItemToProject">\\uD83D\\uDCC1 Assign to Project</button>'
    +'<button class="dtab" data-action="cmd" data-value="setDeveloperProfile">\\uD83D\\uDC64 Developer Profile</button>'
    +'</div>';
}
function projectRowsHtml(){
  var rows=PROJ.map(function(p){
    var act=activeMsOf(p);
    var roi=(p.roi&&p.roi.netValue!=null)?fmtMoney(p.roi.netValue,p.roi.currency):ROI_NONE;
    var reposTxt=(p.repos&&p.repos.length)?esc(p.repos.join(', ')):ROI_NONE;
    return'<tr data-action="proj" data-value="'+esc(p.projectId)+'"><td><strong>'+esc(p.name)+'</strong></td><td class="mono">'+reposTxt+'</td><td>'+p.workItemIds.length+'</td><td>'+fmt(act)+'</td><td>'+((p.credits&&p.credits.credits)||0).toFixed(1)+'</td><td>'+roi+'</td></tr>';
  });
  var none=wiOfProject('__none__');
  if(none.length){
    var act=none.reduce(function(a,w){return a+activeMsOf(w);},0);
    var cr=none.reduce(function(a,w){return a+(w.creditsTotal||0);},0);
    rows.push('<tr data-action="proj" data-value="__none__"><td><strong>\\uD83D\\uDCE5 Unassigned</strong><div class="t-sm muted">work items with no project</div></td><td>'+ROI_NONE+'</td><td>'+none.length+'</td><td>'+fmt(act)+'</td><td>'+cr.toFixed(1)+'</td><td>'+ROI_NONE+'</td></tr>');
  }
  if(!rows.length)return'<tr class="empty-row"><td colspan="6">No projects yet \\u2014 use \\u201cNew Project\\u201d to create one and link this repo.</td></tr>';
  return rows.join('');
}
function renderProjectList(){
  var el=document.getElementById('projects');
  el.innerHTML=projToolbar()
    +'<table><thead><tr><th>Project</th><th>Repos</th><th>Work Items</th><th>Active</th><th>Credits</th><th>ROI Net</th></tr></thead><tbody>'+projectRowsHtml()+'</tbody></table>'
    +'<p class="mt3 t-sm muted">Project ROI net = value produced \\u2212 cost from the project\\u2019s effective rates. \\u201c\\u2014\\u201d means a required rate is not configured (set it with \\u201cSet Rates\\u201d).</p>';
}
// Work-item budgets (issue #94). The status is computed server-side
// (analysis/budget.ts) and rides on each work item summary as w.budget.
var BUD_COL={ok:'var(--added)',warning:'var(--review)',over:'var(--deleted)',unestimated:'var(--muted)'};
var BUD_DIM={time:'time',credits:'credits',cost:'cost'};
function budRisk(w){var b=w.budget;return(b&&b.pct!=null)?b.pct:-1;}
function budVal(k,v,cur){return k==='time'?(Math.round(v*10)/10)+'h':k==='credits'?(Math.round(v*10)/10)+' cr':fmtMoney(v,cur);}
function budBar(b){
  if(!b||b.state==='unestimated')return'<span class="dim badge" title="No hour estimate or budget \\u2014 set one to track consumption">unestimated</span>';
  return'<div class="bud" title="'+esc(BUD_DIM[b.worst]+': '+b.pct+'% used')+'"><div class="budf" style="width:'+Math.min(100,b.pct)+'%;background:'+BUD_COL[b.state]+'"></div></div><div style="font-size:.75em;color:'+BUD_COL[b.state]+'">'+b.pct+'% '+esc(BUD_DIM[b.worst])+'</div>';
}
function budgetCardHtml(w,cur){
  var b=w.budget;if(!b)return'';
  var btns='<button class="dtab" data-action="budSet" data-id="'+esc(w.workItemId)+'">\\uD83D\\uDCB0 Set Budget</button> <button class="dtab" data-action="estSet" data-id="'+esc(w.workItemId)+'">\\uD83D\\uDCCF Estimate</button>';
  var head='<div class="hbar"><h3>\\uD83C\\uDFAF Budget</h3><div>'+btns+'</div></div>';
  if(b.state==='unestimated'){
    return'<div class="mt3 card">'+head+'<p class="muted mt2">This work item has no hour estimate and no credit or money budget, so it cannot be tracked against one. Used so far: '+budVal('time',b.used.hours)+' \\u00b7 '+budVal('credits',b.used.credits)+'.</p></div>';
  }
  var src={explicit:'set explicitly',estimate:'from the estimate',project:'estimate \\u00d7 project credits/hour'};
  var R=roiOf(w);
  var rows=['time','credits','cost'].filter(function(k){return b.dims[k];}).map(function(k){
    var d=b.dims[k];var st=d.pct>=100?'over':(b.crossed.length&&d.pct>=Math.min.apply(null,b.crossed))?'warning':'ok';
    return'<tr title="'+esc(budgetTip(k,d,b,R,cur))+'" style="cursor:help"><td class="nw"><strong>'+esc(BUD_DIM[k])+'</strong> <span style="opacity:.55">\\u24D8</span><div class="t-xs muted">'+esc(src[d.source]||d.source)+'</div></td>'
      +'<td style="width:40%"><div class="bud"><div class="budf" style="width:'+Math.min(100,d.pct)+'%;background:'+BUD_COL[st]+'"></div></div></td>'
      +'<td style="white-space:nowrap;color:'+BUD_COL[st]+'">'+d.pct+'%</td>'
      +'<td class="nw">'+budVal(k,d.used,cur)+' / '+budVal(k,d.budget,cur)+'</td>'
      +'<td class="nw">'+(d.remaining>=0?budVal(k,d.remaining,cur)+' left':'<span class="c-del">'+budVal(k,-d.remaining,cur)+' over</span>')+'</td></tr>';
  }).join('');
  var p=b.projection,bn=b.burn;
  var pace='Last '+bn.days+' days: '+budVal('time',bn.hoursPerDay)+'/day \\u00b7 '+budVal('credits',bn.creditsPerDay)+'/day'+(bn.costPerDay!=null?' \\u00b7 '+fmtMoney(bn.costPerDay,cur)+'/day':'')+'. ';
  var proj=!p?'No recent activity, so no run-out projection.':p.daysLeft<=0?'<span class="c-del">The '+esc(BUD_DIM[p.dimension])+' budget is used up.</span>':'At this pace the '+esc(BUD_DIM[p.dimension])+' budget runs out in <strong>'+p.daysLeft+' days</strong> (around '+esc(p.date)+').';
  var cats=(b.categories||[]).filter(function(c){return c.budgetHours>0||c.usedHours>0;});
  var catHtml=cats.some(function(c){return c.budgetHours>0;})?'<table class="mt3"><thead><tr><th>Category</th><th>Estimate</th><th>Used (by line share)</th><th>%</th></tr></thead><tbody>'+cats.map(function(c){return'<tr><td>'+esc(CAT[c.category]||c.category)+'</td><td>'+(c.budgetHours?budVal('time',c.budgetHours):'\\u2014')+'</td><td>'+budVal('time',c.usedHours)+'</td><td style="color:'+(c.pct==null?'inherit':c.pct>=100?'var(--deleted)':'inherit')+'">'+(c.pct==null?'\\u2014':c.pct+'%')+'</td></tr>';}).join('')+'</tbody></table>':'';
  var br=b.branches||[];
  var brHtml=br.length>1?'<table class="mt3"><thead><tr><th>Branch</th><th>Hours</th><th>Credits</th></tr></thead><tbody>'+br.map(function(x){return'<tr><td>'+esc(x.branch)+'</td><td>'+budVal('time',x.hours)+' ('+x.hoursPct+'%)</td><td>'+budVal('credits',x.credits)+' ('+x.creditsPct+'%)</td></tr>';}).join('')+'</tbody></table>':'';
  return'<div class="mt3 card">'+head
    +'<table class="mt2"><tbody>'+rows+'</tbody></table>'
    +'<p style="margin-top:8px;font-size:.85em;cursor:help" title="'+esc('Average per day over the last '+bn.days+' days, counting days without work too.'+(bn.costPerDay!=null?'\\nCost/day = hours/day \\u00d7 cost rate + credits/day \\u00d7 credit price.':'')+'\\nRun-out = what is left of a budget \\u00f7 its daily pace; the budget that runs out first is shown.')+'">'+pace+proj+'</p>'
    +'<div class="cw" style="height:200px;margin-top:10px"><canvas id="cBudget"></canvas></div>'
    +catHtml+brHtml
    +'<p class="mt2 t-sm muted">Consumption across all branches, manual effort and the credit ledger. Alerts fire once per threshold crossing (settings: aiEffortTracker.budget.*).</p></div>';
}
function renderBudgetChart(w){
  dc('budget');
  var cv=document.getElementById('cBudget');var b=w.budget;
  if(!cv||!b||!b.series||!b.series.length||typeof Chart==='undefined')return;
  var labels=b.series.map(function(s){return s.date.slice(5);});
  var ds=[{label:'Hours used',data:b.series.map(function(s){return s.hours;}),borderColor:'rgba(78,201,176,1)',backgroundColor:'rgba(78,201,176,.15)',fill:true,tension:.2,pointRadius:0,yAxisID:'y'},
    {label:'Credits used',data:b.series.map(function(s){return s.credits;}),borderColor:'rgba(206,145,120,1)',tension:.2,pointRadius:0,yAxisID:'y1'}];
  if(b.dims.time)ds.push({label:'Hour budget',data:b.series.map(function(){return b.dims.time.budget;}),borderColor:'rgba(78,201,176,.6)',borderDash:[6,4],pointRadius:0,yAxisID:'y'});
  if(b.dims.credits)ds.push({label:'Credit budget',data:b.series.map(function(){return b.dims.credits.budget;}),borderColor:'rgba(206,145,120,.6)',borderDash:[6,4],pointRadius:0,yAxisID:'y1'});
  charts.budget=new Chart(cv,{type:'line',data:{labels:labels,datasets:ds},options:{animation:false,responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:fg()}}},scales:{x:{ticks:{color:dfg(),maxTicksLimit:10},grid:{color:gc}},y:{beginAtZero:true,position:'left',ticks:{color:dfg()},grid:{color:gc},title:{display:true,text:'hours',color:dfg()}},y1:{beginAtZero:true,position:'right',ticks:{color:dfg()},grid:{drawOnChartArea:false},title:{display:true,text:'credits',color:dfg()}}}}});
}
function wiRowsHtml(items){
  var rows=items.map(function(w){
    var I=insights(w);
    var est=w.estimate!=null?(w.estimate+' '+(w.estimateUnit||'hours')):ROI_NONE;
    var roiColor=moneyColor(I.roi);
    return'<tr data-action="wi" data-value="'+esc(w.workItemId)+'"><td><strong>'+esc(w.title||('#'+w.workItemId))+'</strong><div class="t-sm muted">#'+esc(w.workItemId)+'</div></td><td>'+est+'</td><td>'+budBar(w.budget)+'</td><td>'+fmt(activeMsOf(w))+'</td><td><span class="badge '+(aiPctOf(w)>50?'ba':'bh')+'">'+aiPctOf(w)+'%</span></td><td>'+(w.creditsTotal||0).toFixed(1)+'</td><td style="color:'+roiColor+'">'+fmtMoney(I.roi,I.currency)+'</td></tr>';
  });
  if(!rows.length)return'<tr class="empty-row"><td colspan="7">No work items here yet.</td></tr>';
  return rows.join('');
}
function renderProjectDetail(){
  var el=document.getElementById('projects');
  var p=PROJ.find(function(x){return x.projectId===selProj;});
  var isNone=selProj==='__none__';
  if(!p&&!isNone){projView='list';return renderProjectList();}
  var items=wiOfProject(selProj).slice().sort(function(a,b){return budRisk(b)-budRisk(a);});
  var name=isNone?'\\uD83D\\uDCE5 Unassigned':esc(p.name);
  var act=isNone?items.reduce(function(a,w){return a+activeMsOf(w);},0):activeMsOf(p);
  var credits=isNone?items.reduce(function(a,w){return a+(w.creditsTotal||0);},0):((p.credits&&p.credits.credits)||0);
  var roi=(!isNone&&p.roi&&p.roi.netValue!=null)?fmtMoney(p.roi.netValue,p.roi.currency):ROI_NONE;
  var repos=(!isNone&&p.repos&&p.repos.length)?esc(p.repos.join(', ')):ROI_NONE;
  var PCF=(!isNone&&p.confidence)||null;
  function PC(k,what,unit){return PCF?confBadge(PCF[k],what,unit):'';}
  var setRates=isNone?'':'<button class="dtab" data-action="ratesSet" data-id="'+esc(p.projectId)+'" title="Edit this project\\u2019s rates">\\u270E Edit Rates</button>';
  el.innerHTML='<button class="back" data-action="pprojects">\\u2190 Projects</button>'
    +'<div class="sg"><div class="st"><div class="lbl">Project</div><div class="val" style="font-size:.95em;word-break:break-word">'+name+'</div></div>'
    +'<div class="st"><div class="lbl">Active Time'+PC('time','Time','ms')+'</div><div class="val">'+fmt(act)+'</div></div>'
    +'<div class="st"><div class="lbl">Credits'+PC('credits','Credits','credits')+'</div><div class="c-cost val">'+credits.toFixed(1)+'</div></div>'
    +'<div class="st"><div class="lbl">ROI Net'+PC('roi','ROI','ms')+'</div><div class="val">'+roi+'</div></div></div>'+(PCF?cfLegend():'')
    +translationSummaryHtml(p)
    +'<p class="sub" style="margin:12px 0 6px">Repos: '+repos+'</p>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">'+setRates+'<button class="dtab" data-action="cmd" data-value="createWorkItem">\\uFF0B New Work Item</button><button class="dtab" data-action="cmd" data-value="assignWorkItemToProject">\\uD83D\\uDCC1 Assign Work Item</button></div>'
    +'<table><thead><tr><th>Work Item</th><th>Estimate</th><th title="Worst budget dimension (time, credits or cost); sorted by risk">Budget</th><th>Actual</th><th>AI %</th><th>Credits</th><th>ROI</th></tr></thead><tbody>'+wiRowsHtml(items)+'</tbody></table>';
}
function meModeLabel(m){return {humanCoding:'Human coding',aiGenerating:'AI generating',reviewing:'Reviewing',idle:'Idle'}[m]||m;}
function meFor(wid){return (ME||[]).filter(function(e){return e.workItemId===wid;});}
function manualSplitHtml(w,T){
  T=T||{};
  var man=w.manual||{humanCodingMs:0,aiGeneratingMs:0,reviewingMs:0,linesHumanAdded:0,linesAiAdded:0,entries:0};
  var manAct=(man.humanCodingMs||0)+(man.aiGeneratingMs||0)+(man.reviewingMs||0);
  var autoAct=Math.max(0,activeMsOf(w)-manAct);
  var manLines=(man.linesHumanAdded||0)+(man.linesAiAdded||0);
  return'<div class="mt1 sg">'
    +sc('Auto-tracked',fmt(autoAct),'var(--human)',T.auto)
    +sc('Manual',fmt(manAct),'var(--review)',T.manual)
    +sc('Manual +Lines','+'+manLines,'var(--ai)',T.manLines)
    +sc('Manual Entries',String(man.entries||0),'var(--cost)',T.manEntries)
    +'</div>';
}
function manualRowsHtml(wid){
  var list=meFor(wid);
  if(!list.length)return'<tr class="empty-row"><td colspan="5">No manual entries yet. Use \\u201c\\uFF0B Add Effort\\u201d to record one.</td></tr>';
  return list.map(function(e){
    var when=new Date(e.ts).toLocaleString();
    var time=(e.mode&&e.durationMs)?esc(meModeLabel(e.mode))+' '+fmt(e.durationMs):'\\u2014';
    var lines=e.category?((e.isAi?'AI':'Human')+' '+esc(CAT[e.category]||e.category)+' +'+(e.linesAdded||0)+'/-'+(e.linesDeleted||0)):'\\u2014';
    var note=e.note?esc(e.note):'';
    return'<tr><td class="nw">'+esc(when)+'</td><td>'+time+'</td><td>'+lines+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+note+'">'+note+'</td><td class="nw"><button class="dtab" data-action="meEdit" data-id="'+esc(e.id)+'" title="Edit entry">\\u270E</button> <button class="dtab" data-action="meDel" data-id="'+esc(e.id)+'" title="Delete entry">\\uD83D\\uDDD1</button></td></tr>';
  }).join('');
}
// #60: Time Log card. Entries ride on the branch/work-item summary objects, so
// they arrive newest-first already. We group them by local day (newest day
// first) with a per-day subtotal and a grand total.
function timeLogRowsHtml(list){
  if(!list||!list.length)return'<tr class="empty-row"><td colspan="5">No time entries yet. Use \\u201c\\u2795 Add time entry\\u201d to log one.</td></tr>';
  var groups=[];var idx={};
  list.forEach(function(e){
    var ts=(typeof e.startTs==='number')?e.startTs:e.createdAt;
    var d=new Date(ts);
    var key=d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
    if(idx[key]===undefined){idx[key]=groups.length;groups.push({label:d.toLocaleDateString(),entries:[],total:0});}
    var g=groups[idx[key]];g.entries.push(e);g.total+=(e.durationMs||0);
  });
  var grand=0;var rows='';
  groups.forEach(function(g){
    rows+='<tr style="background:var(--vscode-editor-lineHighlightBackground)"><td colspan="4"><strong>'+esc(g.label)+'</strong></td><td class="nw ta-r"><strong>'+fmt(g.total)+'</strong></td></tr>';
    g.entries.forEach(function(e){
      grand+=(e.durationMs||0);
      var span='\\u2014';
      if(typeof e.startTs==='number'){
        var s=new Date(e.startTs).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        var en=(typeof e.endTs==='number')?new Date(e.endTs).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'\\u2026';
        span=esc(s)+'\\u2013'+esc(en);
      }
      var tag=[];
      if(e.mode)tag.push(esc(meModeLabel(e.mode)));
      if(e.category)tag.push(esc(e.category));
      var kind=tag.join(' \\u00b7 ')||'\\u2014';
      var src='<span class="badge '+(e.source==='auto'?'ba':'bh')+'">'+(e.source==='auto'?'auto':'manual')+'</span>';
      var note=e.note?esc(e.note):'';
      rows+='<tr><td class="nw">'+span+'</td><td class="nw">'+fmt(e.durationMs||0)+'</td><td>'+kind+' '+src+'</td><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis" title="'+note+'">'+note+'</td><td class="nw"><button class="dtab" data-action="teEdit" data-id="'+esc(e.id)+'" title="Edit entry">\\u270E</button> <button class="dtab" data-action="teDel" data-id="'+esc(e.id)+'" title="Delete entry">\\uD83D\\uDDD1</button></td></tr>';
    });
  });
  rows+='<tr><td colspan="4" class="ta-r"><strong>Grand total</strong></td><td class="nw ta-r"><strong>'+fmt(grand)+'</strong></td></tr>';
  return rows;
}
// btnAttrs pre-seeds the add flow (data-id=work item and/or data-branch); the
// delegation handler joins them with the \\u0000 delimiter (as adjustTrackedTime does).
function timeLogCardHtml(entries,btnAttrs){
  return'<div class="mt3 card"><div class="hbar"><h3>\\u23F1 Time Log</h3><button class="dtab" data-action="teAdd" '+btnAttrs+'>\\u2795 Add time entry</button></div>'
    +'<table class="mt2"><thead><tr><th>Time</th><th>Duration</th><th>Kind</th><th>Note</th><th></th></tr></thead><tbody>'+timeLogRowsHtml(entries)+'</tbody></table>'
    +'<p class="mt2 t-sm muted">Discrete time entries grouped by day. Manual entries roll up into Active Time &amp; ROI above (no double count).</p></div>';
}
function reFor(wid){return (RE||[]).filter(function(r){return r.toWorkItemId===wid||r.fromWorkItemId===wid;});}function reassignRowsHtml(wid){
  var list=reFor(wid);
  if(!list.length)return'<tr class="empty-row"><td colspan="4">No reassignments touch this work item yet.</td></tr>';
  return list.map(function(r){
    var when=new Date(r.ts).toLocaleString();
    var from=r.fromWorkItemId?('#'+esc(r.fromWorkItemId)):'\\u2014';
    var dir=from+' \\u2192 #'+esc(r.toWorkItemId);
    var note=r.note?esc(r.note):'';
    return'<tr><td class="nw">'+esc(when)+'</td><td><strong>'+esc(r.branch)+'</strong></td><td class="nw">'+dir+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+note+'">'+note+'</td></tr>';
  }).join('');
}
function renderWorkItemDetail(){
  var el=document.getElementById('projects');
  var w=WI.find(function(x){return x.workItemId===selWi;});
  if(!w){projView='list';return renderProjectList();}
  var I=insights(w);
  var T=wiTips(w,I);
  var G=w.generated||{};
  var WC=w.confidence||{};
  var genH=(typeof G.equivalentHours==='number')?(Math.round(G.equivalentHours*100)/100):null;
  var genNote=(genH==null)?'':' <span class="muted t-xs">\\u2248 '+genH+'h generated</span>';
  var est=w.estimate!=null?(w.estimate+' '+(w.estimateUnit||'hours')):ROI_NONE;
  var backTarget=w.projectId?w.projectId:'__none__';
  var branchRows=(w.branches||[]).map(function(b){
    var d=allData.find(function(x){return x.branch===b;});
    var act=d?tms(d):0;var ai=d?aiPct(d):0;
    return'<tr data-action="detail" data-value="'+esc(b)+'"><td><strong>'+esc(b)+'</strong></td><td>'+fmt(act)+'</td><td><span class="badge '+(ai>50?'ba':'bh')+'">'+ai+'%</span></td><td>'+(d?'$'+d.estimatedCostUsd.toFixed(4):ROI_NONE)+'</td><td class="nw"><button class="dtab" data-action="moveBranch" data-id="'+esc(b)+'" title="Move to another work item">\\u2192 Move</button></td></tr>';
  });
  if(!branchRows.length)branchRows=['<tr class="empty-row"><td colspan="5">No branches roll up into this work item yet.</td></tr>'];
  el.innerHTML='<button class="back" data-action="proj" data-value="'+esc(backTarget)+'">\\u2190 Back</button>'
    +'<div class="sg"><div class="st"><div class="lbl">Work Item</div><div class="val" style="font-size:.95em;word-break:break-word">'+esc(w.title||('#'+w.workItemId))+'</div><div class="t-sm muted">#'+esc(w.workItemId)+(w.status==='done'?' <span class="badge bh" title="Done'+(w.doneAt?' '+esc(new Date(w.doneAt).toLocaleDateString()):'')+'">\\u2713 done</span>':'')+'</div></div>'
    +'<div class="st tip" title="'+esc(T.estimate)+'"><div class="lbl">Estimate <button class="dtab" data-action="estSet" data-id="'+esc(w.workItemId)+'" title="Edit estimate" style="padding:0 5px;line-height:1.4">\\u270E</button></div><div class="val">'+est+'</div></div>'
    +sc('Actual'+confBadge(WC.time,'Time','ms'),fmt(activeMsOf(w)),'inherit',T.actual)
    +sc('Net ROI / AI gain'+confBadge(WC.roi,'ROI','ms'),fmtMoney(I.netGain,I.currency),moneyColor(I.netGain),T.netGain)+'</div>'
    +'<div class="mt1 sg">'
    +sc('Invoice value'+confBadge(WC.roi,'Invoice value','ms'),fmtMoney(I.invoiceValue,I.currency),moneyColor(I.invoiceValue),T.invoice)
    +sc('Profit'+confBadge(WC.roi,'Profit','ms'),fmtMoney(I.profit,I.currency),moneyColor(I.profit),T.profit)
    +sc('Actual hrs'+confBadge(WC.time,'Time','ms'),(I.actualHours==null?ROI_NONE:(Math.round(I.actualHours*100)/100)+'h')+genNote,'var(--human)',T.actualHrs)
    +sc('Billable hrs',(I.billableHours==null?ROI_NONE:(Math.round(I.billableHours*100)/100)+'h'),'var(--ai)',T.billable)
    +sc('Generated value'+confBadge(WC.lines,'Lines','lines'),fmtMoney(G.generatedValue,I.currency),moneyColor(G.generatedValue),T.generated)
    +'</div>'
    +'<div class="mt1 sg">'
    +sc('AI Share',aiPctOf(w)+'%','var(--ai)',T.aiShare)
    +sc('Credits'+confBadge(WC.credits,'Credits','credits'),(w.creditsTotal||0).toFixed(1),'var(--cost)',T.credits)
    +sc('AI Spend'+confBadge(WC.credits,'AI spend (from credits)','credits'),fmtMoney(I.aiCost,I.currency),'var(--cost)',T.aiSpend)
    +sc('Time Saved',fmtMin(I.timeSavedMin),I.timeSavedMin>=0?'var(--added)':'var(--deleted)',T.timeSaved)
    +reworkStat(w,I)
    +'</div>'
    +(w.confidence?cfLegend():'')
    +manualSplitHtml(w,T)
    +budgetCardHtml(w,I.currency)
    +reviewCardHtml(w)
    +translationSummaryHtml(w)
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin:14px 0"><button class="dtab" data-action="estSet" data-id="'+esc(w.workItemId)+'">\\uD83D\\uDCCF Set Estimate</button>'+(w.status==='done'?'<button class="dtab" data-action="wiReopen" data-id="'+esc(w.workItemId)+'" title="Reopen: count this work item as in progress again">\\u21BA Reopen</button>':'<button class="dtab" data-action="wiDone" data-id="'+esc(w.workItemId)+'" title="Mark done: it then counts toward estimate accuracy and suggestions">\\u2713 Mark Done</button>')+'<button class="dtab" data-action="bhSet" data-id="'+esc(w.workItemId)+'">\\uD83D\\uDCB5 Set Billable Hours</button>'+(genH==null?'':'<button class="dtab" data-action="bhUse" data-id="'+esc(w.workItemId)+'" data-hours="'+esc(genH)+'" title="Prefill billable hours with the generated-lines equivalent (\\u2248 '+genH+'h)">\\u26A1 Use as Billable Hours</button>')+'<button class="dtab" data-action="cmd" data-value="assignWorkItemToProject">\\uD83D\\uDCC1 Assign to Project</button><button class="dtab" data-action="reassignBulk" data-id="'+esc(w.workItemId)+'">\\uD83D\\uDD00 Reassign Branches\\u2026</button><button class="dtab" data-action="meAdd" data-id="'+esc(w.workItemId)+'">\\uFF0B Add Effort</button><button class="dtab" data-action="wiDel" data-id="'+esc(w.workItemId)+'" title="Delete this work item \\u2014 its branches, credits and effort move to Unassigned (nothing is deleted)">\\uD83D\\uDDD1 Delete Work Item</button></div>'
    +'<div class="card"><h3>Branches</h3><table class="mt2"><thead><tr><th>Branch</th><th>Active</th><th>AI %</th><th>Cost</th><th></th></tr></thead><tbody>'+branchRows.join('')+'</tbody></table><p class="mt2 t-sm muted">Click a branch to open its full detail, or \\u201c\\u2192 Move\\u201d to re-home it to another work item.</p></div>'
    +'<div class="mt3 card"><h3>Manual Effort</h3><table class="mt2"><thead><tr><th>When</th><th>Time</th><th>Lines</th><th>Note</th><th></th></tr></thead><tbody>'+manualRowsHtml(w.workItemId)+'</tbody></table><p class="mt2 t-sm muted">Manual entries are hand-recorded corrections folded into the totals above.</p></div>'
    +timeLogCardHtml(w.timeEntries||[],'data-id="'+esc(w.workItemId)+'"')
    +'<div class="mt3 card"><h3>Reassignment History</h3><table class="mt2"><thead><tr><th>When</th><th>Branch</th><th>From \\u2192 To</th><th>Note</th></tr></thead><tbody>'+reassignRowsHtml(w.workItemId)+'</tbody></table><p class="mt2 t-sm muted">Audit trail of branch \\u2192 work item moves touching this work item (newest first).</p></div>';
  renderBudgetChart(w);
}
function renderProjectsView(){
  if(projView==='project')return renderProjectDetail();
  if(projView==='workitem')return renderWorkItemDetail();
  return renderProjectList();
}
// Credit ledger list (issue #19). The ledger is the single source of truth, so
// editing/deleting a row here corrects every derived total automatically.
// Open deep-analysis rows and the last rendered markup survive the periodic 5s
// refresh: unchanged data is not re-rendered, changed data re-opens the rows.
var ledOpen={},ledHtml='';
function renderLedger(){
  var el=document.getElementById('ledger');
  var add='<button class="dtab" data-action="cmd" data-value="logCredits">\\uFF0B Add Entry</button> <button class="dtab" data-action="cmd" data-value="importRealCredits" title="Import recorded credits from a Copilot Chat Debug export">\\u2B07 Import Real Credits</button>';
  add+=' <button class="dtab" data-action="cmd" data-value="importDebugSession">Import Debug Session</button>';
  if(!LEDGER||!LEDGER.length){
    ledHtml='';ledOpen={};
    el.innerHTML='<div class="hbar mb3"><h2>\\uD83E\\uDDFE Credit Ledger</h2>'+add+'</div>'+emptyState('No credit entries yet','Credits are captured from the chat debug log as you use Copilot. Use \\u201cAdd Entry\\u201d to record one by hand.');
    return;
  }
  var LV=LEDGER.filter(function(e){return gfInTs(e.ts)&&gfScope(e.projectId,e.workItemId);});
  var rows=(LV.length?LV:[]).map(function(e){
    var when=new Date(e.ts).toLocaleString();
    var attr=e.branch?esc(e.branch):'\\u2014';
    if(e.workItemId)attr+=' <span class="badge ba">#'+esc(e.workItemId)+'</span>';
    var cost=(e.cost!=null)?fmtMoney(Number(e.cost),projCurrency(e.projectId),4):'\\u2014';
    var note=e.note?esc(e.note):'';
    var sc=e.source==='manual'?'bh':(e.source==='auto'?'ba':'bp');
    var src='<span class="badge '+sc+'">'+esc(e.source)+'</span>';
    if(e.debugUsage)src+='<span class="badge bp" title="'+Number(e.credits).toFixed(6)+' ledger credits">'+(e.debugUsage.creditsOverridden?'manually adjusted':e.debugUsage.unpricedRequests?'partial: '+e.debugUsage.unpricedRequests+' unpriced':'recorded')+'</span>';
    if(e.debugUsage&&e.debugUsage.logWarnings)src+='<span class="badge bd">log warnings</span>';
    var dbtn=e.analysis?'<button class="dtab" data-action="ledDetail" data-id="'+esc(e.id)+'" title="Deep analysis \\u2014 lines, tools, token cost">\\uD83D\\uDD0D</button> ':'';
    return'<tr id="led-'+esc(e.id)+'"'+(e.analysis?' style="cursor:pointer" data-action="ledDetail" data-id="'+esc(e.id)+'"':'')+'><td class="nw">'+esc(when)+'</td><td>'+esc(e.model)+'</td><td class="nw">'+Number(e.credits).toFixed(1)+cfRowBadge(e)+'</td><td>'+cost+'</td><td>'+src+'</td><td>'+attr+'</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis" title="'+note+'">'+note+'</td><td class="nw">'+dbtn+'<button class="dtab" data-action="ledEdit" data-id="'+esc(e.id)+'" title="Edit entry">\\u270E</button> <button class="dtab" data-action="ledDel" data-id="'+esc(e.id)+'" title="Delete entry">\\uD83D\\uDDD1</button></td></tr>';
  }).join('');
  var html='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h2>\\uD83E\\uDDFE Credit Ledger</h2>'+add+'</div>'
    +'<p class="sub">Every credit entry, newest first. Edit or delete any row to correct the ledger \\u2014 totals and ROI recompute automatically.'+(LV.length!==LEDGER.length?' Showing '+LV.length+' of '+LEDGER.length+' entries.':'')+'</p>'+cfLegend()
    +'<div class="card">'+(LV.length?'':emptyState('No entries match the filter','Widen the date range or clear the project and work item in the filter bar.'))+'<table><thead><tr><th>When</th><th>Model</th><th>Credits</th><th>Cost</th><th>Source</th><th>Attribution</th><th>Note</th><th>Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  if(html===ledHtml&&el.querySelector('table'))return;
  ledHtml=html;
  el.innerHTML=html;
  Object.keys(ledOpen).forEach(function(id){if(!openLedgerDetail(id))delete ledOpen[id];});
}

// Deep credit analysis drill-down (issue #74). Toggles an expandable detail row
// under a ledger entry, rendered entirely client-side from the analysis already
// embedded on the LEDGER entry (no round-trip). Shows per-file line impact, tool
// usage, and per-tier token cost so the user can spot optimization potential.
function ledBase(p){if(!p)return'';var i=Math.max(p.lastIndexOf('/'),p.lastIndexOf('\\\\'));return i>=0?p.slice(i+1):p;}
function ledTierRow(label,tokens,credits,total,hint){
  var pct=total>0?((credits/total)*100):0;
  return'<tr><td>'+label+'</td><td class="dc">'+tokens.toLocaleString()+'</td><td class="dc">'+credits.toFixed(2)+'</td><td class="dc">'+pct.toFixed(0)+'%</td><td class="t-sm muted">'+hint+'</td></tr>';
}
function toggleLedgerDetail(id){
  var existing=document.getElementById('led-detail-'+id);
  if(existing){existing.parentNode.removeChild(existing);delete ledOpen[id];return;}
  if(openLedgerDetail(id))ledOpen[id]=true;
}
function openLedgerDetail(id){
  var row=document.getElementById('led-'+id);
  if(!row)return false;
  var e=LEDGER.find(function(x){return String(x.id)===String(id);});
  if(!e||!e.analysis){return false;}
  var an=e.analysis;
  var tc=an.tierCredits||{input:0,cacheRead:0,cacheWrite:0,output:0};
  var tt=an.tiers||{input:0,cacheRead:0,cacheWrite:0,output:0};
  var credTotal=(tc.input||0)+(tc.cacheRead||0)+(tc.cacheWrite||0)+(tc.output||0);
  var netLines=(an.totalAdded||0)-(an.totalRemoved||0);
  // Token-efficiency insight
  var freshPct=credTotal>0?((tc.input||0)/credTotal*100):0;
  var cachePct=credTotal>0?((tc.cacheRead||0)/credTotal*100):0;
  var outPct=credTotal>0?((tc.output||0)/credTotal*100):0;
  var tip;
  if(freshPct>=55)tip='\\u26A0\\uFE0F '+freshPct.toFixed(0)+'% of credits went to <strong>fresh input</strong> (uncached context). Trimming attached files / shorter context, or reusing the same session, would cut cost the most.';
  else if(cachePct>=40)tip='\\u2705 '+cachePct.toFixed(0)+'% of credits were <strong>cache reads</strong> (10\\u00D7 cheaper) \\u2014 good context reuse.';
  else if(outPct>=55)tip='\\uD83D\\uDCA1 '+outPct.toFixed(0)+'% of credits were <strong>output</strong> generation. Cost is driven by how much the model wrote, not context \\u2014 expected for large edits.';
  else tip='Balanced input/output profile.';
  var tiersTbl='<table class="my1"><thead><tr><th>Token tier</th><th class="dc">Tokens</th><th class="dc">Credits</th><th class="dc">% cost</th><th>\\u00A0</th></tr></thead><tbody>'
    +ledTierRow('Fresh input',tt.input||0,tc.input||0,credTotal,'new context (most expensive/token)')
    +ledTierRow('Cache read',tt.cacheRead||0,tc.cacheRead||0,credTotal,'reused context (10\\u00D7 cheaper)')
    +ledTierRow('Cache write',tt.cacheWrite||0,tc.cacheWrite||0,credTotal,'storing context for reuse')
    +ledTierRow('Output',tt.output||0,tc.output||0,credTotal,'model-generated tokens')
    +'</tbody></table>';
  if(e.debugUsage){
    var reqs=e.debugUsage.requests||[];
    var cachedKnown=reqs.every(function(r){return typeof r.cachedTokens==='number';});
    var cached=reqs.reduce(function(n,r){return n+(r.cachedTokens||0);},0);
    tip='Recorded charges include the model request\\u2019s billing rules. Per-tier credit prices are not reported here; no cache discount or price estimate is applied again.'
      +(e.debugUsage.unpricedRequests?' <strong>Incomplete request detail: '+e.debugUsage.unpricedRequests+' model call(s) lack a per-call charge.</strong>':'')
      +(e.debugUsage.exportCredits!==undefined?' A matched export supplies an aggregate charge; the ledger retains the larger recorded total.':'')
      +(e.debugUsage.logWarnings?' <strong>Some log records or edit counts could not be read. Usage or code impact may be incomplete; see Debug Usage output.</strong>':'')
      +(e.debugUsage.creditsOverridden?' <strong>The ledger amount is manually overridden; capture will preserve your correction.</strong>':'');
    var recorded=reqs.reduce(function(n,r){return n+(r.credits||0);},0);
    tiersTbl='<table><tbody><tr><td>Model calls</td><td>'+reqs.length+'</td></tr><tr><td>Input tokens</td><td>'+(e.promptTokens||0).toLocaleString()+'</td></tr><tr><td>Output tokens</td><td>'+(e.completionTokens||0).toLocaleString()+'</td></tr><tr><td>Cached input tokens (part of input)</td><td>'+(cachedKnown?cached.toLocaleString():'Not fully reported')+'</td></tr><tr><td>Known per-call credits</td><td>'+recorded.toFixed(6)+'</td></tr></tbody></table>';
    var models=new Map();
    reqs.forEach(function(r){
      var m=models.get(r.model)||{calls:0,input:0,output:0,credits:0,unknown:0};
      m.calls++;m.input+=r.inputTokens;m.output+=r.outputTokens;
      if(r.credits===null)m.unknown++;else m.credits+=r.credits;
      models.set(r.model,m);
    });
    tiersTbl+='<table><thead><tr><th>Model</th><th>Calls</th><th>Input / output</th><th>Known credits</th></tr></thead><tbody>'+Array.from(models).map(function(pair){
      var m=pair[1];return'<tr><td>'+esc(pair[0])+'</td><td>'+m.calls+'</td><td>'+m.input.toLocaleString()+' / '+m.output.toLocaleString()+'</td><td>'+m.credits.toFixed(6)+(m.unknown?' (partial)':'')+'</td></tr>';
    }).join('')+'</tbody></table>';
  }
  var files=(an.files||[]).slice().sort(function(a,b){return(b.added+b.removed)-(a.added+a.removed);});
  var fileRows=files.map(function(f){
    var cat=f.category?'<span class="badge bp">'+esc(CAT[f.category]||f.category)+'</span>':'\\u2014';
    var cr=f.created?' <span class="badge ba">new</span>':'';
    return'<tr><td style="font-family:monospace;font-size:.85em" title="'+esc(f.path)+'">'+esc(ledBase(f.path))+cr+'</td><td>'+cat+'</td><td class="dc"><span class="c-add">+'+f.added+'</span></td><td class="dc"><span class="c-del">-'+f.removed+'</span></td><td class="dc">'+f.edits+'</td></tr>';
  }).join('')||'<tr class="empty-row"><td colspan="5">No measurable file edits recorded. Terminal/external edits may not expose a diff.</td></tr>';
  var filesTbl='<table class="my1"><thead><tr><th>File</th><th>Category</th><th class="dc">+Added</th><th class="dc">-Removed</th><th class="dc">Edits</th></tr></thead><tbody>'+fileRows+'</tbody></table>';
  if(e.debugUsage)filesTbl+='<p class="t-sm muted">Successful, measurable tool edits only; repeated edits accumulate. Not the final git diff. These counts are diagnostic and are not added again to editor-tracked effort.</p>';
  var tools=(an.tools||[]).slice().sort(function(a,b){return b.count-a.count;});
  var toolChips=tools.map(function(x){return'<span class="badge bp" style="margin:2px">'+esc(x.name)+' \\u00D7'+x.count+'</span>';}).join('')||'<span class="muted">none</span>';
  // Efficiency ratios
  var perNet=!e.debugUsage&&netLines>0?(e.credits/netLines):null;
  var effHtml='<div style="display:flex;gap:18px;flex-wrap:wrap;margin:8px 0;font-size:.88em">'
    +'<span>\\uD83E\\uDDFE <strong>'+Number(e.credits).toFixed(2)+'</strong> credits</span>'
    +'<span>\\u270F\\uFE0F net <strong class="c-add">'+(netLines>=0?'+':'')+netLines+'</strong> lines ('+(an.totalAdded||0)+' added / '+(an.totalRemoved||0)+' removed)</span>'
    +(perNet!=null?'<span>\\u2696\\uFE0F <strong>'+perNet.toFixed(2)+'</strong> credits / net line</span>':'')
    +'<span>\\uD83D\\uDD27 <strong>'+(an.toolCalls||0)+'</strong> tool calls</span>'
    +(an.durationMs?'<span>\\u23F1 <strong>'+fmt(an.durationMs)+'</strong> model time</span>':'')
    +'</div>';
  var html='<td colspan="8" style="background:var(--surface);padding:12px 16px">'
    +'<div style="font-weight:600;margin-bottom:4px">\\uD83D\\uDD0D Deep analysis</div>'
    +effHtml
    +'<div style="background:var(--vscode-editorWidget-background,rgba(128,128,128,.08));border-left:3px solid var(--ai);padding:6px 10px;border-radius:4px;margin:6px 0;font-size:.88em">'+tip+'</div>'
    +'<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">'
    +'<div style="flex:1;min-width:320px"><div style="font-weight:600;font-size:.9em;margin:6px 0 2px">'+(e.debugUsage?'Recorded usage':'Token cost breakdown')+'</div>'+tiersTbl+'</div>'
    +'<div style="flex:1;min-width:320px"><div style="font-weight:600;font-size:.9em;margin:6px 0 2px">Files changed</div>'+filesTbl+'</div>'
    +'</div>'
    +'<div style="font-weight:600;font-size:.9em;margin:8px 0 4px">Tools used</div><div>'+toolChips+'</div>'
    +'</td>';
  var tr=document.createElement('tr');
  tr.id='led-detail-'+id;
  tr.innerHTML=html;
  if(row.nextSibling)row.parentNode.insertBefore(tr,row.nextSibling);
  else row.parentNode.appendChild(tr);
  return true;
}

// Remembers which detail sub-tab (insights/time/lines/types) the user is viewing so the
// periodic 5s refresh re-renders the detail view without snapping back to Insights.
var detailSubTab='insights';
function showDetail(branch){
  var d=allData.find(function(x){return x.branch===branch;});
  if(!d) return;
  var tab=document.getElementById('dtab');
  tab.textContent=branch.length>22?branch.slice(0,20)+'\u2026':branch;
  tab.dataset.branch=branch;
  showTab('detail');
  var extRows=Object.entries(d.byExt||{}).sort(function(a,b){return(b[1].human.added+b[1].ai.added)-(a[1].human.added+a[1].ai.added);}).map(function(e){var ext=e[0],s=e[1],ta=s.human.added+s.ai.added,pct=ta>0?((s.ai.added/ta)*100).toFixed(0):0;return'<tr><td><span class="extb">.'+ext+'</span></td><td class="dc">'+pp(s.human.added,'bp')+' '+pm(s.human.deleted)+'</td><td class="dc">'+pp(s.ai.added,'ba')+' '+pm(s.ai.deleted)+'</td><td><span class="badge '+(pct>50?'ba':'bh')+'">'+pct+'%</span></td></tr>';}).join('')||'<tr class="empty-row"><td colspan="4">No changes recorded yet</td></tr>';
  var catRows=Object.entries(d.byCategory||{}).map(function(e){var cat=e[0],s=e[1],ta=s.human.added+s.ai.added,pct=ta>0?((s.ai.added/ta)*100).toFixed(0):0;return'<tr><td>'+(CAT[cat]||cat)+'</td><td class="dc">'+pp(s.human.added,'bp')+' '+pm(s.human.deleted)+'</td><td class="dc">'+pp(s.ai.added,'ba')+' '+pm(s.ai.deleted)+'</td><td><span class="badge '+(pct>50?'ba':'bh')+'">'+pct+'%</span></td></tr>';}).join('');
  var tot=tms(d);
  var timeModes=[['\\u2328\\ufe0f Human Coding','humanCoding',d.humanCodingMs,'var(--human)'],['\\uD83E\\uDD16 AI Generating','aiGenerating',d.aiGeneratingMs,'var(--ai)'],['\\uD83D\\uDC40 Reviewing','reviewing',d.reviewingMs,'var(--review)'],['\\u2615 Idle','idle',d.idleMs,'var(--idle)']];
  var rawT=d.rawTime||{},adjT=d.timeAdjustment||{},hasAdj=Object.keys(adjT).length>0;
  var timeRows=timeModes.map(function(r){var mode=r[1],adj=adjT[mode],raw=rawT[mode]||0;var sub=(typeof adj==='number'&&adj!==0)?'<div style="font-size:.72em;color:var(--muted)">auto '+fmt(raw)+' \\u00b7 adj '+(adj>0?'+':'\\u2212')+fmt(Math.abs(adj))+'</div>':'';return'<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--surface);border-radius:4px"><span>'+r[0]+sub+'</span><span style="display:flex;align-items:center;gap:8px"><strong style="color:'+r[3]+'">'+fmt(r[2])+'</strong><button class="dtab" data-action="tadjSet" data-id="'+esc(d.branch)+'" data-mode="'+mode+'" title="Adjust tracked time (correct the auto value)" style="padding:0 6px;line-height:1.4">\\u270E</button></span></div>';}).join('');
  var timeNote='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px"><span class="t-sm muted">'+(hasAdj?'\\u270E Adjusted \\u2014 raw auto values preserved':'Auto-tracked \\u00b7 \\u270E to correct')+'</span><button class="dtab" data-action="tadjReset" data-id="'+esc(d.branch)+'" title="Reset all modes on this branch to the auto-tracked value"'+(hasAdj?'':' disabled')+'>\\u21ba Reset to auto</button></div>';
  var I=insights(d);
  var byModel=d.creditsByModel||[];
  var cpu=roiOf(d).creditCostPerUnit; // per-credit cost from the branch's effective rates
  var modelRows=byModel.map(function(r){return'<tr><td>'+r.model+'</td><td class="dc">'+r.credits.toFixed(1)+'</td><td class="dc">'+fmtMoney(cpu!=null?r.credits*cpu:null,I.currency)+'</td></tr>';}).join('')||'<tr class="empty-row"><td colspan="3">No credits logged yet \\u2014 use \\u201cAI Effort Tracker: Log Credits Used\\u201d</td></tr>';
  var savedColor=I.timeSavedMin>=0?'var(--added)':'var(--deleted)';
  var roiColor=moneyColor(I.roi);
  var insHtml='<div class="sg">'
    +sc('AI Share of Lines',I.aiShare.toFixed(0)+'%','var(--ai)','Share of effective changed lines written by Copilot.\\n= '+I.aiNet+' AI \\u00f7 '+I.totalNet+' total.')
    +sc('Velocity',I.velocity.toFixed(1)+' loc/min','var(--human)','Effective changed lines per active minute.\\n= '+I.totalNet+' \\u00f7 '+I.activeMin.toFixed(0)+' min.')
    +sc('Effective Lines',String(I.totalNet),'var(--vscode-foreground)','Meaningful changed lines (human + AI). Unchanged rewrites of whole files are left out; later corrections count again.')
    +sc('Active Time',fmtMin(I.activeMin),'var(--review)','Coding, Copilot generating and reviewing time on this branch, plus manual entries. Idle time does not count.')
    +'</div>'
    +translationSummaryHtml(d)
    +'<div class="mt4 card"><h3>\\uD83D\\uDE80 Productivity Story</h3>'
    +'<p style="line-height:1.7;margin-top:8px">In <strong>'+fmtMin(I.activeMin)+'</strong> of active work you produced <strong>'+I.totalNet+'</strong> effective changed lines '
    +'(<strong class="c-ai">'+I.aiShare.toFixed(0)+'%</strong> from AI) at <strong>'+I.velocity.toFixed(1)+' loc/min</strong>. '
    +'At a manual baseline of <strong>'+CFG.baselineLocPerMinute+' loc/min</strong> the same output would take <strong>'+fmtMin(I.manualEquivMin)+'</strong>, '
    +'so AI saved about <strong style="color:'+savedColor+'">'+fmtMin(I.timeSavedMin)+'</strong>.</p></div>'
    +'<div class="mt4 sg">'
    +sc('Manual-Equiv Time',fmtMin(I.manualEquivMin),'var(--review)','How long the same output would take by hand.\\n= '+I.totalNet+' lines \\u00f7 '+(CFG.baselineLocPerMinute>0?CFG.baselineLocPerMinute:5)+' lines/min (aiEffortTracker.baselineLocPerMinute).')
    +sc('Time Saved',fmtMin(I.timeSavedMin),savedColor,'Manual-equivalent time minus active time.\\n= '+fmtMin(I.manualEquivMin)+' \\u2212 '+fmtMin(I.activeMin)+' = '+fmtMin(I.timeSavedMin))
    +sc('Value Produced',fmtMoney(I.savedValue,I.currency),moneyColor(I.savedValue),I.savedValue==null?'Active hours \\u00d7 sell rate. Needs the project\\u2019s sell rate. '+RATES_HINT:'Your active hours at the sell rate.\\n= '+tH(roiOf(d).actualHours)+' \\u00d7 '+tR(roiOf(d).hourlySellRate,I.currency)+' = '+fmtMoney(I.savedValue,I.currency))
    +sc('Chat Turns',String(I.chatTurns),'var(--human)')
    +'</div>'
    +'<div class="mt4 card"><div class="hbar"><h3>\\uD83D\\uDCB0 Credits & Cost</h3><button class="dtab" data-action="cmd" data-value="logCredits">+ Log Credits</button></div>'
    +'<div class="mt3 sg">'
    +sc('Credits Used',I.credits.toFixed(1),'var(--cost)','Copilot credits (premium requests) used on this branch, including entries you logged.')
    +sc('AI Spend',fmtMoney(I.aiCost,I.currency),'var(--cost)',aiSpendTip(roiOf(d),I.credits,I.currency))
    +sc('Net ROI',fmtMoney(I.roi,I.currency),roiColor,I.roi==null?'Value produced minus total cost. Needs the project\\u2019s sell and cost rates. '+RATES_HINT:'Value produced minus total cost (your hours at the cost rate, plus AI).\\n= '+fmtMoney(I.savedValue,I.currency)+' \\u2212 '+fmtMoney(roiOf(d).totalCost,I.currency)+' = '+fmtMoney(I.roi,I.currency))
    +'</div>'
    +'<table style="margin-top:14px"><thead><tr><th>Model</th><th>Credits</th><th>Cost</th></tr></thead><tbody>'+modelRows+'</tbody></table>'
    +'<p class="mt3 t-sm muted">Net ROI = value produced \\u2212 total cost (labor + credits) from the project\\u2019s effective rates. Credit cost uses the ledger \\u201cCost\\u201d when set, else credits \\u00d7 the project credit rate. \\u201c\\u2014\\u201d means a required rate is unset \\u2014 use \\u201cSet Rates\\u201d on the project. Baseline loc/min tunes the productivity estimate only.</p></div>';
  // Real net change from git (issue: churn vs net). Only for the branch actually
  // checked out (NET reflects the working tree), so we match SCM's Changes view.
  var showNet=NET&&NET.branch===d.branch;
  var netHtml='',netCatCard='';
  if(showNet){
    var na=NET.totalAdded||0,nr=NET.totalRemoved||0,nn=na-nr;
    netHtml='<div class="mb3 card"><div class="hbar"><h3>\\uD83D\\uDCD0 Net change (git)</h3><span class="t-sm muted">real diff vs branch base \\u00b7 '+(NET.fileCount||0)+' files</span></div>'
      +'<div class="mt3 sg"><div class="st"><div class="lbl">Net +Added</div><div class="c-add val">+'+na+'</div></div><div class="st"><div class="lbl">Net -Removed</div><div class="c-del val">-'+nr+'</div></div><div class="st"><div class="lbl">Net Delta</div><div class="val">'+(nn>=0?'+':'')+nn+'</div></div></div>'
      +'<p class="mt3 t-sm muted">This matches what Source Control shows as the branch\\u2019s real change (committed + uncommitted + new files). The \\u201cwritten / rewritten\\u201d counts below are cumulative <em>churn</em> \\u2014 every AI regeneration and rewrite is summed, so they run higher than the net whenever code was revised repeatedly.</p></div>';
    var nc=NET.byCategory||{};
    var netCatRows=Object.keys(nc).sort(function(a,b){return(nc[b].added+nc[b].removed)-(nc[a].added+nc[a].removed);}).map(function(k){var s=nc[k];return'<tr><td>'+(CAT[k]||k)+'</td><td class="dc"><span class="c-add">+'+s.added+'</span></td><td class="dc"><span class="c-del">-'+s.removed+'</span></td><td class="dc">'+((s.added-s.removed)>=0?'+':'')+(s.added-s.removed)+'</td></tr>';}).join('')||'<tr class="empty-row"><td colspan="4">No net change</td></tr>';
    netCatCard='<div class="card"><h3>\\uD83D\\uDCD0 Net by Category (git)</h3><table><thead><tr><th>Category</th><th>+Added</th><th>-Removed</th><th>Net</th></tr></thead><tbody>'+netCatRows+'</tbody></table></div>';
  }
  var effectiveHtml='<div class="mb3 card"><h3>\\u2705 Effective changed lines</h3><div class="mt3 sg"><div class="st"><div class="lbl">Human</div><div class="c-human val">'+(d.effectiveLinesHuman||0)+'</div></div><div class="st"><div class="lbl">AI</div><div class="c-ai val">'+(d.effectiveLinesAi||0)+'</div></div><div class="st"><div class="lbl">Total</div><div class="val">'+((d.effectiveLinesHuman||0)+(d.effectiveLinesAi||0))+'</div></div></div><p class="mt3 t-sm muted">Canonical meaningful line versions used for productivity, equivalent time, generated value and estimate actuals. Unchanged full-file rewrite noise is excluded; later corrections count as additional effective work.</p></div>';
  effectiveHtml+=translationSummaryHtml(d);
  document.getElementById('detail').innerHTML='<button class="back" data-action="tab" data-value="overview">\\u2190 Overview</button><div class="sg"><div class="st"><div class="lbl">Branch</div><div class="val" style="font-size:.9em;word-break:break-all">'+d.branch+'</div></div><div class="st"><div class="lbl">Work Item</div><div class="val">'+(d.workItemId?'#'+d.workItemId:'\\u2014')+'</div></div><div class="st"><div class="lbl">Active Time</div><div class="val">'+fmt(tot)+'</div></div><div class="st"><div class="lbl">Est. Cost</div><div class="c-cost val">$'+d.estimatedCostUsd.toFixed(4)+'</div></div></div>  <div class="dtabs"><button class="dtab active" data-action="ds" data-value="insights">\\uD83D\\uDCCA Insights</button><button class="dtab" data-action="ds" data-value="time">\\u23f1 Time</button><button class="dtab" data-action="ds" data-value="lines">\\uD83D\\uDCDD Lines</button><button class="dtab" data-action="ds" data-value="types">\\uD83D\\uDCC1 File Types</button></div><div id="ds-insights" class="ds active">'+insHtml+'</div><div id="ds-time" class="ds"><div class="cr"><div class="card"><h3>Time Breakdown</h3><div class="cw"><canvas id="cDonut"></canvas></div></div><div class="card" style="display:flex;flex-direction:column;gap:10px;justify-content:center">'+timeNote+timeRows+'</div></div></div>  <div id="ds-lines" class="ds">'+effectiveHtml+netHtml+'<div style="font-weight:600;font-size:.9em;margin-bottom:6px">\\u270D\\uFE0F Written / rewritten (cumulative churn)</div><div class="sg"><div class="st"><div class="lbl">Human +Lines</div><div class="c-add val">+'+d.linesHumanAdded+'</div></div><div class="st"><div class="lbl">Human -Lines</div><div class="c-del val">-'+d.linesHumanDeleted+'</div></div><div class="st"><div class="lbl">AI +Lines</div><div class="c-ai val">+'+d.linesAiAdded+'</div></div><div class="st"><div class="lbl">AI -Lines</div><div class="c-del val">-'+d.linesAiDeleted+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDCAC Chat Typed (chars)</div><div class="c-rev val">'+(d.chatCharsHuman||0)+'</div></div><div class="st"><div class="lbl">\\u2328\\ufe0f Keystrokes</div><div class="c-human val">'+(d.humanKeystrokes||0)+'</div></div><div class="st"><div class="lbl">\\uD83E\\uDD16 AI chars</div><div class="c-ai val">'+(d.aiChars||0)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDD22 Est. tokens</div><div class="c-cost val">~'+Math.round(((d.humanChars||0)+(d.aiChars||0)+(d.chatCharsHuman||0))/4)+'</div></div></div><div class="mt4 card"><h3>Lines by Extension</h3><div class="cw"><canvas id="cLines"></canvas></div></div></div><div id="ds-types" class="ds"><div class="cr">'+netCatCard+'<div class="card"><h3>By Category (churn)</h3><table><thead><tr><th>Category</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+catRows+'</tbody></table></div><div class="card"><h3>By Extension (churn)</h3><table><thead><tr><th>Ext</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+extRows+'</tbody></table></div></div></div>'+timeLogCardHtml(d.timeEntries||[],'data-branch="'+esc(d.branch)+'"');  dc('donut');
  charts.donut=new Chart(document.getElementById('cDonut'),{type:'doughnut',data:{labels:['Human','AI Gen','Review','Idle'],datasets:[{data:[d.humanCodingMs,d.aiGeneratingMs,d.reviewingMs,d.idleMs],backgroundColor:['rgba(78,201,176,.8)','rgba(197,134,192,.8)','rgba(220,220,170,.8)','rgba(77,77,77,.8)'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'62%',plugins:{legend:{position:'bottom',labels:{color:fg(),padding:12}}}}});
  renderLinesChart(d);
  // Honor the user's current sub-tab instead of the hard-coded Insights default, so a
  // background refresh (which re-invokes showDetail) keeps them on Time/Lines/File Types.
  if(detailSubTab!=='insights'){
    var tp=document.getElementById('ds-'+detailSubTab),tb=document.querySelector('#detail .dtab[data-value="'+detailSubTab+'"]');
    if(tp&&tb){
      document.getElementById('ds-insights').classList.remove('active');
      document.querySelector('#detail .dtab[data-value="insights"]').classList.remove('active');
      tp.classList.add('active');tb.classList.add('active');
      if(detailSubTab==='time'&&charts.donut)charts.donut.resize();
    }else{detailSubTab='insights';}
  }
}

function renderLinesChart(d){
  var c=document.getElementById('cLines');if(!c)return;
  dc('lines');
  var exts=Object.keys(d.byExt||{}).slice(0,12);
  charts.lines=new Chart(c,{type:'bar',data:{labels:exts.map(function(e){return'.'+e;}),datasets:[{label:'Human +',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].human?d.byExt[e].human.added:0;}),backgroundColor:'rgba(78,201,176,.7)'},{label:'AI +',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].ai?d.byExt[e].ai.added:0;}),backgroundColor:'rgba(197,134,192,.7)'},{label:'Human -',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].human?-d.byExt[e].human.deleted:0;}),backgroundColor:'rgba(78,201,176,.3)'},{label:'AI -',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].ai?-d.byExt[e].ai.deleted:0;}),backgroundColor:'rgba(197,134,192,.3)'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},scales:{x:{ticks:{color:dfg()},grid:{color:gc}},y:{ticks:{color:dfg()},grid:{color:gc},title:{display:true,text:'lines',color:dfg()}}}}});
}

function showDS(id,btn){
  detailSubTab=id;
  document.querySelectorAll('.ds').forEach(function(s){s.classList.remove('active');});
  document.querySelectorAll('.dtab').forEach(function(b){b.classList.remove('active');});
  document.getElementById('ds-'+id).classList.add('active');
  btn.classList.add('active');
  if(id==='lines'){var bn=document.getElementById('dtab').textContent;var d=allData.find(function(x){return x.branch===bn||bn.startsWith(x.branch.slice(0,16));});if(d)renderLinesChart(d);}
  if(id==='time'&&charts.donut)charts.donut.resize();
}

function showTab(name){
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
  document.getElementById(name).classList.add('active');
  if(name==='overview'){document.getElementById('tab-overview').classList.add('active');renderOverview();}
  else if(name==='trends'){document.getElementById('tab-trends').classList.add('active');renderTrends();}
  else if(name==='focus'){document.getElementById('tab-focus').classList.add('active');renderFocus();}
  else if(name==='ghview'){document.getElementById('tab-ghview').classList.add('active');renderGhMetrics();}
  else if(name==='projects'){document.getElementById('tab-projects').classList.add('active');renderProjectsView();}
  else if(name==='ledger'){document.getElementById('tab-ledger').classList.add('active');renderLedger();}
  else if(name==='optimize'){document.getElementById('tab-optimize').classList.add('active');requestOptimize();}
  else if(name==='sessions'){document.getElementById('tab-sessions').classList.add('active');requestSessions();}
  else if(name==='estimates'){document.getElementById('tab-estimates').classList.add('active');requestEstimates();}
  else if(name==='timesheet'){document.getElementById('tab-timesheet').classList.add('active');requestTimesheet();}
  else if(name==='health'){document.getElementById('tab-health').classList.add('active');requestHealth();}
  else if(name==='corrections'){document.getElementById('tab-corrections').classList.add('active');requestCorrections();}
  else if(name==='settings'){document.getElementById('tab-settings').classList.add('active');requestSettings();}
  else{document.getElementById('dtab').classList.add('active');}
  renderFilterBar();
}

var OPT=null,optLoading=false;
function requestOptimize(){optLoading=true;renderOptimize();vscode.postMessage(Object.assign({type:'optimize'},gfQuery()));}
function n2(v){return(Math.round((v||0)*100)/100).toLocaleString();}
function sevBadge(s){var c=s==='high'?'bd':s==='medium'?'ba':'bh';return'<span class="badge '+c+'">'+esc(s)+'</span>';}
function optTable(head,rows,empty){
  return'<table><thead><tr>'+head.map(function(h){return'<th>'+esc(h)+'</th>';}).join('')+'</tr></thead><tbody>'
    +(rows.length?rows.join(''):'<tr class="empty-row"><td colspan="'+head.length+'">'+esc(empty)+'</td></tr>')+'</tbody></table>';
}
function renderOptimize(){
  var el=document.getElementById('optimize');
  var ctl='<div class="rng">'+'<button class="dtab" data-action="optRefresh">\\u21bb Refresh</button></div>';
  var tip='<p class="mb4 t-md muted">Based on Copilot debug logs (models, tokens, cache, tools). Savings are list-price <strong>estimates</strong>. Ask Copilot in agent mode, e.g. <em>\\u201cUse the AI Effort Tracker usage insights to tell me how to use fewer credits\\u201d</em> \\u2013 the <strong>AI Effort Tracker usage insights</strong> MCP server gives it this data.</p>';
  if(!OPT){el.innerHTML=ctl+tip+(optLoading?loadingState('Analysing\\u2026'):emptyState('No usage data yet','Insights come from Copilot requests captured in the chat debug log. Use Copilot chat, then press Refresh.'));bindOptWi();return;}
  if(OPT.error){el.innerHTML=ctl+tip+'<p class="c-del">'+esc(OPT.error)+'</p>';bindOptWi();return;}
  var o=OPT.overview,t=o.totals,f=OPT.findings;
  var waste=Object.keys(o.cacheBreaks).reduce(function(n,k){return n+(o.cacheBreaks[k].estimatedWaste||0);},0);
  var stats='<div class="sg">'+sc('Credits',n2(t.credits),'var(--cost)')+sc('Model calls',t.calls.toLocaleString())+sc('Cache hit',t.cacheHitPct+'%')+sc('Credits / turn',n2(t.creditsPerTurn))
    +sc('Sessions',String(t.sessions))+sc('Turns',String(t.turns))+sc('Avoidable cache cost',n2(waste),'var(--deleted)')+sc('Subagent credits',n2(o.subagents.credits))+'</div>';
  var fh=f.length?f.map(function(x){
    return'<div class="mb3 card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline"><strong>'+sevBadge(x.severity)+' '+esc(x.title)+'</strong>'
      +(x.creditsAtStake!=null?'<span class="nw c-cost">\\u2248 '+n2(x.creditsAtStake)+' credits</span>':'')+'</div>'
      +'<p class="mt2">'+esc(x.detail)+'</p><p class="mt2"><strong>Try:</strong> '+esc(x.recommendation)+'</p></div>';
  }).join(''):'<div class="mb3 card">No optimization opportunities detected for this period.</div>';
  var models=Object.keys(o.byModel).map(function(m){var b=o.byModel[m];return'<tr><td>'+esc(m)+'</td><td>'+b.calls+'</td><td>'+n2(b.credits)+'</td><td>'+n2(b.creditsPerCall)+'</td><td>'+b.cacheHitPct+'%</td></tr>';});
  var causes={'new-context':'New chat / subagent (expected)','model-switch':'Model switch','idle-expiry':'Pause > 5 min','toolset-change':'Tools changed','other':'Other (summarization, instructions\\u2026)'};
  var cb=Object.keys(o.cacheBreaks).map(function(k){var b=o.cacheBreaks[k];return'<tr><td>'+esc(causes[k]||k)+'</td><td>'+b.count+'</td><td>'+n2(b.credits)+'</td><td>'+n2(b.estimatedWaste)+'</td></tr>';});
  var srv=o.tools.servers.map(function(s){return'<tr><td>'+esc(s.server)+'</td><td>'+s.toolsOffered+'</td><td>'+s.offeredInPct+'%</td><td>'+s.usedTools+'</td><td>'+s.calls+'</td><td>'+(s.failed?'<span class="badge bd">'+s.failed+'</span>':'0')+'</td></tr>';});
  var tools=o.tools.topTools.slice(0,12).map(function(x){return'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.server)+'</td><td>'+x.calls+'</td><td>'+(x.failed||0)+'</td></tr>';});
  var ses=(OPT.sessions||[]).map(function(s){return'<tr><td title="'+esc(s.sessionId)+'">'+esc(s.end.slice(0,16).replace('T',' '))+'</td><td>'+s.turns+'</td><td>'+n2(s.credits)+'</td><td class="nw">'+s.models.map(esc).join('<br>')+'</td><td>'+Math.round(s.maxInputTokens/1000)+'K</td><td>'+s.avoidableCacheBreaks+'</td><td>'+esc((s.workItems.length?'#'+s.workItems.join(', #'):'')||s.branches.join(', '))+'</td></tr>';});
  el.innerHTML=ctl+tip+stats+'<h3 style="margin:8px 0 12px">Findings</h3>'+fh
    +'<div class="cr"><div class="card"><h3>By model</h3>'+optTable(['Model','Calls','Credits','Per call','Cache hit'],models,'No calls')+'</div>'
    +'<div class="card"><h3>Prompt-cache misses</h3>'+optTable(['Cause','Count','Credits','Avoidable \\u2248'],cb,'None')+'</div></div>'
    +'<div class="cr"><div class="card"><h3>Tool sources (max '+o.tools.maxToolsOffered+' tools offered, '+o.tools.toolSearchCalls+' tool searches)</h3>'+optTable(['Server','Offered','In % of calls','Tools used','Calls','Failed'],srv,'No tool data yet')+'</div>'
    +'<div class="card"><h3>Most used tools</h3>'+optTable(['Tool','Source','Calls','Failed'],tools,'No tool calls')+'</div></div>'
    +renderEfficiency(OPT.efficiency)+renderToolProfile(OPT.toolProfile)
    +'<div class="card"><h3>Recent chat sessions</h3>'+optTable(['Last activity','Turns','Credits','Models','Max context','Avoidable cache misses','Work item / branch'],ses,'No sessions')+'</div>'
    +'<p class="mt2 t-sm muted">'+esc(o.dataCoverage.note)+' Timing captured for '+o.dataCoverage.withTimingPct+'% of calls.</p>';
  bindOptWi();
}
function bindOptWi(){}
// #99 Model efficiency per task type: heat map (green = cheapest in the row).
function renderEfficiency(ef){
  if(!ef||!ef.tasks||!ef.tasks.length)return'<div class="card"><h3>Model efficiency by task type</h3><p>No turns with debug-log data in this period.</p></div>';
  var head=['Task type'].concat(ef.models).concat(['Recommendation']);
  var cellMap={};ef.cells.forEach(function(c){cellMap[c.model+'|'+c.task]=c;});
  var rows=ef.tasks.map(function(task){
    var rec=(ef.recommendations||[]).filter(function(r){return r.task===task;})[0];
    var metric=task===ef.qaTask?'creditsPerTurn':'creditsPer100Lines';
    var vals=ef.models.map(function(m){var c=cellMap[m+'|'+task];return c&&!c.smallSample&&c[metric]!=null?c[metric]:null;}).filter(function(v){return v!=null;});
    var lo=vals.length?Math.min.apply(null,vals):0,hi=vals.length?Math.max.apply(null,vals):0;
    var cells=ef.models.map(function(m){
      var c=cellMap[m+'|'+task];if(!c)return'<td class="muted">\u2013</td>';
      var v=c[metric];
      var t=(v==null||hi===lo||c.smallSample)?null:(v-lo)/(hi-lo);
      var bg=t==null?'':'background:rgba('+Math.round(60+160*t)+','+Math.round(170-110*t)+',80,.28);';
      return'<td style="'+bg+(c.smallSample?'opacity:.55;':'')+'" title="'+esc(c.turns+' turns \u00b7 '+n2(c.credits)+' credits \u00b7 '+n2(c.creditsPerTurn)+' / turn'+(c.creditsPer100Lines!=null?' \u00b7 '+n2(c.creditsPer100Lines)+' / 100 lines':'')+' \u00b7 cache '+c.cacheHitPct+'%'+(c.smallSample?' \u00b7 small sample':''))+'">'
        +(v==null?'\u2013':n2(v))+'<div class="t-xs muted">'+c.turns+' turns</div></td>';
    }).join('');
    return'<tr><td><strong>'+esc(ef.taskLabels[task]||task)+'</strong><div class="t-xs muted">'+(metric==='creditsPerTurn'?'credits / turn':'credits / 100 lines')+'</div></td>'+cells
      +'<td class="t-md">'+(rec?esc(rec.note)+(rec.potentialSavings>0?' <span class="c-cost nw">\u2248 '+n2(rec.potentialSavings)+' credits</span>':''):'')+'</td></tr>';
  });
  return'<div class="card"><h3>Model efficiency by task type</h3><p class="t-sm muted mb2">Task type = file category with the most changed lines in the turn (no edits \u2192 Q&amp;A / read-only). Green = cheapest in the row; faded = fewer than '+ef.minSamples+' turns. Savings assume the cheaper model does the same work \u2013 check quality before switching.</p>'
    +'<div class="ox">'+optTable(head,rows,'No data')+'</div></div>';
}
// #102 Tool-set profile: which MCP servers to keep for this project / work item.
function renderToolProfile(tp){
  if(!tp||!tp.servers||!tp.servers.length)return'<div class="card"><h3>Tool-set profile</h3><p>No tool-set data captured yet (needs Copilot debug logs with tools_*.json).</p></div>';
  var badge={keep:'<span class="badge bh">keep</span>',disable:'<span class="badge bd">disable</span>',review:'<span class="badge ba">review</span>'};
  var rows=tp.servers.map(function(s){
    return'<tr><td>'+esc(s.server)+'</td><td title="'+esc(s.reason)+'">'+badge[s.recommendation]+'</td><td>'+s.toolsOffered+'</td><td>'+s.offeredInPct+'%</td><td title="'+esc(s.usedTools.join(', '))+'">'+s.usedTools.length+'</td><td>'+s.calls+(s.failed?' <span class="badge bd">'+s.failed+' failed</span>':'')+'</td><td>'+(s.approxTokens/1000).toFixed(1)+'K</td><td>'+esc(s.lastUsed?s.lastUsed.slice(0,10):'never')+'</td></tr>';
  });
  var kpi='<div class="sg">'+sc('Keep',String(tp.keep.length),'var(--added)')+sc('Disable',String(tp.disable.length),'var(--deleted)')+sc('Tokens saved / request','\u2248 '+(tp.tokensSavedPerRequest/1000).toFixed(1)+'K')+sc('Credits saved','\u2248 '+n2(tp.estimatedCreditsSaved),'var(--cost)')+'</div>';
  return'<div class="card"><h3>Tool-set profile'+(GF.projectId||GF.workItemId?' (filtered)':'')+'</h3><p class="t-sm muted mb2">Tool definitions are sent with every request. Servers that were offered but never called in this scope are candidates to switch off in the chat \u201cConfigure Tools\u201d picker (or a tool set / per-workspace mcp.json). Credits saved = same requests without those definitions (list-price estimate).</p>'
    +kpi+optTable(['Server','Recommendation','Tools','Offered in','Tools used','Calls','Definitions','Last used'],rows,'No servers')
    +(tp.disable.length?'<p class="mt2 t-md"><strong>Minimal set:</strong> '+esc(tp.keep.join(', '))+'</p>':'')+'</div>';
}

// #101 Timesheet tab: hours per work item and day for one week.
var TS=null,tsLoading=false,tsWeek='',tsRound='';
function requestTimesheet(){tsLoading=true;if(!TS)renderTimesheet();vscode.postMessage({type:'timesheet',weekStart:tsWeek||undefined,rounding:tsRound||undefined});}
function fmtH(h){return h>0?(Math.round(h*100)/100).toFixed(2):'';}
function renderTimesheet(){
  var el=document.getElementById('timesheet');if(!el)return;
  if(!TS){el.innerHTML=(tsLoading?loadingState():emptyState('No timesheet yet','Tracked time, manual entries and credits are grouped here by work item and day.'));return;}
  if(TS.error){el.innerHTML='<p class="c-del">'+esc(TS.error)+'</p>';return;}
  var s=TS.sheet;tsWeek=s.weekStart;tsRound=s.rounding;
  if(GF.projectId||GF.workItemId){var vr=s.rows.filter(function(r){return gfScope(r.projectId,r.workItemId==='__unassigned__'?'':r.workItemId);});
    var dt=[0,0,0,0,0,0,0];vr.forEach(function(r){r.cells.forEach(function(h,i){dt[i]+=h;});});
    s=Object.assign({},s,{rows:vr,dayTotals:dt,total:vr.reduce(function(n,r){return n+r.total;},0),rawTotal:vr.reduce(function(n,r){return n+(r.rawTotal!=null?r.rawTotal:r.total);},0)});}
  var names=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var projName=function(id){if(!id)return'';var p=(PROJ||[]).find(function(x){return x.projectId===id||x.id===id;});return p?(p.name||id):id;};
  var ro=[['none','Exact'],['0.25','\u00bc h'],['0.5','\u00bd h']].map(function(o){return'<button class="dtab'+(s.rounding===o[0]?' active':'')+'" data-action="tsRound" data-value="'+o[0]+'">'+o[1]+'</button>';}).join('');
  var ctl='<div class="rng"><button class="dtab" data-action="tsWeek" data-value="-1">\u25c0 Prev</button>'
    +'<button class="dtab'+(s.weekStart===TS.currentWeek?' active':'')+'" data-action="tsWeek" data-value="0">This week</button>'
    +'<button class="dtab" data-action="tsWeek" data-value="1">Next \u25b6</button>'
    +'<span style="margin:0 10px;opacity:.8">Week of '+esc(s.days[0])+' \u2013 '+esc(s.days[6])+'</span>'
    +'<span style="margin-right:6px;opacity:.8">Rounding:</span>'+ro
    +'<button class="dtab" style="margin-left:10px" data-action="tsCsv">\u2b07 CSV</button></div>';
  var head='<tr><th style="text-align:left">Work item</th>'+s.days.map(function(d,i){return'<th style="text-align:right'+(d===TS.today?';color:var(--vscode-textLink-foreground)':'')+'">'+names[i]+'<br><span style="font-weight:normal;opacity:.7">'+esc(d.slice(5))+'</span></th>';}).join('')+'<th class="ta-r">Total</th></tr>';
  var body=s.rows.map(function(r){
    var un=r.workItemId==='__unassigned__';
    var label=un?'<em>'+esc(r.title||'Unassigned')+'</em>':'<a href="#" data-action="wiOpen" data-id="'+esc(r.workItemId)+'">#'+esc(r.workItemId)+'</a> '+esc(r.title||'')+(r.externalRef?' <span class="dim">('+esc(r.externalRef)+')</span>':'')+(r.projectId?'<br><span style="opacity:.6;font-size:.85em">'+esc(projName(r.projectId))+'</span>':'');
    return'<tr><td>'+label+'</td>'+r.cells.map(function(h,i){return'<td style="text-align:right;cursor:pointer" title="Add time for '+esc(s.days[i])+'" data-action="tsAdd" data-id="'+esc(r.workItemId)+'" data-day="'+esc(s.days[i])+'">'+(fmtH(h)||'<span style="opacity:.25">+</span>')+'</td>';}).join('')+'<td style="text-align:right;font-weight:600">'+fmtH(r.total)+'</td></tr>';
  }).join('');
  if(!s.rows.length)body='<tr><td colspan="9" class="dim">No tracked time this week. Use <strong>+ Add time</strong> to log work done outside VS Code.</td></tr>';
  var foot='<tr style="font-weight:600;border-top:2px solid var(--border)"><td>Total</td>'+s.dayTotals.map(function(h){return'<td class="ta-r">'+fmtH(h)+'</td>';}).join('')+'<td class="ta-r">'+fmtH(s.total)+'</td></tr>';
  var note=s.rounding!=='none'&&Math.abs(s.total-s.rawTotal)>=0.01?'<p style="font-size:.85em;opacity:.8">Rounded total '+fmtH(s.total)+' h vs. exact '+fmtH(s.rawTotal)+' h.</p>':'';
  el.innerHTML=ctl+'<p class="mb3 t-md muted">Active hours (human, AI and review time plus manual entries) \u2013 the same numbers as the work item totals. Click a cell to add time for that day. <button class="btn-sm dtab" data-action="tsAdd" data-id="__unassigned__" data-day="'+esc(TS.today)+'">+ Add time</button></p>'
    +'<table class="w100"><thead>'+head+'</thead><tbody>'+body+foot+'</tbody></table>'+note;
}

// #148 Settings tab: every setting with a proper editor, validation, reset and override info.
var SET=null,setLoading=false,setQ='',setGrp='',setMsg={};
function requestSettings(){setLoading=true;setMsg={};renderSettings();vscode.postMessage({type:'settings'});}
function setGet(id){return SET?SET.settings.filter(function(s){return s.id===id;})[0]:null;}
function setVal(s){return s.userValue!==undefined?s.userValue:s.defaultValue;}
function setUnit(s){var u=s.unit||'';if(u.indexOf('{currency}')>=0){var c=setGet('currency');u=u.split('{currency}').join(c&&c.value?c.value:'USD');}return u;}
function setShow(v){if(v===undefined||v===null||v==='')return'(empty)';return typeof v==='object'?JSON.stringify(v):String(v);}
function setOpts(opts,titles,sel){return opts.map(function(o,i){return'<option value="'+esc(o)+'"'+(titles&&titles[i]?' title="'+esc(titles[i])+'"':'')+(o===sel?' selected':'')+'>'+esc(o)+'</option>';}).join('');}
function setKvRow(s,k,v){
  var vi;
  if(s.kind==='rules')vi='<input class="sesin set-kv-v" type="text" placeholder="category" value="'+esc(v==null?'':v)+'">';
  else if(s.valueKind==='enum')vi='<select class="sesin set-kv-v">'+setOpts(s.valueOptions||[],null,v)+'</select>';
  else if(s.valueKind==='number')vi='<input class="sesin set-kv-v" type="number" step="any" min="0" style="width:96px" value="'+esc(v==null?'':String(v))+'">'+(s.unit?' <span class="muted t-sm">'+esc(setUnit(s))+'</span>':'');
  else vi='<input class="sesin set-kv-v" type="text" value="'+esc(v==null?'':v)+'">';
  return'<div class="set-kv hrow"><input class="sesin set-kv-k" type="text" placeholder="'+(s.kind==='rules'?'pattern (regex)':'name')+'" value="'+esc(k)+'">'+vi+'<button class="dtab btn-sm" data-action="setRowDel" title="Remove row" aria-label="Remove row">\u2715</button></div>';
}
function setEditor(s){
  var v=setVal(s),k=esc(s.id);
  if(s.kind==='secret'){
    var src=SET.tokenSource;
    var st=src==='secure'?'<span class="badge b-good">\uD83D\uDD12 Stored securely</span>':src==='settings'?'<span class="badge b-warn">Plain text in settings.json</span>':'<span class="badge b-muted">Not set</span>';
    return st+' <button class="dtab btn-sm primary" data-action="setToken">'+(src==='none'?'Set token\u2026':'Replace token\u2026')+'</button>'
      +(src==='secure'?' <button class="dtab btn-sm" data-action="clearToken">Remove</button>':'')
      +(src==='settings'?' <button class="dtab btn-sm" data-action="moveTokenToSecure">Move to secure storage</button>':'')
      +'<div class="w100 t-sm muted">The token is never shown here. Without one, your VS Code GitHub sign-in is used.</div>';
  }
  if(s.kind==='boolean')return'<label class="hrow"><input type="checkbox" class="set-in" data-key="'+k+'"'+(v?' checked':'')+'> '+(v?'On':'Off')+'</label>';
  if(s.kind==='number')return'<input type="number" class="sesin set-in" data-key="'+k+'" style="width:110px" step="'+(s.integer?'1':'any')+'"'+(s.min!=null?' min="'+s.min+'"':'')+(s.max!=null?' max="'+s.max+'"':'')+' value="'+esc(v==null?'':String(v))+'">'+(s.unit?'<span class="muted t-sm">'+esc(setUnit(s))+'</span>':'');
  if(s.kind==='enum')return'<select class="sesin set-in" data-key="'+k+'">'+setOpts(s.options||[],s.optionLabels,v)+'</select>'+(s.optionLabels&&s.options?'<span class="muted t-sm">'+esc(s.optionLabels[(s.options||[]).indexOf(v)]||'')+'</span>':'');
  if(s.kind==='currency')return'<input type="text" class="sesin set-in" data-key="'+k+'" list="set-cur" maxlength="3" style="width:80px;text-transform:uppercase" value="'+esc(v||'')+'"><span class="muted t-sm">ISO code, e.g. EUR</span>';
  if(s.kind==='string')return'<input type="text" class="sesin set-in" data-key="'+k+'" style="min-width:260px" value="'+esc(v||'')+'">';
  var save='<button class="dtab btn-sm primary" data-action="setSave" data-key="'+k+'">Save</button>';
  if(s.kind==='map'){
    var o=v&&typeof v==='object'?v:{};
    return'<div class="set-rows">'+Object.keys(o).map(function(n){return setKvRow(s,n,o[n]);}).join('')+'</div><button class="dtab btn-sm" data-action="setRowAdd" data-key="'+k+'">+ Add row</button>'+save;
  }
  if(s.kind==='rules'){
    var r=Array.isArray(v)?v:[];
    return'<div class="set-rows">'+r.map(function(x){return setKvRow(s,x.pattern,x.category);}).join('')+'</div><button class="dtab btn-sm" data-action="setRowAdd" data-key="'+k+'">+ Add rule</button>'+save;
  }
  if(s.kind==='list')return'<textarea class="sesin set-ta" data-key="'+k+'" rows="3" placeholder="One entry per line">'+esc((Array.isArray(v)?v:[]).join('\\n'))+'</textarea>'+(s.unit?'<span class="muted t-sm">'+esc(setUnit(s))+'</span>':'')+save;
  return'<textarea class="sesin set-ta" data-key="'+k+'" rows="4">'+esc(JSON.stringify(v===undefined?null:v,null,2))+'</textarea>'+save;
}
function setRow(s){
  var m=setMsg[s.id];
  var head='<div><div><strong>'+esc(s.label)+'</strong>'+(!s.isDefault&&s.kind!=='secret'?' <span class="badge b-info" title="Changed from the default">modified</span>':'')+'</div>'
    +(s.description?'<div class="sd">'+esc(s.description)+'</div>':'')
    +'<div class="hrow mt1"><span class="t-xs muted mono">'+esc(s.id)+'</span>'
    +(s.kind!=='secret'?'<button class="dtab btn-sm" data-action="setReset" data-key="'+esc(s.id)+'" title="Default: '+esc(setShow(s.defaultValue))+'"'+(s.isDefault?' disabled':'')+'>\u21ba Reset</button>':'')+'</div></div>';
  var ov=s.overriddenBy&&s.kind!=='secret'?'<div class="mt2 t-sm"><span class="badge b-warn">'+(s.overriddenBy==='folder'?'Folder':'Workspace')+' setting wins</span> <span class="mono">'+esc(setShow(s.overrideValue))+'</span> <button class="dtab btn-sm" data-action="setClearWs" data-key="'+esc(s.id)+'">Remove override</button></div>':'';
  var msg='<div class="set-msg">'+(m?'<div class="'+(m.ok?'set-ok':'set-err')+'" role="'+(m.ok?'status':'alert')+'">'+esc(m.text)+'</div>':'')+'</div>';
  return'<div class="set-row" data-key="'+esc(s.id)+'">'+head+'<div><div class="set-ed">'+setEditor(s)+'</div>'+ov+msg+'</div></div>';
}
function renderSettings(){
  var el=document.getElementById('settings');if(!el)return;
  if(!SET){el.innerHTML=setLoading?loadingState('Loading settings\u2026'):emptyState('Settings not loaded','Open the tab again to load them.');return;}
  var q=setQ.trim().toLowerCase();
  var all=SET.settings,list=all.filter(function(s){return !q||(s.label+' '+s.description+' '+s.id).toLowerCase().indexOf(q)>=0;});
  var groups=SET.groups.filter(function(g){return all.some(function(s){return s.group===g;});});
  if(setGrp&&groups.indexOf(setGrp)<0)setGrp='';
  var chips='<button class="dtab'+(setGrp===''?' active':'')+'" data-action="setGrp" data-value="">All</button>'+groups.map(function(g){
    var n=list.filter(function(s){return s.group===g;}).length;
    return'<button class="dtab'+(setGrp===g?' active':'')+'" data-action="setGrp" data-value="'+esc(g)+'"'+(n?'':' disabled')+'>'+esc(g)+' <span class="muted">'+n+'</span></button>';
  }).join('');
  var mod=all.filter(function(s){return !s.isDefault&&s.kind!=='secret';}).length,ovr=all.filter(function(s){return s.overriddenBy;}).length;
  var ctl='<div class="rng"><input id="set-q" class="sesin" type="search" placeholder="Search settings\u2026" aria-label="Search settings" value="'+esc(setQ)+'" style="min-width:220px">'+chips
    +'<span style="flex:1"></span><button class="dtab btn-sm" data-action="setOpenUi" title="Open the same settings in the VS Code Settings editor">Open in VS Code Settings</button></div>';
  var note='<p class="t-md muted mb3">Changes are saved to your <strong>user</strong> settings and apply immediately. '+mod+' changed from the default'+(ovr?' \u00b7 <span class="c-cost">'+ovr+' overridden by this workspace</span>':'')+'.</p>';
  var shown=list.filter(function(s){return !setGrp||s.group===setGrp;});
  var body=groups.filter(function(g){return !setGrp||g===setGrp;}).map(function(g){
    var rows=shown.filter(function(s){return s.group===g;});if(!rows.length)return'';
    var basic=rows.filter(function(s){return !s.advanced;}),adv=rows.filter(function(s){return s.advanced;});
    return'<div class="card mb3"><h3>'+esc(g)+'</h3>'+basic.map(setRow).join('')
      +(adv.length?'<details class="set-adv"'+(q?' open':'')+'><summary>Advanced / legacy ('+adv.length+')</summary>'+adv.map(setRow).join('')+'</details>':'')+'</div>';
  }).join('');
  el.innerHTML=ctl+note+(body||emptyState('No settings match','Try another search term.'))
    +'<datalist id="set-cur">'+(SET.currencies||[]).map(function(c){return'<option value="'+esc(c)+'">';}).join('')+'</datalist>';
}
function setSend(key,value){vscode.postMessage({type:'setSetting',key:key,value:value});}
function setCollect(key){
  var s=setGet(key),row=document.querySelector('.set-row[data-key="'+key+'"]');if(!s||!row)return;
  if(s.kind==='map'||s.kind==='rules'){
    var rows=[].slice.call(row.querySelectorAll('.set-kv')).map(function(r){return[r.querySelector('.set-kv-k').value,r.querySelector('.set-kv-v').value];});
    setSend(key,s.kind==='rules'?rows.map(function(p){return{pattern:p[0],category:p[1]};}):rows);
  }else{
    var ta=row.querySelector('.set-ta');if(!ta)return;
    setSend(key,s.kind==='list'?ta.value.split(/\\r?\\n/):ta.value);
  }
}
function setResult(r){
  if(!r||!r.key)return false;
  setMsg={};setMsg[r.key]={ok:r.ok,text:r.ok?'\u2713 Saved':r.error||'Could not save.'};
  (r.also||[]).forEach(function(a){setMsg[a]={ok:true,text:'\u2713 Updated to match '+((setGet(r.key)||{}).label||r.key)};});
  if(r.ok)return false;
  var slot=document.querySelector('.set-row[data-key="'+r.key+'"] .set-msg');
  if(slot){slot.innerHTML='<div class="set-err" role="alert">'+esc(setMsg[r.key].text)+'</div>';return true;}
  return false;
}
// #104 Health tab: problems with the tracked data, each with a fix.
var HEALTH=null,healthLoading=false;
function requestHealth(){healthLoading=true;renderHealth();vscode.postMessage({type:'health'});}
function renderHealth(){
  var el=document.getElementById('health');if(!el)return;
  var ctl='<div class="rng"><button class="dtab" data-action="healthRefresh">\u21bb Re-check</button></div>';
  if(!HEALTH){el.innerHTML=ctl+(healthLoading?loadingState('Checking\u2026'):emptyState('No health report yet','Press Refresh to check the store for problems.'));return;}
  var r=HEALTH,sevC={error:'var(--deleted)',warning:'var(--cost)',info:'var(--muted)'};
  var sevB={error:'<span class="badge bd">error</span>',warning:'<span class="badge ba">warning</span>',info:'<span class="badge bh">hint</span>'};
  var scoreC=r.score>=90?'var(--added)':r.score>=60?'var(--cost)':'var(--deleted)';
  var st=r.stats;
  var kpi='<div class="sg">'+sc('Health score',r.score+' / 100',scoreC)+sc('Errors',String(r.counts.error),r.counts.error?'var(--deleted)':undefined)+sc('Warnings',String(r.counts.warning))+sc('Hints',String(r.counts.info))
    +sc('Credit rows',st.ledgerEntries.toLocaleString())+sc('Branches',String(st.branches))+sc('Work items',String(st.workItems))
    +sc('Data file',st.storeBytes==null?'\u2013':(st.storeBytes/1048576).toFixed(1)+' MB'+(st.backups!=null?' \u00b7 '+st.backups+' backups':''))+'</div>';
  var cards=r.checks.map(function(c){
    var ex=c.examples.length?'<ul style="margin:8px 0 0 18px">'+c.examples.map(function(x){
      return'<li style="margin:3px 0">'+esc(x.label)+(x.action?' <button class="dtab" style="padding:1px 8px;margin-left:6px" data-action="healthCmd" data-cmd="'+esc(x.action.command)+'" data-arg="'+esc(x.action.arg||'')+'">'+esc(x.action.label)+'</button>':'')+'</li>';
    }).join('')+(c.count>c.examples.length?'<li class="muted">\u2026 and '+(c.count-c.examples.length)+' more</li>':'')+'</ul>':'';
    var fix=c.fix?'<button class="dtab active" data-action="healthCmd" data-cmd="'+esc(c.fix.command)+'" data-arg="'+esc(c.fix.arg||'')+'">\uD83D\uDD27 '+esc(c.fix.label)+'</button>':'';
    return'<div class="card" style="margin-bottom:12px;border-left:3px solid '+sevC[c.severity]+'"><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline"><strong>'+sevB[c.severity]+' '+esc(c.title)+' \u2013 '+c.count+'</strong>'+fix+'</div>'
      +'<p class="mt2">'+esc(c.detail)+'</p>'+ex+'</div>';
  }).join('');
  var ok=r.passed.length?'<div class="card"><h3>\u2705 Passed ('+r.passed.length+')</h3><ul style="margin-left:18px">'+r.passed.map(function(p){return'<li>'+esc(p)+'</li>';}).join('')+'</ul></div>':'';
  el.innerHTML=ctl+'<p class="mb3 t-md muted">Checked '+esc(r.checkedAt.slice(0,16).replace('T',' '))+' UTC. Copilot can read the same report through the <strong>data_health</strong> MCP tool.</p>'
    +kpi+(r.checks.length?cards:'<div class="mb3 card">\u2705 No problems found.</div>')+ok;
}

// #132 Corrections tab: label captured corrections (what was wrong + where it applies).
var CORR=null,corrLoading=false,corrFilter='todo',corrSrc='all',corrOpen={},corrLimit=40;
function requestCorrections(){corrLoading=true;renderCorrections();vscode.postMessage({type:'corrections'});}
function corrIsLesson(cat){return !!cat&&CORR&&CORR.nonLesson.indexOf(cat)<0;}
function corrOptions(sel){
  var o='<option value="">\\u2014 unlabeled \\u2014</option><optgroup label="Lessons">';
  var cats=CORR.categories.slice();if(sel&&cats.indexOf(sel)<0&&CORR.nonLesson.indexOf(sel)<0)cats.push(sel);
  o+=cats.map(function(c){return'<option value="'+esc(c)+'"'+(c===sel?' selected':'')+'>'+esc(c)+'</option>';}).join('')+'</optgroup><optgroup label="Not a lesson">';
  o+=CORR.nonLesson.map(function(c){return'<option value="'+esc(c)+'"'+(c===sel?' selected':'')+'>'+esc(c)+'</option>';}).join('')+'</optgroup>';
  return o;
}
function corrCatBadge(cat){return cat?'<span class="badge '+(corrIsLesson(cat)?'ba':'bh')+'">'+esc(cat)+'</span>':'';}
function corrDiff(i){
  var mk=function(lines,sign,color){return(lines||[]).map(function(l){return'<div style="color:'+color+';white-space:pre">'+sign+' '+esc(l)+'</div>';}).join('');};
  var body=mk(i.before,'-','var(--deleted)')+mk(i.after,'+','var(--added)');
  if(i.kind==='move')body='<div>moved from line '+(i.fromLine||'?')+(i.context?' ('+esc(i.context)+')':'')+' to line '+i.line+(i.toContext?' ('+esc(i.toContext)+')':'')+'</div>'+body;
  return body?'<div style="font-family:var(--vscode-editor-font-family);font-size:.85em;background:var(--vscode-textCodeBlock-background);padding:6px 8px;border-radius:4px;overflow:auto;max-height:260px;margin-top:6px">'+body+'</div>':'';
}
function corrItem(i){
  var sug=!i.category&&i.suggestion?'<div class="mt1 t-md">\\uD83D\\uDCA1 Suggestion: <strong>'+esc(i.suggestion.category)+'</strong> <span class="muted">('+esc(i.suggestion.reason)+')</span> <button class="btn-sm dtab" data-action="corrAccept" data-id="'+esc(i.id)+'" data-cat="'+esc(i.suggestion.category)+'">Accept</button></div>':'';
  var by=i.labeledBy&&i.labeledBy!=='user'?' <span class="t-sm muted">by '+esc(i.labeledBy)+'</span>':'';
  return'<div class="corr-row" style="border-top:1px solid var(--border);padding:8px 0">'
    +'<div class="hbar">'
    +'<span><strong>'+esc(i.kind)+'</strong> '+esc(i.path)+':'+i.line+(i.context?' <span class="muted">('+esc(i.context)+')</span>':'')+' <span class="c-add">+'+i.added+'</span> <span class="c-del">-'+i.removed+'</span>'+by+'</span>'
    +'<span class="hrow"><select class="corr-cat" data-id="'+esc(i.id)+'">'+corrOptions(i.category||'')+'</select>'
    +'<input class="corr-scope" data-id="'+esc(i.id)+'" title="Files this lesson applies to (glob)" style="width:170px" value="'+esc(i.scope||i.suggestedScope)+'"></span></div>'
    +'<input class="corr-note" data-id="'+esc(i.id)+'" style="width:100%;margin-top:6px;box-sizing:border-box"'+(i.category?'':' disabled')
    +' placeholder="'+(i.category?'Why was it corrected? Write it as a rule, e.g. \\u201cRead field numbers from the table; never renumber a field\\u201d':'Pick a category first, then add a note')+'" value="'+esc(i.note||'')+'">'
    +sug+corrDiff(i)+'</div>';
}
function corrVisible(e){
  if(!gfInTs(e.start))return false;
  if(GF.workItemId&&String(e.workItemId||'')!==GF.workItemId)return false;
  if(GF.projectId&&!GF.workItemId&&!gfScope('',e.workItemId))return false;
  if(corrSrc!=='all'&&e.source!==corrSrc)return false;
  if(corrFilter==='todo')return e.items.some(function(i){return!i.category;});
  if(corrFilter==='lessons')return e.items.some(function(i){return corrIsLesson(i.category);});
  return true;
}
function renderCorrections(){
  var el=document.getElementById('corrections');if(!el)return;
  var pill=function(act,val,cur,lbl){return'<button class="dtab'+(val===cur?' active':'')+'" data-action="'+act+'" data-value="'+val+'">'+lbl+'</button>';};
  if(!CORR||CORR.error){el.innerHTML=(CORR&&CORR.error?emptyState('Cannot load corrections',esc(CORR.error)):corrLoading?loadingState():emptyState('No corrections yet','They appear when you or Copilot change code an AI edit wrote earlier.'));return;}
  var s=CORR.stats,L=CORR.lessons||{rules:[],groups:[]};
  var pend=L.rules.filter(function(r){return r.status==='proposed';}).length+L.groups.filter(function(g){return g.suggested&&!g.ruleIds.length;}).length;
  var ctl='<div class="rng">'+pill('corrFilter','todo',corrFilter,'To label')+pill('corrFilter','lessons',corrFilter,'Lessons')+pill('corrFilter','all',corrFilter,'All')
    +pill('corrFilter','rules',corrFilter,'\\uD83D\\uDCCF Rules'+(pend?' ('+pend+')':''))
    +pill('corrFilter','rate',corrFilter,'\\uD83D\\uDCC8 Rate')
    +(corrFilter==='rules'||corrFilter==='rate'?'':'<span style="width:14px"></span>'+pill('corrSrc','all',corrSrc,'Everyone')+pill('corrSrc','human',corrSrc,'Your changes')+pill('corrSrc','ai',corrSrc,'AI rework'))
    +'<span style="width:14px"></span><button class="dtab" data-action="corrRefresh">\\u21bb Refresh</button>'
    +(s.suggested&&corrFilter!=='rules'&&corrFilter!=='rate'?'<button class="dtab active" data-action="corrAcceptAll" title="Label every unlabeled correction with its suggestion. You can still change each one.">\\u2714 Accept all suggestions ('+s.suggested+')</button>':'')+'</div>';
  if(corrFilter==='rules'){el.innerHTML=ctl+renderRules(L);return;}
  if(corrFilter==='rate'){el.innerHTML=ctl+renderRate(CORR.rate);return;}
  var kpi='<div class="sg">'+sc('Corrections',String(s.total))+sc('Your changes',String(s.human),undefined,'Lines of AI-written code you changed yourself. These are the most valuable lessons.')
    +sc('AI rework prompts',String(s.prompts),undefined,'Prompts after which Copilot changed its own earlier code.')
    +sc('Labelled',s.labeled+' / '+s.total,s.labeled===s.total&&s.total?'var(--added)':undefined)+sc('Lessons',String(s.lessons),undefined,'Labelled with a lesson category (not requirement change, progress update or not a lesson).')+'</div>';
  var cat=CORR.byCategory.length?'<div class="mb3 card"><h3>By category</h3><table class="w100"><thead><tr><th>Category</th><th>Corrections</th><th>Yours</th><th>Episodes</th><th>Scopes</th></tr></thead><tbody>'
    +CORR.byCategory.map(function(g){return'<tr><td>'+corrCatBadge(g.category)+'</td><td>'+g.count+'</td><td>'+g.human+'</td><td>'+g.episodes+'</td><td class="t-md">'+esc(g.scopes.join(', '))+'</td></tr>';}).join('')+'</tbody></table></div>':'';
  var list=CORR.episodes.filter(corrVisible),shown=list.slice(0,corrLimit);
  var eps=shown.map(function(e){
    var open=!!corrOpen[e.id],when=new Date(e.start).toLocaleString();
    var who=e.source==='human'?'<span class="badge bd">You</span>':'<span class="badge bh">AI</span>';
    var n=e.correctionIds.length,files=e.files.length===1?esc(e.files[0]):e.files.length+' files';
    var lbl=e.category?corrCatBadge(e.category):e.labeled?'<span class="t-md">'+e.labeled+' / '+n+' labelled</span>':'';
    var sug=e.suggestion&&e.labeled<n?' <span class="t-md">\\uD83D\\uDCA1 '+esc(e.suggestion.category)+'</span>':'';
    var head='<div data-action="corrToggle" data-id="'+esc(e.id)+'" style="cursor:pointer;display:flex;gap:8px;align-items:baseline;justify-content:space-between">'
      +'<span>'+(open?'\\u25BE':'\\u25B8')+' '+who+' <span class="muted t-md">'+esc(when)+'</span> \\u00b7 '+files+' \\u00b7 '+n+' change'+(n===1?'':'s')+(e.workItemId?' \\u00b7 #'+esc(e.workItemId):'')+'</span>'
      +'<span>'+lbl+sug+'</span></div>'
      +(e.prompt?'<div style="margin-top:4px;font-size:.9em;color:var(--muted)">'+(e.source==='ai'?'Prompt: ':'Code came from: ')+esc(e.prompt.length>220?e.prompt.slice(0,220)+'\\u2026':e.prompt)+'</div>':'');
    var body='';
    if(open){
      body='<div style="margin-top:8px;display:flex;gap:6px;align-items:center;font-size:.9em">Label all '+n+': <select class="corr-ep-cat" data-ep="'+esc(e.id)+'">'+corrOptions(e.category||'')+'</select>'
        +(e.suggestion&&e.labeled<n?'<button class="btn-sm dtab" data-action="corrAcceptEp" data-ep="'+esc(e.id)+'" data-cat="'+esc(e.suggestion.category)+'">Accept \\u201c'+esc(e.suggestion.category)+'\\u201d for all</button>':'')+'</div>'
        +(e.labeled?'<div style="margin-top:6px;display:flex;gap:6px;align-items:center;font-size:.9em">Note for all '+e.labeled+' labelled: <input class="corr-ep-note" data-ep="'+esc(e.id)+'" style="flex:1" placeholder="One lesson for the whole episode" value="'+esc(corrEpNote(e))+'"></div>':'')
        +e.items.map(corrItem).join('');
    }
    return'<div class="card" style="margin-bottom:10px;border-left:3px solid '+(e.source==='human'?'var(--deleted)':'var(--review)')+'">'+head+body+'</div>';
  }).join('');
  var more=list.length>shown.length?'<button class="dtab" data-action="corrMore">Show more ('+(list.length-shown.length)+')</button>':'';
  var empty=!list.length?(s.total?(corrFilter==='todo'?emptyState('\\u2705 Everything here is labelled'):emptyState('Nothing matches this filter','Pick another filter or widen the filter bar.')):emptyState('No corrections captured yet','They appear when you or Copilot change code an AI edit wrote earlier.')):'';
  el.innerHTML=ctl+'<p class="mb3 t-md muted">Say what was wrong with AI-written code and which files the lesson applies to. Lessons you label here become the input for coding rules for Copilot. Copilot can label them too through the <strong>label_correction</strong> MCP tool.</p>'
    +kpi+cat+eps+more+empty;
}
var ruleOpen={},ruleDelArm={},ruleShowClosed=false,ruleShowOther=false;
function ruleSend(m){m.type='lessonRule';corrLoading=true;vscode.postMessage(m);}
function corrItemById(){var map={};(CORR?CORR.episodes:[]).forEach(function(e){e.items.forEach(function(i){map[i.id]=i;});});return map;}
function ruleCatOptions(sel){var cats=CORR.categories.slice();if(sel&&cats.indexOf(sel)<0)cats.push(sel);return cats.map(function(c){return'<option value="'+esc(c)+'"'+(c===sel?' selected':'')+'>'+esc(c)+'</option>';}).join('');}
function ruleCard(r,items){
  var col={proposed:'var(--review)',approved:'var(--added)',rejected:'var(--deleted)',retired:'var(--muted)'}[r.status];
  var b=function(act,val,lbl,title){return'<button class="btn-sm dtab" data-action="'+act+'" data-id="'+esc(r.id)+'" data-value="'+val+'"'+(title?' title="'+esc(title)+'"':'')+'>'+lbl+'</button>';};
  var acts=r.status==='proposed'?b('ruleStatus','approved','\\u2714 Approve','Copilot gets approved rules after you export them')+b('ruleStatus','rejected','\\u2716 Reject')
    :r.status==='approved'?b('ruleStatus','retired','Retire','No longer applies; kept for history'):b('ruleStatus','proposed','Reopen');
  acts+=ruleDelArm[r.id]?b('ruleDelete','','\\u26A0 Really delete?'):b('ruleDelete','','\\uD83D\\uDDD1 Delete');
  var ex=r.examples.length?'<button class="btn-sm dtab" data-action="ruleExamples" data-id="'+esc(r.id)+'">'+(ruleOpen[r.id]?'\\u25BE':'\\u25B8')+' '+r.examples.length+' example'+(r.examples.length===1?'':'s')+'</button>':'';
  var exBody=ruleOpen[r.id]?r.examples.map(function(id){var i=items[id];return i?'<div style="border-top:1px solid var(--border);padding:6px 0;font-size:.9em"><strong>'+esc(i.kind)+'</strong> '+esc(i.path)+':'+i.line+(i.note?' \\u2014 <em>'+esc(i.note)+'</em>':'')+corrDiff(i)+'</div>':'<div class="t-md muted">'+esc(id)+' (no longer captured)</div>';}).join(''):'';
  return'<div class="card rule-card" style="margin-bottom:10px;border-left:3px solid '+col+'">'
    +'<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:space-between">'
    +'<span class="hrow"><span class="badge '+(r.status==='approved'?'ba':r.status==='proposed'?'bh':'bd')+'">'+esc(r.status)+'</span>'
    +'<select class="rule-cat" data-id="'+esc(r.id)+'">'+ruleCatOptions(r.category)+'</select>'
    +'<input class="rule-scope" data-id="'+esc(r.id)+'" title="Files the rule applies to (glob)" style="width:180px" value="'+esc(r.scope)+'">'
    +(r.repo?'<span class="t-md">only '+esc(r.repo)+'</span>':'')
    +'<span class="t-sm muted">by '+esc(r.createdBy)+'</span></span>'
    +'<span style="display:flex;gap:4px;align-items:center">'+ex+acts+'</span></div>'
    +'<textarea class="rule-text" data-id="'+esc(r.id)+'" rows="2" style="width:100%;box-sizing:border-box;margin-top:6px;font-family:inherit" placeholder="The rule for Copilot in one or two sentences, e.g. \\u201cRead field numbers from the table object; never renumber an existing field.\\u201d">'+esc(r.text)+'</textarea>'
    +ruleEffectHtml(CORR.rate&&CORR.rate.rules.filter(function(e){return e.id===r.id;})[0])
    +exBody+'</div>';
}
function ruleGroup(g,rules){
  var used={};rules.forEach(function(r){if(g.ruleIds.indexOf(r.id)>=0)used[r.text.toLowerCase()]=true;});
  var head='<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between"><span>'+corrCatBadge(g.category)+' <code>'+esc(g.scope)+'</code> \\u00b7 '
    +g.episodes+' episode'+(g.episodes===1?'':'s')+' \\u00b7 '+g.count+' correction'+(g.count===1?'':'s')+(g.human?' ('+g.human+' yours)':'')+' \\u00b7 '+g.workItems.length+' work item'+(g.workItems.length===1?'':'s')
    +(g.suggested?' <span class="badge ba" title="Repeated often enough to become a rule">repeated</span>':'')+(g.ruleIds.length?' <span class="t-md">\\u2714 '+g.ruleIds.length+' rule'+(g.ruleIds.length===1?'':'s')+'</span>':'')+'</span>'
    +'<button class="btn-sm dtab" data-action="ruleCreate" data-key="'+esc(g.key)+'" data-note="-1">\\uFF0B Rule</button></div>';
  var notes=g.notes.map(function(n,ix){return'<div style="display:flex;gap:6px;align-items:baseline;margin-top:4px;font-size:.9em">'
    +(used[n.toLowerCase()]?'<span title="Already a rule">\\u2714</span>':'<button class="dtab" style="padding:0 6px" data-action="ruleCreate" data-key="'+esc(g.key)+'" data-note="'+ix+'" title="Create a rule with this text">\\uFF0B</button>')
    +'<span>\\u201c'+esc(n)+'\\u201d</span></div>';}).join('');
  return'<div class="mb2 card">'+head+(notes||'<div class="mt1 t-md muted">No notes yet. Add a note to the corrections (Lessons filter) or create a rule and write its text.</div>')+'</div>';
}
function ruleEffectHtml(e){
  if(!e)return'';
  var d=e.days+' day'+(e.days===1?'':'s');
  var main=e.before.aiLines||e.after.aiLines
    ?'Corrections in its scope: <strong>'+rpct(e.before.rate)+'</strong> before \\u2192 <strong>'+rpct(e.after.rate)+'</strong> since approval ('+d+')'
      +(e.change!=null?' <span class="'+(e.change>0?'dup':'ddown')+'">'+(e.change>0?'\\u25B2':'\\u25BC')+' '+Math.abs(Math.round(e.change*100))+'%</span>':'')
      +' \\u00b7 '+e.before.corrections+' \\u2192 '+e.after.corrections+' corrections'
    :'No AI lines recorded around the approval yet.';
  var notes=(e.early?' Approved '+d+' ago; wait at least a week before judging.':'')+(e.unlabelledAfter?' '+e.unlabelledAfter+' unlabelled correction'+(e.unlabelledAfter===1?'':'s')+' in its scope since approval; label them to keep the comparison fair.':'');
  return'<div class="mt2 t-md" title="Corrected AI lines of this category in the rule\\u2019s scope per 100 AI lines written, from the approval day until today, compared with the same number of days before (never before correction capture started).">\\uD83D\\uDCC8 '+main+(notes?'<span class="muted">'+notes+'</span>':'')+'</div>';
}
function renderRate(R){
  if(!R||!R.total.corrections)return emptyState('No corrections captured yet','The rate appears when you or Copilot change code an AI edit wrote earlier.');
  var wk=R.trendWeeks;
  var intro='<p class="mb3 t-md muted">Is Copilot getting better? The correction rate is the number of AI-written lines changed later (by you or by a rework prompt) per 100 AI lines written. Lower is better. Requirement changes, progress updates and \\u201cnot a lesson\\u201d do not count; unlabelled corrections do. Rework time is estimated per episode: from the rework prompt (or first edit) to the last edit, 1 to 30 minutes. Copilot can read this through the <strong>correction_rate</strong> MCP tool.</p>';
  var kp='<div class="sg">'+sc('Rate, last '+wk+' weeks',rpct(R.recent.rate),undefined,R.recent.correctedLines+' of '+R.recent.aiLines+' AI lines corrected.')
    +sc('Rate, '+wk+' weeks before',rpct(R.previous.rate),undefined,R.previous.correctedLines+' of '+R.previous.aiLines+' AI lines corrected.')
    +sc('Since capture started',rpct(R.total.rate),undefined,'Capture started '+(R.since?new Date(R.since).toLocaleDateString():'\\u2014')+'. '+R.total.correctedLines+' of '+R.total.aiLines+' AI lines corrected.')
    +sc('Rework time',fmt(R.total.reworkMs),'var(--deleted)',R.total.episodes+' correction episodes since capture started.')+'</div>';
  var cats=Object.keys(R.weeks.reduce(function(m,w){Object.keys(w.byCategory).forEach(function(k){m[k]=1;});return m;},{}));
  var weeks='<div class="mb3 card"><h3>Per week</h3><div class="ox"><table class="w100"><thead><tr><th>Week</th><th>AI lines</th><th>Corrected</th><th>Rate</th><th>Yours</th><th>Episodes</th><th>Rework</th><th>Top categories</th></tr></thead><tbody>'
    +R.weeks.slice().reverse().map(function(w){
      var top=Object.keys(w.byCategory).sort(function(a,b){return w.byCategory[b]-w.byCategory[a];}).slice(0,3).map(function(k){return esc(k)+' '+w.byCategory[k];}).join(', ');
      return'<tr><td>'+esc(fday(w.week,true))+'</td><td>'+w.aiLines+'</td><td>'+w.correctedLines+'</td><td>'+rpct(w.rate)+'</td><td>'+w.human+'</td><td>'+w.episodes+'</td><td>'+(w.reworkMs?fmt(w.reworkMs):'\\u2014')+'</td><td class="t-md">'+top+'</td></tr>';
    }).join('')+'</tbody></table></div></div>';
  var catT=R.categories.length?'<div class="mb3 card"><h3>Per category</h3><table class="w100"><thead><tr><th>Category</th><th>Corrected lines</th><th>Corrections</th><th>Episodes</th><th>Last '+wk+' wk</th><th>Before</th><th>Trend</th></tr></thead><tbody>'
    +R.categories.map(function(c){return'<tr><td>'+corrCatBadge(c.category==='unlabelled'?'':c.category)+(c.category==='unlabelled'?'<em>unlabelled</em>':'')+'</td><td>'+c.correctedLines+'</td><td>'+c.corrections+'</td><td>'+c.episodes+'</td><td>'+rpct(c.recent)+'</td><td>'+rpct(c.previous)+'</td><td>'+trendHtml(c.trend)+'</td></tr>';}).join('')+'</tbody></table></div>':'';
  var grp=function(title,rows,label){return rows.length?'<div class="mb3 card"><h3>'+title+'</h3><table class="w100"><thead><tr><th>'+title.replace('Per ','')+'</th><th>AI lines</th><th>Corrected</th><th>Rate</th><th>Episodes</th><th>Rework</th></tr></thead><tbody>'
    +rows.map(function(g){return'<tr><td>'+label(g.key)+'</td><td>'+g.aiLines+'</td><td>'+g.correctedLines+'</td><td>'+rpct(g.rate)+'</td><td>'+g.episodes+'</td><td>'+fmt(g.reworkMs)+'</td></tr>';}).join('')+'</tbody></table></div>':'';};
  var wiLabel=function(k){if(!k||k==='__unassigned__')return'<em>Unassigned</em>';var w=(WI||[]).find(function(x){return x.workItemId===k;});return'#'+esc(k)+(w&&w.title?' '+esc(w.title):'');};
  var pjLabel=function(k){if(!k)return'<em>No project</em>';var p=(PROJ||[]).find(function(x){return x.projectId===k;});return esc(p?p.name:k);};
  var byId={};((CORR.lessons&&CORR.lessons.rules)||[]).forEach(function(r){byId[r.id]=r;});
  var rules=R.rules.length?'<div class="mb3 card"><h3>Rules: before vs after approval</h3>'
    +R.rules.map(function(e){return'<div style="border-top:1px solid var(--border);padding:6px 0">'+corrCatBadge(e.category)+' <code>'+esc(e.scope)+'</code> <span class="t-md muted">'+esc(e.status)+' \\u00b7 approved '+esc(new Date(e.approvedAt).toLocaleDateString())+'</span><div style="font-size:.9em">'+esc(e.text||(byId[e.id]&&byId[e.id].text)||'')+'</div>'+ruleEffectHtml(e)+'</div>';}).join('')+'</div>'
    :'<div class="mb3 card">No approved rules yet. Approve a rule on the Rules tab to compare its corrections before and after.</div>';
  var note='<p class="t-sm muted">AI lines are the lines Copilot added on the branches, without translation files (like the productivity metrics). They include short lines (fewer than 6 characters) that corrections do not follow, so the rate is a lower bound. Work items and projects follow the current branch mapping.</p>';
  return intro+kp+weeks+catT+rules+grp('Per work item',R.workItems,wiLabel)+grp('Per project',R.projects,pjLabel)+note;
}
function renderRules(L){
  var items=corrItemById();
  var by=function(st){return L.rules.filter(function(r){return st.indexOf(r.status)>=0;});};
  var proposed=by(['proposed']),approved=by(['approved']),closed=by(['rejected','retired']);
  var cand=L.groups.filter(function(g){return g.suggested&&!g.ruleIds.length;}),other=L.groups.filter(function(g){return!(g.suggested&&!g.ruleIds.length);});
  var bar='<div class="mb3 rng"><button class="dtab" data-action="ruleNew">\\uFF0B New rule</button>'
    +'<button class="dtab'+(approved.length?' active':'')+'" data-action="ruleExport" title="Write the approved rules as .instructions.md files that Copilot reads automatically for matching files">\\u21EA Export to Copilot ('+approved.length+')</button></div>';
  var intro='<p class="mb3 t-md muted">Lessons that repeat (at least '+L.minOccurrences+' episodes on '+L.minWorkItems+' work items) are suggested as rules. Create a rule from a note, edit its text and scope, then approve it. <strong>Export to Copilot</strong> writes the approved rules as instructions files that Copilot follows for matching files. Copilot can also read them (<strong>get_lessons</strong>) and propose rules (<strong>propose_rule</strong>) through MCP.</p>';
  var kpi='<div class="sg">'+sc('Approved',String(approved.length),approved.length?'var(--added)':undefined)+sc('Proposed',String(proposed.length),undefined,'Waiting for your decision.')
    +sc('Repeated lessons',String(cand.length),undefined,'Lessons corrected often enough to become a rule, without a rule yet.')+sc('Rejected / retired',String(closed.length))+'</div>';
  var sec=function(t,body){return body?'<h3 style="margin:14px 0 8px">'+t+'</h3>'+body:'';};
  var html=bar+intro+kpi
    +sec('\\uD83D\\uDCA1 Repeated lessons without a rule ('+cand.length+')',cand.map(function(g){return ruleGroup(g,L.rules);}).join(''))
    +sec('\\u23F3 Proposed rules ('+proposed.length+')',proposed.map(function(r){return ruleCard(r,items);}).join(''))
    +sec('\\u2705 Approved rules ('+approved.length+')',approved.map(function(r){return ruleCard(r,items);}).join(''))
    +(other.length?'<h3 style="margin:14px 0 8px;cursor:pointer" data-action="ruleOther">'+(ruleShowOther?'\\u25BE':'\\u25B8')+' Other lessons ('+other.length+')</h3>'+(ruleShowOther?other.map(function(g){return ruleGroup(g,L.rules);}).join(''):''):'')
    +(closed.length?'<h3 style="margin:14px 0 8px;cursor:pointer" data-action="ruleClosed">'+(ruleShowClosed?'\\u25BE':'\\u25B8')+' Rejected / retired ('+closed.length+')</h3>'+(ruleShowClosed?closed.map(function(r){return ruleCard(r,items);}).join(''):''):'');
  if(!L.rules.length&&!L.groups.length)html+=emptyState('No lessons yet','Label corrections with a lesson category (and a note on why) first; repeated lessons show up here.');
  return html;
}
function ruleFromGroup(key,noteIx){
  var g=(CORR.lessons.groups||[]).filter(function(x){return x.key===key;})[0];if(!g)return;
  var ix=parseInt(noteIx,10),text=ix>=0?g.notes[ix]||'':'',items=corrItemById();
  var ex=text?g.examples.filter(function(id){return items[id]&&(items[id].note||'').toLowerCase()===text.toLowerCase();}):[];
  ruleSend({op:'create',rule:{category:g.category,scope:g.scope,text:text,examples:ex.length?ex:g.examples}});
}
function corrEpisode(id){return CORR?CORR.episodes.filter(function(e){return e.id===id;})[0]:null;}
function corrEpNote(e){var ns=e.items.filter(function(i){return i.category;}).map(function(i){return i.note||'';});return ns.length&&ns.every(function(n){return n===ns[0];})?ns[0]:'';}
function corrLabel(ids,category,scope,note){var m={type:'labelCorrections',ids:ids,category:category};if(scope!==undefined)m.scope=scope;if(note!==undefined)m.note=note;corrLoading=true;vscode.postMessage(m);}
document.addEventListener('change',function(e){
  var t=e.target;if(!t||!t.classList)return;
  if(t.classList.contains('set-in')){setSend(t.dataset.key,t.type==='checkbox'?t.checked:t.value);return;}
  var row=t.closest?t.closest('.corr-row'):null;
  var rowVal=function(cls){var x=row?row.querySelector(cls):null;return x?x.value:undefined;};
  if(t.classList.contains('corr-cat')){
    corrLabel([t.dataset.id],t.value,t.value?rowVal('.corr-scope'):undefined,t.value?rowVal('.corr-note'):undefined);
  }else if(t.classList.contains('corr-scope')){
    var cv0=rowVal('.corr-cat');if(cv0)corrLabel([t.dataset.id],cv0,t.value);
  }else if(t.classList.contains('corr-note')){
    var cv1=rowVal('.corr-cat');if(cv1)corrLabel([t.dataset.id],cv1,undefined,t.value);
  }else if(t.classList.contains('corr-ep-cat')){
    var ep=corrEpisode(t.dataset.ep);if(ep)corrLabel(ep.correctionIds,t.value);
  }else if(t.classList.contains('corr-ep-note')){
    var ep2=corrEpisode(t.dataset.ep),byCat={};
    if(ep2)ep2.items.forEach(function(i){if(i.category)(byCat[i.category]=byCat[i.category]||[]).push(i.id);});
    Object.keys(byCat).forEach(function(c){corrLabel(byCat[c],c,undefined,t.value);});
  }else if(t.classList.contains('rule-cat')||t.classList.contains('rule-scope')||t.classList.contains('rule-text')){
    var f=t.classList.contains('rule-cat')?'category':t.classList.contains('rule-scope')?'scope':'text',pa={};pa[f]=t.value;
    ruleSend({op:'update',id:t.dataset.id,patch:pa});
  }
});

// #97/#98 Estimates tab: accuracy of finished work items + suggestions for open ones.
var EST=null,estLoading=false;
function requestEstimates(){estLoading=true;renderEstimates();vscode.postMessage({type:'estimates',projectId:GF.projectId||undefined,workItemId:GF.workItemId||undefined});}
function estFactor(f){if(f==null)return'\\u2014';var c=Math.abs(f-1)<=0.2?'var(--added)':f>1?'var(--deleted)':'var(--review)';return'<span style="color:'+c+'">'+f.toFixed(2)+'\\u00d7</span>';}
function estRange(r){return r?(r.median+' h <span class="t-sm muted">('+r.low+'\\u2013'+r.high+')</span>'):'\\u2014';}
function estGroupRows(list,label){return list.map(function(g){return'<tr><td>'+esc(label?label(g.key):g.key)+'</td><td>'+g.count+'</td><td>'+estFactor(g.medianFactor)+'</td><td>'+g.withinPct+'%</td><td>'+g.overPct+'%</td><td>'+g.underPct+'%</td><td>'+g.meanAbsErrorPct+'%</td></tr>';});}
function renderEstimates(){
  var el=document.getElementById('estimates');
  var ctl='<div class="rng"><button class="dtab" data-action="estRefresh">\\u21bb Refresh</button></div>';
  var info='<p style="margin:10px 0;font-size:.85em;color:var(--muted)">A work item counts as <strong>finished</strong> when you mark it done (\\u2713 on the work item) or when it has had no tracked time or credits for 14 days. <strong>Factor</strong> = actual \\u00f7 estimate: 1.00\\u00d7 is spot on, 1.40\\u00d7 took 40% longer. Actual = active tracked time (coding + AI + review, incl. manual entries). Suggestions come from finished items with similar titles or the same project.</p>';
  if(!EST){el.innerHTML=ctl+info+(estLoading?loadingState('Analysing\\u2026'):emptyState('No estimate data yet','Add hour estimates to work items and mark them done to measure accuracy.'));bindEst();return;}
  if(EST.error){el.innerHTML=ctl+info+'<p class="c-del">'+esc(EST.error)+'</p>';bindEst();return;}
  var A=EST.accuracy,O=A.overall;
  var projName=function(id){var p=(PROJ||[]).find(function(x){return x.projectId===id;});return p?p.name:id;};
  var stats='<div class="sg">'+sc('Finished items',String(A.finished))+sc('With hour estimate',String(A.rows.length))
    +sc('Median factor',O?estFactor(O.medianFactor):'\\u2014')+sc('Within \\u00b120%',O?O.withinPct+'%':'\\u2014','var(--added)')
    +sc('Over / under',O?O.overPct+'% / '+O.underPct+'%':'\\u2014')+sc('Mean abs. error',O?O.meanAbsErrorPct+'%':'\\u2014')+'</div>';
  var sizeL={small:'< 4 h',medium:'4\\u201316 h',large:'> 16 h'};
  var gh=['Group','Items','Median factor','Within \\u00b120%','Over','Under','Mean abs. error'];
  var groups=O?'<div class="cr"><div class="card"><h3>By size</h3>'+optTable(gh,estGroupRows(A.bySize,function(k){return sizeL[k]||k;}),'\\u2014')+'</div>'
    +'<div class="card"><h3>By project</h3>'+optTable(gh,estGroupRows(A.byProject,projName),'\\u2014')+'</div></div>'
    +'<div class="cr"><div class="card"><h3>Trend by month</h3><div style="height:200px"><canvas id="estChart"></canvas></div></div>'
    +'<div class="card"><h3>By category (breakdown estimates)</h3>'+optTable(['Category','Items','Estimated','Actual','Factor'],A.byCategory.map(function(c){return'<tr><td>'+esc(c.category)+'</td><td>'+c.count+'</td><td>'+c.estimateHours+' h</td><td>'+c.actualHours+' h</td><td>'+estFactor(c.factor)+'</td></tr>';}),'No per-category estimates on finished items')+'</div></div>'
    :'<div class="mb3 card">No finished work items with an hour estimate yet'+(A.unestimated?' ('+A.unestimated+' finished without an hour estimate'+(A.points?', '+A.points+' in story points':'')+')':'')+'. Mark work items done to start measuring accuracy.</div>';
  var fin=A.rows.map(function(r){return'<tr data-action="wiOpen" data-id="'+esc(r.id)+'" class="ptr"><td>#'+esc(r.id)+(r.title?' \\u2013 '+esc(r.title):'')+'</td><td>'+esc(r.projectId?projName(r.projectId):'')+'</td><td>'+esc(r.month||'')+'</td><td>'+r.estimate+' h</td><td>'+r.actual+' h</td><td>'+estFactor(r.factor)+'</td><td>'+n2(r.credits)+'</td></tr>';});
  var open=(EST.open||[]).map(function(o){
    var est=o.estimateHours!=null?o.estimateHours+' h':o.estimatePoints!=null?o.estimatePoints+' pts':'<span class="dim badge">none</span>';
    var pct=o.estimateHours?Math.round(o.actualHours/o.estimateHours*100)+'%':'\\u2014';
    var adj=o.adjusted!=null&&o.biasFactor!=null&&Math.abs(o.biasFactor-1)>0.2?o.adjusted+' h':'\\u2014';
    var basis={similar:'similar titles',project:'same project',all:'all finished',none:''}[o.basis]||'';
    return'<tr><td><a href="#" data-action="wiOpen" data-id="'+esc(o.id)+'">#'+esc(o.id)+'</a>'+(o.title?' \\u2013 '+esc(o.title):'')+(o.status==='active'?' <span class="badge bh">active</span>':'')+'</td><td>'+est+'</td><td>'+o.actualHours+' h ('+pct+')</td><td>'+estRange(o.suggestion)+(basis?'<div class="t-xs muted">'+esc(basis)+'</div>':'')+'</td><td>'+adj+'</td>'
      +'<td class="nw"><button class="dtab" data-action="estSet" data-id="'+esc(o.id)+'">\\uD83D\\uDCCF Estimate</button> <button class="dtab" data-action="wiDone" data-id="'+esc(o.id)+'">\\u2713 Done</button></td></tr>';
  });
  el.innerHTML=ctl+info+stats+groups
    +'<div class="card"><h3>Open work items</h3>'+optTable(['Work item','Estimate','Actual (used)','Suggested','Bias-adjusted','' ],open,'No open work items')+'</div>'
    +'<div class="mt3 card"><h3>Finished work items</h3>'+optTable(['Work item','Project','Finished','Estimate','Actual','Factor','Credits'],fin,'None yet')+'</div>';
  bindEst();
  if(O&&typeof Chart!=='undefined'){
    var cv=document.getElementById('estChart');
    if(cv){dc('est');charts.est=new Chart(cv,{type:'line',data:{labels:A.byMonth.map(function(g){return g.key;}),datasets:[
      {label:'Median factor',data:A.byMonth.map(function(g){return g.medianFactor;}),borderColor:'#c586c0',yAxisID:'y',tension:.25},
      {label:'Within \\u00b120% (%)',data:A.byMonth.map(function(g){return g.withinPct;}),borderColor:'#4ec9b0',yAxisID:'y1',tension:.25}]},
      options:{responsive:true,maintainAspectRatio:false,scales:{y:{position:'left',title:{display:true,text:'factor'}},y1:{position:'right',min:0,max:100,grid:{drawOnChartArea:false}}}}});}
  }
}
function bindEst(){}

// #95 Sessions tab: all chat sessions with titles, filters, sorting, paging, CSV.
var SES=null,sesLoading=false,sesOpen={},sesDet={};
var sesQ={branch:'',model:'',minCredits:0,lowOutputOnly:false,sort:'end',descending:true,offset:0,limit:50};
function sesMsg(type){return Object.assign({type:type},sesQ,gfQuery());}
function requestSessions(){sesLoading=true;renderSessions();vscode.postMessage(sesMsg('sessions'));}
function sesSelect(id,first,items,val){
  return'<select id="'+id+'" class="sesin"><option value="">'+esc(first)+'</option>'+items.map(function(o){return'<option value="'+esc(o[0])+'"'+(o[0]===val?' selected':'')+'>'+esc(o[1])+'</option>';}).join('')+'</select>';
}
function sesWhen(s){return esc(String(s||'').slice(0,16).replace('T',' '));}
function sesDetailHtml(id){
  var d=sesDet[id];
  if(!d)return'<em>Loading\\u2026</em>';
  if(!d.detail)return'<em>No captured usage for this session.</em>';
  var P=d.prompts||{};
  var rows=d.detail.turns.map(function(t){
    var tools=(t.tools||[]).slice().sort(function(a,b){return b.calls-a.calls;}).slice(0,3).map(function(x){return esc(x.name)+' \\u00d7'+x.calls;}).join(', ');
    var add=0,rem=0;(t.filesEdited||[]).forEach(function(f){add+=f.added||0;rem+=f.removed||0;});
    var cb=(t.cacheBreaks||[]).filter(function(b){return b.cause!=='new-context';}).map(function(b){return esc(b.cause);}).join(', ');
    var p=P[t.turnId];
    return'<tr><td class="nw">'+sesWhen(t.at)+'</td><td style="max-width:320px">'+(p?esc(p):'<span class="muted">\\u2014</span>')+'</td><td>'+esc((t.models||[]).join(', '))+'</td><td>'+t.calls+'</td><td>'+n2(t.credits)+'</td><td>'+t.cacheHitPct+'%</td><td>'+(tools||'\\u2014')+'</td><td>+'+add+' / \\u2212'+rem+'</td><td>'+(cb||'\\u2014')+'</td><td>'+esc(t.workItemId?('#'+t.workItemId):(t.branch||''))+'</td><td><button class="dtab" data-action="ledEdit" data-id="'+esc(t.entryId||'')+'" title="Edit / reassign this turn\\u2019s credits to another work item">\\u270E</button></td></tr>';
  });
  return'<div style="padding:6px 0"><div style="font-size:.8em;color:var(--muted);margin-bottom:6px">Session '+esc(id)+' <button class="dtab" style="padding:1px 8px;margin-left:8px" data-action="handoff" data-id="'+esc(id)+'" title="Open a new chat pre-filled with a summary of this one (work item, branch, files, commits)">\u21aa New chat with handoff</button></div>'
    +optTable(['Turn','Prompt','Models','Calls','Credits','Cache hit','Top tools','Lines','Cache misses','Work item','' ],rows,'No turns')+'</div>';
}
function renderSessions(){
  var el=document.getElementById('sessions');
  var S=SES&&!SES.error?SES:{rows:[],total:0,offset:0,totals:{credits:0,turns:0,lowOutput:0},models:[],branches:[],titles:{}};
  var ctl='<div class="rng" style="flex-wrap:wrap;gap:6px;align-items:center">'
    +sesSelect('sesBranch','All branches',S.branches.map(function(b){return[b,b];}),sesQ.branch)
    +sesSelect('sesModel','All models',S.models.map(function(m){return[m,m];}),sesQ.model)
    +'<label>Min credits <input type="number" min="0" step="1" id="sesMin" class="sesin" style="width:70px" value="'+(sesQ.minCredits||'')+'"></label>'
    +'<label><input type="checkbox" id="sesLow"'+(sesQ.lowOutputOnly?' checked':'')+'> Expensive, low output only</label>'
    +'<button class="dtab" data-action="sesRefresh">\\u21bb Refresh</button><button class="dtab" data-action="sesCsv">\\u2B07 Export CSV</button></div>';
  var info='<p style="margin:10px 0;font-size:.85em;color:var(--muted)">Every Copilot chat session with captured usage. Titles are the chat names VS Code shows (or the first prompt), read from local files on demand and never stored'+(SES&&SES.showTitles===false?' \\u2013 <strong>hidden</strong> by <code>aiEffortTracker.sessions.showTitles</code>':'')+'. Click a row for per-turn detail. \\uD83D\\uDCB8 = top-quartile credits but fewer than 10 lines changed.</p>';
  if(SES&&SES.error){el.innerHTML=ctl+info+'<p class="c-del">'+esc(SES.error)+'</p>';bindSes();return;}
  if(!SES){el.innerHTML=ctl+info+(sesLoading?loadingState():emptyState('No sessions yet','Chat sessions appear once Copilot requests are captured from the chat debug log.'));bindSes();return;}
  var cols=[['title','Chat',0],['end','Last activity',1],['durationMin','Duration',1],['wi','Work item / branch',0],['models','Models',0],['turns','Turns',1],['calls','Calls',1],['credits','Credits',1],['creditsPerTurn','Cr / turn',1],['cacheHitPct','Cache hit',1],['maxInputTokens','Max context',1],['linesChanged','Lines \\u00b1',1],['avoidableCacheBreaks','Avoidable misses',1]];
  var head='<tr>'+cols.map(function(c){
    if(!c[2])return'<th>'+c[1]+'</th>';
    var arrow=sesQ.sort===c[0]?(sesQ.descending?' \\u25BC':' \\u25B2'):'';
    return'<th data-action="sesSort" data-value="'+c[0]+'" class="ptr nw" title="Sort">'+c[1]+arrow+'</th>';
  }).join('')+'</tr>';
  var T=S.titles||{};
  var body=S.rows.map(function(s){
    var open=!!sesOpen[s.sessionId];
    var title=T[s.sessionId]?esc(T[s.sessionId]):'<span class="muted">'+esc(s.sessionId.slice(0,8))+'\\u2026</span>';
    var flag=s.expensiveLowOutput?' <span class="badge bd" title="Top-quartile credits in this period but fewer than 10 lines changed">\\uD83D\\uDCB8 low output</span>':'';
    var where=s.workItems.length?'#'+s.workItems.join(', #'):s.branches.join(', ');
    var row='<tr data-action="sesRow" data-id="'+esc(s.sessionId)+'" class="ptr"><td style="max-width:280px" title="'+esc(s.sessionId)+'">'+(open?'\\u25BE ':'\\u25B8 ')+title+flag+'</td><td class="nw">'+sesWhen(s.end)+'</td><td class="nw">'+fmtMin(s.durationMin)+'</td><td>'+esc(where)+'</td><td>'+esc(s.models.join(', '))+'</td><td>'+s.turns+'</td><td>'+s.calls+'</td><td>'+n2(s.credits)+'</td><td>'+n2(s.creditsPerTurn)+'</td><td>'+s.cacheHitPct+'%</td><td>'+Math.round(s.maxInputTokens/1000)+'K</td><td class="nw">+'+s.linesAdded+' / \\u2212'+s.linesRemoved+'</td><td>'+s.avoidableCacheBreaks+'</td></tr>';
    return open?row+'<tr><td colspan="'+cols.length+'">'+sesDetailHtml(s.sessionId)+'</td></tr>':row;
  }).join('')||'<tr class="empty-row"><td colspan="'+cols.length+'">No sessions match these filters.</td></tr>';
  var first=S.total?S.offset+1:0,last=Math.min(S.total,S.offset+S.rows.length);
  var pager='<div style="display:flex;gap:8px;align-items:center;margin-top:10px"><button class="dtab" data-action="sesPage" data-value="-1"'+(S.offset>0?'':' disabled')+'>\\u2190 Prev</button><span>'+first+'\\u2013'+last+' of '+S.total+'</span><button class="dtab" data-action="sesPage" data-value="1"'+(last<S.total?'':' disabled')+'>Next \\u2192</button></div>';
  var stats='<div class="sg">'+sc('Sessions',String(S.total))+sc('Credits',n2(S.totals.credits),'var(--cost)')+sc('Turns',String(S.totals.turns))+sc('Expensive, low output',String(S.totals.lowOutput),'var(--deleted)')+'</div>';
  el.innerHTML=ctl+info+stats+'<div class="ox card"><table><thead>'+head+'</thead><tbody>'+body+'</tbody></table>'+pager+'</div>';
  bindSes();
}
function bindSes(){
  var on=function(id,fn){var n=document.getElementById(id);if(n)n.addEventListener('change',function(){fn(this);sesQ.offset=0;requestSessions();});};
  on('sesBranch',function(n){sesQ.branch=n.value;});
  on('sesModel',function(n){sesQ.model=n.value;});
  on('sesMin',function(n){sesQ.minCredits=parseFloat(n.value)||0;});
  on('sesLow',function(n){sesQ.lowOutputOnly=!!n.checked;});
}
function toggleSession(id){
  if(sesOpen[id]){delete sesOpen[id];renderSessions();return;}
  sesOpen[id]=true;delete sesDet[id];renderSessions();
  vscode.postMessage({type:'sessionDetail',sessionId:id});
}

window.addEventListener('message',function(e){
  var msg=e.data;
  if(msg.type==='sessionsData'){sesLoading=false;SES=msg;var sv=document.querySelector('.view.active');if(sv&&sv.id==='sessions')renderSessions();return;}
  if(msg.type==='sessionDetailData'){sesDet[msg.sessionId]=msg;var dv=document.querySelector('.view.active');if(dv&&dv.id==='sessions')renderSessions();return;}
  if(msg.type==='openWorkItem'&&msg.id){selWi=String(msg.id);projView='workitem';showTab('projects');return;}
  if(msg.type==='openTab'&&['overview','trends','focus','projects','ledger','optimize','sessions','estimates','timesheet','health','corrections','settings'].indexOf(msg.tab)>=0){showTab(msg.tab);return;}
  if(msg.type==='timesheetData'){tsLoading=false;TS=msg;var tv=document.querySelector('.view.active');if(tv&&tv.id==='timesheet')renderTimesheet();return;}
  if(msg.type==='correctionsData'){corrLoading=false;CORR=msg;var cv=document.querySelector('.view.active');if(cv&&cv.id==='corrections')renderCorrections();return;}
  if(msg.type==='settingsData'){setLoading=false;SET=msg;var kept=setResult(msg.result);var stv=document.querySelector('.view.active');if(!kept&&stv&&stv.id==='settings')renderSettings();return;}
  if(msg.type==='healthData'){healthLoading=false;HEALTH=msg.report;var hv=document.querySelector('.view.active');if(hv&&hv.id==='health')renderHealth();return;}
  if(msg.type==='estimatesData'){estLoading=false;EST=msg;var ev=document.querySelector('.view.active');if(ev&&ev.id==='estimates')renderEstimates();return;}
  if(msg.type==='optimizeData'){optLoading=false;OPT=msg;var ov=document.querySelector('.view.active');if(ov&&ov.id==='optimize')renderOptimize();return;}
  if(msg.type==='update'){
    allData=msg.summaries;currentBranch=msg.currentBranch;
    if(msg.ghMetrics!==undefined)ghMetrics=msg.ghMetrics;
    if(msg.config!==undefined&&msg.config)CFG=msg.config;
    if(msg.analytics!==undefined&&msg.analytics)AN=msg.analytics;
    if(msg.billing!==undefined)BL=msg.billing;
    if(msg.projectSummaries!==undefined&&msg.projectSummaries)PROJ=msg.projectSummaries;
    if(msg.workItemSummaries!==undefined&&msg.workItemSummaries)WI=msg.workItemSummaries;
    if(msg.ledger!==undefined&&msg.ledger)LEDGER=msg.ledger;
    if(msg.manualEffort!==undefined&&msg.manualEffort)ME=msg.manualEffort;
    if(msg.reassignments!==undefined&&msg.reassignments)RE=msg.reassignments;
    if(msg.netChange!==undefined)NET=msg.netChange;
    var av=document.querySelector('.view.active');
    if(av&&av.id==='overview')renderOverview();
    else if(av&&av.id==='trends')renderTrends();
    else if(av&&av.id==='focus')renderFocus();
    else if(av&&av.id==='ghview')renderGhMetrics();
    else if(av&&av.id==='projects')renderProjectsView();
    else if(av&&av.id==='ledger')renderLedger();
    else if(av&&av.id==='timesheet')requestTimesheet();
    else if(av&&av.id==='detail'){var dt=document.getElementById('dtab');if(dt&&dt.dataset.branch)showDetail(dt.dataset.branch);}
    renderFilterBar();
  }
});

document.addEventListener('input',function(e){
  var t=e.target;if(!t||t.id!=='set-q')return;
  setQ=t.value;renderSettings();var q2=document.getElementById('set-q');if(q2){q2.focus();q2.setSelectionRange(q2.value.length,q2.value.length);}
});
renderOverview();
renderFilterBar();
// Wire up tab buttons (CSP blocks inline onclick — use addEventListener instead)
document.getElementById('tab-overview').addEventListener('click',function(){showTab('overview');});
document.getElementById('tab-trends').addEventListener('click',function(){showTab('trends');});
document.getElementById('tab-focus').addEventListener('click',function(){showTab('focus');});
document.getElementById('tab-ghview').addEventListener('click',function(){showTab('ghview');});
document.getElementById('tab-projects').addEventListener('click',function(){showTab('projects');});
document.getElementById('tab-ledger').addEventListener('click',function(){showTab('ledger');});
document.getElementById('tab-optimize').addEventListener('click',function(){showTab('optimize');});
document.getElementById('tab-sessions').addEventListener('click',function(){showTab('sessions');});
document.getElementById('tab-estimates').addEventListener('click',function(){showTab('estimates');});
document.getElementById('tab-timesheet').addEventListener('click',function(){showTab('timesheet');});
document.getElementById('tab-health').addEventListener('click',function(){showTab('health');});
document.getElementById('tab-corrections').addEventListener('click',function(){showTab('corrections');});
document.getElementById('tab-settings').addEventListener('click',function(){showTab('settings');});
document.getElementById('dtab').addEventListener('click',function(){
  var br=this.dataset.branch||currentBranch;showDetail(br);
});
// Event delegation for dynamically generated content (branch rows, back button, detail sub-tabs)
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-action]');
  if(!t)return;
  if(t.tagName!=='SUMMARY'&&t.closest('summary'))e.preventDefault();
  var a=t.dataset.action,v=t.dataset.value;
  if(a==='detail')showDetail(v);
  else if(a==='tab'){if(t.dataset.rate)corrFilter='rate';showTab(v);}
  else if(a==='ds')showDS(v,t);
  else if(a==='calMetric'){calMetric=v;renderCalendar();}
  else if(a==='calDay'){calSel=v||null;renderCalendar();}
  else if(a==='optRefresh')requestOptimize();
  else if(a==='setGrp'){setGrp=v||'';renderSettings();}
  else if(a==='setReset')vscode.postMessage({type:'resetSetting',key:t.dataset.key});
  else if(a==='setClearWs')vscode.postMessage({type:'clearWorkspaceSetting',key:t.dataset.key});
  else if(a==='setToken'||a==='clearToken'||a==='moveTokenToSecure')vscode.postMessage({type:a});
  else if(a==='setOpenUi')vscode.postMessage({type:'openSettingsJson'});
  else if(a==='setSave')setCollect(t.dataset.key);
  else if(a==='setRowDel'){var kvr=t.closest('.set-kv');if(kvr)kvr.remove();}
  else if(a==='setRowAdd'){var srs=setGet(t.dataset.key),box=t.closest('.set-ed').querySelector('.set-rows');if(srs&&box){box.insertAdjacentHTML('beforeend',setKvRow(srs,'',srs.kind==='map'&&srs.valueKind==='enum'?(srs.valueOptions||[])[0]:''));var ni=box.lastElementChild.querySelector('input');if(ni)ni.focus();}}
  else if(a==='sesRefresh')requestSessions();
  else if(a==='sesCsv')vscode.postMessage(sesMsg('sessionsCsv'));
  else if(a==='sesSort'){if(sesQ.sort===v)sesQ.descending=!sesQ.descending;else{sesQ.sort=v;sesQ.descending=true;}sesQ.offset=0;requestSessions();}
  else if(a==='sesPage'){sesQ.offset=Math.max(0,sesQ.offset+(parseInt(v,10)||0)*sesQ.limit);requestSessions();}
  else if(a==='sesRow')toggleSession(t.dataset.id);
  else if(a==='proj'){selProj=v;selWi=null;projView='project';renderProjectsView();}
  else if(a==='wi'){selWi=v;projView='workitem';renderProjectsView();}
  else if(a==='pprojects'){projView='list';selProj=null;selWi=null;renderProjectList();}
  else if(a==='cmd')vscode.postMessage({type:'cmd',value:v});
  else if(a==='gfRange'){gfSet({range:v});}
  else if(a==='gfClear'){if(v==='all')gfSet({range:'30',projectId:'',workItemId:''});else{var gp={};gp[v]='';gfSet(gp);}}
  else if(a==='ovWi'){selWi=String(v);projView='workitem';showTab('projects');}
  else if(a==='ledEdit')vscode.postMessage({type:'cmd',value:'editLedgerEntry',arg:t.dataset.id});
  else if(a==='ledDel')vscode.postMessage({type:'cmd',value:'deleteLedgerEntry',arg:t.dataset.id});
  else if(a==='ledDetail')toggleLedgerDetail(t.dataset.id);
  else if(a==='meAdd')vscode.postMessage({type:'cmd',value:'addManualEffort',arg:t.dataset.id});
  else if(a==='meEdit')vscode.postMessage({type:'cmd',value:'editManualEffort',arg:t.dataset.id});
  else if(a==='meDel')vscode.postMessage({type:'cmd',value:'deleteManualEffort',arg:t.dataset.id});
  else if(a==='teAdd')vscode.postMessage({type:'cmd',value:'addTimeEntry',arg:(t.dataset.id||'')+'\\u0000'+(t.dataset.branch||'')});
  else if(a==='teEdit')vscode.postMessage({type:'cmd',value:'editTimeEntry',arg:t.dataset.id});
  else if(a==='teDel')vscode.postMessage({type:'cmd',value:'deleteTimeEntry',arg:t.dataset.id});
  else if(a==='moveBranch')vscode.postMessage({type:'cmd',value:'moveBranchToWorkItem',arg:t.dataset.id});
  else if(a==='reassignBulk')vscode.postMessage({type:'cmd',value:'reassignBranchesBulk',arg:t.dataset.id});
  else if(a==='wiDel')vscode.postMessage({type:'cmd',value:'deleteWorkItem',arg:t.dataset.id});
  else if(a==='bhSet')vscode.postMessage({type:'cmd',value:'setBillableHours',arg:t.dataset.id});
  else if(a==='bhUse')vscode.postMessage({type:'cmd',value:'setBillableHours',arg:t.dataset.id+'\\u0000'+t.dataset.hours});
  else if(a==='tadjSet')vscode.postMessage({type:'cmd',value:'adjustTrackedTime',arg:t.dataset.id+'\\u0000'+t.dataset.mode});
  else if(a==='tadjReset')vscode.postMessage({type:'cmd',value:'resetTrackedTime',arg:t.dataset.id});
  else if(a==='estSet')vscode.postMessage({type:'cmd',value:'setWorkItemEstimate',arg:t.dataset.id});
  else if(a==='budSet')vscode.postMessage({type:'cmd',value:'setWorkItemBudget',arg:t.dataset.id});
  else if(a==='wiDone')vscode.postMessage({type:'cmd',value:'markWorkItemDone',arg:t.dataset.id});
  else if(a==='wiReopen')vscode.postMessage({type:'cmd',value:'reopenWorkItem',arg:t.dataset.id});
  else if(a==='wiOpen'){e.preventDefault();selWi=t.dataset.id;projView='workitem';showTab('projects');}
  else if(a==='estRefresh')requestEstimates();
  else if(a==='healthRefresh')requestHealth();
  else if(a==='corrRefresh')requestCorrections();
  else if(a==='corrFilter'){corrFilter=v;corrLimit=40;renderCorrections();}
  else if(a==='ruleNew')ruleSend({op:'create',rule:{category:CORR.categories[0]||'style',scope:'**',text:''}});
  else if(a==='ruleExport'){corrLoading=true;vscode.postMessage({type:'exportLessons'});}
  else if(a==='ruleCreate')ruleFromGroup(t.dataset.key,t.dataset.note);
  else if(a==='ruleStatus'){var rc=t.closest('.rule-card'),rtx=rc?rc.querySelector('.rule-text'):null,rp={status:v};if(rtx)rp.text=rtx.value;ruleSend({op:'update',id:t.dataset.id,patch:rp});}
  else if(a==='ruleDelete'){var rid=t.dataset.id;if(ruleDelArm[rid]){delete ruleDelArm[rid];ruleSend({op:'delete',id:rid});}else{ruleDelArm[rid]=true;renderCorrections();setTimeout(function(){if(ruleDelArm[rid]){delete ruleDelArm[rid];renderCorrections();}},4000);}}
  else if(a==='ruleExamples'){if(ruleOpen[t.dataset.id])delete ruleOpen[t.dataset.id];else ruleOpen[t.dataset.id]=true;renderCorrections();}
  else if(a==='ruleOther'){ruleShowOther=!ruleShowOther;renderCorrections();}
  else if(a==='ruleClosed'){ruleShowClosed=!ruleShowClosed;renderCorrections();}
  else if(a==='corrSrc'){corrSrc=v;corrLimit=40;renderCorrections();}
  else if(a==='corrMore'){corrLimit+=40;renderCorrections();}
  else if(a==='corrToggle'){var cid=t.dataset.id;if(corrOpen[cid])delete corrOpen[cid];else corrOpen[cid]=true;renderCorrections();}
  else if(a==='corrAccept'){var crow=t.closest('.corr-row'),sci=crow?crow.querySelector('.corr-scope'):null;corrLabel([t.dataset.id],t.dataset.cat,sci?sci.value:undefined);}
  else if(a==='corrAcceptEp'){var cep=corrEpisode(t.dataset.ep);if(cep)corrLabel(cep.items.filter(function(i){return!i.category;}).map(function(i){return i.id;}),t.dataset.cat);}
  else if(a==='corrAcceptAll'){corrLoading=true;vscode.postMessage({type:'acceptCorrectionSuggestions'});}
  else if(a==='handoff'){e.stopPropagation();vscode.postMessage({type:'cmd',value:'newChatWithHandoff',arg:t.dataset.id});}
  else if(a==='tsWeek'){var dv=parseInt(v,10)||0;if(dv===0||!tsWeek){tsWeek='';}else{var p=tsWeek.split('-').map(Number);var nd=new Date(p[0],p[1]-1,p[2]+7*dv);tsWeek=nd.getFullYear()+'-'+String(nd.getMonth()+1).padStart(2,'0')+'-'+String(nd.getDate()).padStart(2,'0');}requestTimesheet();}
  else if(a==='tsRound'){tsRound=v;requestTimesheet();}
  else if(a==='tsCsv')vscode.postMessage({type:'cmd',value:'exportTimesheetCsv',arg:(tsWeek||'')+'\\u0000'+(tsRound||'')});
  else if(a==='tsAdd'){e.preventDefault();vscode.postMessage({type:'cmd',value:'timesheetAddEntry',arg:(t.dataset.id||'')+'\\u0000'+(t.dataset.day||'')});}
  else if(a==='healthCmd'){vscode.postMessage({type:'cmd',value:t.dataset.cmd,arg:t.dataset.arg||undefined});setTimeout(requestHealth,1500);}
  else if(a==='ratesSet')vscode.postMessage({type:'cmd',value:'setProjectRates',arg:t.dataset.id});
});
vscode.postMessage({type:'ready'});`;

  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src data:;">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>AI Effort Tracker</title>',
    `<style nonce="${nonce}">${css}</style>`,
    '</head><body>',
    '<h1>\u{1F4CA} AI Effort Tracker</h1>',
    '<p class="sub"><span class="ld"></span>Live tracking \u00b7 refreshes every 5s</p>',
    '<div class="tabs">',
    '  <button class="tab active" id="tab-overview">Overview</button>',
    '  <button class="tab" id="tab-trends">\uD83D\uDCC8 Trends</button>',
    '  <button class="tab" id="tab-focus">\uD83C\uDFAF Focus</button>',
    '  <button class="tab" id="tab-projects">\uD83D\uDCC1 Projects</button>',
    '  <button class="tab" id="tab-ledger">\uD83E\uDDFE Ledger</button>',
    '  <button class="tab" id="tab-optimize">\uD83D\uDCA1 Optimize</button>',
    '  <button class="tab" id="tab-sessions">\uD83D\uDCAC Sessions</button>',
    '  <button class="tab" id="tab-estimates">\uD83D\uDCD0 Estimates</button>',
    '  <button class="tab" id="tab-timesheet">\uD83D\uDDD3 Timesheet</button>',
    '  <button class="tab" id="tab-health">\uD83E\uDE7A Health</button>',
    '  <button class="tab" id="tab-corrections">\uD83E\uDDE0 Corrections</button>',
    '  <button class="tab" id="dtab">Branch Detail</button>',
    '  <button class="tab" id="tab-ghview">\uD83D\uDC19 Copilot Metrics</button>',
    '  <button class="tab" id="tab-settings">\u2699 Settings</button>',
    '</div>',
    '<div id="gf" class="gf"></div>',
    '<div id="overview" class="view active"></div>',
    '<div id="trends" class="view"></div>',
    '<div id="focus" class="view"></div>',
    '<div id="projects" class="view"></div>',
    '<div id="ledger" class="view"></div>',
    '<div id="optimize" class="view"></div>',
    '<div id="sessions" class="view"></div>',
    '<div id="estimates" class="view"></div>',
    '<div id="timesheet" class="view"></div>',
    '<div id="health" class="view"></div>',
    '<div id="corrections" class="view"></div>',
    '<div id="detail" class="view"></div>',
    '<div id="ghview" class="view"></div>',
    '<div id="settings" class="view"></div>',
    `<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>`,
    `<script nonce="${nonce}">${js}</script>`,
    '</body></html>'
  ].join('\n');
}

import type { BranchSummary, ProjectSummary, WorkItemSummary, LedgerEntry, ManualEffortEntry, ReassignmentRecord } from '../store/database';
import { CATEGORY_LABELS } from '../util/fileTypes';
import type { CopilotMetrics, BillingUsage } from '../services/githubService';

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
  reassignments: ReassignmentRecord[] = []
): string {
  const data = JSON.stringify(summaries);
  const current = JSON.stringify(currentBranch);
  const catLabels = JSON.stringify(CATEGORY_LABELS);
  const ghData = JSON.stringify(ghMetrics);
  const cfgData = JSON.stringify(config);
  const anData = JSON.stringify(analytics);
  const blData = JSON.stringify(billing);
  const projData = JSON.stringify(projectSummaries);
  const wiData = JSON.stringify(workItemSummaries);
  const ledData = JSON.stringify(ledger);
  const meData = JSON.stringify(manualEffort);
  const reData = JSON.stringify(reassignments);

  // CSS and HTML are built with string concatenation to avoid backtick nesting issues.
  const css = `
  :root{--human:#4ec9b0;--ai:#c586c0;--review:#dcdcaa;--idle:#4d4d4d;--cost:#f4a261;--added:#4ec9b0;--deleted:#f47174;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;}
  h1{font-size:1.3em;margin-bottom:4px;}
  .sub{color:var(--vscode-descriptionForeground);font-size:.85em;margin-bottom:20px;}
  .tabs{display:flex;gap:8px;margin-bottom:20px;border-bottom:1px solid var(--vscode-panel-border);}
  .tab{padding:6px 14px;cursor:pointer;border-bottom:2px solid transparent;color:var(--vscode-descriptionForeground);background:none;border-top:none;border-left:none;border-right:none;font-family:inherit;font-size:inherit;}
  .tab.active{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-foreground);}
  .view{display:none;}.view.active{display:block;}
  .cr{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;}
  .card{background:var(--vscode-editor-inactiveSelectionBackground);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:16px;}
  .card h3{font-size:.9em;margin-bottom:12px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.05em;}
  .cw{position:relative;height:200px;}
  table{width:100%;border-collapse:collapse;font-size:.9em;}
  th{text-align:left;padding:8px 10px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);font-weight:normal;font-size:.85em;text-transform:uppercase;letter-spacing:.04em;}
  td{padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:middle;}
  tr:hover td{background:var(--vscode-list-hoverBackground);cursor:pointer;}
  tr.cur td{background:var(--vscode-editor-lineHighlightBackground);}
  .badge{display:inline-block;padding:2px 6px;border-radius:3px;font-size:.8em;}
  .ba{background:rgba(197,134,192,.2);color:var(--ai);}
  .bh{background:rgba(78,201,176,.2);color:var(--human);}
  .bp{background:rgba(78,201,176,.15);color:var(--added);}
  .bd{background:rgba(244,113,116,.15);color:var(--deleted);}
  .mb{display:flex;height:6px;border-radius:3px;overflow:hidden;width:80px;}
  .mb span{display:block;}
  .sg{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}
  .st{background:var(--vscode-editor-inactiveSelectionBackground);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px 16px;}
  .st .lbl{font-size:.75em;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;}
  .st .val{font-size:1.4em;font-weight:bold;}
  .back{background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:.85em;margin-bottom:16px;}
  .back:hover{background:var(--vscode-list-hoverBackground);}
  .ld{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ec9b0;margin-right:6px;animation:pulse 2s infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
  .dtabs{display:flex;gap:6px;margin-bottom:16px;}
  .dtab{padding:4px 12px;cursor:pointer;border:1px solid var(--vscode-panel-border);border-radius:4px;background:none;color:var(--vscode-descriptionForeground);font-family:inherit;font-size:.85em;}
  .dtab.active{background:var(--vscode-editor-lineHighlightBackground);color:var(--vscode-foreground);border-color:var(--vscode-focusBorder);}
  .ds{display:none;}.ds.active{display:block;}
  .extb{display:inline-block;padding:1px 5px;border-radius:3px;font-size:.8em;font-family:monospace;background:rgba(128,128,128,.15);margin-right:4px;}
  .dc{font-family:monospace;}
  .rng{display:flex;gap:6px;margin-bottom:16px;}
  .hm{display:grid;grid-template-columns:auto repeat(24,1fr);gap:2px;font-size:.7em;}
  .hm .hc{width:100%;padding-top:100%;border-radius:2px;position:relative;background:rgba(128,128,128,.08);}
  .hm .hl{color:var(--vscode-descriptionForeground);display:flex;align-items:center;justify-content:flex-end;padding-right:6px;}
  .hm .hh{color:var(--vscode-descriptionForeground);text-align:center;font-size:.9em;}
  .ring{position:relative;width:150px;height:150px;margin:0 auto;}
  .ring svg{transform:rotate(-90deg);}
  .ring .rt{position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .ring .rt .rp{font-size:1.6em;font-weight:bold;}
  .ring .rt .rl{font-size:.7em;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.05em;}`;

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
const charts={};

const fg=()=>getComputedStyle(document.body).getPropertyValue('--vscode-foreground');
const dfg=()=>getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground');
const gc='rgba(128,128,128,0.15)';

function fmt(ms){const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return h>0?h+'h '+m+'m':m>0?m+'m '+sec+'s':sec+'s';}
function aiPct(d){const t=d.linesHumanAdded+d.linesAiAdded;return t>0?((d.linesAiAdded/t)*100).toFixed(0):0;}
function tms(d){return d.humanCodingMs+d.aiGeneratingMs+d.reviewingMs;}
function pp(n,c){return n>0?'<span class="badge '+c+'">+'+n+'</span>':'';}
function pm(n){return n>0?'<span class="badge bd">-'+n+'</span>':'';}
function dc(k){if(charts[k]){charts[k].destroy();delete charts[k];}}
function insights(d){
  var activeMs=d.humanCodingMs+d.aiGeneratingMs+d.reviewingMs;
  var activeMin=activeMs/60000;
  var aiNet=d.linesAiAdded||0, humanNet=d.linesHumanAdded||0;
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
function sc(lbl,val,color){return'<div class="st"><div class="lbl">'+lbl+'</div><div class="val" style="color:'+(color||'inherit')+'">'+val+'</div></div>';}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function activeMsOf(x){return(x.humanCodingMs||0)+(x.aiGeneratingMs||0)+(x.reviewingMs||0);}

function billingHtml(){
  var imp='<button class="dtab" data-action="cmd" data-value="importCredits" style="margin-top:10px">\\u21bb Import / refresh usage</button>';
  if(!BL){
    return'<div class="card" style="margin-top:16px"><h3>\\uD83D\\uDCB3 Copilot Premium Requests &mdash; real usage</h3><p style="margin-top:8px;color:var(--vscode-descriptionForeground)">Pull your real billed premium-request usage from GitHub\\u2019s billing API.</p>'+imp+'</div>';
  }
  if(!BL.ok){
    var msg=BL.error==='no-token'?'No GitHub token \\u2014 set <code>aiEffortTracker.githubToken</code> (fine-grained PAT with <strong>Plan: Read-only</strong>) or sign in to GitHub.':BL.error==='no-copilot'?'No Copilot premium-request usage found for '+BL.period+' yet.':(BL.errorDetail||'Could not load billing usage.');
    return'<div class="card" style="margin-top:16px"><h3>\\uD83D\\uDCB3 Copilot Premium Requests &mdash; real usage</h3><p style="margin-top:8px;color:var(--vscode-descriptionForeground)">'+msg+'</p>'+imp+'</div>';
  }
  var rows=(BL.items||[]).map(function(i){return'<tr><td>'+i.sku+'</td><td>'+i.quantity.toLocaleString()+(i.unit?' '+i.unit:'')+'</td><td>$'+i.grossUsd.toFixed(2)+'</td><td>$'+i.netUsd.toFixed(2)+'</td></tr>';}).join('')||'<tr><td colspan="4" style="color:var(--vscode-descriptionForeground)">No line items</td></tr>';
  return'<div class="card" style="margin-top:16px"><h3>\\uD83D\\uDCB3 Copilot Premium Requests &mdash; real usage ('+BL.period+' \\u00b7 '+BL.scope+')</h3>'
    +'<div class="sg" style="grid-template-columns:repeat(3,1fr);margin-top:8px">'
    +'<div class="st"><div class="lbl">Premium Requests</div><div class="val" style="color:var(--ai)">'+BL.premiumRequests.toLocaleString()+'</div></div>'
    +'<div class="st"><div class="lbl">Gross</div><div class="val">$'+BL.grossUsd.toFixed(2)+'</div></div>'
    +'<div class="st"><div class="lbl">Net (billed)</div><div class="val" style="color:var(--cost)">$'+BL.netUsd.toFixed(2)+'</div></div>'
    +'</div>'
    +'<table style="margin-top:8px"><thead><tr><th>SKU</th><th>Quantity</th><th>Gross</th><th>Net</th></tr></thead><tbody>'+rows+'</tbody></table>'
    +'<p style="margin-top:8px;font-size:.78em;color:var(--vscode-descriptionForeground)">Net = amount billed beyond your included allowance. This is GitHub\\u2019s authoritative usage, unlike the heuristic estimates on the Overview tab.</p>'+imp+'</div>';
}
function renderGhMetrics(){
  const el=document.getElementById('ghview');
  var bh=billingHtml();
  if(!ghMetrics){
    el.innerHTML=bh+'<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3><p style="color:var(--vscode-descriptionForeground);margin-top:8px">Configure your GitHub token in settings to load official Copilot metrics.</p><p style="margin-top:8px;font-size:.85em;color:var(--vscode-descriptionForeground)">Required: <code>aiEffortTracker.githubToken</code> (needs <code>manage_billing:copilot</code> scope)</p></div>';
    return;
  }
  if(ghMetrics.error==='needs-scope-ado'){
    el.innerHTML=bh+'<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3>'
      +'<p style="margin-top:8px">&#x2705; Signed in &nbsp;|&nbsp; &#x1F4E6; Azure DevOps repo detected</p>'
      +'<p style="margin-top:10px;font-size:.9em;color:var(--vscode-descriptionForeground)">Copilot metrics live on <strong>GitHub</strong>, not Azure DevOps. Set your <strong>GitHub org name</strong> in settings:</p>'
      +'<p style="margin-top:8px;font-family:monospace;font-size:.9em">aiEffortTracker.githubOrg = <em>your-github-org</em></p>'
      +'<p style="margin-top:8px;font-size:.85em;color:var(--vscode-descriptionForeground)">(This is the GitHub organisation where your Copilot licences are managed &mdash; not your Azure DevOps org.)</p></div>';
    return;
  }
  if(ghMetrics.error==='needs-scope'){
    el.innerHTML=bh+'<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3><p style="margin-top:8px">&#x2705; Signed in to GitHub! Could not detect a GitHub remote in the current workspace.</p><p style="margin-top:10px;font-size:.9em;color:var(--vscode-descriptionForeground)">Open a GitHub repository in VS Code, or manually set <code>aiEffortTracker.githubOrg</code> or <code>aiEffortTracker.githubRepo</code> in settings.</p></div>';
    return;
  }
  if(ghMetrics.error==='api-error'){
    var detail=ghMetrics.errorDetail?'<p style="margin-top:10px;padding:10px;background:rgba(244,113,116,.1);border-left:3px solid var(--deleted);border-radius:4px;font-size:.85em;line-height:1.5">'+ghMetrics.errorDetail+'</p>':'';
    el.innerHTML=bh+'<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3><p style="margin-top:8px">&#x26A0;&#xFE0F; Could not load metrics for <strong>'+ghMetrics.scopeName+'</strong>.</p>'+detail+'<p style="margin-top:10px;font-size:.85em;color:var(--vscode-descriptionForeground)">Note: this endpoint is <strong>org/enterprise only</strong> &mdash; personal Copilot subscriptions have no metrics API.</p></div>';
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
  var modelRows=Object.entries(modelMap).sort(function(a,b){return b[1]-a[1];}).map(function(e){return'<tr><td><span class="extb">'+e[0]+'</span></td><td>'+e[1]+'</td></tr>';}).join('')||'<tr><td colspan="2" style="color:var(--vscode-descriptionForeground)">No chat data yet</td></tr>';

  // Combine local tracker totals for comparison
  var localAiLines=allData.reduce(function(a,d){return a+d.linesAiAdded;},0);

  // Top languages from last 14 days
  var langMap={};
  days.forEach(function(d){d.byLanguage.forEach(function(l){if(!langMap[l.name])langMap[l.name]={sugg:0,acc:0,linesSugg:0,linesAcc:0};langMap[l.name].sugg+=l.totalSuggestionsCount;langMap[l.name].acc+=l.totalAcceptancesCount;langMap[l.name].linesSugg+=l.totalLinesSuggested;langMap[l.name].linesAcc+=l.totalLinesAccepted;});});
  var topLangs=Object.entries(langMap).sort(function(a,b){return b[1].linesAcc-a[1].linesAcc;}).slice(0,8);

  var langRows=topLangs.map(function(e){var n=e[0],s=e[1],r=s.sugg>0?((s.acc/s.sugg)*100).toFixed(0):0;return'<tr><td><span class="extb">'+n+'</span></td><td>'+s.sugg+'</td><td>'+s.acc+'</td><td><span class="badge '+(r>50?'ba':'bh')+'">'+r+'%</span></td><td>+'+s.linesAcc+'</td></tr>';}).join('');

  el.innerHTML=bh+'<div class="sg" style="grid-template-columns:repeat(5,1fr)">'
    +'<div class="st"><div class="lbl">Suggestions (14d)</div><div class="val">'+totSugg+'</div></div>'
    +'<div class="st"><div class="lbl">Acceptances (14d)</div><div class="val" style="color:var(--human)">'+totAcc+'</div></div>'
    +'<div class="st"><div class="lbl">Acceptance Rate</div><div class="val" style="color:var(--ai)">'+accRate+'%</div></div>'
    +'<div class="st"><div class="lbl">Lines Accepted (14d)</div><div class="val" style="color:var(--ai)">'+totLinesAcc+'</div></div>'
    +'<div class="st"><div class="lbl">&#x1F4AC; Chat Turns (14d)</div><div class="val" style="color:var(--review)">'+totChat+'</div></div>'
    +'</div>'
    +'<div class="cr">'
    +'<div class="card"><h3>Daily Accepted Lines (14d)</h3><div class="cw"><canvas id="cGhDaily"></canvas></div></div>'
    +'<div class="card"><h3>Local Heuristic vs Official</h3>'
    +'<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">'
    +'<div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px"><span>Official lines accepted (14d)</span><strong style="color:var(--ai)">'+totLinesAcc+'</strong></div>'
    +'<div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px"><span>Our heuristic AI lines</span><strong style="color:var(--review)">'+localAiLines+'</strong></div>'
    +'<div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px"><span>Line acceptance rate</span><strong style="color:var(--human)">'+lineAccRate+'%</strong></div>'
    +'<div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px"><span>Source</span><strong>'+ghMetrics.scopeName+' ('+ghMetrics.source+')</strong></div>'
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
  return'<div style="margin-top:6px;padding-top:14px;border-top:1px solid var(--vscode-panel-border)">'
    +'<div style="font-size:.8em;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);margin-bottom:8px">\\uD83E\\uDD16 AI source split \\u2014 inline completions vs chat / agent</div>'
    +'<div class="mb" style="width:100%;height:10px;margin-bottom:8px"><span style="width:'+iP+'%;background:var(--ai)" title="Inline completions"></span><span style="width:'+cP+'%;background:var(--review)" title="Chat / agent"></span></div>'
    +'<div style="display:flex;gap:18px;font-size:.85em;flex-wrap:wrap">'
    +'<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--ai);margin-right:5px"></span>Inline completions: <strong>'+iP.toFixed(0)+'%</strong> \\u00b7 '+nf(inC)+' chars \\u00b7 +'+nf(inL)+' lines</span>'
    +'<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--review);margin-right:5px"></span>Chat / agent: <strong>'+cP.toFixed(0)+'%</strong> \\u00b7 '+nf(chC)+' chars \\u00b7 +'+nf(chL)+' lines</span>'
    +'</div></div>';
}
function renderOverview(){
  const el=document.getElementById('overview');
  const T=allData.reduce(function(a,d){return{human:a.human+d.humanCodingMs,ai:a.ai+d.aiGeneratingMs,review:a.review+d.reviewingMs,lhA:a.lhA+d.linesHumanAdded,lhD:a.lhD+d.linesHumanDeleted,laA:a.laA+d.linesAiAdded,laD:a.laD+d.linesAiDeleted,cost:a.cost+d.estimatedCostUsd};},{human:0,ai:0,review:0,lhA:0,lhD:0,laA:0,laD:0,cost:0});
  var rows=allData.map(function(d){
    var tot=tms(d),hp=tot>0?d.humanCodingMs/tot*100:0,ap=tot>0?d.aiGeneratingMs/tot*100:0,rp=tot>0?d.reviewingMs/tot*100:0,isCur=d.branch===currentBranch;
    return '<tr class="'+(isCur?'cur':'')+'" style="cursor:pointer" data-action="detail" data-value="'+d.branch+'"><td>'+(isCur?'\\u25b6 ':'')+'<strong>'+d.branch+'</strong></td><td>'+(d.workItemId?'<span class="badge ba">#'+d.workItemId+'</span>':'\\u2014')+'</td><td>'+fmt(tot)+'</td><td><div class="mb"><span style="width:'+hp+'%;background:var(--human)"></span><span style="width:'+ap+'%;background:var(--ai)"></span><span style="width:'+rp+'%;background:var(--review)"></span></div></td><td class="dc">'+pp(d.linesHumanAdded,'bp')+' '+pm(d.linesHumanDeleted)+'</td><td class="dc">'+pp(d.linesAiAdded,'ba')+' '+pm(d.linesAiDeleted)+'</td><td><span class="badge '+(aiPct(d)>50?'ba':'bh')+'">'+aiPct(d)+'%</span></td><td>$'+d.estimatedCostUsd.toFixed(4)+'</td></tr>';
  }).join('');
  var AS=AN||{};var stk=AS.streak||{current:0,longest:0};var wk=AS.week||{thisWeek:{activeMs:0,lines:0,aiShare:0},lastWeek:{activeMs:0,lines:0,aiShare:0}};
  function dlt(n,p){if(p===0)return n>0?'<span style="color:var(--added)">\\u25b2 new</span>':'';var d=(n-p)/p*100;var up=d>=0;return'<span style="color:'+(up?'var(--added)':'var(--deleted)')+'">'+(up?'\\u25b2':'\\u25bc')+' '+Math.abs(d).toFixed(0)+'%</span>';}
  function scd(lbl,val,sub,color){return'<div class="st"><div class="lbl">'+lbl+'</div><div class="val" style="color:'+(color||'inherit')+'">'+val+'</div><div style="font-size:.75em;margin-top:2px">'+sub+'</div></div>';}
  var hdr='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px">'
    +'<div class="sub" style="margin:0">This week vs last week \\u00b7 streak \\u00b7 totals</div>'
    +'<div style="display:flex;gap:6px"><button class="dtab" data-action="cmd" data-value="assignBranchToWorkItem">\\uD83D\\uDD17 Assign Work Item</button><button class="dtab" data-action="cmd" data-value="weeklyReport">\\uD83D\\uDCC4 Weekly Report</button><button class="dtab" data-action="cmd" data-value="exportCsv">\\u2B07 Export CSV</button></div></div>'
    +'<div class="sg">'
    +scd('\\uD83D\\uDD25 Streak',stk.current+'d','longest '+stk.longest+'d','var(--cost)')
    +scd('This Week Active',fmt(wk.thisWeek.activeMs),dlt(wk.thisWeek.activeMs,wk.lastWeek.activeMs)+' vs last','var(--review)')
    +scd('This Week Lines','+'+wk.thisWeek.lines,dlt(wk.thisWeek.lines,wk.lastWeek.lines)+' vs last','var(--human)')
    +scd('This Week AI Share',wk.thisWeek.aiShare.toFixed(0)+'%',dlt(wk.thisWeek.aiShare,wk.lastWeek.aiShare)+' vs last','var(--ai)')
    +'</div>';
  var tf=(AN&&AN.topFiles)||[];
  var hotRows=tf.map(function(f){
    var p=f.path.length>48?'\\u2026'+f.path.slice(-46):f.path;
    var pct=f.aiShare.toFixed(0);
    return'<tr><td title="'+f.path+'" style="font-family:monospace;font-size:.85em">'+p+'</td><td>'+f.edits+'</td><td class="dc">'+pp(f.human,'bp')+'</td><td class="dc">'+pp(f.ai,'ba')+'</td><td><span class="badge '+(pct>50?'ba':'bh')+'">'+pct+'%</span></td></tr>';
  }).join('')||'<tr><td colspan="5" style="color:var(--vscode-descriptionForeground)">No file edits recorded yet</td></tr>';
  var hot='<div class="card" style="margin-top:24px"><h3>\\uD83D\\uDD25 Most-Edited Files (hotspots)</h3><table style="margin-top:8px"><thead><tr><th>File</th><th>Edits</th><th>Human +</th><th>AI +</th><th>AI %</th></tr></thead><tbody>'+hotRows+'</tbody></table></div>';
  var sumF=function(k){return allData.reduce(function(a,d){return a+(d[k]||0);},0);};
  var hC=sumF('humanChars'),aC=sumF('aiChars'),ks=sumF('humanKeystrokes'),chC=sumF('chatCharsHuman');
  var nf=function(n){return Math.round(n).toLocaleString();};
  var CPT=4;
  var aiTok=aC/CPT,huTok=hC/CPT,chTok=chC/CPT,totTok=aiTok+huTok+chTok;
  var ratio=hC>0?aC/hC:0;
  var ratioTxt=hC>0?(ratio>=1?ratio.toFixed(1)+'\\u00d7 AI vs typed':(1/ratio).toFixed(1)+'\\u00d7 typed vs AI'):(aC>0?'100% AI':'\\u2014');
  var totC=hC+aC,hPct=totC>0?hC/totC*100:0,aPct=totC>0?aC/totC*100:0;
  var kt='<div class="card" style="margin-top:24px"><h3>\\u2328\\ufe0f Keystrokes vs \\uD83E\\uDD16 AI &mdash; \\uD83D\\uDD22 Token Estimate</h3>'
    +'<div class="sg" style="margin-top:8px">'
    +scd('\\u2328\\ufe0f Keystrokes',nf(ks),'hand-typed edits','var(--human)')
    +scd('Human chars typed',nf(hC),'into code','var(--human)')
    +scd('\\uD83E\\uDD16 AI chars',nf(aC),'inserted','var(--ai)')
    +scd('AI : Human',ratioTxt,'character ratio','var(--cost)')
    +'</div>'
    +'<div class="mb" style="margin:12px 0"><span style="width:'+hPct+'%;background:var(--human)" title="Human typed"></span><span style="width:'+aPct+'%;background:var(--ai)" title="AI inserted"></span></div>'
    +'<div style="font-size:.8em;color:var(--vscode-descriptionForeground);margin-bottom:14px">'+hPct.toFixed(0)+'% of characters typed by you \\u00b7 '+aPct.toFixed(0)+'% inserted by AI</div>'
    +'<div class="sg">'
    +scd('\\uD83E\\uDD16 AI tokens','~'+nf(aiTok),'code generated','var(--ai)')
    +scd('\\u2328\\ufe0f Human tokens','~'+nf(huTok),'code typed','var(--human)')
    +scd('\\uD83D\\uDCAC Chat tokens','~'+nf(chTok),'prompts typed','var(--review)')
    +scd('\\uD83D\\uDD22 Total tokens','~'+nf(totTok),'~'+CPT+' chars/token','var(--cost)')
    +'</div>'
    +aiSplitHtml()
    +'<p style="margin-top:8px;font-size:.78em;color:var(--vscode-descriptionForeground)">Token estimates use a ~'+CPT+'-chars-per-token heuristic on inserted text \\u2014 a rough proxy for prompt/output size, not billed credits.</p></div>';
  el.innerHTML=hdr+'<div class="sg"><div class="st"><div class="lbl">\\u2328\\ufe0f Human Coding</div><div class="val" style="color:var(--human)">'+fmt(T.human)+'</div></div><div class="st"><div class="lbl">\\uD83E\\uDD16 AI Generating</div><div class="val" style="color:var(--ai)">'+fmt(T.ai)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDC40 Reviewing</div><div class="val" style="color:var(--review)">'+fmt(T.review)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDCB0 Est. Cost</div><div class="val" style="color:var(--cost)">$'+T.cost.toFixed(4)+'</div></div></div><div class="cr"><div class="card"><h3>Time per Branch</h3><div class="cw"><canvas id="cBar"></canvas></div></div><div class="card"><h3>AI % per Branch</h3><div class="cw"><canvas id="cAi"></canvas></div></div></div><table><thead><tr><th>Branch</th><th>Work Item</th><th>Active</th><th>Split</th><th>Human +/-</th><th>AI +/-</th><th>AI %</th><th>Cost</th></tr></thead><tbody>    '+rows+'</tbody></table>'+hot+kt;
  var labels=allData.map(function(d){return d.branch.length>16?d.branch.slice(0,14)+'\\u2026':d.branch;});
  dc('bar');
  charts.bar=new Chart(document.getElementById('cBar'),{type:'bar',data:{labels:labels,datasets:[{label:'Human',data:allData.map(function(d){return Math.round(d.humanCodingMs/60000);}),backgroundColor:'rgba(78,201,176,.7)'},{label:'AI Gen',data:allData.map(function(d){return Math.round(d.aiGeneratingMs/60000);}),backgroundColor:'rgba(197,134,192,.7)'},{label:'Review',data:allData.map(function(d){return Math.round(d.reviewingMs/60000);}),backgroundColor:'rgba(220,220,170,.7)'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},scales:{x:{ticks:{color:dfg()},grid:{color:gc},stacked:true},y:{ticks:{color:dfg()},grid:{color:gc},stacked:true,title:{display:true,text:'min',color:dfg()}}}}});
  dc('ai');
  charts.ai=new Chart(document.getElementById('cAi'),{type:'bar',data:{labels:labels,datasets:[{label:'AI %',data:allData.map(function(d){return aiPct(d);}),backgroundColor:allData.map(function(d){return aiPct(d)>50?'rgba(197,134,192,.8)':'rgba(78,201,176,.8)';}),borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:dfg()},grid:{color:gc}},y:{ticks:{color:dfg()},grid:{color:gc},max:100,title:{display:true,text:'%',color:dfg()}}}}});
}

var trendRange=30;
function renderTrends(){
  var el=document.getElementById('trends');
  var all=AN.daily||[];
  var days=all.slice(-trendRange);
  var sum=days.reduce(function(a,d){return{h:a.h+d.humanCoding,ai:a.ai+d.aiGenerating,r:a.r+d.reviewing,lh:a.lh+d.linesHuman,la:a.la+d.linesAi};},{h:0,ai:0,r:0,lh:0,la:0});
  var activeMs=sum.h+sum.ai+sum.r;
  var activeDays=days.filter(function(d){return(d.humanCoding+d.aiGenerating+d.reviewing)>0;}).length;
  var avgMs=activeDays>0?activeMs/activeDays:0;
  var totLines=sum.lh+sum.la;
  var rngBtns=[7,30,90].map(function(n){return'<button class="dtab '+(n===trendRange?'active':'')+'" data-action="rng" data-value="'+n+'">'+n+'d</button>';}).join('');
  el.innerHTML='<div class="rng">'+rngBtns+'</div>'
    +'<div class="sg">'
    +sc('Active Time ('+trendRange+'d)',fmt(activeMs),'var(--review)')
    +sc('Daily Average',fmt(avgMs),'var(--human)')
    +sc('Active Days',String(activeDays),'var(--vscode-foreground)')
    +sc('Lines ('+trendRange+'d)','+'+totLines,'var(--ai)')
    +'</div>'
    +'<div class="card" style="margin-top:8px"><h3>Daily Activity &mdash; Human vs AI vs Review</h3><div class="cw" style="height:240px"><canvas id="cTrend"></canvas></div></div>'
    +'<div class="card" style="margin-top:16px"><h3>\\uD83E\\uDD16 AI Dependency Trend &mdash; AI % of lines per day</h3><div class="cw" style="height:200px"><canvas id="cTrendAi"></canvas></div></div>'
    +'<div class="card" style="margin-top:16px"><h3>\\uD83D\\uDD25 Activity Heatmap &mdash; when you work (all history)</h3><div id="heat" style="margin-top:12px"></div><p style="margin-top:10px;font-size:.78em;color:var(--vscode-descriptionForeground)">Darker = more active minutes in that hour. Local time.</p></div>';
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
    +'<div class="cr" style="margin-top:8px"><div class="card" style="display:flex;flex-direction:column;align-items:center;justify-content:center"><h3>Daily Focus Goal</h3>'+ring
    +'<p style="margin-top:14px;text-align:center;font-size:.9em">'+goalDoneMin+' min of '+goal+' min goal</p></div>'
    +'<div class="card"><h3>Most Productive Hours (all history)</h3><div class="cw" style="height:200px"><canvas id="cHours"></canvas></div></div></div>'
    +'<div class="card" style="margin-top:16px"><h3>\\uD83D\\uDCC5 Today\\u2019s Timeline &mdash; activity by hour</h3><div class="cw" style="height:160px"><canvas id="cTimeline"></canvas></div><p style="margin-top:8px;font-size:.8em;color:var(--vscode-descriptionForeground)">Active minutes per hour today, split by Human / AI / Review.</p></div>'
    +'<div class="card" style="margin-top:16px"><h3>This Week</h3><div class="sg" style="margin-top:4px">'
    +sc('Focus Time (7d)',fmt(f.totalFocusMsWeek||0),'var(--human)')
    +sc('Sessions (7d)',String(f.sessionsWeek||0),'var(--vscode-foreground)')
    +'</div><p style="margin-top:10px;font-size:.8em;color:var(--vscode-descriptionForeground)">A focus session = continuous active work (no break longer than your idle threshold). Set your goal with <code>aiEffortTracker.dailyActiveGoalMinutes</code>.</p></div>';
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
function aiPctOf(x){var t=(x.linesHumanAdded||0)+(x.linesAiAdded||0);return t>0?Math.round((x.linesAiAdded/t)*100):0;}
function projToolbar(){
  return'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">'
    +'<button class="dtab" data-action="cmd" data-value="createProject">\\uFF0B New Project</button>'
    +'<button class="dtab" data-action="cmd" data-value="linkRepoToProject">\\uD83D\\uDD17 Link This Repo</button>'
    +'<button class="dtab" data-action="cmd" data-value="createWorkItem">\\uFF0B New Work Item</button>'
    +'<button class="dtab" data-action="cmd" data-value="editWorkItem">\\u270E Edit Work Item</button>'
    +'<button class="dtab" data-action="cmd" data-value="assignWorkItemToProject">\\uD83D\\uDCC1 Assign to Project</button>'
    +'</div>';
}
function projectRowsHtml(){
  var rows=PROJ.map(function(p){
    var act=activeMsOf(p);
    var roi=(p.roi&&p.roi.netValue!=null)?fmtMoney(p.roi.netValue,p.roi.currency):ROI_NONE;
    var reposTxt=(p.repos&&p.repos.length)?esc(p.repos.join(', ')):ROI_NONE;
    return'<tr data-action="proj" data-value="'+esc(p.projectId)+'"><td><strong>'+esc(p.name)+'</strong></td><td style="font-family:monospace;font-size:.85em">'+reposTxt+'</td><td>'+p.workItemIds.length+'</td><td>'+fmt(act)+'</td><td>'+((p.credits&&p.credits.credits)||0).toFixed(1)+'</td><td>'+roi+'</td></tr>';
  });
  var none=wiOfProject('__none__');
  if(none.length){
    var act=none.reduce(function(a,w){return a+activeMsOf(w);},0);
    var cr=none.reduce(function(a,w){return a+(w.creditsTotal||0);},0);
    rows.push('<tr data-action="proj" data-value="__none__"><td><strong>\\uD83D\\uDCE5 Unassigned</strong><div style="font-size:.78em;color:var(--vscode-descriptionForeground)">work items with no project</div></td><td>'+ROI_NONE+'</td><td>'+none.length+'</td><td>'+fmt(act)+'</td><td>'+cr.toFixed(1)+'</td><td>'+ROI_NONE+'</td></tr>');
  }
  if(!rows.length)return'<tr><td colspan="6" style="color:var(--vscode-descriptionForeground)">No projects yet \\u2014 use \\u201cNew Project\\u201d to create one and link this repo.</td></tr>';
  return rows.join('');
}
function renderProjectList(){
  var el=document.getElementById('projects');
  el.innerHTML=projToolbar()
    +'<table><thead><tr><th>Project</th><th>Repos</th><th>Work Items</th><th>Active</th><th>Credits</th><th>ROI Net</th></tr></thead><tbody>'+projectRowsHtml()+'</tbody></table>'
    +'<p style="margin-top:12px;font-size:.8em;color:var(--vscode-descriptionForeground)">Project ROI net = value produced \\u2212 cost from the project\\u2019s effective rates. \\u201c\\u2014\\u201d means a required rate is not configured (set it with \\u201cSet Rates\\u201d).</p>';
}
function wiRowsHtml(items){
  var rows=items.map(function(w){
    var I=insights(w);
    var est=w.estimate!=null?(w.estimate+' '+(w.estimateUnit||'hours')):ROI_NONE;
    var roiColor=moneyColor(I.roi);
    return'<tr data-action="wi" data-value="'+esc(w.workItemId)+'"><td><strong>'+esc(w.title||('#'+w.workItemId))+'</strong><div style="font-size:.78em;color:var(--vscode-descriptionForeground)">#'+esc(w.workItemId)+'</div></td><td>'+est+'</td><td>'+fmt(activeMsOf(w))+'</td><td><span class="badge '+(aiPctOf(w)>50?'ba':'bh')+'">'+aiPctOf(w)+'%</span></td><td>'+(w.creditsTotal||0).toFixed(1)+'</td><td style="color:'+roiColor+'">'+fmtMoney(I.roi,I.currency)+'</td></tr>';
  });
  if(!rows.length)return'<tr><td colspan="6" style="color:var(--vscode-descriptionForeground)">No work items here yet.</td></tr>';
  return rows.join('');
}
function renderProjectDetail(){
  var el=document.getElementById('projects');
  var p=PROJ.find(function(x){return x.projectId===selProj;});
  var isNone=selProj==='__none__';
  if(!p&&!isNone){projView='list';return renderProjectList();}
  var items=wiOfProject(selProj);
  var name=isNone?'\\uD83D\\uDCE5 Unassigned':esc(p.name);
  var act=isNone?items.reduce(function(a,w){return a+activeMsOf(w);},0):activeMsOf(p);
  var credits=isNone?items.reduce(function(a,w){return a+(w.creditsTotal||0);},0):((p.credits&&p.credits.credits)||0);
  var roi=(!isNone&&p.roi&&p.roi.netValue!=null)?fmtMoney(p.roi.netValue,p.roi.currency):ROI_NONE;
  var repos=(!isNone&&p.repos&&p.repos.length)?esc(p.repos.join(', ')):ROI_NONE;
  var setRates=isNone?'':'<button class="dtab" data-action="cmd" data-value="setProjectRates">\\uD83D\\uDCB0 Set Rates</button>';
  el.innerHTML='<button class="back" data-action="pprojects">\\u2190 Projects</button>'
    +'<div class="sg"><div class="st"><div class="lbl">Project</div><div class="val" style="font-size:.95em;word-break:break-word">'+name+'</div></div>'
    +'<div class="st"><div class="lbl">Active Time</div><div class="val">'+fmt(act)+'</div></div>'
    +'<div class="st"><div class="lbl">Credits</div><div class="val" style="color:var(--cost)">'+credits.toFixed(1)+'</div></div>'
    +'<div class="st"><div class="lbl">ROI Net</div><div class="val">'+roi+'</div></div></div>'
    +'<p class="sub" style="margin:12px 0 6px">Repos: '+repos+'</p>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">'+setRates+'<button class="dtab" data-action="cmd" data-value="createWorkItem">\\uFF0B New Work Item</button><button class="dtab" data-action="cmd" data-value="assignWorkItemToProject">\\uD83D\\uDCC1 Assign Work Item</button></div>'
    +'<table><thead><tr><th>Work Item</th><th>Estimate</th><th>Actual</th><th>AI %</th><th>Credits</th><th>ROI</th></tr></thead><tbody>'+wiRowsHtml(items)+'</tbody></table>';
}
function meModeLabel(m){return {humanCoding:'Human coding',aiGenerating:'AI generating',reviewing:'Reviewing',idle:'Idle'}[m]||m;}
function meFor(wid){return (ME||[]).filter(function(e){return e.workItemId===wid;});}
function manualSplitHtml(w){
  var man=w.manual||{humanCodingMs:0,aiGeneratingMs:0,reviewingMs:0,linesHumanAdded:0,linesAiAdded:0,entries:0};
  var manAct=(man.humanCodingMs||0)+(man.aiGeneratingMs||0)+(man.reviewingMs||0);
  var autoAct=Math.max(0,activeMsOf(w)-manAct);
  var manLines=(man.linesHumanAdded||0)+(man.linesAiAdded||0);
  return'<div class="sg" style="margin-top:4px">'
    +sc('Auto-tracked',fmt(autoAct),'var(--human)')
    +sc('Manual',fmt(manAct),'var(--review)')
    +sc('Manual +Lines','+'+manLines,'var(--ai)')
    +sc('Manual Entries',String(man.entries||0),'var(--cost)')
    +'</div>';
}
function manualRowsHtml(wid){
  var list=meFor(wid);
  if(!list.length)return'<tr><td colspan="5" style="color:var(--vscode-descriptionForeground)">No manual entries yet. Use \\u201c\\uFF0B Add Effort\\u201d to record one.</td></tr>';
  return list.map(function(e){
    var when=new Date(e.ts).toLocaleString();
    var time=(e.mode&&e.durationMs)?esc(meModeLabel(e.mode))+' '+fmt(e.durationMs):'\\u2014';
    var lines=e.category?((e.isAi?'AI':'Human')+' '+esc(CAT[e.category]||e.category)+' +'+(e.linesAdded||0)+'/-'+(e.linesDeleted||0)):'\\u2014';
    var note=e.note?esc(e.note):'';
    return'<tr><td style="white-space:nowrap">'+esc(when)+'</td><td>'+time+'</td><td>'+lines+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+note+'">'+note+'</td><td style="white-space:nowrap"><button class="dtab" data-action="meEdit" data-id="'+esc(e.id)+'" title="Edit entry">\\u270E</button> <button class="dtab" data-action="meDel" data-id="'+esc(e.id)+'" title="Delete entry">\\uD83D\\uDDD1</button></td></tr>';
  }).join('');
}
function reFor(wid){return (RE||[]).filter(function(r){return r.toWorkItemId===wid||r.fromWorkItemId===wid;});}
function reassignRowsHtml(wid){
  var list=reFor(wid);
  if(!list.length)return'<tr><td colspan="4" style="color:var(--vscode-descriptionForeground)">No reassignments touch this work item yet.</td></tr>';
  return list.map(function(r){
    var when=new Date(r.ts).toLocaleString();
    var from=r.fromWorkItemId?('#'+esc(r.fromWorkItemId)):'\\u2014';
    var dir=from+' \\u2192 #'+esc(r.toWorkItemId);
    var note=r.note?esc(r.note):'';
    return'<tr><td style="white-space:nowrap">'+esc(when)+'</td><td><strong>'+esc(r.branch)+'</strong></td><td style="white-space:nowrap">'+dir+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+note+'">'+note+'</td></tr>';
  }).join('');
}
function renderWorkItemDetail(){
  var el=document.getElementById('projects');
  var w=WI.find(function(x){return x.workItemId===selWi;});
  if(!w){projView='list';return renderProjectList();}
  var I=insights(w);
  var est=w.estimate!=null?(w.estimate+' '+(w.estimateUnit||'hours')):ROI_NONE;
  var backTarget=w.projectId?w.projectId:'__none__';
  var branchRows=(w.branches||[]).map(function(b){
    var d=allData.find(function(x){return x.branch===b;});
    var act=d?tms(d):0;var ai=d?aiPct(d):0;
    return'<tr data-action="detail" data-value="'+esc(b)+'"><td><strong>'+esc(b)+'</strong></td><td>'+fmt(act)+'</td><td><span class="badge '+(ai>50?'ba':'bh')+'">'+ai+'%</span></td><td>'+(d?'$'+d.estimatedCostUsd.toFixed(4):ROI_NONE)+'</td><td style="white-space:nowrap"><button class="dtab" data-action="moveBranch" data-id="'+esc(b)+'" title="Move to another work item">\\u2192 Move</button></td></tr>';
  });
  if(!branchRows.length)branchRows=['<tr><td colspan="5" style="color:var(--vscode-descriptionForeground)">No branches roll up into this work item yet.</td></tr>'];
  el.innerHTML='<button class="back" data-action="proj" data-value="'+esc(backTarget)+'">\\u2190 Back</button>'
    +'<div class="sg"><div class="st"><div class="lbl">Work Item</div><div class="val" style="font-size:.95em;word-break:break-word">'+esc(w.title||('#'+w.workItemId))+'</div><div style="font-size:.78em;color:var(--vscode-descriptionForeground)">#'+esc(w.workItemId)+'</div></div>'
    +'<div class="st"><div class="lbl">Estimate</div><div class="val">'+est+'</div></div>'
    +'<div class="st"><div class="lbl">Actual</div><div class="val">'+fmt(activeMsOf(w))+'</div></div>'
    +'<div class="st"><div class="lbl">Net ROI / AI gain</div><div class="val" style="color:'+moneyColor(I.netGain)+'">'+fmtMoney(I.netGain,I.currency)+'</div></div></div>'
    +'<div class="sg" style="margin-top:4px">'
    +sc('Invoice value',fmtMoney(I.invoiceValue,I.currency),moneyColor(I.invoiceValue))
    +sc('Profit',fmtMoney(I.profit,I.currency),moneyColor(I.profit))
    +sc('Actual hrs',(I.actualHours==null?ROI_NONE:(Math.round(I.actualHours*100)/100)+'h'),'var(--human)')
    +sc('Billable hrs',(I.billableHours==null?ROI_NONE:(Math.round(I.billableHours*100)/100)+'h'),'var(--ai)')
    +'</div>'
    +'<div class="sg" style="margin-top:4px">'
    +sc('AI Share',aiPctOf(w)+'%','var(--ai)')
    +sc('Credits',(w.creditsTotal||0).toFixed(1),'var(--cost)')
    +sc('AI Spend',fmtMoney(I.aiCost,I.currency),'var(--cost)')
    +sc('Time Saved',fmtMin(I.timeSavedMin),I.timeSavedMin>=0?'var(--added)':'var(--deleted)')
    +'</div>'
    +manualSplitHtml(w)
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin:14px 0"><button class="dtab" data-action="cmd" data-value="setWorkItemEstimate">\\uD83D\\uDCCF Set Estimate</button><button class="dtab" data-action="bhSet" data-id="'+esc(w.workItemId)+'">\\uD83D\\uDCB5 Set Billable Hours</button><button class="dtab" data-action="cmd" data-value="assignWorkItemToProject">\\uD83D\\uDCC1 Assign to Project</button><button class="dtab" data-action="reassignBulk" data-id="'+esc(w.workItemId)+'">\\uD83D\\uDD00 Reassign Branches\\u2026</button><button class="dtab" data-action="meAdd" data-id="'+esc(w.workItemId)+'">\\uFF0B Add Effort</button></div>'
    +'<div class="card"><h3>Branches</h3><table style="margin-top:8px"><thead><tr><th>Branch</th><th>Active</th><th>AI %</th><th>Cost</th><th></th></tr></thead><tbody>'+branchRows.join('')+'</tbody></table><p style="margin-top:8px;font-size:.8em;color:var(--vscode-descriptionForeground)">Click a branch to open its full detail, or \\u201c\\u2192 Move\\u201d to re-home it to another work item.</p></div>'
    +'<div class="card" style="margin-top:12px"><h3>Manual Effort</h3><table style="margin-top:8px"><thead><tr><th>When</th><th>Time</th><th>Lines</th><th>Note</th><th></th></tr></thead><tbody>'+manualRowsHtml(w.workItemId)+'</tbody></table><p style="margin-top:8px;font-size:.8em;color:var(--vscode-descriptionForeground)">Manual entries are hand-recorded corrections folded into the totals above.</p></div>'
    +'<div class="card" style="margin-top:12px"><h3>Reassignment History</h3><table style="margin-top:8px"><thead><tr><th>When</th><th>Branch</th><th>From \\u2192 To</th><th>Note</th></tr></thead><tbody>'+reassignRowsHtml(w.workItemId)+'</tbody></table><p style="margin-top:8px;font-size:.8em;color:var(--vscode-descriptionForeground)">Audit trail of branch \\u2192 work item moves touching this work item (newest first).</p></div>';
}
function renderProjectsView(){
  if(projView==='project')return renderProjectDetail();
  if(projView==='workitem')return renderWorkItemDetail();
  return renderProjectList();
}
// Credit ledger list (issue #19). The ledger is the single source of truth, so
// editing/deleting a row here corrects every derived total automatically.
function renderLedger(){
  var el=document.getElementById('ledger');
  var add='<button class="dtab" data-action="cmd" data-value="logCredits">\\uFF0B Add Entry</button>';
  if(!LEDGER||!LEDGER.length){
    el.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2>\\uD83E\\uDDFE Credit Ledger</h2>'+add+'</div><div class="card"><p style="color:var(--vscode-descriptionForeground)">No credit entries yet. Use \\u201cAdd Entry\\u201d to record one.</p></div>';
    return;
  }
  var rows=LEDGER.map(function(e){
    var when=new Date(e.ts).toLocaleString();
    var attr=e.branch?esc(e.branch):'\\u2014';
    if(e.workItemId)attr+=' <span class="badge ba">#'+esc(e.workItemId)+'</span>';
    var cost=(e.cost!=null)?fmtMoney(Number(e.cost),projCurrency(e.projectId),4):'\\u2014';
    var note=e.note?esc(e.note):'';
    var sc=e.source==='manual'?'bh':(e.source==='auto'?'ba':'bp');
    var src='<span class="badge '+sc+'">'+esc(e.source)+'</span>';
    return'<tr><td style="white-space:nowrap">'+esc(when)+'</td><td>'+esc(e.model)+'</td><td>'+Number(e.credits).toFixed(1)+'</td><td>'+cost+'</td><td>'+src+'</td><td>'+attr+'</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis" title="'+note+'">'+note+'</td><td style="white-space:nowrap"><button class="dtab" data-action="ledEdit" data-id="'+esc(e.id)+'" title="Edit entry">\\u270E</button> <button class="dtab" data-action="ledDel" data-id="'+esc(e.id)+'" title="Delete entry">\\uD83D\\uDDD1</button></td></tr>';
  }).join('');
  el.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h2>\\uD83E\\uDDFE Credit Ledger</h2>'+add+'</div>'
    +'<p class="sub">Every credit entry, newest first. Edit or delete any row to correct the ledger \\u2014 totals and ROI recompute automatically.</p>'
    +'<div class="card"><table><thead><tr><th>When</th><th>Model</th><th>Credits</th><th>Cost</th><th>Source</th><th>Attribution</th><th>Note</th><th>Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function showDetail(branch){
  var d=allData.find(function(x){return x.branch===branch;});
  if(!d) return;
  var tab=document.getElementById('dtab');
  tab.textContent=branch.length>22?branch.slice(0,20)+'\u2026':branch;
  tab.dataset.branch=branch;
  showTab('detail');
  var extRows=Object.entries(d.byExt||{}).sort(function(a,b){return(b[1].human.added+b[1].ai.added)-(a[1].human.added+a[1].ai.added);}).map(function(e){var ext=e[0],s=e[1],ta=s.human.added+s.ai.added,pct=ta>0?((s.ai.added/ta)*100).toFixed(0):0;return'<tr><td><span class="extb">.'+ext+'</span></td><td class="dc">'+pp(s.human.added,'bp')+' '+pm(s.human.deleted)+'</td><td class="dc">'+pp(s.ai.added,'ba')+' '+pm(s.ai.deleted)+'</td><td><span class="badge '+(pct>50?'ba':'bh')+'">'+pct+'%</span></td></tr>';}).join('')||'<tr><td colspan="4" style="color:var(--vscode-descriptionForeground)">No changes recorded yet</td></tr>';
  var catRows=Object.entries(d.byCategory||{}).map(function(e){var cat=e[0],s=e[1],ta=s.human.added+s.ai.added,pct=ta>0?((s.ai.added/ta)*100).toFixed(0):0;return'<tr><td>'+(CAT[cat]||cat)+'</td><td class="dc">'+pp(s.human.added,'bp')+' '+pm(s.human.deleted)+'</td><td class="dc">'+pp(s.ai.added,'ba')+' '+pm(s.ai.deleted)+'</td><td><span class="badge '+(pct>50?'ba':'bh')+'">'+pct+'%</span></td></tr>';}).join('');
  var tot=tms(d);
  var timeRows=[['\\u2328\\ufe0f Human Coding',d.humanCodingMs,'var(--human)'],['\\uD83E\\uDD16 AI Generating',d.aiGeneratingMs,'var(--ai)'],['\\uD83D\\uDC40 Reviewing',d.reviewingMs,'var(--review)'],['\\u2615 Idle',d.idleMs,'var(--idle)']].map(function(r){return'<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px"><span>'+r[0]+'</span><strong style="color:'+r[2]+'">'+fmt(r[1])+'</strong></div>';}).join('');
  var I=insights(d);
  var byModel=d.creditsByModel||[];
  var cpu=roiOf(d).creditCostPerUnit; // per-credit cost from the branch's effective rates
  var modelRows=byModel.map(function(r){return'<tr><td>'+r.model+'</td><td class="dc">'+r.credits.toFixed(1)+'</td><td class="dc">'+fmtMoney(cpu!=null?r.credits*cpu:null,I.currency)+'</td></tr>';}).join('')||'<tr><td colspan="3" style="color:var(--vscode-descriptionForeground)">No credits logged yet \\u2014 use \\u201cAI Effort Tracker: Log Credits Used\\u201d</td></tr>';
  var savedColor=I.timeSavedMin>=0?'var(--added)':'var(--deleted)';
  var roiColor=moneyColor(I.roi);
  var insHtml='<div class="sg">'
    +sc('AI Share of Lines',I.aiShare.toFixed(0)+'%','var(--ai)')
    +sc('Velocity',I.velocity.toFixed(1)+' loc/min','var(--human)')
    +sc('Net Lines',(I.totalNet>=0?'+':'')+I.totalNet,'var(--vscode-foreground)')
    +sc('Active Time',fmtMin(I.activeMin),'var(--review)')
    +'</div>'
    +'<div class="card" style="margin-top:16px"><h3>\\uD83D\\uDE80 Productivity Story</h3>'
    +'<p style="line-height:1.7;margin-top:8px">In <strong>'+fmtMin(I.activeMin)+'</strong> of active work you produced <strong>'+I.totalNet+'</strong> net lines '
    +'(<strong style="color:var(--ai)">'+I.aiShare.toFixed(0)+'%</strong> from AI) at <strong>'+I.velocity.toFixed(1)+' loc/min</strong>. '
    +'At a manual baseline of <strong>'+CFG.baselineLocPerMinute+' loc/min</strong> the same output would take <strong>'+fmtMin(I.manualEquivMin)+'</strong>, '
    +'so AI saved about <strong style="color:'+savedColor+'">'+fmtMin(I.timeSavedMin)+'</strong>.</p></div>'
    +'<div class="sg" style="margin-top:16px">'
    +sc('Manual-Equiv Time',fmtMin(I.manualEquivMin),'var(--review)')
    +sc('Time Saved',fmtMin(I.timeSavedMin),savedColor)
    +sc('Value Produced',fmtMoney(I.savedValue,I.currency),moneyColor(I.savedValue))
    +sc('Chat Turns',String(I.chatTurns),'var(--human)')
    +'</div>'
    +'<div class="card" style="margin-top:16px"><div style="display:flex;justify-content:space-between;align-items:center"><h3>\\uD83D\\uDCB0 Credits & Cost</h3><button class="dtab" data-action="cmd" data-value="logCredits">+ Log Credits</button></div>'
    +'<div class="sg" style="margin-top:12px">'
    +sc('Credits Used',I.credits.toFixed(1),'var(--cost)')
    +sc('AI Spend',fmtMoney(I.aiCost,I.currency),'var(--cost)')
    +sc('Net ROI',fmtMoney(I.roi,I.currency),roiColor)
    +'</div>'
    +'<table style="margin-top:14px"><thead><tr><th>Model</th><th>Credits</th><th>Cost</th></tr></thead><tbody>'+modelRows+'</tbody></table>'
    +'<p style="margin-top:10px;font-size:.8em;color:var(--vscode-descriptionForeground)">Net ROI = value produced \\u2212 total cost (labor + credits) from the project\\u2019s effective rates. Credit cost uses the ledger \\u201cCost\\u201d when set, else credits \\u00d7 the project credit rate. \\u201c\\u2014\\u201d means a required rate is unset \\u2014 use \\u201cSet Rates\\u201d on the project. Baseline loc/min tunes the productivity estimate only.</p></div>';
  document.getElementById('detail').innerHTML='<button class="back" data-action="tab" data-value="overview">\\u2190 Overview</button><div class="sg"><div class="st"><div class="lbl">Branch</div><div class="val" style="font-size:.9em;word-break:break-all">'+d.branch+'</div></div><div class="st"><div class="lbl">Work Item</div><div class="val">'+(d.workItemId?'#'+d.workItemId:'\\u2014')+'</div></div><div class="st"><div class="lbl">Active Time</div><div class="val">'+fmt(tot)+'</div></div><div class="st"><div class="lbl">Est. Cost</div><div class="val" style="color:var(--cost)">$'+d.estimatedCostUsd.toFixed(4)+'</div></div></div>  <div class="dtabs"><button class="dtab active" data-action="ds" data-value="insights">\\uD83D\\uDCCA Insights</button><button class="dtab" data-action="ds" data-value="time">\\u23f1 Time</button><button class="dtab" data-action="ds" data-value="lines">\\uD83D\\uDCDD Lines</button><button class="dtab" data-action="ds" data-value="types">\\uD83D\\uDCC1 File Types</button></div><div id="ds-insights" class="ds active">'+insHtml+'</div><div id="ds-time" class="ds"><div class="cr"><div class="card"><h3>Time Breakdown</h3><div class="cw"><canvas id="cDonut"></canvas></div></div><div class="card" style="display:flex;flex-direction:column;gap:10px;justify-content:center">'+timeRows+'</div></div></div><div id="ds-lines" class="ds"><div class="sg"><div class="st"><div class="lbl">Human +Lines</div><div class="val" style="color:var(--added)">+'+d.linesHumanAdded+'</div></div><div class="st"><div class="lbl">Human -Lines</div><div class="val" style="color:var(--deleted)">-'+d.linesHumanDeleted+'</div></div><div class="st"><div class="lbl">AI +Lines</div><div class="val" style="color:var(--ai)">+'+d.linesAiAdded+'</div></div><div class="st"><div class="lbl">AI -Lines</div><div class="val" style="color:var(--deleted)">-'+d.linesAiDeleted+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDCAC Chat Typed (chars)</div><div class="val" style="color:var(--review)">'+(d.chatCharsHuman||0)+'</div></div><div class="st"><div class="lbl">\\u2328\\ufe0f Keystrokes</div><div class="val" style="color:var(--human)">'+(d.humanKeystrokes||0)+'</div></div><div class="st"><div class="lbl">\\uD83E\\uDD16 AI chars</div><div class="val" style="color:var(--ai)">'+(d.aiChars||0)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDD22 Est. tokens</div><div class="val" style="color:var(--cost)">~'+Math.round(((d.humanChars||0)+(d.aiChars||0)+(d.chatCharsHuman||0))/4)+'</div></div></div><div class="card" style="margin-top:16px"><h3>Lines by Extension</h3><div class="cw"><canvas id="cLines"></canvas></div></div></div><div id="ds-types" class="ds"><div class="cr"><div class="card"><h3>By Category</h3><table><thead><tr><th>Category</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+catRows+'</tbody></table></div><div class="card"><h3>By Extension</h3><table><thead><tr><th>Ext</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+extRows+'</tbody></table></div></div></div>';  dc('donut');
  charts.donut=new Chart(document.getElementById('cDonut'),{type:'doughnut',data:{labels:['Human','AI Gen','Review','Idle'],datasets:[{data:[d.humanCodingMs,d.aiGeneratingMs,d.reviewingMs,d.idleMs],backgroundColor:['rgba(78,201,176,.8)','rgba(197,134,192,.8)','rgba(220,220,170,.8)','rgba(77,77,77,.8)'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'62%',plugins:{legend:{position:'bottom',labels:{color:fg(),padding:12}}}}});
  renderLinesChart(d);
}

function renderLinesChart(d){
  var c=document.getElementById('cLines');if(!c)return;
  dc('lines');
  var exts=Object.keys(d.byExt||{}).slice(0,12);
  charts.lines=new Chart(c,{type:'bar',data:{labels:exts.map(function(e){return'.'+e;}),datasets:[{label:'Human +',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].human?d.byExt[e].human.added:0;}),backgroundColor:'rgba(78,201,176,.7)'},{label:'AI +',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].ai?d.byExt[e].ai.added:0;}),backgroundColor:'rgba(197,134,192,.7)'},{label:'Human -',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].human?-d.byExt[e].human.deleted:0;}),backgroundColor:'rgba(78,201,176,.3)'},{label:'AI -',data:exts.map(function(e){return d.byExt[e]&&d.byExt[e].ai?-d.byExt[e].ai.deleted:0;}),backgroundColor:'rgba(197,134,192,.3)'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},scales:{x:{ticks:{color:dfg()},grid:{color:gc}},y:{ticks:{color:dfg()},grid:{color:gc},title:{display:true,text:'lines',color:dfg()}}}}});
}

function showDS(id,btn){
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
  else{document.getElementById('dtab').classList.add('active');}
}

window.addEventListener('message',function(e){
  var msg=e.data;
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
    var av=document.querySelector('.view.active');
    if(av&&av.id==='overview')renderOverview();
    else if(av&&av.id==='trends')renderTrends();
    else if(av&&av.id==='focus')renderFocus();
    else if(av&&av.id==='ghview')renderGhMetrics();
    else if(av&&av.id==='projects')renderProjectsView();
    else if(av&&av.id==='ledger')renderLedger();
    else if(av&&av.id==='detail'){var dt=document.getElementById('dtab');if(dt&&dt.dataset.branch)showDetail(dt.dataset.branch);}
  }
});

renderOverview();
// Wire up tab buttons (CSP blocks inline onclick — use addEventListener instead)
document.getElementById('tab-overview').addEventListener('click',function(){showTab('overview');});
document.getElementById('tab-trends').addEventListener('click',function(){showTab('trends');});
document.getElementById('tab-focus').addEventListener('click',function(){showTab('focus');});
document.getElementById('tab-ghview').addEventListener('click',function(){showTab('ghview');});
document.getElementById('tab-projects').addEventListener('click',function(){showTab('projects');});
document.getElementById('tab-ledger').addEventListener('click',function(){showTab('ledger');});
document.getElementById('dtab').addEventListener('click',function(){
  var br=this.dataset.branch||currentBranch;showDetail(br);
});
// Event delegation for dynamically generated content (branch rows, back button, detail sub-tabs)
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-action]');
  if(!t)return;
  var a=t.dataset.action,v=t.dataset.value;
  if(a==='detail')showDetail(v);
  else if(a==='tab')showTab(v);
  else if(a==='ds')showDS(v,t);
  else if(a==='rng'){trendRange=parseInt(v,10)||30;renderTrends();}
  else if(a==='proj'){selProj=v;selWi=null;projView='project';renderProjectsView();}
  else if(a==='wi'){selWi=v;projView='workitem';renderProjectsView();}
  else if(a==='pprojects'){projView='list';selProj=null;selWi=null;renderProjectList();}
  else if(a==='cmd')vscode.postMessage({type:'cmd',value:v});
  else if(a==='ledEdit')vscode.postMessage({type:'cmd',value:'editLedgerEntry',arg:t.dataset.id});
  else if(a==='ledDel')vscode.postMessage({type:'cmd',value:'deleteLedgerEntry',arg:t.dataset.id});
  else if(a==='meAdd')vscode.postMessage({type:'cmd',value:'addManualEffort',arg:t.dataset.id});
  else if(a==='meEdit')vscode.postMessage({type:'cmd',value:'editManualEffort',arg:t.dataset.id});
  else if(a==='meDel')vscode.postMessage({type:'cmd',value:'deleteManualEffort',arg:t.dataset.id});
  else if(a==='moveBranch')vscode.postMessage({type:'cmd',value:'moveBranchToWorkItem',arg:t.dataset.id});
  else if(a==='reassignBulk')vscode.postMessage({type:'cmd',value:'reassignBranchesBulk',arg:t.dataset.id});
  else if(a==='bhSet')vscode.postMessage({type:'cmd',value:'setBillableHours',arg:t.dataset.id});
});`;

  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'nonce-${nonce}'; img-src data:;">`,
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
    '  <button class="tab" id="dtab">Branch Detail</button>',
    '  <button class="tab" id="tab-ghview">\uD83D\uDC19 Copilot Metrics</button>',
    '</div>',
    '<div id="overview" class="view active"></div>',
    '<div id="trends" class="view"></div>',
    '<div id="focus" class="view"></div>',
    '<div id="projects" class="view"></div>',
    '<div id="ledger" class="view"></div>',
    '<div id="detail" class="view"></div>',
    '<div id="ghview" class="view"></div>',
    `<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>`,
    `<script nonce="${nonce}">${js}</script>`,
    '</body></html>'
  ].join('\n');
}

import type { BranchSummary } from '../store/database';
import { CATEGORY_LABELS } from '../util/fileTypes';
import type { CopilotMetrics } from '../services/githubService';

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
  analytics: DashboardAnalytics = { daily: [], heatmap: [], focus: { sessionsToday: 0, sessionsWeek: 0, totalFocusMsToday: 0, totalFocusMsWeek: 0, longestMs: 0, avgMs: 0, goalProgressPct: 0 } }
): string {
  const data = JSON.stringify(summaries);
  const current = JSON.stringify(currentBranch);
  const catLabels = JSON.stringify(CATEGORY_LABELS);
  const ghData = JSON.stringify(ghMetrics);
  const cfgData = JSON.stringify(config);
  const anData = JSON.stringify(analytics);

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
  var aiCost=credits*CFG.usdPerCredit;
  var savedValue=(timeSavedMin/60)*CFG.hourlyRateUsd;
  var roi=savedValue-aiCost;
  return {activeMin:activeMin,totalNet:totalNet,aiNet:aiNet,humanNet:humanNet,aiShare:aiShare,velocity:velocity,manualEquivMin:manualEquivMin,timeSavedMin:timeSavedMin,credits:credits,aiCost:aiCost,savedValue:savedValue,roi:roi,chatTurns:d.chatTurnsHuman||0,chatChars:d.chatCharsHuman||0};
}
function fmtMin(m){if(m>=60)return(m/60).toFixed(1)+'h';if(m<=0)return'0m';return m.toFixed(0)+'m';}
function sc(lbl,val,color){return'<div class="st"><div class="lbl">'+lbl+'</div><div class="val" style="color:'+(color||'inherit')+'">'+val+'</div></div>';}

function renderGhMetrics(){
  const el=document.getElementById('ghview');
  if(!ghMetrics){
    el.innerHTML='<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3><p style="color:var(--vscode-descriptionForeground);margin-top:8px">Configure your GitHub token in settings to load official Copilot metrics.</p><p style="margin-top:8px;font-size:.85em;color:var(--vscode-descriptionForeground)">Required: <code>aiEffortTracker.githubToken</code> (needs <code>manage_billing:copilot</code> scope)</p></div>';
    return;
  }
  if(ghMetrics.error==='needs-scope-ado'){
    el.innerHTML='<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3>'
      +'<p style="margin-top:8px">&#x2705; Signed in &nbsp;|&nbsp; &#x1F4E6; Azure DevOps repo detected</p>'
      +'<p style="margin-top:10px;font-size:.9em;color:var(--vscode-descriptionForeground)">Copilot metrics live on <strong>GitHub</strong>, not Azure DevOps. Set your <strong>GitHub org name</strong> in settings:</p>'
      +'<p style="margin-top:8px;font-family:monospace;font-size:.9em">aiEffortTracker.githubOrg = <em>your-github-org</em></p>'
      +'<p style="margin-top:8px;font-size:.85em;color:var(--vscode-descriptionForeground)">(This is the GitHub organisation where your Copilot licences are managed &mdash; not your Azure DevOps org.)</p></div>';
    return;
  }
  if(ghMetrics.error==='needs-scope'){
    el.innerHTML='<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3><p style="margin-top:8px">&#x2705; Signed in to GitHub! Could not detect a GitHub remote in the current workspace.</p><p style="margin-top:10px;font-size:.9em;color:var(--vscode-descriptionForeground)">Open a GitHub repository in VS Code, or manually set <code>aiEffortTracker.githubOrg</code> or <code>aiEffortTracker.githubRepo</code> in settings.</p></div>';
    return;
  }
  if(ghMetrics.error==='api-error'){
    var detail=ghMetrics.errorDetail?'<p style="margin-top:10px;padding:10px;background:rgba(244,113,116,.1);border-left:3px solid var(--deleted);border-radius:4px;font-size:.85em;line-height:1.5">'+ghMetrics.errorDetail+'</p>':'';
    el.innerHTML='<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3><p style="margin-top:8px">&#x26A0;&#xFE0F; Could not load metrics for <strong>'+ghMetrics.scopeName+'</strong>.</p>'+detail+'<p style="margin-top:10px;font-size:.85em;color:var(--vscode-descriptionForeground)">Note: this endpoint is <strong>org/enterprise only</strong> &mdash; personal Copilot subscriptions have no metrics API.</p></div>';
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

  el.innerHTML='<div class="sg" style="grid-template-columns:repeat(5,1fr)">'
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
    +'<div style="display:flex;gap:6px"><button class="dtab" data-action="cmd" data-value="weeklyReport">\\uD83D\\uDCC4 Weekly Report</button><button class="dtab" data-action="cmd" data-value="exportCsv">\\u2B07 Export CSV</button></div></div>'
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
  el.innerHTML=hdr+'<div class="sg"><div class="st"><div class="lbl">\\u2328\\ufe0f Human Coding</div><div class="val" style="color:var(--human)">'+fmt(T.human)+'</div></div><div class="st"><div class="lbl">\\uD83E\\uDD16 AI Generating</div><div class="val" style="color:var(--ai)">'+fmt(T.ai)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDC40 Reviewing</div><div class="val" style="color:var(--review)">'+fmt(T.review)+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDCB0 Est. Cost</div><div class="val" style="color:var(--cost)">$'+T.cost.toFixed(4)+'</div></div></div><div class="cr"><div class="card"><h3>Time per Branch</h3><div class="cw"><canvas id="cBar"></canvas></div></div><div class="card"><h3>AI % per Branch</h3><div class="cw"><canvas id="cAi"></canvas></div></div></div><table><thead><tr><th>Branch</th><th>Work Item</th><th>Active</th><th>Split</th><th>Human +/-</th><th>AI +/-</th><th>AI %</th><th>Cost</th></tr></thead><tbody>  '+rows+'</tbody></table>'+hot;
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
  var modelRows=byModel.map(function(r){return'<tr><td>'+r.model+'</td><td class="dc">'+r.credits.toFixed(1)+'</td><td class="dc">$'+(r.credits*CFG.usdPerCredit).toFixed(2)+'</td></tr>';}).join('')||'<tr><td colspan="3" style="color:var(--vscode-descriptionForeground)">No credits logged yet \\u2014 use \\u201cAI Effort Tracker: Log Credits Used\\u201d</td></tr>';
  var savedColor=I.timeSavedMin>=0?'var(--added)':'var(--deleted)';
  var roiColor=I.roi>=0?'var(--added)':'var(--deleted)';
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
    +sc('Value of Time Saved','$'+I.savedValue.toFixed(2),savedColor)
    +sc('Chat Turns',String(I.chatTurns),'var(--human)')
    +'</div>'
    +'<div class="card" style="margin-top:16px"><div style="display:flex;justify-content:space-between;align-items:center"><h3>\\uD83D\\uDCB0 Credits & Cost</h3><button class="dtab" data-action="cmd" data-value="logCredits">+ Log Credits</button></div>'
    +'<div class="sg" style="margin-top:12px">'
    +sc('Credits Used',I.credits.toFixed(1),'var(--cost)')
    +sc('AI Spend','$'+I.aiCost.toFixed(2),'var(--cost)')
    +sc('Net ROI','$'+I.roi.toFixed(2),roiColor)
    +'</div>'
    +'<table style="margin-top:14px"><thead><tr><th>Model</th><th>Credits</th><th>Cost</th></tr></thead><tbody>'+modelRows+'</tbody></table>'
    +'<p style="margin-top:10px;font-size:.8em;color:var(--vscode-descriptionForeground)">ROI = (value of time saved) \\u2212 (AI spend). Tune <code>baselineLocPerMinute</code>, <code>hourlyRateUsd</code>, <code>usdPerCredit</code> in settings.</p></div>';
  document.getElementById('detail').innerHTML='<button class="back" data-action="tab" data-value="overview">\\u2190 Overview</button><div class="sg"><div class="st"><div class="lbl">Branch</div><div class="val" style="font-size:.9em;word-break:break-all">'+d.branch+'</div></div><div class="st"><div class="lbl">Work Item</div><div class="val">'+(d.workItemId?'#'+d.workItemId:'\\u2014')+'</div></div><div class="st"><div class="lbl">Active Time</div><div class="val">'+fmt(tot)+'</div></div><div class="st"><div class="lbl">Est. Cost</div><div class="val" style="color:var(--cost)">$'+d.estimatedCostUsd.toFixed(4)+'</div></div></div>  <div class="dtabs"><button class="dtab active" data-action="ds" data-value="insights">\\uD83D\\uDCCA Insights</button><button class="dtab" data-action="ds" data-value="time">\\u23f1 Time</button><button class="dtab" data-action="ds" data-value="lines">\\uD83D\\uDCDD Lines</button><button class="dtab" data-action="ds" data-value="types">\\uD83D\\uDCC1 File Types</button></div><div id="ds-insights" class="ds active">'+insHtml+'</div><div id="ds-time" class="ds"><div class="cr"><div class="card"><h3>Time Breakdown</h3><div class="cw"><canvas id="cDonut"></canvas></div></div><div class="card" style="display:flex;flex-direction:column;gap:10px;justify-content:center">'+timeRows+'</div></div></div><div id="ds-lines" class="ds"><div class="sg"><div class="st"><div class="lbl">Human +Lines</div><div class="val" style="color:var(--added)">+'+d.linesHumanAdded+'</div></div><div class="st"><div class="lbl">Human -Lines</div><div class="val" style="color:var(--deleted)">-'+d.linesHumanDeleted+'</div></div><div class="st"><div class="lbl">AI +Lines</div><div class="val" style="color:var(--ai)">+'+d.linesAiAdded+'</div></div><div class="st"><div class="lbl">AI -Lines</div><div class="val" style="color:var(--deleted)">-'+d.linesAiDeleted+'</div></div><div class="st"><div class="lbl">\\uD83D\\uDCAC Chat Typed (chars)</div><div class="val" style="color:var(--review)">'+(d.chatCharsHuman||0)+'</div></div></div><div class="card" style="margin-top:16px"><h3>Lines by Extension</h3><div class="cw"><canvas id="cLines"></canvas></div></div></div><div id="ds-types" class="ds"><div class="cr"><div class="card"><h3>By Category</h3><table><thead><tr><th>Category</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+catRows+'</tbody></table></div><div class="card"><h3>By Extension</h3><table><thead><tr><th>Ext</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+extRows+'</tbody></table></div></div></div>';  dc('donut');
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
  else{document.getElementById('dtab').classList.add('active');}
}

window.addEventListener('message',function(e){
  var msg=e.data;
  if(msg.type==='update'){
    allData=msg.summaries;currentBranch=msg.currentBranch;
    if(msg.ghMetrics!==undefined)ghMetrics=msg.ghMetrics;
    if(msg.config!==undefined&&msg.config)CFG=msg.config;
    if(msg.analytics!==undefined&&msg.analytics)AN=msg.analytics;
    var av=document.querySelector('.view.active');
    if(av&&av.id==='overview')renderOverview();
    else if(av&&av.id==='trends')renderTrends();
    else if(av&&av.id==='focus')renderFocus();
    else if(av&&av.id==='ghview')renderGhMetrics();
    else if(av&&av.id==='detail'){var dt=document.getElementById('dtab');if(dt&&dt.dataset.branch)showDetail(dt.dataset.branch);}
  }
});

renderOverview();
// Wire up tab buttons (CSP blocks inline onclick — use addEventListener instead)
document.getElementById('tab-overview').addEventListener('click',function(){showTab('overview');});
document.getElementById('tab-trends').addEventListener('click',function(){showTab('trends');});
document.getElementById('tab-focus').addEventListener('click',function(){showTab('focus');});
document.getElementById('tab-ghview').addEventListener('click',function(){showTab('ghview');});
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
  else if(a==='cmd')vscode.postMessage({type:'cmd',value:v});
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
    '  <button class="tab" id="dtab">Branch Detail</button>',
    '  <button class="tab" id="tab-ghview">\uD83D\uDC19 Copilot Metrics</button>',
    '</div>',
    '<div id="overview" class="view active"></div>',
    '<div id="trends" class="view"></div>',
    '<div id="focus" class="view"></div>',
    '<div id="detail" class="view"></div>',
    '<div id="ghview" class="view"></div>',
    `<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>`,
    `<script nonce="${nonce}">${js}</script>`,
    '</body></html>'
  ].join('\n');
}

import type { BranchSummary } from '../store/database';
import { CATEGORY_LABELS } from '../util/fileTypes';
import type { CopilotMetrics } from '../services/githubService';

export function renderDashboardHtml(
  summaries: BranchSummary[],
  currentBranch: string,
  nonce: string,
  ghMetrics: CopilotMetrics | null = null
): string {
  const data = JSON.stringify(summaries);
  const current = JSON.stringify(currentBranch);
  const catLabels = JSON.stringify(CATEGORY_LABELS);
  const ghData = JSON.stringify(ghMetrics);

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
  .dc{font-family:monospace;}`;

  const js = `
const vscode=acquireVsCodeApi();
let allData=${data};
let currentBranch=${current};
const CAT=${catLabels};
let ghMetrics=${ghData};
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
    el.innerHTML='<div class="card" style="margin-top:16px"><h3>GitHub Copilot Metrics API</h3><p style="color:var(--vscode-descriptionForeground);margin-top:8px">&#x26A0;&#xFE0F; API request failed for <strong>'+ghMetrics.scopeName+'</strong>.</p><p style="margin-top:8px;font-size:.85em;color:var(--vscode-descriptionForeground)">Check that your token has the <code>manage_billing:copilot</code> scope (classic) or <em>GitHub Copilot Business: Read</em> permission (fine-grained), and that the org/repo name is correct.</p></div>';
    return;
  }
  var days=ghMetrics.days.slice(-14);
  var totSugg=days.reduce(function(a,d){return a+d.totalSuggestionsCount;},0);
  var totAcc=days.reduce(function(a,d){return a+d.totalAcceptancesCount;},0);
  var totLinesAcc=days.reduce(function(a,d){return a+d.totalLinesAccepted;},0);
  var totLinesSugg=days.reduce(function(a,d){return a+d.totalLinesSuggested;},0);
  var accRate=totSugg>0?((totAcc/totSugg)*100).toFixed(1):0;
  var lineAccRate=totLinesSugg>0?((totLinesAcc/totLinesSugg)*100).toFixed(1):0;

  // Combine local tracker totals for comparison
  var localAiLines=allData.reduce(function(a,d){return a+d.linesAiAdded;},0);

  // Top languages from last 14 days
  var langMap={};
  days.forEach(function(d){d.byLanguage.forEach(function(l){if(!langMap[l.name])langMap[l.name]={sugg:0,acc:0,linesSugg:0,linesAcc:0};langMap[l.name].sugg+=l.totalSuggestionsCount;langMap[l.name].acc+=l.totalAcceptancesCount;langMap[l.name].linesSugg+=l.totalLinesSuggested;langMap[l.name].linesAcc+=l.totalLinesAccepted;});});
  var topLangs=Object.entries(langMap).sort(function(a,b){return b[1].linesAcc-a[1].linesAcc;}).slice(0,8);

  var langRows=topLangs.map(function(e){var n=e[0],s=e[1],r=s.sugg>0?((s.acc/s.sugg)*100).toFixed(0):0;return'<tr><td><span class="extb">'+n+'</span></td><td>'+s.sugg+'</td><td>'+s.acc+'</td><td><span class="badge '+(r>50?'ba':'bh')+'">'+r+'%</span></td><td>+'+s.linesAcc+'</td></tr>';}).join('');

  el.innerHTML='<div class="sg" style="grid-template-columns:repeat(4,1fr)">'
    +'<div class="st"><div class="lbl">Suggestions (14d)</div><div class="val">'+totSugg+'</div></div>'
    +'<div class="st"><div class="lbl">Acceptances (14d)</div><div class="val" style="color:var(--human)">'+totAcc+'</div></div>'
    +'<div class="st"><div class="lbl">Acceptance Rate</div><div class="val" style="color:var(--ai)">'+accRate+'%</div></div>'
    +'<div class="st"><div class="lbl">Lines Accepted (14d)</div><div class="val" style="color:var(--ai)">'+totLinesAcc+'</div></div>'
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
    +'<div class="card"><h3>By Language (14d)</h3>'
    +'<table><thead><tr><th>Language</th><th>Suggestions</th><th>Accepted</th><th>Accept %</th><th>Lines Accepted</th></tr></thead>'
    +'<tbody>'+langRows+'</tbody></table></div>';

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
  el.innerHTML='<div class="sg"><div class="st"><div class="lbl">\\u2328\\ufe0f Human Coding</div><div class="val" style="color:var(--human)">'+fmt(T.human)+'</div></div><div class="st"><div class="lbl">\\U0001f916 AI Generating</div><div class="val" style="color:var(--ai)">'+fmt(T.ai)+'</div></div><div class="st"><div class="lbl">\\U0001f440 Reviewing</div><div class="val" style="color:var(--review)">'+fmt(T.review)+'</div></div><div class="st"><div class="lbl">\\U0001f4b0 Est. Cost</div><div class="val" style="color:var(--cost)">$'+T.cost.toFixed(4)+'</div></div></div><div class="cr"><div class="card"><h3>Time per Branch</h3><div class="cw"><canvas id="cBar"></canvas></div></div><div class="card"><h3>AI % per Branch</h3><div class="cw"><canvas id="cAi"></canvas></div></div></div><table><thead><tr><th>Branch</th><th>Work Item</th><th>Active</th><th>Split</th><th>Human +/-</th><th>AI +/-</th><th>AI %</th><th>Cost</th></tr></thead><tbody>'+rows+'</tbody></table>';
  var labels=allData.map(function(d){return d.branch.length>16?d.branch.slice(0,14)+'\\u2026':d.branch;});
  dc('bar');
  charts.bar=new Chart(document.getElementById('cBar'),{type:'bar',data:{labels:labels,datasets:[{label:'Human',data:allData.map(function(d){return Math.round(d.humanCodingMs/60000);}),backgroundColor:'rgba(78,201,176,.7)'},{label:'AI Gen',data:allData.map(function(d){return Math.round(d.aiGeneratingMs/60000);}),backgroundColor:'rgba(197,134,192,.7)'},{label:'Review',data:allData.map(function(d){return Math.round(d.reviewingMs/60000);}),backgroundColor:'rgba(220,220,170,.7)'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:fg()}}},scales:{x:{ticks:{color:dfg()},grid:{color:gc},stacked:true},y:{ticks:{color:dfg()},grid:{color:gc},stacked:true,title:{display:true,text:'min',color:dfg()}}}}});
  dc('ai');
  charts.ai=new Chart(document.getElementById('cAi'),{type:'bar',data:{labels:labels,datasets:[{label:'AI %',data:allData.map(function(d){return aiPct(d);}),backgroundColor:allData.map(function(d){return aiPct(d)>50?'rgba(197,134,192,.8)':'rgba(78,201,176,.8)';})}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:dfg()},grid:{color:gc}},y:{ticks:{color:dfg()},grid:{color:gc},max:100,title:{display:true,text:'%',color:dfg()}}}}});
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
  var timeRows=[['\\u2328\\ufe0f Human Coding',d.humanCodingMs,'var(--human)'],['\\U0001f916 AI Generating',d.aiGeneratingMs,'var(--ai)'],['\\U0001f440 Reviewing',d.reviewingMs,'var(--review)'],['\\u2615 Idle',d.idleMs,'var(--idle)']].map(function(r){return'<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px"><span>'+r[0]+'</span><strong style="color:'+r[2]+'">'+fmt(r[1])+'</strong></div>';}).join('');
  document.getElementById('detail').innerHTML='<button class="back" data-action="tab" data-value="overview">\\u2190 Overview</button><div class="sg"><div class="st"><div class="lbl">Branch</div><div class="val" style="font-size:.9em;word-break:break-all">'+d.branch+'</div></div><div class="st"><div class="lbl">Work Item</div><div class="val">'+(d.workItemId?'#'+d.workItemId:'\\u2014')+'</div></div><div class="st"><div class="lbl">Active Time</div><div class="val">'+fmt(tot)+'</div></div><div class="st"><div class="lbl">Est. Cost</div><div class="val" style="color:var(--cost)">$'+d.estimatedCostUsd.toFixed(4)+'</div></div></div><div class="dtabs"><button class="dtab active" data-action="ds" data-value="time">\\u23f1 Time</button><button class="dtab" data-action="ds" data-value="lines">\\U0001f4dd Lines</button><button class="dtab" data-action="ds" data-value="types">\\U0001f4c1 File Types</button></div><div id="ds-time" class="ds active"><div class="cr"><div class="card"><h3>Time Breakdown</h3><div class="cw"><canvas id="cDonut"></canvas></div></div><div class="card" style="display:flex;flex-direction:column;gap:10px;justify-content:center">'+timeRows+'</div></div></div><div id="ds-lines" class="ds"><div class="sg"><div class="st"><div class="lbl">Human +Lines</div><div class="val" style="color:var(--added)">+'+d.linesHumanAdded+'</div></div><div class="st"><div class="lbl">Human -Lines</div><div class="val" style="color:var(--deleted)">-'+d.linesHumanDeleted+'</div></div><div class="st"><div class="lbl">AI +Lines</div><div class="val" style="color:var(--ai)">+'+d.linesAiAdded+'</div></div><div class="st"><div class="lbl">AI -Lines</div><div class="val" style="color:var(--deleted)">-'+d.linesAiDeleted+'</div></div></div><div class="card" style="margin-top:16px"><h3>Lines by Extension</h3><div class="cw"><canvas id="cLines"></canvas></div></div></div><div id="ds-types" class="ds"><div class="cr"><div class="card"><h3>By Category</h3><table><thead><tr><th>Category</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+catRows+'</tbody></table></div><div class="card"><h3>By Extension</h3><table><thead><tr><th>Ext</th><th>Human +/-</th><th>AI +/-</th><th>AI%</th></tr></thead><tbody>'+extRows+'</tbody></table></div></div></div>';
  dc('donut');
  charts.donut=new Chart(document.getElementById('cDonut'),{type:'doughnut',data:{labels:['Human','AI Gen','Review','Idle'],datasets:[{data:[d.humanCodingMs,d.aiGeneratingMs,d.reviewingMs,d.idleMs],backgroundColor:['rgba(78,201,176,.8)','rgba(197,134,192,.8)','rgba(220,220,170,.8)','rgba(77,77,77,.8)'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:fg(),padding:12}}}}});
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
}

function showTab(name){
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
  document.getElementById(name).classList.add('active');
  if(name==='overview'){document.getElementById('tab-overview').classList.add('active');renderOverview();}
  else if(name==='ghview'){document.getElementById('tab-ghview').classList.add('active');renderGhMetrics();}
  else{document.getElementById('dtab').classList.add('active');}
}

window.addEventListener('message',function(e){
  var msg=e.data;
  if(msg.type==='update'){
    allData=msg.summaries;currentBranch=msg.currentBranch;
    if(msg.ghMetrics!==undefined)ghMetrics=msg.ghMetrics;
    var av=document.querySelector('.view.active');
    if(av&&av.id==='overview')renderOverview();
    else if(av&&av.id==='ghview')renderGhMetrics();
  }
});

renderOverview();
// Wire up tab buttons (CSP blocks inline onclick — use addEventListener instead)
document.getElementById('tab-overview').addEventListener('click',function(){showTab('overview');});
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
    '  <button class="tab" id="dtab">Branch Detail</button>',
    '  <button class="tab" id="tab-ghview">\uD83D\uDC19 Copilot Metrics</button>',
    '</div>',
    '<div id="overview" class="view active"></div>',
    '<div id="detail" class="view"></div>',
    '<div id="ghview" class="view"></div>',
    `<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>`,
    `<script nonce="${nonce}">${js}</script>`,
    '</body></html>'
  ].join('\n');
}

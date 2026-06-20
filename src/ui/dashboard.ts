import type { BranchSummary } from '../store/database';

export function renderDashboardHtml(
  summaries: BranchSummary[],
  currentBranch: string,
  nonce: string
): string {
  const data = JSON.stringify(summaries);
  const current = JSON.stringify(currentBranch);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           style-src 'nonce-${nonce}';
           img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Effort Tracker</title>
<style nonce="${nonce}">
  :root {
    --human: #4ec9b0;
    --ai: #c586c0;
    --review: #dcdcaa;
    --idle: #4d4d4d;
    --cost: #f4a261;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
  }
  h1 { font-size: 1.3em; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 20px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab {
    padding: 6px 14px; cursor: pointer; border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground); background: none; border-top: none;
    border-left: none; border-right: none; font-family: inherit; font-size: inherit;
  }
  .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  .view { display: none; }
  .view.active { display: block; }
  .charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 16px;
  }
  .card h3 { font-size: 0.9em; margin-bottom: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  .chart-wrap { position: relative; height: 200px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th { text-align: left; padding: 8px 10px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  tr:hover td { background: var(--vscode-list-hoverBackground); cursor: pointer; }
  tr.current-branch td { background: var(--vscode-editor-lineHighlightBackground); }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 0.8em; }
  .badge-ai { background: rgba(197,134,192,0.2); color: var(--ai); }
  .badge-human { background: rgba(78,201,176,0.2); color: var(--human); }
  .mini-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; width: 80px; }
  .mini-bar span { display: block; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 16px; }
  .stat .label { font-size: 0.75em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .stat .value { font-size: 1.4em; font-weight: bold; }
  .back-btn { background: none; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 0.85em; margin-bottom: 16px; }
  .back-btn:hover { background: var(--vscode-list-hoverBackground); }
  .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #4ec9b0; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
</style>
</head>
<body>
<h1>📊 AI Effort Tracker</h1>
<p class="subtitle"><span class="live-dot"></span>Live tracking · refreshes every 5s</p>

<div class="tabs">
  <button class="tab active" onclick="showTab('overview')">Overview</button>
  <button class="tab" onclick="showTab('detail')" id="detail-tab" style="display:none">Branch Detail</button>
</div>

<div id="overview" class="view active"></div>
<div id="detail" class="view"></div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let allData = ${data};
let currentBranch = ${current};
let overviewBarChart = null;
let overviewAiChart = null;
let detailDonut = null;

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}

function aiPct(d) {
  const total = d.linesHuman + d.linesAi;
  return total > 0 ? ((d.linesAi / total) * 100).toFixed(0) : 0;
}

function totalActiveMs(d) {
  return d.humanCodingMs + d.aiGeneratingMs + d.reviewingMs;
}

function renderOverview() {
  const el = document.getElementById('overview');
  const totals = allData.reduce((acc, d) => {
    acc.human += d.humanCodingMs; acc.ai += d.aiGeneratingMs;
    acc.review += d.reviewingMs; acc.linesHuman += d.linesHuman;
    acc.linesAi += d.linesAi; acc.cost += d.estimatedCostUsd;
    return acc;
  }, { human: 0, ai: 0, review: 0, linesHuman: 0, linesAi: 0, cost: 0 });

  const totalLines = totals.linesHuman + totals.linesAi;
  const totalAiPct = totalLines > 0 ? ((totals.linesAi / totalLines) * 100).toFixed(0) : 0;

  el.innerHTML = \`
    <div class="stat-grid">
      <div class="stat"><div class="label">⌨️ Human Coding</div><div class="value" style="color:var(--human)">\${fmt(totals.human)}</div></div>
      <div class="stat"><div class="label">🤖 AI Generating</div><div class="value" style="color:var(--ai)">\${fmt(totals.ai)}</div></div>
      <div class="stat"><div class="label">👀 Reviewing</div><div class="value" style="color:var(--review)">\${fmt(totals.review)}</div></div>
      <div class="stat"><div class="label">💰 Est. Cost</div><div class="value" style="color:var(--cost)">$\${totals.cost.toFixed(4)}</div></div>
    </div>
    <div class="charts-row">
      <div class="card"><h3>Time per Branch</h3><div class="chart-wrap"><canvas id="overviewBar"></canvas></div></div>
      <div class="card"><h3>AI % per Branch</h3><div class="chart-wrap"><canvas id="overviewAi"></canvas></div></div>
    </div>
    <table>
      <thead><tr>
        <th>Branch</th><th>Work Item</th><th>Active Time</th>
        <th>Split</th><th>AI Lines</th><th>AI %</th><th>Est. Cost</th>
      </tr></thead>
      <tbody>
        \${allData.map(d => {
          const total = totalActiveMs(d);
          const hPct = total > 0 ? (d.humanCodingMs / total * 100) : 0;
          const aiGenPct = total > 0 ? (d.aiGeneratingMs / total * 100) : 0;
          const revPct = total > 0 ? (d.reviewingMs / total * 100) : 0;
          const isCurrent = d.branch === currentBranch;
          return \`<tr class="\${isCurrent ? 'current-branch' : ''}" onclick="showBranchDetail('\${d.branch}')">
            <td>\${isCurrent ? '▶ ' : ''}<strong>\${d.branch}</strong></td>
            <td>\${d.workItemId ? '<span class="badge badge-ai">#' + d.workItemId + '</span>' : '—'}</td>
            <td>\${fmt(total)}</td>
            <td><div class="mini-bar">
              <span style="width:\${hPct}%;background:var(--human)"></span>
              <span style="width:\${aiGenPct}%;background:var(--ai)"></span>
              <span style="width:\${revPct}%;background:var(--review)"></span>
            </div></td>
            <td>\${d.linesAi}</td>
            <td><span class="badge \${aiPct(d) > 50 ? 'badge-ai' : 'badge-human'}">\${aiPct(d)}%</span></td>
            <td>$\${d.estimatedCostUsd.toFixed(4)}</td>
          </tr>\`;
        }).join('')}
      </tbody>
    </table>
  \`;

  const labels = allData.map(d => d.branch.length > 20 ? d.branch.slice(0,18)+'…' : d.branch);
  const chartDefaults = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: getComputedStyle(document.body).getPropertyValue('--vscode-foreground') } } }, scales: { x: { ticks: { color: getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') }, grid: { color: 'rgba(128,128,128,0.15)' } }, y: { ticks: { color: getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') }, grid: { color: 'rgba(128,128,128,0.15)' } } } };

  if (overviewBarChart) overviewBarChart.destroy();
  overviewBarChart = new Chart(document.getElementById('overviewBar'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: '⌨️ Human', data: allData.map(d => Math.round(d.humanCodingMs/60000)), backgroundColor: 'rgba(78,201,176,0.7)' },
        { label: '🤖 AI Gen', data: allData.map(d => Math.round(d.aiGeneratingMs/60000)), backgroundColor: 'rgba(197,134,192,0.7)' },
        { label: '👀 Review', data: allData.map(d => Math.round(d.reviewingMs/60000)), backgroundColor: 'rgba(220,220,170,0.7)' }
      ]
    },
    options: { ...chartDefaults, scales: { ...chartDefaults.scales, x: { ...chartDefaults.scales.x, stacked: true }, y: { ...chartDefaults.scales.y, stacked: true, title: { display: true, text: 'minutes', color: getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') } } } }
  });

  if (overviewAiChart) overviewAiChart.destroy();
  overviewAiChart = new Chart(document.getElementById('overviewAi'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'AI %', data: allData.map(d => aiPct(d)), backgroundColor: allData.map(d => aiPct(d) > 50 ? 'rgba(197,134,192,0.8)' : 'rgba(78,201,176,0.8)') }] },
    options: { ...chartDefaults, plugins: { legend: { display: false } }, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, max: 100, title: { display: true, text: '%', color: getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') } } } }
  });
}

function showBranchDetail(branch) {
  const d = allData.find(x => x.branch === branch);
  if (!d) return;
  const tab = document.getElementById('detail-tab');
  tab.style.display = '';
  tab.textContent = branch.length > 24 ? branch.slice(0,22)+'…' : branch;
  showTab('detail');

  const total = totalActiveMs(d);
  const totalAll = total + d.idleMs;
  const detail = document.getElementById('detail');
  detail.innerHTML = \`
    <button class="back-btn" onclick="showTab('overview')">← Back to Overview</button>
    <div class="stat-grid">
      <div class="stat"><div class="label">Branch</div><div class="value" style="font-size:1em">\${d.branch}</div></div>
      <div class="stat"><div class="label">Work Item</div><div class="value">\${d.workItemId ? '#' + d.workItemId : '—'}</div></div>
      <div class="stat"><div class="label">Total Active</div><div class="value">\${fmt(total)}</div></div>
      <div class="stat"><div class="label">Est. Cost</div><div class="value" style="color:var(--cost)">$\${d.estimatedCostUsd.toFixed(4)}</div></div>
    </div>
    <div class="charts-row">
      <div class="card"><h3>Time Breakdown</h3><div class="chart-wrap"><canvas id="detailDonut"></canvas></div></div>
      <div class="card" style="display:flex;flex-direction:column;gap:12px;justify-content:center;">
        \${[
          ['⌨️ Human Coding', fmt(d.humanCodingMs), 'var(--human)'],
          ['🤖 AI Generating', fmt(d.aiGeneratingMs), 'var(--ai)'],
          ['👀 Reviewing', fmt(d.reviewingMs), 'var(--review)'],
          ['☕ Idle', fmt(d.idleMs), 'var(--idle)'],
        ].map(([label, val, color]) => \`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px">
            <span>\${label}</span><strong style="color:\${color}">\${val}</strong>
          </div>\`).join('')}
        <div style="padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;display:flex;justify-content:space-between">
          <span>Lines Human / AI</span><strong>\${d.linesHuman} / \${d.linesAi} <span class="badge badge-ai">\${aiPct(d)}% AI</span></strong>
        </div>
        <div style="padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;display:flex;justify-content:space-between">
          <span>Copilot Acceptances</span><strong>\${d.copilotAcceptances}</strong>
        </div>
      </div>
    </div>
  \`;

  if (detailDonut) detailDonut.destroy();
  detailDonut = new Chart(document.getElementById('detailDonut'), {
    type: 'doughnut',
    data: {
      labels: ['⌨️ Human Coding', '🤖 AI Generating', '👀 Reviewing', '☕ Idle'],
      datasets: [{ data: [d.humanCodingMs, d.aiGeneratingMs, d.reviewingMs, d.idleMs], backgroundColor: ['rgba(78,201,176,0.8)', 'rgba(197,134,192,0.8)', 'rgba(220,220,170,0.8)', 'rgba(77,77,77,0.8)'], borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: getComputedStyle(document.body).getPropertyValue('--vscode-foreground'), padding: 12 } } } }
  });
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(name).classList.add('active');
  const tabs = document.querySelectorAll('.tab');
  if (name === 'overview') tabs[0].classList.add('active');
  else tabs[1].classList.add('active');
  if (name === 'overview') renderOverview();
}

// Handle live updates from extension
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'update') {
    allData = msg.summaries;
    currentBranch = msg.currentBranch;
    const activeView = document.querySelector('.view.active')?.id;
    if (activeView === 'overview') renderOverview();
  }
});

renderOverview();
</script>
</body>
</html>`;
}

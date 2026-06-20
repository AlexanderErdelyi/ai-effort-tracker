# AI Effort Tracker

> VS Code extension that tracks **human vs AI effort**, time, and estimated cost per branch / work item.

## What it tracks

| Metric | How |
|--------|-----|
| ⌨️ Human coding time | Keystroke & edit activity |
| 🤖 AI generating time | Copilot Chat / agent activity |
| 👀 Review time | Focus without typing |
| ☕ Idle time | No activity |
| Lines: Human vs AI | Copilot accepted completions |
| Estimated AI cost | Accepted lines × model rate |
| Work item linkage | Branch name pattern (`feature/1234-...`) |

## Usage

1. Install the extension in VS Code
2. It auto-starts tracking on launch
3. Click the status bar item (`⌨️ Coding`) or run **AI Effort Tracker: Show Session Summary**
4. At end of a feature branch, export the report via **AI Effort Tracker: Export Report (JSON)**

## Commands

| Command | Description |
|---------|-------------|
| `AI Effort Tracker: Show Session Summary` | Open webview summary for current branch |
| `AI Effort Tracker: Start Tracking Session` | Manually start tracking |
| `AI Effort Tracker: Stop Tracking Session` | Pause tracking |
| `AI Effort Tracker: Export Report (JSON)` | Export branch report as JSON |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `aiEffortTracker.idleThresholdSeconds` | `120` | Seconds before switching to idle |
| `aiEffortTracker.reviewThresholdSeconds` | `10` | Seconds of no-keystroke before switching to review |
| `aiEffortTracker.azureDevOpsOrg` | `""` | AzDO org URL for work item lookup |
| `aiEffortTracker.githubToken` | `""` | GitHub PAT for issue metadata |

## Development

```bash
npm install
npm run watch
# Press F5 in VS Code to launch Extension Development Host
```

## Roadmap

- [ ] Azure DevOps work item API integration (fetch title, story points)
- [ ] GitHub Issues integration
- [ ] Dashboard webview with charts across all branches
- [ ] Accurate Copilot token usage via GitHub Copilot Metrics API
- [ ] Team aggregation / export to CSV

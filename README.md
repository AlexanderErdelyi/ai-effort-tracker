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

## Recorded Copilot credits and code impact

Live capture reads this VS Code window's workspace storage:
`GitHub.copilot-chat/debug-logs/<session-id>/main.jsonl`. It uses the recorded
`copilotUsageNanoAiu / 1,000,000,000` charge for each physical model call, including
agent/tool rounds. It does not estimate a charge from generated lines or reapply a
token/cache price to an already recorded charge. A missing charge is **unknown**;
the ledger labels the known subtotal as partial. GitHub billing is still the
source for final billed spend, allowances and adjustments.

Sibling subagent `.jsonl` logs are included in the invoking user turn through
their declared parent session and parent tool span, including nested subagents.
Child-only log updates refresh the same ledger entry. Unlinked child requests are
reported as warnings rather than assigned by timing alone. Span reuse after an
extension-host restart is isolated from previous requests.

- `aiEffortTracker.captureDebugLogs` is enabled by default. It replaces both live
  estimators and automatic export-folder imports (reload after changing it).
  Disabling it restores the export-folder mode or one legacy estimator.
- New user turns observed while the extension is running are tracked automatically.
  The branch is captured when the turn is first observed and retained through later
  rounds and restarts. A branch transition between polls is ambiguous; those turns
  are parked under `unknown` rather than silently assigned to the wrong work item.
- Existing, unsynced history is **not** assigned to the currently checked-out
  branch automatically. Run **AI Effort Tracker: Import Copilot Debug Session**
  (also in the Ledger) and explicitly select the chat and branch. Repeat imports
  update the same entries; they do not rewrite existing attribution.
- Ledger drill-down shows token counts and successful, measurable tool edits,
  including `apply_patch`. Additions/removals are accumulated edit activity, not
  the final git diff. These diagnostics **do not increment editor effort again**.
  Terminal scripts, external changes, failed tools, or tools without before/after
  data cannot be treated as measured changes.

Only compact request identities, charges, token counts, file paths and edit counts
are saved in the effort store. Prompts, source content, tool arguments and results
are discarded after parsing; the system-prompt and tool-definition files are not
read. The live scanner retains metadata for at most 200 recent sessions and 5,000
turn bindings, reads at most 16 MiB per log and 64 MiB / 200 log files per session,
and skips oversized sessions with a message
in **AI Effort Tracker — Debug Usage**. It never deletes Copilot's own logs. Older
sessions remain available for explicit import; compact ledger history is retained.

Capture requires logs to exist locally in this window's workspace storage. Missing
logs are not evidence of zero usage. In remote development the Copilot logs and this
extension may be on different hosts; this feature does not scan other workspaces
or silently fall back to guessed charges.

Existing manual entries are preserved. Older automatic/imported entries are
reconciled only when request identities establish an overlap; unrelated history is
never globally deleted. Old entries without usable identities may need manual
review before importing overlapping history.

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

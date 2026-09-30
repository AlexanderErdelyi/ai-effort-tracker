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
| `aiEffortTracker.mcpServer.enabled` | `true` | Offer the read-only usage-insights MCP server to Copilot |
| `aiEffortTracker.sessions.showTitles` | `true` | Show chat titles in the Sessions tab |
| `aiEffortTracker.budget.*` | | Budget alerts, status bar, thresholds, credits per estimated hour (see [Work item budgets](#work-item-budgets)) |
| `aiEffortTracker.nudges.*` | | Live nudges and running chat cost (see [Live nudges](#live-nudges-while-you-chat)) |

## Branch changes and tracked time

Switching branches settles the pending heartbeat and closes the current focus
session on the branch being left, then checkpoints the store. Returning to a
branch continues its existing totals; it does not start them over. Manual
work-item assignments remain sticky.

Branch detection polls Git every five seconds. Polls do not overlap, and results
received after the tracker is disposed are ignored. Time attribution follows the
detected transition, so changes between polls can still have up to one polling
interval of attribution uncertainty. Sleep/stall gaps are not counted as work.

## Shared storage and recovery

VS Code windows share the extension's local `effort-tracker.json` store. Saves
take an interprocess lock, read the latest committed data, and merge only local
changes before atomically replacing the file. Automatic counters merge as deltas;
manual values and recorded credit charges are not blindly added together.
Unchanged stale data cannot overwrite another window's changes. Concurrent edits
to the same scalar field use commit order; deletion wins over a stale edit to an
existing item. Clean windows refresh shared data every two seconds for subsequent
dashboard renders.

Failed saves retain pending changes, show a warning, and retry every two seconds.
Shutdown uses the same transaction path and reports failure instead of silently
discarding pending changes. The short disk commit is synchronous; it can briefly
block the extension host. Shutdown waits up to five seconds for a competing writer.

Recovery copies live beside the main store:

- `effort-tracker.json.bak` is an atomically replaced copy of the previous main.
- Immutable history retains the first pre-save snapshot in each UTC hour/day,
  keeping up to **24 hourly and 7 daily snapshots**. These are sampled restore
  points, not a record of every edit.
- Loading does not overwrite healthy recovery copies. A damaged main can recover
  from backup/history while preserving damaged bytes. If every available copy is
  unusable, loading fails explicitly rather than silently starting an empty store.

**After upgrading, reload every VS Code window running the extension.** Older
extension hosts do not obey the new locking protocol and can still overwrite the
shared file. Since 0.22.0 every save stamps the store; when a save finds the stamp
missing (an older window replaced the whole file from its stale copy), the dropped
branches, work items, ledger rows and keys are restored, automatic counters keep the
larger value, and a warning asks you to reload all windows. Deletions made by such
an older window are not trusted. These safeguards cover cooperating processes on a local filesystem,
not network/cloud-sync storage or arbitrary external file edits. File contents are
fsynced; Windows does not support the directory fsync used on other platforms.
The fix cannot reconstruct history already overwritten before recovery copies
existed. Export important reports separately for longer-term backup.

## Translation line tracking

XLF, XLIFF, PO, POT and RESX files default to the **Translations** category.
For JSON or other localization files, use a folder rule such as
`"aiEffortTracker.categoryRules.folders": { "Translations": "translation" }`.
Explicit user category rules still take precedence.

Translation effective lines are shown separately for branches, work items and
projects, and in file-category breakdowns. They are excluded from headline
productivity effective lines, velocity, manual-equivalent time and generated
value. Actual time, credit costs and financial ROI are not removed or discounted.
These are changed-line counts, not translated words or a monetary valuation of
translation work.

Existing effective counters are reclassified when retained per-file counts
identify their category; totals and raw churn are preserved. Old aggregate-only
baselines or pruned file history cannot be reliably separated retroactively and
are not guessed. The reclassification is persisted and does not repeat on reload.

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
  rounds and restarts. When the branch changed between polls, the git reflog
  decides which branch was checked out at the turn's start; if that is unknowable
  (detached HEAD, a switch within two seconds, no reflog), the turn is parked under
  `unknown` rather than silently assigned to the wrong work item.
- Turns from the last **7 days** that are missing from the store (window reloaded
  mid-chat, crash, or data dropped by an older window) are recovered on start and
  attributed the same way via the reflog. Each recovery is logged in
  **AI Effort Tracker — Debug Usage**. A captured row you deleted in the Ledger can
  reappear this way while its log still exists.
- Older history is **not** assigned automatically. Run **AI Effort Tracker: Import Copilot Debug Session**
  (also in the Ledger) and explicitly select the chat and branch. Repeat imports
  update the same entries; they do not rewrite existing attribution.
- Ledger drill-down shows token counts and successful, measurable tool edits,
  including `apply_patch`. Additions/removals are accumulated edit activity, not
  the final git diff. These diagnostics **do not increment editor effort again**.
  Terminal scripts, external changes, failed tools, or tools without before/after
  data cannot be treated as measured changes.

Only compact request identities, charges, token counts, timing, model, agent name,
reasoning effort, file paths and edit counts are saved in the effort store. Prompts,
source content, tool arguments and results are discarded after parsing; the
system-prompt file is not read. Tool-definition files (`tools_N.json`) are reduced
to a content-free fingerprint (MCP tool names, counts and definition sizes;
descriptions and schemas are discarded), and `models.json` to per-model token
prices. The live scanner retains metadata for at most 200 recent sessions and 5,000
turn bindings, reads at most 256 MiB per log and 512 MiB / 200 log files per session.
Sessions larger than 16 MiB are re-read only after a minute without new log writes
or at most every five minutes, so long chats do not stall the editor. Oversized
sessions are skipped with one message per log state
in **AI Effort Tracker — Debug Usage**. Copilot itself may cut the start of very large
logs; calls whose user turn was cut off cannot be attributed and are reported as
warnings. It never deletes Copilot's own logs. Older
sessions remain available for explicit import; compact ledger history is retained.

Capture requires logs to exist locally in this window's workspace storage. Missing
logs are not evidence of zero usage. In remote development the Copilot logs and this
extension may be on different hosts; this feature does not scan other workspaces
or silently fall back to guessed charges.

Existing manual entries are preserved. Older automatic/imported entries are
reconciled only when request identities establish an overlap; unrelated history is
never globally deleted. Old entries without usable identities may need manual
review before importing overlapping history.

## Usage optimization insights and MCP server

The dashboard's **💡 Optimize** tab and the built-in MCP server analyse the recorded
debug-log usage to show where credits go and how to use fewer of them:

- a **model efficiency** heat map: credits per turn and per changed line for each
  model × task type (Q&A, programming, docs, spec, …), with a cheaper model
  suggested where one did the same kind of work for less;
- a **tool-set profile**: tools offered per request vs. tools used, and which MCP
  servers to keep, disable or review, with a minimal set and the tokens saved;
- credits, calls, tokens and prompt-cache hit rate by model, agent, reasoning
  effort and subagents; recent chat sessions with their context size;
- prompt-cache misses by cause — new chat/subagent (expected), **model switch**
  mid-chat, **pause over 5 minutes**, **tools changed** mid-chat, other — with
  the avoidable extra cost;
- enabled tools per source (built-in or MCP server) vs. tools actually used,
  duplicate MCP servers, `tool_search` rounds and failing tools;
- ranked findings with an estimated number of credits at stake, e.g. read-only or
  question turns that ran on a premium model, chats that grew past 100K tokens,
  mostly high reasoning effort.

Savings are **estimates**: the recorded charge is scaled by Copilot's list prices
(captured from `models.json`) for the alternative, so discounts that applied are
kept. Different models use different token counts, so model comparisons are a
starting point, not a quality judgement. Usage captured before 0.22 has no timing,
effort or tool-set details until its debug log is re-read (automatic on restart
while the log still exists).

### Ask an AI (MCP)

The extension registers the read-only MCP server **AI Effort Tracker usage insights**
(VS Code 1.101+). In Copilot agent mode, enable it in the tool picker and ask, e.g.
*"Use the AI Effort Tracker usage insights to tell me how I can use fewer credits"*
or *"Analyse my usage for work item 1987"*. Tools:

| Tool | Returns |
|------|---------|
| `usage_overview` | Totals by model/agent/effort, cache misses by cause, tool sources |
| `optimization_findings` | Ranked recommendations with evidence and credits at stake |
| `list_work_items` | Credits per work item plus budget status (used %, projection, warning/over), to choose a scope |
| `list_sessions` | Recent chat sessions with models, context size, avoidable cache misses; `includeTitles` adds chat titles |
| `session_detail` | Per-turn breakdown of one chat; `includePrompts` adds short prompt excerpts |
| `model_efficiency` | Credits per turn and per changed line for each model × task type, with cheaper-model recommendations |
| `tool_profile` | Enabled tool sources vs. tools actually used; which MCP servers to keep, disable or review, and the tokens it would save |
| `suggest_estimate` | Hours and credits for a new work item from similar finished ones, corrected by your estimation bias |
| `estimate_accuracy` | Estimated vs. actual hours of finished work items, bias by category and over time |
| `data_health` | The data health report (see below) |
| `review_status` | Code review coverage per work item and branch, files left and open review issues |
| `review_issues` | Open review issues read live from disk: file, current lines, your note and the flagged code, so Copilot can fix them |

All tools accept `days`, `from`, `to`, `branch`, `workItemId`, `projectId` and
`sessionId` filters. The server only reads the tracker's store. Prompt excerpts
(`includePrompts`, 50–1000 characters) are read on demand from Copilot's own local
debug logs while they exist; they are returned to the asking model and are never
stored by the tracker. Disable the server with `aiEffortTracker.mcpServer.enabled`.

## Chat sessions

The dashboard's **💬 Sessions** tab lists recorded chats with their title, work
item, branch, models, turns, credits, context size and avoidable cache misses.
Filter by period, work item, branch, model, minimum credits or low-output chats,
sort any column, expand a chat for its per-turn breakdown, or export the list as
CSV. Titles are read on demand from VS Code's
local chat history (renamed titles win); they are never copied into the store.
Turn them off with `aiEffortTracker.sessions.showTitles`.

## Work item budgets

Each work item gets a budget from its estimate: **hours** (estimate in hours),
**credits** (explicit, or estimated hours × `aiEffortTracker.budget.creditsPerEstimatedHour`
or the project's value from **Set Project Rates**) and **cost** (explicit, or
estimated hours × hourly cost). Set explicit values with **AI Effort Tracker: Set
Work Item Budget** or the **💰 Set Budget** button on the work item's budget card.

- The work item detail shows used %, a linear end-of-work projection, and a
  burn-down chart of hours and credits against the budget lines, plus the split
  by category and branch.
- Project work item lists get a budget column and are sorted by risk.
- A status bar item shows the current branch's work item (e.g. `WI 1761: 64% · 3.2h left`),
  turning yellow at the warning threshold and red when over.
- A notification appears once per threshold (`aiEffortTracker.budget.thresholds`,
  default 80 % and 100 %) for work items active in the last 7 days, with
  **Open work item** and **Adjust estimate**. Disable with `aiEffortTracker.budget.alerts`
  or hide the status bar item with `aiEffortTracker.budget.showStatusBar`.
- The MCP tool `list_work_items` includes the budget status of each work item.

## Live nudges while you chat

While a chat runs, the status bar shows its running cost (e.g. `chat 312 cr · 9.4/call`;
hover for turns, context size, cache hit rate and model; click for the Sessions tab).
After each recorded turn the tracker checks the new calls and may show one short
tip with the credits at stake:

| Nudge | When | Repeats |
|-------|------|---------|
| Model switch | Switching models mid-chat re-sent a large context uncached | Per chat after `nudges.cooldownMinutes` (30) |
| Expired cache | A pause over 5 minutes made a large context billed again | Once per chat |
| Context growth | The main chat's context passed `nudges.contextTokens` (150K) | Each time it doubles |
| Light turns on a premium model | `nudges.lightTurnCount` (3) read-only/Q&A turns on a model at least twice as expensive as an available one | Once per chat |
| Too many tools | `nudges.toolCount` (100) tools offered per request, or `tool_search` rounds | Once a day |

Any two nudges are at least 10 minutes apart and cache nudges ignore breaks that
wasted under 2 credits. Each notification offers **Don't show again for this chat**,
**Mute this nudge** and **Open Optimize** (the context-growth nudge offers
**New chat with handoff** instead of Open Optimize); **AI Effort Tracker: Reset Nudge Mutes**
undoes the mutes. Nudges use only recorded token and credit metadata, never prompt
content, and never fire for history imported from older logs. Turn them off with
`aiEffortTracker.nudges.enabled`, per type with `aiEffortTracker.nudges.modelSwitch`,
`idleCache`, `contextGrowth`, `lightTurns` and `toolBloat`, and hide the running
cost with `aiEffortTracker.nudges.showLiveChatCost`.

## Chat handoff

When a chat gets large, **AI Effort Tracker: New Chat with Handoff** (also on the
context-growth nudge and on each chat in the Sessions tab) opens a new chat with a
summary pre-filled but not sent: work item, branch, files changed in the chat,
recent commits, the chat title and its first and last prompt. Finish the last line
and send it. The prompt is also copied to the clipboard. Prompt excerpts are read
from Copilot's local debug log on demand and never stored; leave them out with
`aiEffortTracker.handoff.includePrompts`.

## Estimates

The **📐 Estimates** tab compares estimated and actual hours of finished work items
(mark them with **Mark Work Item Done**): your bias overall, per category and over
time. For open work items it suggests hours and credits from similar finished
items (title words, project) and shows your estimate corrected by your bias. New
work items get the suggestion as the default estimate.

## Model efficiency and tool profiles

See the Optimize tab above: it answers "which model is cheapest for this kind of
task" from your own history and "which tools can I switch off". Both are also
available to Copilot through the MCP tools `model_efficiency` and `tool_profile`.

## Timesheet

The **🗓 Timesheet** tab shows one week of active hours per work item and day
(tracked time plus manual entries, the same numbers as the work item totals), with
day and week totals and a row for branches without a work item. Click a cell to
add time for that work item and day; entries appear in the work item's time log.
Round to exact, ¼ or ½ hours (default `aiEffortTracker.timesheet.rounding`) and
export the week as CSV (work item, external ref, title, day, hours).

## Away detection

When you come back to VS Code after being away (idle, another app, a meeting,
sleep) for at least `aiEffortTracker.away.minMinutes` (15) and at most
`away.maxMinutes` (240), the tracker asks how to count the time: **Meeting**,
**Review / thinking**, **Other work…** (pick a work item and category) or
**Don't count**. The answer is logged as a time entry on the current branch's work
item. Time during which another VS Code window was active is not asked about
(windows share a small activity file). Turn the prompt off with
`aiEffortTracker.away.prompt`.

## Data health

**AI Effort Tracker: Check Data Health** and the **🩺 Health** tab check the store
for problems and show a score: save errors, missing backups, schema, store size,
invalid numbers, duplicate ledger rows, orphaned references, branches and credits
without a work item, stale credit attribution, work items without a project or
estimate, projects without rates, unpriced requests and models without prices,
future timestamps and implausible days. Most findings have a one-click fix or a
button that opens the right command. Copilot can read the report through the MCP
tool `data_health`.

## Code review tracking

When you accept AI code and commit it to test first, you can review it later and
mark what you checked. Changed lines are the lines that differ from the branch's
merge-base with `origin/HEAD` (or `main`/`master`), plus untracked files and unsaved
edits.

- **In the editor:** unreviewed changed lines get an amber gutter mark, reviewed
  lines a green one, flagged lines a red one with your note on hover. CodeLens above
  each unreviewed block offers **✓ Mark reviewed** and **⚑ Flag issue**; the file
  header shows progress and **Mark file reviewed** (with Undo). The editor context
  menu has the same actions for a selection, plus **Clear review mark**.
- **Next unreviewed** jumps to the next open block across the branch's changed files.
- **AI Effort: Review** (Explorer) lists open issues, files with review left and a
  collapsed list of fully reviewed files. The status bar shows `Review NN%` and the
  open issue count.
- **Set Review Baseline** compares against another ref for this branch (e.g. a
  release tag or the commit you last reviewed).
- The work item detail shows a 🔍 Code review card with coverage over all its
  branches, files left and open issues. A file changed on several branches counts
  once. The health check warns when a work item marked done is not fully reviewed,
  and Copilot can read coverage through the MCP tool `review_status`.

### Let Copilot fix flagged issues

Flag what is wrong with **⚑ Flag issue** and write what needs to change in the note.
Then either ask Copilot in agent mode ("fix my review issues") or click **✨ Fix with
Copilot** (CodeLens on an issue, the issue's actions, the Issues group in the Review
view, or the command **Review: Fix Review Issues with Copilot**). That opens a new chat
with a prompt listing the issues with their code; pick Agent mode and send it.
Copilot reads the issues through the MCP tool `review_issues`: file, current line
numbers (read live from disk, so they are right even after edits), your note and a
numbered code excerpt, optionally filtered by `workItemId`, `branch` or `path`.
Issues that only exist on another branch are listed separately with a hint to check
that branch out. When Copilot changes a flagged line the flag clears by itself and the
new code shows up as "to review", so you check the fix like any other change.
Marks are anchored to the line's content and its neighbours, not to line numbers,
so they survive edits elsewhere, rebases and branch switches, and a moved block
keeps its marks. Editing a reviewed line makes it (and its direct neighbours)
unreviewed again. Marks are stored per repository in `review-marks.json` next to the
tracker's store, with the same locking, `.bak` and history as the main store, so
several windows can review at once.

Settings: `aiEffortTracker.review.enabled`, `review.showDecorations`,
`review.codeLens`, `review.showStatusBar`, `review.exclude` (globs, default lock
files, build output, minified files, source maps and generated `*.g.xlf`) and `review.baseRef` (default baseline for
all branches).

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

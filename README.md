# AI Effort Tracker

[![CI](https://github.com/AlexanderErdelyi/ai-effort-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexanderErdelyi/ai-effort-tracker/actions/workflows/ci.yml)

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
| Work item linkage | Branch name pattern (`feature/1234-...`, `#1234-...`, `AB#1234_...`). New items take their title from the branch (shown as "from branch") until you rename them (✎ or *Rename Work Item*) |

## Usage

1. Install the extension in VS Code. On a fresh install the **Get Started** walkthrough opens (see [Setup wizard](#setup-wizard))
2. It auto-starts tracking on launch
3. Click the status bar item (`⌨️ Coding`) or run **AI Effort Tracker: Show Session Summary**
4. At end of a feature branch, export the report via **AI Effort Tracker: Export Report (JSON)**

## Commands

| Command | Description |
|---------|-------------|
| `AI Effort Tracker: Show Session Summary` | Open webview summary for current branch |
| `AI Effort Tracker: Run Setup` | Guided setup: profile, rates, Copilot plan, category rules, project and token (see [Setup wizard](#setup-wizard)) |
| `AI Effort Tracker: Start Tracking Session` | Manually start tracking |
| `AI Effort Tracker: Stop Tracking Session` | Pause tracking |
| `AI Effort Tracker: Export Report (JSON)` | Export branch report as JSON |
| `AI Effort Tracker: Export Full Backup…` | Save all data and settings to one file (see [Your data](#your-data-backups-restore-and-moving-to-another-machine)) |
| `AI Effort Tracker: Restore Data from Backup…` | Restore from a backup file or an automatic checkpoint, with a safety copy first |
| `AI Effort Tracker: Reveal Data Folder` | Open the folder where the data is stored |
| `AI Effort Tracker: Show Captured Corrections` | Newest corrections of AI-written code (see below) |
| `AI Effort Tracker: Label Corrections` | Opens the dashboard's Corrections tab to label what each correction teaches |
| `AI Effort Tracker: Export Lessons to Copilot` | Writes the approved rules as Copilot instructions files (see [Rules for Copilot](#rules-for-copilot)) |

## Configuration

Every setting can be changed in the dashboard's **⚙ Settings** tab (see [Settings tab](#settings-tab)) or in the VS Code Settings editor. The most used ones:

| Setting | Default | Description |
|---------|---------|-------------|
| `aiEffortTracker.idleThresholdSeconds` | `120` | Seconds before switching to idle |
| `aiEffortTracker.reviewThresholdSeconds` | `10` | Seconds of no-keystroke before switching to review |
| `aiEffortTracker.azureDevOpsOrg` | `""` | AzDO org URL for work item lookup |
| `aiEffortTracker.githubToken` | `""` | Legacy plain-text GitHub PAT. Prefer **⚙ Settings → Integrations → Set token**, which keeps it in VS Code secure storage |
| `aiEffortTracker.mcpServer.enabled` | `true` | Offer the usage-insights MCP server to Copilot (read-only except review marks, correction labels and rule proposals) |
| `aiEffortTracker.sessions.showTitles` | `true` | Show chat titles in the Sessions tab |
| `aiEffortTracker.budget.*` | | Budget alerts, status bar, thresholds, credits per estimated hour (see [Work item budgets](#work-item-budgets)) |
| `aiEffortTracker.nudges.*` | | Live nudges and running chat cost (see [Live nudges](#live-nudges-while-you-chat)) |
| `aiEffortTracker.credits.monthlyBudget` | `0` | Monthly Copilot credit budget for the Overview pace card (0 = off) |
| `aiEffortTracker.credits.renewalDay` | `1` | Day of the month the credit budget period renews (1–31) |
| `aiEffortTracker.lessons.*` | | Thresholds for repeated lessons, export folder and review skill (see [Rules for Copilot](#rules-for-copilot)) |

## Setup wizard

Run **AI Effort Tracker: Run Setup** (or **🧭 Run setup** on the dashboard's Settings tab). A list of steps opens; pick one, finish it, and you come back to the list. Every step can be skipped and run again later, and the list shows which ones are done.

| Step | What it does |
|------|--------------|
| Restore from a backup *(optional)* | For a new machine: restores a backup file |
| Developer profile | Junior, mid or senior preset for lines per minute, which you can override |
| Currency and hourly rates | Currency, hourly cost and hourly sell rate (projects can override them) |
| Copilot plan and credit budget | Your plan pre-fills the monthly AI credit budget and the cost per credit (plan price ÷ credits, e.g. Pro $10 ÷ 1,000 = $0.01). Also asks for the renewal day |
| Category rules | Scans the workspace and proposes rules for file types counted as *Other* and for folders such as `docs/`, `specs/`, `infra/`, `translations/` |
| Project and repository | Creates a project (or picks one) and links the open repository |
| GitHub token *(optional)* | Stores a token in VS Code secure storage |

The same steps make up the **Get Started → Set up AI Effort Tracker** walkthrough. It opens once on a fresh install, and its check marks follow your settings. Open it again with **Help → Welcome** or the wizard's *Open the Get Started walkthrough* entry. The wizard never deletes data; it only writes settings, creates projects and links repos.

## Settings tab

The **⚙ Settings** tab in the dashboard shows every setting, grouped as Profile & baselines, Rates & ROI, Credits & budget, Categories, Tracking, Nudges, Review, Corrections & rules and Integrations. Search across all of them or pick a group.

- **Proper editors.** Numbers show their unit (lines/min, minutes, your currency per hour). Choices are dropdowns, and the currency field suggests common ISO codes. Category rules, per-category baselines and keyword rules are editable tables. Lists such as budget thresholds take one entry per line.
- **Validation.** A value is checked before it is saved. If it is out of range, a duplicate row, an invalid regular expression, malformed JSON or a wrong `owner/repo` format, it is rejected with a message next to the field. Numbers accept a decimal comma.
- **Live.** Changes go to your *user* settings and apply right away. Picking a seniority level also fills in its default baseline, which you can still change.
- **Reset and overrides.** Changed values have a *modified* badge and a ↺ Reset button that restores the default. If this workspace's `.vscode/settings.json` overrides a value, the tab shows the value that wins and a *Remove override* button.
- **Secure GitHub token.** *Set token* asks for the token in a password box and keeps it in VS Code secure storage (SecretStorage), never in `settings.json`. The tab only shows where the token comes from, never its value. A token already in the plain-text setting can be moved with *Move to secure storage*. Without a token, your VS Code GitHub sign-in is used.
- Legacy estimator settings are grouped under *Advanced / legacy* in each group.

## Overview dashboard

The Overview tab opens with a credit summary:

- KPI cards for today, the last 7 days, the current billing period and the
  average per active day, each compared with the previous period.
- A monthly budget card with a progress bar, the projected end-of-period
  spend and the date it will run out at the current pace. Set it with
  **AI Effort Tracker: Set Monthly Credit Budget** (budget and renewal day).
- A daily spend chart, stacked by model with a cumulative line (and the budget
  line in the "This period" view), for the range picked in the filter bar.
- Insights: budget pace, spend spikes, credits not linked to a work item,
  one dominant model, and big week-on-week changes.
- "Where the credits went": model, work item, weekday and source breakdowns
  for the filter range. Click a work item to open it in Projects.

Activity, branches, hotspots and keystrokes sit in collapsible sections below;
which sections are open is remembered.

### Filter everything at once

A filter bar above the tabs sets one date range (7, 30 or 90 days, this
billing period, all time, or custom dates), one project (or "No project") and
one work item. Every tab reads the same filter, so switching tabs keeps your
selection, and it survives reloads. Chips show what is active; **Clear** goes
back to 30 days, all projects.

Some tabs use only part of it, and a short note on the bar says so:

- Overview: the KPI cards keep their fixed windows (today, 7 days, period) and
  branch totals are all-time, but both follow the project and work item. The
  budget always covers all projects.
- Trends is not split by project; only the date range applies.
- Estimates ignore the date range; accuracy uses every finished work item.
- Timesheet keeps its week buttons and only applies the project and work item.
- Correction episodes without a work item count as "No project".

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
existed.

## Your data: backups, restore and moving to another machine

Everything is stored locally in the extension's global storage folder
(**AI Effort Tracker: Reveal Data Folder** opens it). On Windows that is
`%APPDATA%\Code\User\globalStorage\alexandererdelyi.ai-effort-tracker\`:

| File | Content |
|------|---------|
| `effort-tracker.json` | Time, lines, credits, work items, projects, estimates, manual entries |
| `corrections.json` | Captured corrections of AI code and their labels |
| `review-marks.json` | Code review marks (approved / issue / fixed) |
| `lessons.json` | Rules for Copilot |

Each of these keeps automatic checkpoints next to it (`.bak` = previous save,
`.history/` = hourly and daily snapshots, see above). Other `*-snapshot.json`
files are derived caches and are rebuilt automatically.

- **AI Effort Tracker: Export Full Backup…** writes one JSON file with all four
  data sets plus your user-level `aiEffortTracker.*` settings (rates, profile,
  category rules…). The GitHub token is **never** included. Keep it somewhere
  safe, e.g. OneDrive, before reinstalling or switching machines.
- **AI Effort Tracker: Restore Data from Backup…** restores from such a file, from
  a plain `effort-tracker.json` copied from another machine, or from any automatic
  checkpoint listed in the picker. It validates the file, lets you pick which data
  sets (and whether settings) to restore, and shows *Backup vs. Current* totals
  before anything changes.
- Before every restore a **safety copy** of all current data is written to
  `backups/pre-restore-<time>.json` (the newest 10 are kept). These appear at the
  top of the restore picker, so a restore can always be undone.
- A restore **replaces** the chosen data sets; it does not merge them. Other open
  VS Code windows pick up the restored data within two seconds; changes they had
  not saved yet are added on top.

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

The extension registers the MCP server **AI Effort Tracker usage insights**
(VS Code 1.101+). In Copilot agent mode, enable it in the tool picker and ask, e.g.
*"Use the AI Effort Tracker usage insights to tell me how I can use fewer credits"*
or *"Analyse my usage for work item 1987"*. All tools are read-only except
`review_mark` and `review_resolve_issue`, which only write review marks. Tools:

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
| `review_mark` | Marks changed code reviewed, removes marks or flags lines, by path, glob or category, only when you ask (writes review marks only) |
| `review_resolve_issue` | Reports a flagged issue as fixed by Copilot (with a note of what changed) so it waits in **Fixed — to verify**; can reopen it, or remove the flag when you ask |
| `list_corrections` | Captured corrections of AI-written code (see below): what you or prompted Copilot rework changed, with snippets and prompts, to learn rules from (filter `category`, `none` = unlabeled) |
| `label_correction` | Labels corrections (by `ids` or a whole `episodeId`) with a category, an optional `scope` glob and a `note`, only when you ask; an empty category removes the label (writes corrections only) |
| `get_lessons` | Approved rules learned from corrections, filtered by `path` (rules whose scope matches the file) and `repo`; `includeProposed`, and `includeCandidates` for repeated lessons without a rule |
| `propose_rule` | Proposes a rule (`category`, `scope`, `text`, optional `correctionIds`, `repo`) that waits for your approval in the Rules view (writes lessons only) |
| `correction_rate` | Correction rate of AI code per week, category, work item and project, and each approved rule's effect; optional `weeks`, `trendWeeks`, `workItemId`, `projectId` (see [Correction rate](#correction-rate-is-copilot-getting-better)) |

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
- Hover any KPI card or budget row marked ⓘ (work item and branch detail) to see
  what the value means and how it was calculated from your own numbers and rates
  (e.g. `Budget = 6h × €44.00/h = €264.00`).
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

## Year at a glance

The **Trends** tab starts with a calendar of the last 12 months, one square per
day. Switch the colour between active time, AI credits and lines; the four
shades are quartiles of your own active days, so a quiet week still stands out.
Click a day to see its time by mode (coding, AI generating, reviewing, logged
manually), credits with their dollar value, lines you wrote versus AI lines per
category (Code, Docs, Specs, …), and every branch and work item you touched, with
links to their details. Step to the previous or next active day from there.
Per-category lines are recorded from version 0.36.0 on; older days show totals only.

## How sure is each number?

Totals mix figures captured in different ways, so key numbers carry a small
marker. Hover it to see the split behind the number.

| Marker | Meaning |
| --- | --- |
| ● Exact | Measured: tracked time, lines counted edit by edit, or the real per-request credit charge. |
| ◐ Mixed | Part measured, part estimated or entered by hand. |
| ○ Estimated | Estimated: credits from token counts, credits from a debug log with unpriced calls (a lower bound), or lines inferred from history recorded before line-level tracking. |
| ✎ Manual | Entered or corrected by hand: manual credits, manual effort, time log entries and time corrections. |

A number is Exact, Estimated or Manual when at least 98% of it is that kind;
otherwise it is Mixed. ROI, invoice value and profit inherit the markers of the
time and credits they are computed from. Moving a branch to another work item
does not change the marker, but the tooltip notes the move because the branch's
tracked time moves with it. Markers appear on the Overview (credits and the
activity totals), on project and work item details, and on every Credit Ledger row.

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
  lines a green ✓ and a light green background, flagged lines a red one with your
  note on hover. Hover the first line of a reviewed block for **Remove mark** or
  **Flag issue**. To keep only the ✓, use **Toggle Green Background on Reviewed
  Lines** in the Review view's `…` menu (`aiEffortTracker.review.highlightReviewedLines`;
  the color is the theme color `aiEffortTracker.review.reviewedLineBackground`). CodeLens above
  each unreviewed block offers **✓ Mark reviewed** and **⚑ Flag issue**; the file
  header shows progress and **Mark file reviewed** (with Undo). The editor context
  menu has the same actions for a selection, plus **Clear review mark**.
- **Next unreviewed** jumps to the next open block across the branch's changed files.
- **AI Effort: Review** (Explorer) lists open issues, fixes to verify, then **To
  review** and **Reviewed**. Expand a file to see its blocks, named after the enclosing
  procedure, trigger, field, object or Markdown heading (e.g. `procedure SyncJob ·
  lines 12–18`); click one to select those lines in the editor. Tick the checkbox of a
  block, file or group to mark it reviewed, untick it in **Reviewed** to remove the
  marks; the same actions are inline (✓ / ✕) and in the right-click menu. Actions on
  several files ask first, file and group actions offer Undo. Files are grouped by effort category (your
  `aiEffortTracker.categoryRules`), then by folder with single-folder chains compacted;
  switch to a plain folder tree or a flat list with the **Group Files By…** button
  (`aiEffortTracker.review.groupBy`). The status bar shows `Review NN%` and the
  open issue count.
- **Set Review Baseline** compares against another ref for this branch (e.g. a
  release tag or the commit you last reviewed).
- The work item detail shows a 🔍 Code review card with coverage over all its
  branches, files left and open issues. A file changed on several branches counts
  once. The health check warns when a work item marked done is not fully reviewed,
  and Copilot can read coverage through the MCP tool `review_status`.
- **Ask Copilot to mark code:** "mark the specs as reviewed", "mark NOBJQMSyncMgt
  reviewed", "remove my review marks from the page files". The MCP tool `review_mark`
  selects files by path, folder, name fragment, glob (`app/specs/**`, `*.Table.al`)
  or effort category and marks only the changed lines still to review (`clear`
  removes reviewed marks and keeps flagged issues). With a line range it marks or
  flags exact lines. It works on the files checked out now, can do a dry run, and is
  the only MCP tool that writes: its description tells Copilot to use it only when
  you ask. VS Code shows the new marks within a second.

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
that branch out. When Copilot changes a flagged line the flag clears from that line and
the new code shows up as "to review", so you check the fix like any other change.

After fixing an issue Copilot calls the MCP tool `review_resolve_issue` with a note of
what it changed. The issue then moves from **Issues** to **Fixed — to verify** in the
Review view (✨ fixed by Copilot, with its note on hover), and a CodeLens on the code
shows it too. Issues whose flagged lines were all edited or deleted appear there as
well ("flagged lines changed"), but only on the branch they were flagged on. Click one
to jump to the code, then **✓ Accept fix** (removes the flag, with Undo) or **↺
Reopen**. You can also move an issue there yourself with **Fixed — verify later** in
its actions or the right-click menu.

Fixes waiting for verification get a **purple background** in the editor, like the
red one of open issues. Copilot passes the `startLine`/`endLine` of the code it
changed to `review_resolve_issue`, so the new code is highlighted, along with any
flagged lines that are still there. The highlight follows the code when lines
shift. Hover a purple line to see the issue and fix notes, with **✓ Accept fix** and
**↺ Reopen**; both remove the purple. Clicking a fixed issue in the Review view jumps
to the first purple line. The color is the theme color
`aiEffortTracker.review.fixedLineBackground`. Like the red issue background, it is
always shown while review decorations are on (`aiEffortTracker.review.showDecorations`).
Marks are anchored to the line's content and its neighbours, not to line numbers,
so they survive edits elsewhere, rebases and branch switches, and a moved block
keeps its marks. Editing a reviewed line makes it (and its direct neighbours)
unreviewed again. Marks are stored per repository in `review-marks.json` next to the
tracker's store, with the same locking, `.bak` and history as the main store, so
several windows can review at once.

Settings: `aiEffortTracker.review.enabled`, `review.showDecorations`,
`review.highlightReviewedLines`, `review.codeLens`, `review.showStatusBar`, `review.groupBy`, `review.exclude` (globs, default lock
files, build output, minified files, source maps and generated `*.g.xlf`) and `review.baseRef` (default baseline for
all branches).

## Capturing corrections of AI code

The tracker learns how AI-written code gets corrected, the first step toward rules
Copilot can follow on its own. Every line an AI edit adds (chat, agent or inline
completion) is remembered as AI-written for 90 days. When that code changes later,
the change is saved as a **correction** once the file has been quiet for 10 seconds,
saved or closed:

- **modify** or **delete**: AI-written lines were replaced or removed;
- **insert**: lines were added between AI-written lines (e.g. documentation or a
  missing check);
- **move**: an AI-written block was moved, e.g. to reorder procedures.

Each correction records the file, line, the enclosing declaration, the branch and
work item, a short before/after snippet and, from Copilot's debug logs, the prompt
that produced the original code. A correction is either **yours** (typing, pasting,
undo) or **AI rework**. AI rework is only kept when you sent a new prompt between the
original code and the change (that prompt is stored as the trigger). Without a new
prompt, Copilot was fixing its own code within the same request. Whitespace-only
changes are ignored.

Run **AI Effort Tracker: Show Captured Corrections** to see them: your own changes
first, with before/after snippets, then AI rework grouped by the prompt that caused it.
One prompt that changes a requirement can rework dozens of lines, so it is listed
once with all the lines it touched. You can also ask
Copilot with the MCP tool `list_corrections` (filters: `workItemId`, `branch`,
`path`, `repo`, `source`, `kind`, `days`, `limit`); it returns the same grouping as
`episodes`. Corrections are kept in
`corrections.json` next to the tracker's store, with the same locking, `.bak` and
history copies. Nothing leaves your machine. Turn off
`aiEffortTracker.corrections.captureCode` to keep only metadata (no code snippets
or prompt text), or `aiEffortTracker.corrections.enabled` to stop capturing.
Files matching `aiEffortTracker.review.exclude` are skipped.

### Labelling corrections

A correction becomes a lesson once it says *what kind of* mistake it fixed. Run
**AI Effort Tracker: Label Corrections** (or open the dashboard's **🧠 Corrections**
tab). It lists the episodes (your changes first, then AI rework by prompt) with the
before/after code; filter **To label**, **Lessons** or **All**, and **Yours** or
**AI rework**. Pick a category per line or for the whole episode, and adjust the
**scope**, a glob saying where the lesson applies (suggested from the file: `**/*.Codeunit.al`
for AL objects, otherwise `**/*.<ext>`). Notes and labels show up in the
**Show Captured Corrections** report too.

The tracker suggests a label you can accept per line, per episode or all at once.
In this order:

1. **Your earlier labels**: a correction like ones you (or Copilot) already labelled
   gets the same category, scope and note ("Like 3 corrections labelled “progress
   update” in `**/*.md`"). AI rework is compared by its prompt, your own changes by
   the file and the words that changed. Labels from **Accept all** do not count.
2. AI rework: the first keyword rule matching the prompt (e.g. "wrong", "doesn't work"
   → *logic bug*, "status" → *progress update*).
3. What changed: moved code (also cut and pasted within 30 minutes) is
   *ordering/structure*, spacing, letter case, quotes or semicolons only is *style*,
   changed numbers are *wrong fact*, comments only is *documentation*. For your own
   changes also: the same lines in another order is *ordering/structure*, one
   identifier renamed is *naming*, a test file is *tests*, an added error or guard is
   *error handling* and an edit of a Markdown or text file is *documentation*.
4. AI rework otherwise: *requirement change*.

**Suggestion accuracy** under the category table shows how often the suggestion
was the label you picked, per source, and the keyword rules you usually change
(with the category you pick instead), so you know which rules to edit. Corrections
labelled with **Accept all** and not reviewed since are not counted.

Lesson categories are `aiEffortTracker.corrections.categories` (wrong fact, logic bug,
style, naming, documentation, ordering/structure, error handling, tests and performance
by default). *requirement change*, *progress update* and *not a lesson* are always
available for corrections that do not teach a rule; they are kept but do not count as lessons. The keyword rules are
`aiEffortTracker.corrections.keywordRules` (`{ "pattern": regex, "category": name }`,
case-insensitive, first match wins). Copilot can label too with the MCP tool
`label_correction`, e.g. "label the corrections of the last episode as naming";
`list_corrections` gives it the suggestion for each unlabelled correction.

Add a **note** per line (or **Note for all** in an open episode) saying *why* the code
was corrected, written as a rule: "Read field numbers from the table; never renumber a
field". Notes become the draft text of rules.

### Rules for Copilot

The **📏 Rules** filter of the Corrections tab turns repeated lessons into rules Copilot
follows:

1. **Repeated lessons without a rule**: lesson-labelled corrections grouped by category
   and scope. A group is *repeated* when it has at least
   `aiEffortTracker.lessons.minOccurrences` episodes (3) on
   `aiEffortTracker.lessons.minWorkItems` work items or branches (2); one prompt that
   reworks 30 lines counts once. Click **＋** next to a note to create a rule with that
   text, or **＋ Rule** to write your own. **Other lessons** lists the groups that are
   not repeated yet.
2. **Proposed rules**: edit the text, category and scope, then **Approve** or **Reject**.
   **＋ New rule** adds one from scratch. Copilot can propose rules with the MCP tool
   `propose_rule`; they wait here for your approval.
3. **Approved rules**: **Retire** a rule that no longer applies. Each rule keeps its
   example corrections.

**⇪ Export to Copilot** (or **AI Effort Tracker: Export Lessons to Copilot**) writes
the approved rules as one `aet-lessons-<scope>.instructions.md` per scope into
`.github/instructions` of each workspace folder (`applyTo` = the scope), so Copilot
follows them for matching files. Rules limited to a repository only go to that folder.
`aiEffortTracker.lessons.exportFolder` changes the folder (relative to each workspace
folder, or absolute for one shared folder). Generated files carry an
`aet-lessons:generated` line; files of scopes without rules are removed, and a file
without that line (your own edit) is never overwritten or removed.

The export also writes the agent skill **lessons-review** (`aiEffortTracker.lessons.reviewSkill`:
`personal` = `~/.copilot/skills`, `workspace` = `.github/skills`, or `off`). Ask
Copilot to "review my changes against the lessons": it reads the rules for each changed
file with `get_lessons` and reports violations (and flags them as review issues if you ask).

### Correction rate: is Copilot getting better?

The **📈 Rate** filter of the Corrections tab shows the correction rate: AI-written
lines that you or a rework prompt changed later, per 100 AI lines written. Lower is
better. Requirement changes, progress updates and "not a lesson" do not count;
unlabelled corrections do. AI lines leave out translation files, like the productivity
metrics, and include short lines that corrections do not follow, so the rate is a lower
bound.

- KPIs for the last 4 weeks, the 4 weeks before, everything since capture started, and
  the rework time.
- Per week: AI lines, corrected lines, rate, your own corrections, episodes, rework
  time and top categories.
- Per category with a trend (up, down, flat, new, gone) between the last 4 weeks and
  the 4 weeks before.
- Rules before vs after approval: the rate of corrections in each rule's category and
  scope since approval vs the same span before. Wait at least a week before judging, and
  label the corrections in its scope to keep the comparison fair. The same line is shown
  under each approved rule.
- Per work item and per project.

Rework time is estimated per correction episode: from the rework prompt (or first edit)
to the last edit, 1 to 30 minutes. The work item ROI shows it as **Rework** with its
cost (hours × the project's cost rate, or the sell rate). The Overview has a collapsible
**🔁 Corrections of AI code** section with the same summary. Copilot can read the
report through the MCP tool `correction_rate`.

## Development

```bash
npm install
npm run watch
# Press F5 in VS Code to launch Extension Development Host
```

Checks (the same ones CI runs on Ubuntu and Windows for every push and pull request):

```bash
npm run compile
npm run lint
npm test              # compiles, then runs every tests/*.test.cjs
npm test -- backup    # only test files whose name contains "backup"
```

CI also packages the extension and keeps the `.vsix` as a build artifact for 14 days.

Dashboard styling (`src/ui/dashboard.ts`) uses a small design system so every tab looks the same in light, dark and high-contrast themes:

- **Tokens** in `:root`: `--muted`, `--border`, `--surface`, `--good`/`--warn`/`--bad`/`--info`, spacing `--sp1..5`, radii `--r-sm/--r/--r-lg` and font sizes `--fs-xs..lg`. They map onto VS Code theme variables, so prefer them over raw `--vscode-*` names.
- **Classes** instead of inline styles: `muted`, `t-sm`, `mt2`, `hbar`, `c-ai`/`c-human`/`c-cost`, buttons `dtab` (`btn-sm`, `primary`) and badges `b-good`/`b-warn`/`b-bad`/`b-info`/`b-muted`.
- **States**: `emptyState(title, hint)` and `loadingState(label)` in the webview script, and `<tr class="empty-row">` for empty tables. Columns where every cell is a number are right-aligned automatically.

## Roadmap

- [ ] Azure DevOps work item API integration (fetch title, story points)
- [ ] GitHub Issues integration
- [ ] Dashboard webview with charts across all branches
- [ ] Accurate Copilot token usage via GitHub Copilot Metrics API
- [ ] Team aggregation / export to CSV

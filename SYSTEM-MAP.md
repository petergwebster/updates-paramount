# SYSTEM MAP

Generated 2026-08-02 14:07 by system-map.ps1. Do not edit by hand.

Read this BEFORE proposing any new intake, parser, table, upload path or data
source. If the thing you are about to build appears below, it already exists.

## Inbound feeds (Netlify functions)

### audit-digest.js

- schedule: cron 30 10 * * *  (schedule() wrapper)
- touches tables: audit_runs, integration_state, sched_snapshots

### audit-nightly.js

- schedule: cron 0 5 * * *  (schedule() wrapper)
- touches tables: audit_exceptions, audit_findings, audit_runs, deck_kpis, financial_transactions, integration_state, order_ledger, people_weekly, sched_snapshots, vena_monthly

### audit-run.js

- schedule: not scheduled

### digest-run.js

- schedule: not scheduled

### lift-wip-run.js

- schedule: not scheduled

### lift-wip-sync.js

- schedule: cron @hourly  (schedule() wrapper)

### lock-wip.js

- schedule: not scheduled

### sharefile-cron.js

- schedule: cron 0 13 * * *  (schedule() wrapper)

### sharefile-run.js

- schedule: not scheduled

### sharefile-sync.js

- schedule: cron 0 13 * * *  (in-code config export)
- source paths: JEN_PATH = ['DASH WORK', 'Claude Files', 'Purchases'] ; CLAUDE_PATH = ['DASH WORK', 'Claude Files'] ; VENA_PATH = ['Parmount Monthly Results'] ; INV_PATH = ['Inventory Reports'] ; PAYROLL_PATH = ['DASH WORK', 'Claude Files', 'Payroll'] ; DECKS_PATH = ['Paramount Month End Decks']
- parsers: arApLock, inventoryWorkbook, payrollWorkbook, purchasesWorkbook, venaWorkbook
- touches tables: financial_aging, financial_transactions, integration_state, inventory_snapshot, month_end_decks, people_weekly, vena_monthly

### slack-queue-notify.js

- schedule: not scheduled

## Libraries in src/lib, and what imports them

- access.js  <-  AdminLayout.jsx, App.jsx, DestinationNav.jsx, LandingPage.jsx, UserManagement.jsx
- arApLock.js  <-  AdminFinancials.jsx, sharefile-sync.js
- budgets.js  <-  BNYScheduler.jsx, HeartbeatPage.jsx, LiveOpsTab.jsx, monthlyBriefData.js, PassaicScheduler.jsx, ProductionDashboard.jsx, WeekRevenueChip.jsx
- contextBuilder.js  <-  ClaudeReadBlock.jsx
- dailyOps.js  <-  BNYScheduler.jsx, LiveOpsTab.jsx, PassaicScheduler.jsx, poTotals.js, StatusTab.jsx, weeklyProdSummaryData.js
- fileFingerprint.js  <-  UploadTile.jsx
- historicalSummaries.js  <-  DashboardPage.jsx
- inventoryWorkbook.js  <-  sharefile-sync.js
- monthlyBriefData.js  <-  MonthlyBriefs.jsx
- monthlyBriefNarrative.js  <-  MonthlyBriefs.jsx
- monthlyBriefPdf.js  <-  MonthlyBriefs.jsx
- newGoods.js  <-  NewGoodsTab.jsx
- parsers\parseInventoryFile.js  <-  LIFTDataRefresh.jsx
- parsers\parseMosFile.js  <-  LIFTDataRefresh.jsx
- parsers\parseMosMaterialColor.js  <-  **NOTHING IMPORTS THIS**
- parsers\parserHelpers.js  <-  parseInventoryFile.js, parseMosFile.js, parseWipFile.js
- parsers\parseWipFile.js  <-  LIFTDataRefresh.jsx
- payrollWorkbook.js  <-  sharefile-sync.js
- persistSnapshot.js  <-  LIFTDataRefresh.jsx, UploadTile.jsx
- poTotals.js  <-  BNYScheduler.jsx, LiveOpsTab.jsx, PassaicScheduler.jsx, StatusTab.jsx
- productionPrefill.js  <-  AdminPanel.jsx
- prompts\dashboardNarrative.js  <-  ClaudeReadBlock.jsx
- prompts\weeklyRecapNarrative.js  <-  ExecutiveDashboardPage.jsx
- purchasesWorkbook.js  <-  AdminFinancials.jsx, sharefile-sync.js
- scheduleUtils.js  <-  BNYScheduler.jsx, BNYSection.jsx, dailyOps.js, FinanceHome.jsx, HeartbeatPage.jsx, InventoryTab.jsx, LiftFreshnessBadge.jsx, LiveOpsTab.jsx, NewGoodsTab.jsx, NewGoodsView.jsx, OpsAttentionPanel.jsx, OpsDailyChart.jsx, OpsHome.jsx, OpsPulseTiles.jsx, OpsSectionGrid.jsx, PassaicScheduler.jsx, PassaicSection.jsx, PeopleTab.jsx, ProcurementHome.jsx, QueueTab.jsx, SchedulerTab.jsx, ShareFileFreshnessBadge.jsx, StatusTab.jsx, WeekRevenueChip.jsx, WIPTab.jsx
- venaWorkbook.js  <-  sharefile-sync.js
- weeklyProdSummaryData.js  <-  WeeklyProductionSummary.jsx
- weeklyProdSummaryNarrative.js  <-  WeeklyProductionSummary.jsx

## Components nothing renders (dead code candidates)

LIMIT: this detects files that are NEVER IMPORTED. It does NOT detect a file
that is imported and whose exports are then unused - ProductionTab.jsx is the
known case, imported by App.jsx with all four of its exports unreferenced.
Absence from this list is not proof a component is live.

- NewGoodsView.jsx
- PlantRollup.jsx
- ShareFileFreshnessBadge.jsx
- WeekPaceStrip.jsx

## ShareFile mirror (C:\Dev\TriadBridge\pulled)

Full recursive mirror of S:\Shared Folders, refreshed by sf_pull.py.
If a file is missing here, re-run that script. Never chase the S: drive
letter - the Filesystem connector cannot resolve a session-mapped drive.

LAST SYNCED is the LOCAL download time, not ShareFile's modified date, so it
says when sf_pull last wrote the file and NOT how current the data is. The
give-away on the first run: Parmount Monthly Results listed May as newest
while June sat in the same folder. For true source dates read
pulled\_sync_manifest.json, which sf_pull v2 keeps per file.

| folder | files | newest file | last synced | feeds a table? |
| --- | --- | --- | --- | --- |
| _legacy | 76 | Paramount Prints- February 2026 Purchases 2.24... | 2026-06-19 | no - mirrored only |
| DASH WORK | 165 | 2026 3RD PARTY PRICING.pdf | 2026-08-02 | partial - one subfolder only |
| Inventory Reports | 9 | Transfered Aug 2025.xlsx | 2026-07-25 | yes |
| lift | 7 | mv_dash_current_month.json | 2026-07-01 | no - mirrored only |
| LIFT_docs | 17 | LIFT Issues 2-25.docx | 2026-07-25 | no - mirrored only |
| Management Financial Reporting | 95 | BNY - Planned P&L - 7-11-2025_APratt Version.x... | 2026-07-25 | no - mirrored only |
| Management Sales Reporting | 147 | Dashboard-Produced @ Job Level.xlsx | 2026-08-02 | no - mirrored only |
| Paramount Month End Decks | 14 | Paramount Prints January Results.pdf | 2026-07-29 | yes |
| Parmount Monthly Results | 8 | Paramount Results vs Forecast_May 2026.xlsx | 2026-07-25 | yes |
| reports | 17 | spark_check.txt | 2026-07-07 | no - mirrored only |
| Reports fr JD | 9 | 07Jul Paramount Prints - Monthly Results (610)... | 2026-07-25 | no - mirrored only |
| updates | 9 | _pull_log.json | 2026-06-21 | no - mirrored only |

## Facts that keep getting re-discovered

- ShareFile is the source of record for every finance and reporting input,
  and it is ALREADY AUTOMATED. sharefile-sync.js runs daily and ingests
  Jen's weekly GP file, Abigail's Vena monthly close, and both inventory
  workbooks. There is no manual upload step left to build.
- The month-end decks are in the mirror and readable. June also exists as a
  2.3 MB PDF, so the old 48 MB copy limit no longer applies.
- LIFT exposes TWELVE reporting endpoints; lift-wip-sync.js uses two.
  orders.csv has 45 columns and roughly 20 are mapped. Probe before assuming
  a field is unavailable.
- C:\Dev\TriadBridge is shared plumbing for this project and Triad both.
  ARCHITECTURE.md there is the canonical cross-project file.
- A wrong column name in a .select() is rejected WHOLE by PostgREST: the
  screen renders zero, silently. Run check-selects.ps1 after touching data
  loading. Four instances of this shipped before anyone noticed.


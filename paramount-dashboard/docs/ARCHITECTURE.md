# Architecture

> **The capstone of the paramount-dashboard architecture audit.** This is the entry point: a one-page system overview, an index into the five phase deliverables, and the **ranked implementation roadmap** (Phase 6) that sequences all 29 findings into executable waves.
> Status: **DRAFT — awaiting sign-off.** The whole audit is **analysis + plan only** — no code or schema has been changed (audit Decision 1). Every finding below is a *plan*; the implementation passes are future work, sequenced in §7.

---

## §0 — How to use this document

**Audience.** Anyone onboarding to paramount-dashboard, or any engineer (or future Claude Code session) about to implement a fix. Start here, then open the phase doc for the area you're touching, then check §7 for where that work sits in the sequence and what it depends on.

**The document set.** Six docs, each a phase deliverable, plus the running findings log:

| Doc | Phase | What it is |
|---|---|---|
| **ARCHITECTURE.md** (this) | 6 | Capstone: overview + index + ranked roadmap |
| `MODULE_MAP.md` | 1 | What every component / lib / function does |
| `DATA_MODEL.md` | 2 | The 42 tables + 8 views: columns, keys, RLS, who R/W |
| `WEEK_ANCHORING.md` | 3 | The Sunday/Monday conflict and its staged fix (F-001) |
| `CONSOLIDATION.md` | 4 | Dead code, shared-utility gaps, the `budgets.js` target |
| `NARRATIVE_INTEGRATION.md` | 5 | The unified AI/narrative-memory design (F-010 + F-026–F-029) |
| `FINDINGS_LOG.md` | all | The 29 findings — full detail per ID; this doc ranks them |

**Provenance.** The phase docs were built from line-cited reads and cross-agent verification; where an agent conclusion contradicted a committed doc it was re-checked by direct read (see `CONSOLIDATION.md §0`, `WEEK_ANCHORING.md §3`). The data-model constraint columns are inline-only and **constraint-lossy** — verify composites against the live DB before relying on them (`DATA_MODEL.md §0`). This capstone synthesizes those docs; it introduces no new findings.

---

## §1 — System overview

Paramount Prints (a wallpaper/fabric printer, division of F. Schumacher & Co.) runs a single-page **React 18 + Vite** dashboard. **Supabase is the entire backend** — Postgres, Auth, Realtime, Storage. There is no custom server; the only server-side code is **Netlify functions** that proxy third-party APIs (Anthropic, Slack, Monday.com) and keep their keys server-side.

```
┌─────────────────────────── Browser (Vite SPA) ───────────────────────────┐
│  App.jsx  — hand-rolled router (no router lib)                            │
│    destination ∈ { landing, performance, operations, heartbeat } + Admin  │
│                                                                           │
│   Performance        Operations            Heartbeat         Admin        │
│   recap·financials   WIP→NewGoods→         single deep       data entry · │
│   ·people·inventory  Scheduler→LiveOps     pulse, 2 plants   access·intel │
│         │                  │                    │               │         │
│         └──────────── supabase-js (anon key, RLS permissive) ──┴────┐     │
└──────────────────────────────────│──────────────────────────────────│────┘
                                    │                                   │
                    ┌───────────────▼─────────────┐      ┌──────────────▼──────────────┐
                    │  Supabase: Postgres + Auth   │      │  Netlify functions (/api/*) │
                    │  + Realtime + Storage        │      │  edge (Deno): claude*,       │
                    │  42 tables · 8 views         │      │   slack*, monday-newgoods-* │
                    │  RLS ≈ open (URL-obscurity   │      │  Node: lock-wip, gen-pdf,   │
                    │   + client role gating)      │◄─────│   claude.mjs (mostly dead)  │
                    └──────────────────────────────┘ svc  └─────────────────────────────┘
                                                     role     proxy to api.anthropic.com,
                                                              Slack, Monday GraphQL
```

**Key shapes to know before reading the rest:**
- **Three destinations, role-gated client-side.** `src/lib/access.js` maps `profiles.role` → destinations; the super-admin is a hardcoded email. This is *not* a security boundary (see §8).
- **4/4/5 fiscal calendar, Sunday-anchored.** `week_start` stores the Sunday as `yyyy-MM-dd`. The lone Monday-keyed straggler (`fiscalCalendar.js`) is the source of F-001.
- **Snapshot-versioned ingestion.** Excel/LIFT + Monday data land via `persistSnapshot.js`; reads go through `v_current_*` views. There are **three** independent "current snapshot" mechanisms (a consolidation theme).
- **AI everywhere, logged almost nowhere.** Eight AI surfaces; only the `ClaudeReadBlock` path logs. Phase 5 designs the fix.

---

## §2 — Module map → `MODULE_MAP.md`

The component/lib/function inventory: every module's responsibility, data sources (tables R/W, `/api/*`, external), relationships, week anchor, and seams. Grouped by the shell + the three destinations + Admin, then the shared `lib/` layer, then the serverless functions, with a consolidated data-source matrix and week-anchor table. **Read it to find where a behavior lives.** → `docs/MODULE_MAP.md`

## §3 — Data model → `DATA_MODEL.md`

The live schema: 42 tables + 8 views across nine domains, with columns/keys/constraints, RLS posture, and per-table R/W cross-refs. Documents the snapshot-versioning model, the week-anchoring at the data layer, the schema↔code contradictions (F-018/F-019/F-020), and the data-shape gotchas (JSONB string-numbers, the `.actual` bug, `day_of_week` TEXT). **Constraint columns are inline-only — verify composites live (§0).** → `docs/DATA_MODEL.md`

## §4 — Week anchoring → `WEEK_ANCHORING.md`

Resolves F-001. The canonical anchor is **Sunday** (DB + `scheduleUtils.sundayOf` already there; most code is already correct). The conflict splits into two mirror-image bug classes — Monday→Sunday-DB queries (silent zero rows) and Sunday→Monday-`fiscalCalendar` lookups (silent null labels) — fixed by a two-step migration (re-key the 52-row map + transitional normalization, then enforce strict Sunday). Line-cited anchor table for all 16 week-aware modules. → `docs/WEEK_ANCHORING.md`

## §5 — Consolidation & cleanup → `CONSOLIDATION.md`

The dead-code deletion plan (in dependency layers), the shared-utility gap analysis (F-004 `scheduleUtils`, F-006 `period.js`, F-007 `aging.js`, F-008 `productionRollup.js`), and the `budgets.js` consolidation (F-005) — where `budgets.js` itself must be corrected to the March 2026 deck *before* the duplicate local copies are deleted. **Three findings were re-verified by direct read** because they contradicted prior docs. → `docs/CONSOLIDATION.md`

## §6 — Narrative integration → `NARRATIVE_INTEGRATION.md`

The unified AI/narrative design (Phase 5). Eight binding product decisions: an accumulating, recency-weighted **memory layer** (new `narrative_memory` table) behind a **server-side gateway** (closing F-010/F-029, folding in the F-014 Anthropic-key fix), with role-tailored views and a **promote-gate** governance model (F-026). Inventories all eight AI surfaces, the three-way context fragmentation (F-028), and the staged migration. → `docs/NARRATIVE_INTEGRATION.md`

---

## §7 — Implementation roadmap (Phase 6 ranked backlog)

**No code or schema has been changed by the audit.** This section ranks the 29 findings and sequences them for the implementation passes.

**Method.** Each finding is scored on **Impact** (silent data-corruption > security exposure > broken feature > velocity drag > cosmetic), **Blast radius** (breadth × *silence* — silent-and-wide ranks highest), and **Dependency leverage** (does it unblock, or is it blocked). **Effort** (S/M/L) is a cost tag, not a ranking axis. **The `Wave` column is the single source of truth** for sequencing; the wave narrative below it is the derived view.

**Streams:** SEC (security & secrets) · WEEK (week-anchoring) · NARR (narrative) · SCHEMA (schema/broken features) · NETLIFY (deploy cleanup) · DEAD (dead code) · UTIL (shared-utility) · DOC (closed-in-audit).

### §7.1 — Ranked master table (all 29, sorted by wave)

| Wave | ID | Finding | Stream | Impact | Blast | Effort | Notes / dependency |
|:---:|---|---|---|:---:|:---:|:---:|---|
| **1** | F-001 | Week-anchor Sun/Mon conflict | WEEK | High | High | L | Silent wrong-week / zero-row reads *today*; underlies the `narrative_memory` anchor. Joint-top. Plan: `WEEK_ANCHORING.md`. |
| **1** | F-016 | RLS is not an access boundary | SEC | High | High | L | Top security; 25 tables anon-exposed incl. financials/payroll/AI logs. Parallel epic. Gateway later mitigates only `ai_call_log`+`narrative_memory`. Joint-top. |
| **1→2** | F-014 | `VITE_`-prefixed server secrets | SEC | High | Med | S | **Anthropic-half = Wave 1** (blocks narrative Stage 0 — gateway can't ship without it); **Monday-half = Wave 2** (rides the netlify cleanup). Handled in notes, not split. |
| **2** | F-018 | `monthly_briefs` table absent | SCHEMA | High | Med | M | MonthlyBriefs save/load broken; **gates narrative Stage 5**. Likely incomplete rename from `monthly_reports`. |
| **2** | F-013 | Node fns not deployed (dir-casing + bogus edge decls) | NETLIFY | Med | Med | S | The keystone of the netlify wave — its fix + the dead-fn deletes land in one config commit. |
| **2** | F-019 | `role_change_log` table absent | SCHEMA | Med | Low | M | Role-change audit silently fails (swallowed error) — compliance gap. |
| **2** | F-020 | `profiles.role` DEFAULT invalid | SCHEMA | Med | Low | S | DEFAULT `'viewer'` not in CHECK set. Confirm the profile-creation path first. |
| **2** | F-012 | Duplicate `/api/claude` (`claude.mjs` dead) | NETLIFY | Low | Low | S | Edge wins; Node copy unreachable + undeployed. Delete; bundle with F-013. |
| **2** | F-003 | `lock-wip` triply dead | NETLIFY | Low | Low | S | Not deployed + no write target + no reader. Delete cron+fn; bundle with F-013. |
| **2** | F-017 | `generate-pdf.mjs` dead | NETLIFY | Low | Low | S | No `src/` caller; undeployed. Delete; bundle with F-013. |
| **2** | F-024 | `sched_daily_ops` composite-unique unverified | SCHEMA | Low | Low | S | Run the `pg_constraint` check; the `upsertDailyOp` path depends on it. |
| **3** | F-010 | Inconsistent `ai_call_log` logging | NARR | Med | Med | M | Closed by the **server-side gateway, Stage 0**. Depends on F-014(Anthropic). |
| **3** | F-029 | Model-ID drift / stale model | NARR | Med | Med | S | Gateway owns model selection (Stage 0). |
| **3** | F-028 | Fragmented context assembly (3 builders) | NARR | Med | Med | M | Unify into one `buildContext` (Stage 1). |
| **3** | F-027 | Prompt templates in 3 locations | NARR | Low | Med | M | One parameterized scaffold (Stage 1). |
| **3** | F-026 | Narrative-memory governance (promote-gate) | NARR | Med | Med | M | Memory + promote-gate (Stages 2–5). **Depends on F-001** (Sunday anchor) and F-018 (Stage 5). |
| **4** | F-008 | productionRollup reimplemented ×6 | UTIL | Med | High | L | *(see Wave 5 ordering note)* highest-value extraction; enables cross-checking. |
| **4** | F-002 | `ProductionTab.jsx` orphaned | DEAD | Low | Low | S | Remove `App.jsx:16` import → delete → retire `VITE_GOOGLE_SHEETS_API_KEY`. |
| **4** | F-025 | `Correspondence.jsx` orphaned | DEAD | Low | Low | S | Delete code (Layer 1); decide the `correspondence` table/bucket cascade (Layer 3). |
| **4** | F-011 | `PlantRollup.jsx` unused | DEAD | Low | Low | S | Confirm no importer, delete. |
| **4** | F-022 | `sched_current_wip` orphan view + 3 snapshot mechanisms | DEAD | Low | Med | M | Drop the view (trivial); the snapshot-mechanism consolidation is the larger, optional follow-on. |
| **4** | F-023 | `comments` dead table | DEAD | Low | Low | S | Drop after external-SQL-consumer check (irreversible — snapshot first). |
| **5** | F-005 | Targets duplicated vs `budgets.js` | UTIL | Med | Med | M | **Rewrite `budgets.js` to the deck FIRST, then delete the 3 copies.** BNY +500 per-bucket allocation = open input. |
| **5** | F-006 | `derivePeriod` read/write split | UTIL | Med | Med | S | Extract `period.js`; the **round-trip test** is the deliverable, not the move. |
| **5** | F-007 | Age-bucket inconsistency | UTIL | Low | Med | S | Standardize on the parser scheme; extract `aging.js`. |
| **5** | F-004 | Pool-status sets (single-source today) | UTIL | Low | Low | S | Preventive move to `scheduleUtils`; verify the schedulers' inline filters first. |
| **—** | F-009 | Heartbeat fiscal-label mismatch | WEEK | — | — | — | **Closed — subsumed by the F-001 fix** (one instance of Class 2). |
| **—** | F-015 | Stale `supabase-schema.sql` | DOC | — | — | — | **Closed — live export captured** (`db/schema.sql`); constraint-lossy caveat noted. |
| **—** | F-021 | Export-lossiness (composite uniques) | DOC | — | — | — | **Closed — caveat established** (`DATA_MODEL §0`); verify-before-relying, no discrete task. |

> **F-008 wave note:** scored in the UTIL/extraction stream (Wave 5 conceptually), but tagged **Wave 4** for *timing* — it's the largest extraction and the one that unlocks pool/scheduled/produced cross-checking, so it starts as soon as the structural waves (1–3) settle, alongside the dead-code pass, rather than waiting behind the smaller extractions. The other four extractions (F-004/05/06/07) stay Wave 5.

### §7.2 — Dependency chains

```
F-014(Anthropic) ─┐
F-029 ────────────┼─► Narrative Stage 0 (gateway) ─► Stage 1 (scaffold/context)
                  │            │                          │
F-001 (Sunday) ───┼────────────┼──► Stages 2–3 (narrative_memory + gated feed-forward)
                  │            │                          │
                  │            │            F-018 ──► Stage 5 (monthly-brief node)
                  │            │                          │
                  └────────────┴──────────────────────────┴─► Stages 6–7 (advisor RW · role views)

F-013 (dir-casing fix) ─► delete { F-012, F-003, F-017 } + remove bogus edge decls
                          └─ F-014(Monday-half) rides this same netlify commit

F-005:  rewrite budgets.js (to deck)  ─►  delete the 3 local copies   (order is load-bearing)
F-008:  productionRollup.js extracted  ─►  unlocks cross-checking for F-004/F-006/F-007
F-022:  DROP VIEW (trivial)            ··· snapshot-mechanism unification (optional, larger)
```

**Read:** F-001 and F-014(Anthropic) are the two things that gate the narrative epic — neither is itself blocked, so both start in Wave 1. F-016 is joint-top by *priority* but is an independent security epic (it doesn't block the others), so it runs in parallel. F-013 is the keystone that lets the four netlify deletes land cleanly together.

### §7.3 — Execution waves (derived view)

- **Wave 1 — Critical foundations (start now).** `F-001` (week-anchoring: stops silent data corruption *and* unblocks the memory anchor), `F-016` (the RLS security epic, parallel track), and `F-014`-Anthropic (the cheap Stage-0 unblocker). One L structural + one L security + one S unblocker.
- **Wave 2 — Deploy & schema hygiene (parallelizable with Wave 1).** The netlify cleanup as one config commit (`F-013` + delete `F-012`/`F-003`/`F-017` + `F-014`-Monday); the broken-feature table fixes (`F-018` — also gates narrative Stage 5 — `F-019`, `F-020`); and the `F-024` verification. Mostly S, low-risk, unblocks features.
- **Wave 3 — Narrative integration epic.** The Phase 5 staged plan (`NARRATIVE_INTEGRATION.md §4`): Stage 0 gateway (`F-010`/`F-029`, needs F-014-Anthropic) → Stage 1 scaffold/context (`F-027`/`F-028`) → Stages 2–5 memory + promote-gate (`F-026`, needs F-001 and F-018) → Stages 6–7. One L epic.
- **Wave 4 — Dead-code removal + the big extraction.** Batched deletes (`F-002`, `F-025`, `F-011`, `F-023`, `F-022`-view) to clear orphans, plus `F-008` (productionRollup) kicked off here as the highest-value extraction. Low-risk deletes + one L extraction.
- **Wave 5 — Shared-utility extraction.** `F-005` (budgets — deck-first, then delete copies; BNY +500 open), `F-006` (period.js + round-trip test), `F-007` (aging.js), `F-004` (scheduleUtils move). Quality/velocity work, done last so extractions target post-migration code.

**Open inputs that gate specific items (not whole waves):** the BNY +500 per-bucket allocation (F-005), and the `correspondence` table/bucket cascade decision (F-025). Both are flagged in their phase docs; neither blocks its wave's other work.

---

## §8 — Cross-cutting themes

Patterns that recur across findings — worth internalizing before touching the code:

1. **Silent failure is the dominant risk mode.** The worst bugs don't throw — they return wrong/zero data: Monday-anchored queries against Sunday-keyed tables (F-001), `0 + "9483"` JSONB string concatenation, null fiscal labels (F-009), the swallowed `role_change_log` insert (F-019), ungated narrative feed-forward (F-026). Prefer loud failure; add round-trip/liveness assertions (F-006's test is the model).
2. **RLS is not an access boundary.** 25 tables are anon-exposed; security rests on URL obscurity + client-side role gating (F-016) — exactly as `CLAUDE.md` states, and contradicting the older "RLS is the real boundary" framing. Treat `profiles.role` as UX, not security; server-side writes should use the service role (the gateway, F-010/F-014, moves that direction for two tables).
3. **"A single source that isn't."** Canonical modules exist but are bypassed: `budgets.js` (F-005, and it's itself wrong), `derivePeriod` (F-006), `productionRollup` (F-008, reimplemented 6×), context assembly (F-028, 3 builders), prompts (F-027, 3 dirs). The fix is usually *correct the canonical source first, then delete the copies* — never the reverse.
4. **Three divergent snapshot/"current" mechanisms** (pipeline `is_current`, New-Goods `is_current`, scheduler latest-`uploaded_at`) — F-022. Unifying the convention is the structural cleanup behind several dead-code items.
5. **Verify before trusting — agents and exports both lie systematically.** Verification sub-agents made repeatable errors that contradicted committed docs (re-checked by direct read); the schema export is constraint-lossy (F-021). The audit's discipline — direct-read any claim that overturns a record — should carry into implementation.
6. **Plan-only, by design.** Nothing here is implemented (audit Decision 1). The roadmap (§7) is the bridge from analysis to code; each wave is a separate implementation session.

---

## §9 — Provenance & findings index

The full per-finding detail — evidence, confidence, line cites, resolution status — lives in **`docs/FINDINGS_LOG.md`** (F-001…F-029). This capstone ranks and sequences them (§7) but does not restate them. Confidence levels and the "resolved-in" annotations there are authoritative; §7's waves are the execution layer on top.

---

*Phase 6 deliverable — the assembled audit. Pairs with all five phase docs (§2–§6) and `FINDINGS_LOG.md` (§9). Doc/plan only; implementation deferred to the wave-sequenced passes in §7 (audit Decision 1).*

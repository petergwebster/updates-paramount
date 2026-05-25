# Narrative Integration

> Phase 5 deliverable of the architecture audit. **`ARCHITECTURE.md` §6 links here** as the canonical reference for the AI/narrative layer.
> Built from **direct line-cited reads** of the narrative spine — `contextBuilder.js`, `ClaudeReadBlock.jsx`, the four prompt templates (`dashboardNarrative.js`, `weeklyRecapNarrative.js`, `heartbeatNarrative.js`, `monthlyBriefNarrative.js`), and the server-side `monday-newgoods-observations.ts` — cross-referenced against `MODULE_MAP.md` (components), `DATA_MODEL.md` (the AI/Narrative tables), and `FINDINGS_LOG.md` (F-010 resolved-here; F-026–F-029 opened-here).
> Status: **DRAFT — awaiting sign-off.** Scope is **analysis + target architecture + migration plan only**; the code/schema changes are a separate post-audit implementation pass (audit Decision 1).

---

## §0 — How to use this document

**Audience.** Future Claude Code sessions and any engineer building or extending the AI/narrative layer. This is the "what every AI surface does today, what the unified system should be, and how to get there without breaking the live reads" reference. Pair it with `MODULE_MAP.md §6/§7` (the widgets + lib), `DATA_MODEL.md` (the `dashboard_narratives` / `ai_call_log` / `business_facts` / `historical_summaries` tables), and `FINDINGS_LOG.md` (F-010 + F-026–F-029).

**It answers:** which AI surfaces exist and how each assembles context / calls Claude / caches / logs; where that machinery is fragmented; the eight product decisions that define the target system; the `narrative_memory` schema and the recency-weighted memory model; the promote-gate governance model; and the staged migration.

**Provenance — this doc is line-verified, the Phase 1 map was not.** `MODULE_MAP.md`'s own header flags it as "leads from a breadth-first read, not line-verified." Everything in §2/§3 below was confirmed by **direct read** of the named files at the cited lines. Where this doc and the Phase 1 map differ in specificity, trust this doc for the narrative layer. (Same discipline as `WEEK_ANCHORING.md §3` and `CONSOLIDATION.md §0`.)

**The §1 decisions are product decisions, not findings.** They were made by the owner (May 2026) in the Phase 5 scoping dialogue and are recorded here as **binding inputs** to the design, not as things the audit discovered. The override on Decision 8 (propagate → promote-gate) is captured as made.

---

## §1 — Decision record (the target system)

The eight decisions that define what "unified narrative" means here. These are binding; the architecture in §3 implements exactly them.

| # | Decision | Choice | Implication |
|---|---|---|---|
| 1 | **Ambition** | **Accumulating memory layer** | One canonical narrative that persists and feeds forward — not just a refactor. Drives §3.2. |
| 2 | **Audience** | **Both, role-tailored** | Exec *and* ops, each with a tuned view. *Default mechanism: one canonical generation + role-specific rendering* (§3.3) — not per-role generations. |
| 3 | **Memory horizon** | **Recency-weighted hybrid** | Recent verbatim, older progressively summarized, explicit decay/rollup. Formalizes what `contextBuilder` already tiers (§2.2). |
| 4 | **AI gateway** | **Gateway (server-side) + streaming stays separate** | Centralize the cached-narrative path in a server-side edge function; the scheduler's interactive Ask-Claude (Opus, streaming) keeps its own generation path. Location settled **server-side** (§3.1) — folds in the F-014 key fix and partially mitigates F-016. |
| 5 | **Memory store** | **New dedicated `narrative_memory` table** | Memory is a first-class, queryable/auditable/versioned object: `period, scope, summary, salience/decay, supersedes-link, …`. `dashboard_narratives` stays per-surface cache · `historical_summaries` stays rolled metrics · `business_facts` stays curated static tail. |
| 6 | **Monthly brief** | **Fix F-018 separately, then consume** | Phase 5 does *not* own the `monthly_briefs` table fix; it depends on it, then wires the brief as the monthly rollup node. |
| 7 | **Scheduler advisor** | **Read + write-back** | Reads the shared recency-weighted memory; contributes notable proposals/outcomes back. Generation/streaming/logging path still separate (Decision 4). |
| 8 | **Edit propagation** | **Promote to propagate** *(override of the initial "edits propagate")* | Edits/write-backs are **local-and-audited by default**; an explicit, one-click-but-visible **promote** action makes them canonical and propagating. Restricted to **admin + designated curators (Wendy / Chandler, scoped to their operational domains)**. Anti-poisoning guardrails (provenance, confidence, retractability, audit) are the **backstop**; the promote-gate is the **primary** mechanism. |

---

## §2 — Current-state narrative inventory

### §2.1 — The eight AI surfaces

Confirmed against code (the `/api/claude*` grep returned exactly these call sites; `logAICall` exists in exactly two files: `contextBuilder.js:575` and `ClaudeReadBlock.jsx`).

| Surface | Entry point | Prompt | Context source | Logs `ai_call_log`? | Output store | Notes |
|---|---|---|---|---|---|---|
| **Run-rate read** | `DashboardPage` → `ClaudeReadBlock` | `dashboardNarrative` (forward, 3–5 para) | `contextBuilder` (full) | ✅ | `dashboard_narratives` (today/week/month) | the reference path |
| **Heartbeat read** | `HeartbeatPage` → `ClaudeReadBlock` | `heartbeatNarrative` (floor voice, 4–6 para) | `contextBuilder` (**minimal**) | ✅ | `dashboard_narratives` (heartbeat) | minimal scope is deliberate — see §2.2 |
| **Executive recap** | `ExecutiveDashboardPage` → `ClaudeReadBlock` | `weeklyRecapNarrative` (backward, 5–7 para) | `contextBuilder` (full) | ✅ | `dashboard_narratives` (recap) | one of two generations on the page |
| **KPI narrative** | `KPIScorecard` → `/api/claude` direct | inline | none (ad-hoc) | ❌ | `weeks` (via parent `onSave`) | unlogged sub-narrative |
| **Monthly brief** | `MonthlyBriefs` → `/api/claude` direct | `monthlyBriefNarrative` (mid/end, ~250–400 w) | **own `formatBriefContext`** (not `contextBuilder`) | ❌ | `monthly_briefs` — **table absent (F-018), save/load broken** | unlogged *and* non-functional |
| **HR extract** | `AdminPeople` → `/api/claude` direct | inline | none | ❌ | `people_weekly` | PPTX→JSON extraction, not a narrative |
| **Scheduler advisor** | `PassaicScheduler` / `BNYScheduler` → `/api/claude-stream` | inline, Opus, streaming | bespoke scheduling context | ❌ | not cached | interactive *proposals*, not a read |
| **New Goods observations** | edge fn `monday-newgoods-observations` | server-side `buildPrompt` | server-side, from `mng_items` | ❌ (records `model_used` in `mng_observations` instead) | `mng_observations` (per snapshot+site) | already server-side + service-role — the working server template |

**F-010, precisely:** three surfaces log; five do not. The recap page logs its block but not its embedded KPI narrative. Even the server-side observations call sits outside `ai_call_log` (it has its own per-table audit). There is **no single place** that sees every AI call.

### §2.2 — The shared spine (and the memory loop that already exists)

**`contextBuilder.js` already implements a primitive recency-weighted memory** — Decision 3 is formalizing this, not inventing it. The tiers (docstring lines 4–9, fetchers below):

- **Bucket A — static facts:** `business_facts` where `active` (`fetchBusinessFacts`, :29).
- **Bucket B — recency-tiered history:** last **4 weeks raw** (`fetchRecentWeeksDetail`, :62) → last **13 weeks** weekly summaries (`fetchWeeklySummaries`, :151, `historical_summaries` `period_type='weekly'`) → last **12 months** monthly (:179) → last **3 yr** quarterly (:206); plus last **~30 days** of `section_comments` (`fetchRecentComments`, :234).
- **Bucket B′ — prior narratives:** `fetchRecentNarratives` (:264–285) pulls the **last 4 prior `dashboard_narratives`** so "today's narrative knows what the previous weeks said." **This is the existing feed-forward memory loop — and it is *ungated*:** it reads raw `dashboard_narratives`, i.e. every cached/edited narrative propagates with no human gate. Under Decision 8 this read must repoint to **promoted `narrative_memory` rows** (see §3.2).
- **Bucket C — forward state:** the page's `currentData` payload, formatted by `formatCurrentWindow` (:401) — two shapes (heartbeat-structured vs generic actuals/expected/gaps).

`buildDashboardContext({ weekStart, timeWindow, currentData, scope })` (:313) assembles all of the above; **`scope='minimal'`** (:318) drops Bucket B/B′/comments and keeps only facts + currentData. Heartbeat *must* use minimal "or Claude parrots stale weekly recap data as if it were live heartbeat truth" (:307–309) — a real, documented failure mode and a key constraint for the memory design: **more memory is not always better.**

**`ClaudeReadBlock.jsx`** is the load/generate/edit/cache lifecycle for the three good surfaces:
- Load existing by `(week_start, time_window)` `.single()` (:96–101).
- **Respect human edits** — if `edited_at` is set, *never* auto-regen (:112–115). This is today's entire edit-governance model: a human edit freezes *that one cell*; it neither propagates nor is versioned.
- Else regen if older than `STALE_HOURS = 2` (:49, :120).
- Generate → `/api/claude`, model **`claude-sonnet-4-20250514`** hardcoded (:174) → upsert `dashboard_narratives` `onConflict: 'week_start,time_window'` (:200–207) → `logAICall` (:210).
- `saveEdit` upserts with `edited_by`/`edited_at` (:259–266); regenerate over edits requires a confirm modal (:278–290).

### §2.3 — The fragmentation (what the gateway/memory work consolidates)

1. **Three context builders.** `contextBuilder.js` (ClaudeReadBlock surfaces) · inline `formatBriefContext` in `monthlyBriefNarrative.js` (MonthlyBriefs, from `monthlyBriefData`) · server-side `buildPrompt` in the observations edge fn. → **F-028.**
2. **Prompt templates in three locations.** `src/lib/prompts/` (dashboard, recap) · `src/prompts/` (heartbeat) · `src/lib/` root (monthlyBrief). No shared scaffold despite a shared skeleton. → **F-027.**
3. **Model-ID drift.** Client surfaces hardcode `claude-sonnet-4-20250514` (ClaudeReadBlock:174, `logAICall` default :594); the observations edge fn uses `claude-sonnet-4-6` (:19); the streaming advisor uses Opus. No single model policy. → **F-029.**
4. **Logging gap.** Only `ClaudeReadBlock` calls `logAICall`. → **F-010.**

But note the **shared prompt skeleton** that makes consolidation tractable: all four templates follow `analyst persona → named audience → contextString → data-state guard → task → structure → voice/constraints → "begin now, no preamble"`, and the **data-state guard** (don't read empty data as "we shut down") is independently re-implemented in every one. Role is already encoded implicitly — recap/brief name FSCO leadership (Timur/Antonella/Emily/Abigail/Kim); heartbeat *explicitly excludes* them and names the floor (Peter/Wendy/Brynn). Role-tailoring (Decision 2) formalizes a distinction the prompts already make by hand.

---

## §3 — Target architecture

### §3.1 — The gateway (Decision 4; closes F-010, F-029)

A single **narrative gateway** — a **server-side edge function** that every non-streaming AI narrative call routes through. The existing `monday-newgoods-observations.ts` is the **working pattern** to generalize: it already runs the full pipeline server-side (service-role Supabase client, cache-per-key, `model_used` recorded, Anthropic key read from `Deno.env` rather than the client bundle). The gateway makes that the shape for *all* narrative generation:

```
POST /api/narrative { surface, weekStart, scope, currentData, role } →
  buildContext(...)            // §3.2 — one context builder, replaces the 3
  → buildPrompt(surface,role)  // §3.3 — one scaffold, per-surface + per-role deltas
  → callClaude(model)          // §3.1 — single model policy (fixes F-029)
  → logAICall(...)             // ALWAYS, service-role write (fixes F-010)
  → writeCache(dashboard_narratives) + maybe writeMemory(narrative_memory)   // service-role
```

- **Server-side, by decision (owner, May 2026).** Generation, logging, and cache/memory writes happen in the edge function under the **service role** — not the client anon key. Rationale: (a) it folds in the **F-014** fix — the Anthropic key stops being `VITE_`-prefixed and never enters the client bundle (a Stage 0 *prerequisite*, §4); (b) it **partially mitigates F-016** — writes to `narrative_memory` + `ai_call_log` go through the service role instead of relying on those tables being anon-writable; (c) it reuses a pattern already proven in production (the observations fn) rather than inventing a client abstraction.
- **Owns model selection** — one place names the model; kills the drift (F-029) and the stale hardcoded `claude-sonnet-4-20250514`.
- **Always logs** — `logAICall` (server-side, service-role) becomes non-optional inside the gateway, so the five unlogged surfaces (KPI, MonthlyBriefs, AdminPeople, and the two schedulers' *read* context if they adopt it) are covered the moment they route through it.
- **Streaming stays separate (Decision 4).** The scheduler's `/api/claude-stream` advisor keeps its own generation/streaming path. It does **not** route generation through the gateway — but it **does** call the gateway's `buildContext` for its read (§3.4) and emits its own `logAICall`, so it lands in telemetry without being forced into the cached-narrative shape.
- **Rejected alternative — client-side service module.** A `src/lib/narrativeGateway.js` wrapping `ClaudeReadBlock`'s in-browser pipeline would be lower-disruption (no new function, no auth plumbing) and was the initial recommendation. **Rejected:** it leaves the Anthropic key client-exposed (F-014 unaddressed) and keeps cache/memory writes on the anon key (no F-016 movement) — it would fix observability (F-010) while baking in the two security debts the server-side path retires.

### §3.2 — The memory model (Decisions 1, 3, 5)

**`narrative_memory`** — the canonical running story, distinct from cache (`dashboard_narratives`), metrics (`historical_summaries`), and static facts (`business_facts`). Proposed shape (final columns settled in the implementation pass):

| Column | Purpose |
|---|---|
| `id` | PK |
| `period` / `period_type` | the period this entry summarizes (week / month / quarter), Sunday-anchored `week_start` — **defer anchor to F-001** |
| `scope` | the domain/surface this memory belongs to (e.g. `business`, `passaic`, `bny`, `financial`) — supports curator domain-scoping (Decision 8) |
| `summary` | the narrative text (the unit of memory) |
| `salience` / `decay` | recency-weight inputs — how strongly this entry feeds forward, decaying as it ages |
| `author` | `model` \| `<userId>` \| `advisor` — provenance |
| `confidence` | gateway/model-set; advisor write-backs default **low** |
| `status` | `local` (default) \| `promoted` \| `retracted` — the promote-gate state (§3.5) |
| `supersedes_id` | self-FK — versioning; a promoted correction supersedes the prior entry |
| `created_at` / `promoted_at` / `promoted_by` | audit trail |

**Recency-weighted assembly (Decision 3)** generalizes `contextBuilder`'s existing tiers:
- Keep Bucket A (facts) and Bucket B (4 wk raw → 13 wk → 12 mo → 3 yr metric summaries) as-is — that *is* the recency-weighted metric memory.
- **Repoint Bucket B′** (`fetchRecentNarratives`, :264–285) from raw `dashboard_narratives` to **`narrative_memory` WHERE `status='promoted'` AND NOT `retracted`**, weighted by `salience`/`decay`. This is the single most important behavioral change: it converts today's *ungated* feed-forward into the **promote-gated** one Decision 8 requires.
- `dashboard_narratives` stays exactly as the per-surface render cache (`ClaudeReadBlock`'s `(week_start, time_window)` store); `narrative_memory` is what *propagates*.
- Honor the **minimal-scope lesson** (§2.2): heartbeat and other live surfaces can still opt out of the narrative memory tier. Memory is recency-*weighted*, not all-you-can-eat.

### §3.3 — Generation & rendering (Decision 2)

- **One canonical generation per period** (default mechanism for "role-tailored"). Render role-specific *views* — not separate generations — keyed off the existing destination/role split: **Performance/recap → exec voice**, **Operations/Heartbeat → ops voice**. (Flag to owner: an alternative is mapping to raw `profiles.role`; destinations are proposed because the prompts already split that way.)
- **Unified prompt scaffold** (closes F-027): one builder holding the shared skeleton (persona → audience → context → **shared data-state guard** → task → structure → voice → "begin now"), with per-surface and per-role deltas as parameters. The four existing templates collapse into deltas on this scaffold; their distinct structures (recap 5–7 para, run-rate 3–5, heartbeat 4–6, brief mid/end) become surface configs. The duplicated data-state guard becomes one shared block.
- **One context builder** (closes F-028): `monthlyBriefNarrative`'s inline `formatBriefContext` and the observations fn's `buildPrompt` data-assembly fold into the gateway's `buildContext` as surface-specific context shapes (the monthly brief's COGS-pending / procurement-pass-through framing is a *content rule* that stays in its prompt delta, not the context builder).

### §3.4 — Per-surface target flows

- **Run-rate / heartbeat / recap:** unchanged externally; routed through the gateway (already logged, so this is mostly mechanical). Recap's embedded **KPI narrative** also routes through the gateway → now logged.
- **Monthly brief:** **after F-018 is fixed** (Decision 6 — separate track), route through the gateway; fold `formatBriefContext` into `buildContext`; it becomes the **monthly rollup node** that writes a `period_type='month'` `narrative_memory` entry.
- **Scheduler advisor:** **reads** the gateway's recency-weighted context (so proposals know the running story); generation stays on `/api/claude-stream` (Decision 4); **write-back** lands notable outcomes as `narrative_memory` rows tagged `author='advisor'`, `status='local'`, low `confidence` — *nothing the advisor writes propagates until a curator promotes it* (§3.5).
- **New Goods observations:** already the working server-side template; minimally, add a `logAICall` (or its server equivalent) so it joins central telemetry; optionally surface its observations as a `scope='newgoods'` memory feed. Low priority.
- **AdminPeople HR extract:** a structured-extraction call, not a narrative — route through the gateway only to gain logging; it does **not** write `narrative_memory`.

### §3.5 — Edit & write-back governance (Decision 8 — promote-gate primary)

- **Default = local + audited.** Edits to a narrative and advisor write-backs create `narrative_memory` rows with `status='local'`. Local rows render and are fully audited (`author`, `created_at`, `supersedes_id`) but **do not feed forward** into future generations.
- **Promote = the propagation switch.** An explicit **promote** action flips `status` to `promoted`, recording `promoted_by`/`promoted_at`; only promoted rows enter the Bucket B′ feed (§3.2). A promoted correction `supersedes` the entry it replaces.
- **Promote is one-click but visible** — surfaced inline on the narrative (e.g. a "Promote to memory" affordance next to Edit), **not** buried in a separate admin workflow.
- **Restricted to admin + designated curators** (`Wendy`, `Chandler`), **scoped to their operational domains** via `narrative_memory.scope` (e.g. Chandler promotes BNY-scope, Wendy Passaic-scope). Gating reuses `access.js` role logic; curator identities are config, not hardcoded in components.
- **Guardrails are the backstop, not the gate.** `confidence` (advisor write-backs low by default), full provenance, one-click **retract** (`status='retracted'`, drops out of the feed immediately), and the audit trail exist so a bad promote is *recoverable* — but the promote-gate itself is what prevents poison from entering, so guardrails never have to be the first line of defense.

---

## §4 — Migration plan (staged, plan-only)

Each stage is independently shippable and ordered so nothing breaks mid-flight. Code/schema changes are the post-audit implementation pass (audit Decision 1).

1. **Stage 0 — Server-side gateway extraction (closes F-010, F-029; prerequisite F-014).** Stand up the `/api/narrative` edge function (modeled on `monday-newgoods-observations.ts`): `buildContext` → `buildPrompt` (one model policy) → `callClaude` → always `logAICall` → cache write, all server-side under the **service role**. **Prerequisite — F-014 lands here:** rename the Anthropic key off the `VITE_` prefix and read it server-side only, so it leaves the client bundle; the gateway cannot stand up otherwise. Route the five unlogged callers at the new endpoint. **Side effect:** `ai_call_log` (and later `narrative_memory`) writes move to the service role, **partially mitigating F-016** for those tables. No `narrative_memory` schema yet; surface outputs unchanged. Highest value-to-risk; do first.
2. **Stage 1 — Prompt-scaffold + context-builder unification (closes F-027, F-028).** Collapse the four prompts onto one scaffold; fold `formatBriefContext` into `buildContext`. Still no schema, still per-surface outputs unchanged.
3. **Stage 2 — `narrative_memory` table.** Create the table (§3.2). Nothing reads it yet; back-populate is optional. (Bundle the migration with — or after — the F-016/F-022 schema work for consistency, owner's call.)
4. **Stage 3 — Gate the feed-forward.** Repoint `fetchRecentNarratives` (Bucket B′) from raw `dashboard_narratives` to promoted `narrative_memory` rows. **This is the behavioral cutover** from ungated to promote-gated memory — verify the recency weighting before/after.
5. **Stage 4 — Promote-gate UI + governance (§3.5).** Promote/retract affordance, `access.js` curator scoping, audit fields wired.
6. **Stage 5 — Monthly brief adoption.** **Gated on F-018** (separate fix). Route through gateway; wire as monthly rollup node.
7. **Stage 6 — Advisor read + write-back (Decision 7).** Advisor reads shared context; notable outcomes written back as low-confidence local rows.
8. **Stage 7 — Role views (Decision 2).** One canonical generation + role-specific rendering across surfaces.

**Dependencies:** **F-014** is a Stage 0 prerequisite — the Anthropic key must go server-only as the gateway is stood up. F-018 before Stage 5. Week-anchoring (F-001) underlies every `week_start`/`period` query in the memory layer — `narrative_memory` must store the canonical **Sunday** key; ideally land after (or alongside) the F-001 fix so memory isn't built on the split anchor.

---

## §5 — New findings & risks

Recorded in `FINDINGS_LOG.md`; ranked in Phase 6.

- **F-010 — inconsistent AI-call logging.** *Resolved-here (plan):* the gateway makes `logAICall` non-optional (Stage 0). Closes the observability gap across all five unlogged surfaces.
- **F-026 — memory governance (promote-gate primary).** *(Reframed from "memory-poisoning needs guardrails.")* With Decision 8, the **promote-gate is the primary governance mechanism**; provenance/confidence/retractability/audit are the **backstop**. Risk is now a *missing or mis-scoped gate*, not raw propagation. Design in §3.5.
- **F-027 — prompt templates in three locations** (`src/lib/prompts/`, `src/prompts/`, `src/lib/` root); no shared scaffold despite a shared skeleton. Consolidation in Stage 1.
- **F-028 — fragmented context assembly:** `contextBuilder.js` vs inline `formatBriefContext` (`monthlyBriefNarrative.js`) vs the observations edge fn's `buildPrompt`. Three independent context builders → divergent context for the same business. Consolidation in Stage 1.
- **F-029 — model-ID drift / stale hardcoded model:** client `claude-sonnet-4-20250514` (ClaudeReadBlock:174, `logAICall` default :594) vs edge `claude-sonnet-4-6` (:19) vs Opus (advisor). No single policy. Gateway owns model selection (Stage 0).
- **F-014 (cross-ref) — `VITE_`-prefixed Anthropic key.** No longer a parallel security epic: it is a **Stage 0 prerequisite, integrated into this migration** — the server-side gateway cannot be stood up without moving the Anthropic key server-only, so the F-014 fix (Anthropic-key half) lands as part of Stage 0 (§3.1/§4).
- **F-016 (cross-ref) — RLS is not an access boundary.** The server-side gateway **partially mitigates** F-016: writes to `ai_call_log` and `narrative_memory` go through the service role rather than depending on anon-writability. This is a narrow improvement for two tables — the **full RLS-posture rework (the ~25 anon-exposed tables) remains its own security epic**, untouched here.
- **`business_facts` hygiene (cross-ref `DATA_MODEL §7`).** Sharpens under a formal memory layer: point-in-time WIP snapshots seeded into `business_facts` (Bucket A) get quoted as live truth. A `narrative_memory` with decay does not fix a *static* fact that has gone stale — keep Bucket A curated. Not a new finding; flagged so the memory work doesn't paper over it.
- **F-018 dependency (Decision 6).** Monthly brief absorption is blocked until `monthly_briefs` exists. Not re-owned here.

---

## §6 — Out of scope / open items

- **No code or schema written this phase** (audit Decision 1).
- **F-018 fix itself** — separate bug track; Phase 5 only depends on it.
- **Streaming advisor generation internals** (`/api/claude-stream`, Opus) — stay as-is (Decision 4); only its *read context* and *write-back* are in scope.
- **Gateway location is settled** — server-side edge function (Decision 4, §3.1). No longer open.
- **Open for owner sign-off during implementation:**
  - **Role-view keying** — destinations (recommended) vs raw `profiles.role` — §3.3.
  - **Final `narrative_memory` columns** — §3.2 is the shape, not the DDL.
  - **Whether New Goods observations** join `narrative_memory` as a `scope='newgoods'` feed, or stay a standalone surface.
  - **BNY +500 / budget specifics** are a `budgets.js` concern (`CONSOLIDATION.md §3`), not narrative — noted only because the memory layer will quote budget figures.

---

## §7 — Verification approach (for the implementation pass)

- **Logging coverage (F-010):** after Stage 0, assert every `/api/claude*` path (except the deliberately-separate streaming generation) produces an `ai_call_log` row — diff `ai_call_log` call counts before/after exercising each surface in a `netlify dev` session.
- **No-regression on the three good surfaces:** run-rate / heartbeat / recap render identical narratives pre/post gateway extraction (same prompt, same model, same cache key).
- **Model policy (F-029):** grep confirms exactly one model constant remains after Stage 0.
- **Feed-forward cutover (Stage 3):** confirm an *unpromoted* edit does **not** appear in the next generation's context, and a *promoted* one does; confirm a **retract** removes it immediately.
- **Promote-gate authority (§3.5):** a non-curator cannot promote; a curator can only promote within their `scope`.
- **Memory anchor:** `narrative_memory.period` round-trips on the canonical **Sunday** key (depends on F-001) — a Monday-anchored write would silently miss on read, exactly the F-001 failure class.

---

*Phase 5 deliverable. Pairs with `MODULE_MAP.md` (the narrative widgets + lib), `DATA_MODEL.md` (the AI/Narrative tables), `WEEK_ANCHORING.md` (the `period` anchor dependency), and `FINDINGS_LOG.md` (F-010 resolved-here; F-026–F-029 opened-here). Code/schema changes deferred to a post-audit implementation pass (audit Decision 1).*

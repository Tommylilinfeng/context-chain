# Chain Analysis — Internal Design Doc

## Problem

The original batch analysis groups functions linearly (first N, next N, ...) with no regard for call relationships. This causes:

1. **Token waste** — if function A and B both call C, C's code is loaded twice in the prompt
2. **Context fragmentation** — related functions end up in different batches, producing contradictory or redundant decisions
3. **Missed cross-function insights** — the LLM can't reason about caller-callee patterns when they're split across separate LLM calls

## Solution: Chain Analysis

A three-layer batching strategy that groups functions by their CALLS edges in the graph.

### Layer 1: Chain Batches (center + level-1 as targets)

For each chain batch:
- **Center** (level 0): selected by greedy set cover — the function that covers the most unanalyzed neighbors
- **Level-1** (direct callers/callees): become analysis targets alongside the center
- **Level-2** (callers/callees of level-1): loaded as context-only — visible to the LLM but no decisions produced

This means every level-1 function has its callers/callees already present in the batch (either as other targets or as level-2 context), eliminating the need to load them separately.

### Layer 2: Linear Fallback

Functions with no CALLS edges (orphans) are grouped into linear batches using the manual batch size setting.

### Layer 3: Context Window Trim

Each chain batch is pre-estimated for token cost:
- Target: ~1200 tokens each
- Context-only: ~800 tokens each
- Prompt overhead: ~2000 tokens

If a batch exceeds 100k tokens, it's trimmed: first reduce context-only functions, then reduce targets. The `splitsDueToSize` stat in logs tracks how often this happens.

## Key Files

| File | Role |
|------|------|
| `src/core/batch-grouping.ts` | Graph query, seed selection (greedy set cover), batch formation, context window trim |
| `src/core/analyze-function.ts` | `analyzeChainBatch()` — shared context pool, call graph section, relationship-aware prompt |
| `src/dashboard/server.ts` | Integration: `chainMode` flag, batch dispatch (chain vs linear vs single), token savings tracking |
| `src/dashboard/public/run.html` | UI: Chain Analysis toggle, tokens-saved stat, chain-mode indicators |
| `src/ingestion/ingest-cpg.ts` | Callee ID resolution fix (Joern scope prefix normalization) |

## Seed Selection Algorithm

Greedy set cover on the call graph:

```
1. For each unanalyzed function, compute coverage = 1 + |available neighbors|
2. Skip hub functions (degree > batchSize * 3) as centers — they'd create low-quality mega-batches
3. Pick highest-coverage function as center
4. Mark center + neighbors as covered
5. Repeat until no center with coverage >= 2 remains
6. Remaining functions → orphans → linear fallback
```

Tie-breaking: prefer centers whose level-1 fits within maxBatchSize (no trimming needed).

## Prompt Structure (Chain Batch)

```
[Stable prefix — instructions, finding types, JSON schema]

## Shared Context (referenced by multiple targets)
### [S1] utils/db.ts::getPool
```code```

## Call Graph
createOrder (Target) → processPayment (Target)
handleCheckout [S1] → createOrder (Target)

---
## Target 1/3: createOrder (file: store/orderStore.ts)
Callers: [S1] handleCheckout, scheduleReorder
Callees: processPayment (Target 2)
```code```
### Existing decisions (from prior analysis):
- [decision] Uses optimistic locking to prevent double-charges
### Unique context: store/cronJobs.ts::scheduleReorder
```code```
```

Key differences from standard batch prompt:
- **Shared context pool** — deduplicates code snippets referenced by 2+ targets
- **Call graph section** — shows edges among targets and context (helps LLM understand data flow)
- **Target cross-references** — "(Target N)" labels so the LLM knows related functions are in the same batch
- **Existing decisions** — already-analyzed functions' decisions are shown as context, LLM can skip/modify

## Callee ID Resolution Fix

Joern's CPG export uses different ID formats for caller vs callee:
- **Caller ID** (function definition): `fn:repo/file.ts::functionName` — matches node IDs
- **Callee ID** (call site): `fn:repo/file.ts::scopeParent:functionName` — does NOT match

The fix in `ingest-cpg.ts` normalizes callee IDs before building CALLS edges:
1. If callee_id already matches a node → keep it
2. Try same-file: `callerFilePrefix::calleeName` → if match, use it
3. Try cross-file: find unique node with matching function name → if unambiguous, use it
4. Otherwise skip (ambiguous or truly external)

Result: 0 → 17,023 CALLS edges on the Claude Code repo.

## Token Savings

Estimated per batch: `dedupedReferences * 800` tokens (each deduped snippet ~800 tokens).

Tracked at three levels:
- **Per batch**: `chain-stats` SSE event with `sharedSnippets`, `dedupedRefs`, `estimatedSaved`
- **Per run**: `totalTokensSaved` accumulated across all chain batches, reported in `done` event
- **Per function**: token usage divided equally among targets in the batch (same as linear batching)

## Concurrency & Overlap

Chain batches can overlap with parallel workers analyzing functions that share callers/callees. Strategy: **allow duplicate decisions, resolve later**. Each decision has a unique `session_id: analyze-chain-{date}` and goes through `connect-decisions` grouping which deduplicates by comparing summaries.

## UI

- **Chain Analysis toggle** (run.html) — when on, batch size is auto-managed (default 8); when off, manual batch size applies
- **Tokens Saved stat** — shown in progress header during analysis
- **[chain: centerFn]** tag — displayed next to each function-start event
- **chain-stats events** — streamed via SSE, update the tokens-saved counter in real time

## Metrics from Claude Code repo test

| Metric | Value |
|--------|-------|
| Total functions | 11,991 |
| CALLS edges | 17,023 |
| Graph density | 1.33 edges/fn |
| Chain batches | 745 (3,702 functions) |
| Linear batches | 929 (4,644 functions) |
| Batches trimmed | 9 |
| Chain coverage | 44% of functions |

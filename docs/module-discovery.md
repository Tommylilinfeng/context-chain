# Semantic Module Discovery — Design Doc

## Problem

Analyzing a codebase function-by-function is expensive (~30-45M tokens for a large repo) and produces flat decisions with no structural context. We need a way to discover the semantic module structure of a codebase cheaply, so that:

1. Analysis can be scoped per-module instead of per-function
2. Cross-module relationships can be discovered (the key value AST alone can't provide)
3. Users get a human-readable map of their codebase architecture

## Approach: AST Community Detection + LLM Reasoning

### Why not just AST?

Louvain community detection on the function call graph gives structural clusters, but:
- Hub functions (logging, config, utils) connect unrelated modules into one giant cluster
- A single file can contain functions belonging to different modules
- Structural clusters don't have semantic names

### Why not just LLM?

Feeding 12K function names to an LLM and asking "what are the modules?" would work but:
- No structural grounding — LLM might hallucinate module boundaries
- Expensive if you include code
- No way to validate without code structure

### Solution: Both

1. **Louvain on CALLS subgraph** (zero tokens) → structural clusters
2. **Hub removal** (in-degree > threshold) → prevents utility functions from merging unrelated clusters
3. **LLM Round 1** (~2K tokens) → names clusters semantically, with function signatures + call edges as evidence
4. **LLM Round 2** (~11K tokens) → reviews boundary functions (high cross-module caller ratio), adjusts memberships

Total: ~13K tokens, 2-3 LLM calls, ~3 minutes.

## Key Design Decisions

### Many-to-many module membership

A function can belong to multiple modules. This is intentional:
- `formatError()` genuinely serves both Permission System and API Client
- Shared functions are a natural signal for cross-module coupling
- Forcing single-module assignment distorts the actual architecture

### Hub removal threshold

Default: functions called by >20 other functions are excluded from community detection. These are infrastructure (logging, config, fs operations) that would collapse all modules into one. After module discovery, hub functions can be assigned to a "Shared Infrastructure" module or left unassigned.

### Boundary function detection

After Round 1, we compute for each function:
- **in-ratio**: fraction of callers from the same module
- **out-ratio**: fraction of callers from other modules

Functions with out-ratio > 0.3 and callers from ≥2 modules are "boundary functions" — candidates for multi-module membership or reassignment.

### Round 2 is global, not per-module

Unlike the original design (per-module validation that couldn't move functions across modules), Round 2 sees all module names + boundary functions with their caller distribution. It can add a function to additional modules or remove it from a misassigned one.

## Pipeline Steps

```
detectFunctionCommunities()     Zero-cost: Louvain on CALLS subgraph
        ↓
enrichCommunities()             Zero-cost: add signatures + call edges from graph/disk
        ↓
runRound1()                     ~2K tokens: LLM names semantic modules
        ↓
findBoundaryFunctions()         Zero-cost: graph query for cross-module callers
        ↓
runRound2()                     ~11K tokens: LLM reviews boundary assignments
        ↓
applyEdits()                    Zero-cost: update module memberships
        ↓
writeModulesToGraph()           Write SemanticModule nodes + BELONGS_TO edges
```

## Key Files

| File | Role |
|------|------|
| `src/prompts/module-discovery.ts` | Prompt templates + types for R1 and R2 |
| `src/ingestion/module-discovery.ts` | Pipeline orchestration, community detection, graph queries, boundary analysis |
| `src/runners/discover-modules.ts` | CLI entry point |

## Graph Schema

```cypher
-- Module node
(:SemanticModule {id, name, description, repo, confidence, function_count, created_at, source})

-- Many-to-many membership
(:CodeEntity {entity_type:'function'})-[:BELONGS_TO]->(:SemanticModule)
```

Idempotent: existing SemanticModule nodes for the repo are deleted before writing.

## Metrics (Claude Code repo, 11,991 functions)

| Metric | Value |
|--------|-------|
| Hub functions removed | 78 (in-degree > 20) |
| AST communities detected | 72 (≥10 functions each) |
| R1 proposed modules | 27 |
| R2 boundary functions reviewed | 150 |
| R2 edits applied | 83 |
| Final modules | 27 |
| Total tokens | 12,874 |
| Duration | 188s |

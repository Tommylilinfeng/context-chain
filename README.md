# Context Chain

A local knowledge graph that extracts design decisions from your codebase, serves them to your coding AI via MCP, and bridges the context window gap among teammates.

Existing context engineering tools (OpenSpec, Git-AI, Dexicon) capture knowledge at the spec or repo level. Context Chain goes deeper:

- **Function-level anchoring** — decisions are tied to specific functions via Joern CPG, not floating above the repo
- **Automatic staleness detection** — code changes flag affected decisions; knowledge doesn't silently rot
- **Decision-level extraction** — not prompt summaries or raw transcripts, but _what was chosen, what was rejected, and why_
- **Decision relationships** — `CAUSED_BY`, `DEPENDS_ON`, `CONFLICTS_WITH` edges across a graph, not flat files
- **Runs overnight on your subscription** — uses `claude -p` or `codex exec` (Claude CLI / Codex CLI), no API costs, doesn't eat your daytime quota

```
Codebase → Joern CPG → LLM extracts decisions per function
    → Memgraph (graph DB) → MCP Server (9 tools)
        → Claude Code queries context while you code
```

> **System requirements:** Context Chain relies on **Memgraph** (graph database, ~1.5 GB) and **Joern** (code analysis, ~2 GB) — expect **~3.5 GB+ disk space** and Docker installed. This is a relatively heavy local tool, not a lightweight plugin.

**Website:** [usecontextchain.com](https://usecontextchain.com)

---

## Roadmap

| Area | What's coming |
|------|--------------|
| Consumption layer | Immersive KT system and team knowledge map — help _people_ understand the codebase, not just AI |
| Agent support | Currently Claude Code; adding Cursor, Windsurf, Cline, Copilot, and other MCP-compatible agents |
| Multi-source ingestion | Slack threads, Notion docs, meeting transcripts — not just code and AI sessions |
| Spec-driven workflow | OpenSpec-style proposal → spec → design → implement, with decisions auto-anchored after implementation |

---

## Quick Start

```bash
# Prerequisites: Node.js 18+, Docker, Claude CLI
# (Java and Joern are auto-installed by setup if missing)
git clone https://github.com/Tommylilinfeng/context-chain.git
cd context-chain && npm run setup
```

```bash
# Start Memgraph (wait for it to be ready before proceeding)
docker compose up -d
```

```bash
# Start the Dashboard
npm run dashboard
# → http://localhost:3001
```

From the Dashboard:

1. **System** → Add your repo (name, path, language)
2. **System** → Generate CPG (Joern code analysis)
3. **System** → Full Setup (schema + import code structure)
4. **Run** → Execute analysis → decisions appear, then **Group** to connect them

Or from CLI:

```bash
npm run db:schema                                         # init schema
npm run ingest:cpg -- --file data/your-repo.json          # import code structure
npm run analyze -- --repo my-repo                         # full scan (Ctrl+C to pause, --continue to resume)
npm run mcp                                               # start MCP server
```

### Connect to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "context-chain": {
      "command": "/bin/bash",
      "args": ["/path/to/context-chain/mcp-start.sh"]
    }
  }
}
```

Or use the install script: `bash scripts/install-hooks.sh /path/to/your/project`

Now when Claude Code works on your codebase, it can query "why was this written this way?" and get real answers.

---

## What gets extracted

Not descriptions of what code does (any AI can read source for that) — but **decisions**: what was chosen, what was rejected, why, and what tradeoffs were accepted. Each decision is anchored to specific functions and linked to related decisions. When your coding AI later touches that function, relevant decisions surface automatically via MCP.

---

## Five-slot retrieval

When your coding AI asks for context, Context Chain searches five channels in priority order:

1. **Code anchor** — exact function/file match in the graph
2. **Keywords** — inverted index match (business terms like "refund", "auth" that don't exist in code)
3. **Decision relationships** — one-hop expansion along CAUSED_BY / DEPENDS_ON / CONFLICTS_WITH edges
4. **Semantic similarity** — vector search fallback (catches "idempotency" when you searched "prevent duplicate charges")
5. **Metadata filters** — staleness, recency, owner — applied on top of all results

Progressive disclosure: summaries first, full content on demand.

---

## Core architecture

### analyze_function — the building block

All decision extraction goes through one module: give it a function name + config, it queries the graph for callers/callees, reads source code, calls the LLM, and outputs structured decisions.

Highly configurable via a template system (JSON files with inheritance):

```bash
npm run analyze -- --list-templates                           # see available templates
npm run analyze -- --function createOrder --file store/orderStore.js --repo my-repo
npm run analyze -- --repo my-repo --template deep-analysis    # full scan with a specific template
npm run analyze -- --repo my-repo --continue                  # resume interrupted scan
```

Configuration dimensions: context depth (caller/callee hops), code granularity (full/truncated/signature), output control (finding types, max decisions, language), prompt templates, AI provider.

### MCP Server

Single tool: `get_context_for_code` — five-channel fused retrieval (anchor, keyword, relationship, vector). Supports summary/detail modes and single-decision expansion with relationship chains.

### Dashboard

Web UI for browsing decisions, visualizing coverage gaps, managing pipelines, and configuring repos. Supports EN/ZH.

```bash
npm run dashboard    # http://localhost:3001
```

### Refinement pipeline

Runs overnight to keep the graph accurate:

```bash
npm run refine                       # all tasks
npm run refine -- --only staleness   # single task
```

Tasks: staleness detection (compare against git HEAD), anchor precision upgrade, keyword normalization, decision edge completion, gap detection (high-complexity functions with zero coverage).

---

## Configuration

`ckg.config.json` in project root (see `ckg.config.example.json`):

```json
{
  "project": "my-project",
  "ai": { "provider": "claude-cli" },
  "repos": [
    {
      "name": "my-service",
      "path": "/absolute/path/to/repo",
      "type": "backend",
      "cpgFile": "data/my-service.json"
    }
  ]
}
```

AI providers: `claude-cli` (Anthropic subscription), `codex-cli` (OpenAI subscription), or `anthropic-api` (direct API key). Set in config or Dashboard.

---

## Data model

### Node types

```
CodeEntity        — Code structure: service / file / function / api_endpoint
DecisionContext   — Design decision: why, tradeoffs, rejected alternatives
AggregatedSummary — Aggregated summary (generated by refinement)
```

### Edge types

```
# Code structure (from Joern / LLM)
CONTAINS          — service -> file -> function
CALLS             — function calls function
CALLS_CROSS_REPO  — cross-repo function call
DEPENDS_ON_API    — cross-service API dependency
ACCESSES_TABLE    — function accesses database table

# Decision anchoring
ANCHORED_TO       — DecisionContext -> CodeEntity (precise)
APPROXIMATE_TO    — DecisionContext -> CodeEntity (fuzzy)

# Decision relationships
CAUSED_BY         — decision A exists because of decision B
DEPENDS_ON        — decision A requires decision B
CONFLICTS_WITH    — decisions A and B have tension/tradeoff
CO_DECIDED        — made together in the same decision session
SUPERSEDES        — new decision replaces old decision
```

---

## Tech stack

| Component | Technology |
|-----------|-----------|
| Graph DB | Memgraph |
| Code analysis | Joern (CPG) |
| Decision extraction | Claude CLI / Codex CLI / Anthropic API |
| Embedding | Voyage AI (optional) |
| MCP Server | TypeScript + `@modelcontextprotocol/sdk` |
| Dashboard | Hono + vanilla HTML/JS |
| Container | Docker Compose |

---

## All commands

```bash
# Infrastructure
docker compose up -d               # Start Memgraph
npm run db:schema                  # Initialize schema
npm run db:reset                   # Clear entire graph

# Core — analyze_function
npm run analyze -- --list-templates                     # List templates
npm run analyze -- --function X --file Y --repo Z       # Single function
npm run analyze -- --repo Z                             # Full scan
npm run analyze -- --repo Z --continue                  # Resume from checkpoint

# Code structure
npm run ingest:cpg -- --file X     # Import CPG
npm run link:repos                 # Cross-repo calls
npm run link:services              # Cross-service dependencies
npm run link:tables                # Table access relationships

# Pipelines
npm run cold-start:v2 -- --goal X  # Cold-start 4-round pipeline
npm run ingest:sessions:v2         # Session ingestion

# Refinement
npm run refine                     # All 5 refinement tasks
npm run embed:decisions            # Generate embeddings

# Services
npm run mcp                        # MCP Server
npm run dashboard                  # Dashboard (localhost:3001)
```

---

## Status

Core pipeline (analyze_function + full-scan runner + MCP Server + Dashboard + session ingestion + Joern CPG + cross-repo linking) is production-tested on a multi-repo TypeScript project. Semantic vector search and refinement pipeline are code-complete.

---

## License

Apache-2.0

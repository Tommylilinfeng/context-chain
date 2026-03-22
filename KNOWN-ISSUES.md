# Known Issues

## `parse-sql.ts` — Cross-repo table references silently dropped

**Date:** 2026-03-19

The post-processing validation in `parse-sql.ts` filters out edges whose callee node doesn't exist in the extracted node set. This correctly eliminates false positives (PL/pgSQL variables, singular/plural table name mismatches), but has a side effect:

If a SQL function in repo A references a table defined in repo B, and `parse-sql` is run against repo A alone, the table node won't be in repo A's extracted set — so the edge gets dropped.

This is currently acceptable because cross-repo dependencies are handled separately by `link-services.ts`, not by intra-repo `parse-sql` edges. But if we ever consolidate SQL migrations from multiple repos into a single parse run, this validation would need to be scope-aware (validate against nodes from all repos, not just the current one).

---

## `ACCESSES_TABLE` edges need a toggle in MCP consumption layer

**Date:** 2026-03-19

`link-tables.ts` creates `ACCESSES_TABLE` edges (function → table) from `supabase.from()` calls. These are precise and useful, but there are a lot of them (59 currently). When coding AI queries the graph for context, including all table access edges may flood the context window.

The MCP server (`get_cross_repo_dependencies` and future tools) should expose an option to include/exclude `ACCESSES_TABLE` edges, defaulting to off. This way users or coding AI can opt in when they need to understand data flow, and opt out when they only care about API-level dependencies.

Not implemented yet — waiting until the MCP consumption layer is more mature before adding toggles.

---

## Session Ingestion v2 — 开放问题

**Date:** 2026-03-21

### Cold-start session 自动过滤

`~/.claude/projects/` 下有大量 cold-start pipeline 跑 `claude -p` 产生的 session（`queue-operation` 类型），这些不是交互式编码。Phase 0 是否应该自动检测并跳过？检测方式：整个 session 只有 1 轮 user + 1 轮 assistant，或第一条是 `queue-operation`。

### 多 repo session

一个 session 可能跨多个 repo（比如 `cwd` 变化了）。目前 `projectNameFromDir` 只取最后一段。要不要支持一个 session 拆到多个 repo？

### Dashboard Phase 1 交互的中间状态

先做 CLI，但 Dashboard 版本需要一个中间状态——Phase 1 分段结果存在哪里等待用户审批？存文件？存 Memgraph 临时节点？

### 与 v1 session 决策的关系

v1 已经处理过一些 session 产生了决策。v2 跑同一个 session 会产生更好的决策。是否自动替换 v1 的结果？还是共存？

### Phase 2 token 预算

单个 segment 的原始对话 + 图谱上下文 + prompt 可能超过 context window。需要估算并设上限，超过时对原始对话做截断。

### 无代码锚点的决策（anchoring fallback）

有些 session 讨论了架构决策但没有写代码（纯讨论），或者讨论的内容不对应任何具体文件/函数（比如"要不要从 REST 切到 GraphQL"）。当前 `batchWriteDecisions` 的 fallback 链是：函数级 → 文件级 → 无锚点（孤立节点）。孤立节点无法被 MCP 的 `get_context_for_code` 查到（它从代码节点出发沿边查）。

需要加一层 service 级 fallback：函数匹配失败 → 文件匹配失败 → APPROXIMATE_TO service 节点（从 session 的 cwd/projectName 推断 repo）。这样 MCP 查 service 下所有 context 时能捞到。

### Git 联动（暂不做）

Session → commit 时间匹配、commit hash 存入 DecisionContext、diff 作为 Phase 2 上下文、staleness 检测。方案已设计（见 session-ingestion-v2-design.md 第七节），暂不实现。

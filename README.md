# Context Knowledge Graph (CKG)

> **grep 找的是代码写了什么，我们记录的是代码为什么这样写。**

---

## 为什么你需要这个

**你的 AI agent 半夜闲着，你的 subscription 在浪费。** CKG 让你的 agent 在你睡觉的时候持续工作——分析代码、提取决策、构建知识图谱。所有 pipeline 走 `claude -p`（Claude Code CLI），用的是你已有的 subscription，不需要 API key，不额外花钱。一夜之间，你的整个代码库的设计决策就被自动提取并结构化了。

**CKG 的核心是一个 context 仓库，不是一个分析工具。** 我们自带了多条 ingestion pipeline（从代码分析、AI 对话记录、会议纪要等渠道自动提取 context），但这些只是入口。CKG 的真正价值是：**一个统一的、结构化的、可被任何 AI agent 查询的知识存储层。** 你可以把任何非标的 context 挂进来——架构决策、产品需求、技术选型理由、踩过的坑——通过 MCP 协议，所有 coding AI 都能在写代码时自动获取这些上下文。

我们想成为每个开发者都会用的 AI context 仓库。

---

## 它解决什么问题

在 AI 写代码的时代，开发者与 AI 的对话中包含大量决策理由——为什么选方案 A 而不是 B、当时还考虑过什么、这个 trade-off 是什么。但这些信息随着对话窗口关闭永久丢失。

新功能、新成员、甚至三个月后的自己，都无法知道"为什么这样写"。

CKG 把这些散落的决策自动提取、存储为知识图谱，并通过 MCP 协议喂给 Claude Code / Cursor，让 AI 在写代码时知道"这里为什么这样设计"。

---

## 架构概览

```
你的代码仓库
    │
    ├── Joern (CPG 静态分析)
    │       └── CodeEntity 节点 + CALLS/CONTAINS 边
    │
    ├── Cold-start pipeline (4 轮，可半夜自动跑)
    │       ├── Round 1: LLM 选相关文件
    │       ├── Round 2: 每个文件筛选值得分析的函数
    │       ├── Round 3: 每个函数独立深度分析 + 分类
    │       └── Round 4: 决策分组 → 关系边 + 关键词归一化
    │
    ├── Session ingestion pipeline
    │       └── 读 ~/.claude/projects/*.jsonl → 提取决策
    │
    └── 手动录入 / 任何自定义来源
            └── Business Context、架构说明、产品需求...
                        ↓
                  Memgraph 图数据库 (context 仓库)
                        ↓
                  MCP Server → Claude Code / Cursor 自动获取上下文
```

---

## 两种使用方式

### 1. 自动提取（用我们的 pipeline）

```bash
# 半夜跑：分析整个代码库，提取设计决策
npm run cold-start:v2 -- --goal "全部功能" --owner me --force

# 增量跑：只分析改动过的文件
npm run cold-start:v2 -- --goal "订单和支付"

# 从 Claude Code 对话记录提取
npm run ingest:sessions
```

### 2. 手动录入（挂任何 context）

通过 Dashboard 或直接写入 Memgraph，把任何你觉得重要的 context 挂到代码节点上：

- 架构决策文档
- 产品需求和 spec
- 技术选型理由
- 踩坑记录
- 会议讨论结论

消费端（MCP）不区分 context 来源。AI 只看"对当前任务有没有用"。

---

## 技术栈

| 组件 | 技术 | 用途 |
|------|------|------|
| 图数据库 | Memgraph | 存储代码结构 + 决策节点（context 仓库） |
| 可视化 | Memgraph Lab | 图谱浏览和查询 |
| 代码分析 | Joern | 生成 CPG（代码属性图） |
| 决策提取 | `claude -p`（subscription） | 从代码和对话中提取决策 |
| MCP Server | TypeScript + `@modelcontextprotocol/sdk` | 对外暴露查询接口 |
| 运行时 | Node.js / TypeScript | 所有脚本和服务 |
| 容器 | Docker Compose | Memgraph + Lab |

---

## 数据模型

### 节点类型

```
CodeEntity        — 代码实体：service / file / function / api_endpoint
DecisionContext   — 设计决策：为什么这样写、当时考虑过什么、trade-off 是什么
AggregatedSummary — 聚合摘要（后台精炼生成，暂未实现）
```

### 边类型

```
# 代码结构（来自 Joern）
CONTAINS          — 服务→文件→函数
CALLS             — 函数调用函数
DEPENDS_ON_API    — 跨服务 API 依赖（LLM 推断）

# 决策锚定
ANCHORED_TO       — DecisionContext → CodeEntity（精确）
APPROXIMATE_TO    — DecisionContext → CodeEntity（模糊）

# 决策关系
CAUSED_BY         — 决策 A 是因为决策 B
DEPENDS_ON        — 决策 A 依赖决策 B 成立
CONFLICTS_WITH    — 决策 A 和 B 有张力/trade-off
CO_DECIDED        — 同一次决策中一起做出的
```

---

## Cold-start Pipeline（4 轮）

**Round 1 — 选文件：** 给一个 goal（如"订单和支付"），LLM 从 CPG 的文件列表中选出相关文件。

**Round 2 — 筛函数：** 每个文件一个 session。LLM 看完整代码 + CPG 依赖关系 + Business Context，判断哪些函数值得深入分析。

**Round 3 — 深度分析：** 每个函数单独一个 session。LLM 看函数完整代码 + 所有 caller/callee 的完整代码（跨文件）+ Business Context，提取决策并分类（decision / suboptimal / bug）。

**Round 4 — 关系和归一化：**
- 4a: 一次 LLM 调用，把所有决策 summary + CPG 调用提示传入，返回相关决策的分组
- 4b: 每个分组一次 LLM 调用，传入 full content，确定具体关系边（CAUSED_BY / DEPENDS_ON 等）
- 关键词归一化: 一次轻量调用，合并同义词（"鉴权" = "auth" = "认证"）

---

## 可用命令

```bash
# 基础设施
docker compose up -d           # 启动 Memgraph（http://localhost:3000 看图谱）
npm run db:schema              # 初始化索引和约束
npm run db:reset               # 清空图谱（谨慎）

# 代码结构导入
joern --script joern/extract-code-entities.sc \
  --param cpgFile=path/to.cpg.bin \
  --param outFile=data/output.json   # 从 CPG 提取代码结构

npm run ingest:cpg -- --file data/output.json  # 导入代码结构

# Cold-start（可半夜跑）
npm run cold-start:v2 -- \
  --goal "全部功能" \
  --repo bite-me-website \
  --owner me \
  --force                       # 全量分析

npm run cold-start:v2 -- \
  --goal "订单和支付" \
  --concurrency 3               # 增量分析，3 并发

# Session 摄入
npm run ingest:sessions         # 从 Claude Code 对话记录提取决策
npm run ingest:sessions -- --project bite-me-website  # 指定项目

# MCP Server
npm run mcp                    # 启动（通常由 Claude Code 自动管理）

# Dashboard
npm run dashboard              # http://localhost:3001
```

---

## MCP 工具（Claude Code 可调用）

| 工具 | 说明 |
|------|------|
| `get_code_structure` | 查某个文件/服务下有哪些函数 |
| `get_callers` | 查谁调用了某个函数（上游依赖） |
| `get_callees` | 查某个函数调用了谁（下游依赖） |
| `get_context_for_code` | 查某个文件/函数背后的设计决策 |
| `get_cross_repo_dependencies` | 查跨 repo / 跨服务的依赖关系 |

### 在业务 repo 里配置 MCP

在 `your-repo/.mcp.json`（建议加入 `.gitignore`）：

```json
{
  "mcpServers": {
    "context-knowledge-graph": {
      "command": "/bin/bash",
      "args": ["/path/to/context-knowledge-graph/mcp-start.sh"]
    }
  }
}
```

---

## 设计原则

**1. 存储优先，pipeline 只是入口**
CKG 是一个 context 仓库。自带的 pipeline 覆盖了常见的 ingestion 场景，但你可以把任何来源的 context 写进来。MCP 查询不关心 context 从哪来。

**2. Subscription 友好，半夜跑**
所有 LLM 调用走 `claude -p`，用你已有的 Claude Max subscription。Pipeline 设计为可以在低峰时段自动运行，充分利用你的 subscription 额度。

**3. 消费端不区分来源**
DecisionContext 不管来自 cold-start、session 摄入、手动录入还是 API 写入，MCP 查询结果一视同仁。`confidence` 字段仅供后台精炼管线内部使用。

**4. 图谱是辅助，不是必要**
所有摄入 pipeline 都会尝试查图谱获取调用上下文，但查不到不影响流程。

**5. 状态追踪避免重复**
增量分析只处理改动过的文件。`data/cold-start-state.json` 记录每个文件的分析状态。

---

## 目录结构

```
context-knowledge-graph/
├── docker-compose.yml              # Memgraph + Memgraph Lab
├── ckg.config.json                 # Repo 配置
├── mcp-start.sh                    # MCP Server 启动脚本
├── joern/
│   └── extract-code-entities.sc   # Joern 脚本：CPG → JSON
├── data/
│   ├── ingested-sessions.json     # 已处理 session 状态
│   └── cold-start-state.json      # 增量分析状态
└── src/
    ├── prompts/
    │   └── cold-start.ts          # 4 轮 prompt 模板
    ├── db/
    │   ├── client.ts              # Memgraph 连接
    │   ├── schema.ts              # 索引 + 约束
    │   ├── reset.ts               # 清空图谱
    │   └── graphContext.ts        # 图谱上下文查询（共享模块）
    ├── ingestion/
    │   ├── cold-start-v2.ts       # 4 轮 pipeline
    │   ├── ingest-cpg.ts          # CPG JSON → Memgraph
    │   ├── ingest-sessions.ts     # Claude Code 对话 → 决策
    │   ├── git-utils.ts           # git change detection
    │   └── state.ts               # 增量分析状态
    ├── mcp/
    │   └── server.ts              # MCP Server（5 个工具）
    └── dashboard/
        ├── server.ts              # Dashboard API + SSE
        └── public/                # Dashboard UI
```

---

## 下一步

- [ ] **后台精炼管线** — 夜间自动优化锚定精度、staleness 检测、摘要层生成
- [ ] **Session ingestion v2** — 升级到 CPG 感知的函数级锚定
- [ ] **消费层** — 出题式 KT、知识地图、团队知识覆盖可视化
- [ ] **团队共享** — Transcript 多人共享存储方案
- [ ] **向量搜索** — Memgraph 内置向量 or 独立向量库，实现语义兜底检索

# Context Graph

> **grep 找的是代码写了什么，我们记录的是代码为什么这样写。**

---

## 为什么你需要这个

在 AI 写代码的时代，开发者与 AI 的对话中包含大量决策理由——为什么选方案 A 而不是 B、当时还考虑过什么、这个 trade-off 是什么。但这些信息随着对话窗口关闭永久丢失。新功能、新成员、甚至三个月后的自己，都无法知道"为什么这样写"。

Context Graph 把这些散落的决策自动提取、存储为知识图谱，并通过 MCP 协议喂给 Claude Code / Cursor。

**核心架构分三层：**

1. **图谱层（neutral 存储+检索平台）** — Memgraph 图数据库，五槽位检索模型，不关心数据从哪来
2. **Building block 层** — `analyze_function` 核心模块：输入一个函数 + 配置 → 查图谱 → 读代码 → 调 AI → 输出决策。高度可定制（上下文深度、代码粒度、prompt 模板、输出类型），用户可以保存多个模板
3. **Runner 层** — 编排 building block 的执行方式。内置 full-scan runner（遍历 repo 所有函数，可暂停恢复），也可以自己写 runner

Pipeline（cold-start、session ingestion）是参考实现，不是唯一入口。

---

## Quick Start

```bash
# 1. 启动 Memgraph
docker compose up -d

# 2. 初始化 schema
npm run db:schema

# 3. 导入代码结构（需要先用 Joern 生成 CPG）
npm run ingest:cpg -- --file data/your-repo.json

# 4. 分析单个函数试试效果
npm run analyze -- --function createOrder --file store/orderStore.js --repo my-repo

# 5. 全量扫描（可 Ctrl+C 暂停，--continue 恢复）
npm run analyze -- --repo my-repo --cleanup

# 6. 启动 MCP Server（Claude Code / Cursor 自动调用）
npm run mcp
```

---

## analyze_function — 核心 Building Block

所有决策提取最终都通过这个模块。它是高度可配置的：

### 配置维度

| 维度 | 可配置项 |
|------|---------|
| 上下文深度 | `caller_depth` (0-2层), `callee_depth` (0-2层), `max_callers_per_level`, `include_cross_repo`, `include_table_access` |
| 代码粒度 | `target_code` (full/truncated/signature_only), `caller_code`, `callee_code`, `target_max_lines`, `include_file_context` |
| 输出控制 | `finding_types` (decision/suboptimal/bug), `max_decisions`, `summary_length`, `language`, `extract_keywords` |
| Prompt | `prompt_template` (自定义模板), `system_prompt`, `custom_context` |
| AI | `ai_provider`, `model`, `timeout_ms` |

### 模板系统

配置保存为 JSON 模板文件，支持继承：

```
templates/
  _default.json           ← 内置默认值（所有字段）
  quick-scan.json         ← extends _default, 只 override 想改的字段
  deep-analysis.json
  your-custom.json
```

```json
// templates/quick-scan.json
{
  "name": "Quick Scan",
  "description": "快速扫描，不看上下游",
  "extends": "_default",
  "caller_depth": 0,
  "callee_depth": 0,
  "finding_types": ["decision"],
  "max_decisions": 2
}
```

### CLI

```bash
# 列出可用模板
npm run analyze -- --list-templates

# 单函数分析
npm run analyze -- --function addItem --file store/cartStore.js --repo bite-me-website

# 指定模板
npm run analyze -- --function addItem --file store/cartStore.js --repo bite-me-website --template deep-analysis

# 全量扫描（逐函数，可暂停恢复）
npm run analyze -- --repo bite-me-website
npm run analyze -- --repo bite-me-website --continue

# 强制重新分析所有函数
npm run analyze -- --repo bite-me-website --force

# Budget 控制
npm run analyze -- --repo bite-me-website --budget 500000

# 跑完自动清理 claude -p 产生的 session 文件
npm run analyze -- --repo bite-me-website --cleanup

# CLI 覆盖配置
npm run analyze -- --repo bite-me-website --caller-depth 2 --include-tables --language zh
```

### 作为库使用

```typescript
import { analyzeFunction, loadTemplate } from './core'

const result = await analyzeFunction(
  { functionName: 'createOrder', filePath: 'store/orderStore.js', repo: 'my-repo', repoPath: '/path/to/repo' },
  { caller_depth: 2, include_table_access: true },  // 部分覆盖
  'deep-analysis'  // 模板名
)

// result.decisions — PendingDecisionOutput[]
// result.metadata — { template_used, caller_count, callee_count, token_usage, duration_ms }
```

---

## MCP Server — 9 个工具

| 工具 | 说明 |
|------|------|
| `get_code_structure` | 查某个文件/服务下有哪些函数 |
| `get_callers` | 查谁调用了某个函数（上游依赖） |
| `get_callees` | 查某个函数调用了谁（下游依赖） |
| `search_decisions_by_keyword` | 按关键词搜索决策（倒排索引 + 全文兜底） |
| `get_context_for_code` | 五槽位融合检索 + 渐进披露（summary → detail → 单条展开） |
| `search_decisions_semantic` | 语义向量搜索（需配置 embedding provider） |
| `get_decision_relationships` | 查决策的因果/依赖/冲突关系链 |
| `get_cross_repo_dependencies` | 查跨 repo / 跨服务的依赖关系 |
| `report_context_usage` | 反馈回路：哪些决策被实际使用 |

### 五槽位检索优先级

`get_context_for_code` 按优先级依次查五个通道：

1. **P0 精确锚点** — 函数级 ANCHORED_TO 匹配
2. **P1 模糊锚点** — 文件级 APPROXIMATE_TO 匹配
3. **P2 关键词** — keywords 数组 CONTAINS 匹配
4. **P3 关系边展开** — 对 P0-P2 命中的做一跳 CAUSED_BY/DEPENDS_ON/CONFLICTS_WITH 展开
5. **P4 语义兜底** — 向量相似度搜索（需配置 embedding）

渐进披露：默认返回 summary 列表，传 `detail=true` 返回完整内容，传 `decision_id` 展开单条 + 2跳关系链。

### 接入方式

**Claude Code** — `.mcp.json`：
```json
{
  "mcpServers": {
    "context-graph": {
      "command": "/bin/bash",
      "args": ["/path/to/context-knowledge-graph/mcp-start.sh"]
    }
  }
}
```

---

## 后台精炼管线

```bash
npm run refine                          # 全部 5 个子任务
npm run refine -- --only staleness      # 只跑 staleness 检测
npm run refine -- --budget 200000       # Token 限额
```

5 个子任务：

1. **Staleness 检测** — 对比 git HEAD，标记代码已变化的决策为 stale
2. **锚点精度提升** — APPROXIMATE_TO → ANCHORED_TO 升级（当决策 summary 包含函数名时）
3. **关键词归一化** — LLM 合并同义词（"鉴权" = "auth" = "认证"）
4. **决策边补全** — 同文件决策对关系分析（CAUSED_BY / DEPENDS_ON / CONFLICTS_WITH）
5. **空洞检测** — 找出高调用量但无决策覆盖的函数，输出 `data/coverage-report.json`

---

## Dashboard

```bash
npm run dashboard    # http://localhost:3001
```

| 页面 | 功能 |
|------|------|
| Overview | 统计数字、repo 覆盖率、关键词云、最近决策 |
| Decisions | 决策列表 + 搜索 + 按类型/repo 过滤 |
| Relationships | 决策关系图可视化 |
| Coverage | 文件级/函数级决策覆盖率 |
| Dependencies | 跨 repo 依赖力导向图 |
| Feedback | 反馈日志（哪些决策被使用） |
| Sessions | Claude Code session 摄入（3阶段 pipeline） |
| **Templates** | **模板编辑器：可视化管理 analyze_function 配置** |
| Pipeline | Prompt 模板编辑器（cold-start 专用） |
| Run / Schedule | 一键运行 + 定时任务 |
| Query | 直接执行 Cypher 查询 |
| System | Memgraph 状态 + 配置验证 |

---

## 技术栈

| 组件 | 技术 | 用途 |
|------|------|------|
| 图数据库 | Memgraph | 代码结构 + 决策节点 + 关系边 |
| 可视化 | Memgraph Lab | 图谱浏览 (`localhost:3000`) |
| 代码分析 | Joern | CPG 生成（函数调用、数据流） |
| 决策提取 | `claude -p` (subscription) | 核心 AI 调用通道 |
| Embedding | Voyage AI | 语义向量搜索（可选） |
| MCP Server | TypeScript + `@modelcontextprotocol/sdk` | 9 个查询/反馈工具 |
| Dashboard | Hono + 原生 HTML/JS | 管理界面 |
| 容器 | Docker Compose | Memgraph + Lab |

---

## 数据模型

### 节点类型

```
CodeEntity        — 代码实体：service / file / function / api_endpoint
DecisionContext   — 设计决策：为什么这样写、trade-off、被否决的方案
AggregatedSummary — 聚合摘要（后台精炼生成）
```

### 边类型

```
# 代码结构（Joern / LLM）
CONTAINS          — 服务→文件→函数
CALLS             — 函数调用函数
CALLS_CROSS_REPO  — 跨 repo 函数调用
DEPENDS_ON_API    — 跨服务 API 依赖
ACCESSES_TABLE    — 函数访问数据库表
REFERENCES_TABLE  — SQL 函数查表
TRIGGERED_ON      — Trigger 绑表
TRIGGERS_FUNCTION — Trigger 调函数

# 决策锚定
ANCHORED_TO       — DecisionContext → CodeEntity（精确）
APPROXIMATE_TO    — DecisionContext → CodeEntity（模糊）

# 决策关系
CAUSED_BY         — 决策 A 是因为决策 B
DEPENDS_ON        — 决策 A 依赖决策 B 成立
CONFLICTS_WITH    — 决策 A 和 B 有张力/trade-off
CO_DECIDED        — 同一次决策中一起做出的
SUPERSEDES        — 新决策替代旧决策
```

---

## 目录结构

```
context-knowledge-graph/
├── docker-compose.yml
├── ckg.config.json                 # 项目配置：repos、AI provider
├── templates/                      # analyze_function 模板
│   ├── _default.json
│   ├── quick-scan.json
│   └── deep-analysis.json
├── src/
│   ├── core/                       # 核心 building blocks
│   │   ├── analyze-function.ts     # 单函数分析（核心模块）
│   │   ├── template-loader.ts      # 模板加载/继承/合并
│   │   ├── session-cleanup.ts      # Claude session 清理
│   │   ├── types.ts                # 类型定义
│   │   └── index.ts                # 公共 API
│   ├── runners/                    # CLI runners
│   │   ├── analyze.ts              # 单函数 + 全量扫描
│   │   └── cleanup-sessions.ts     # 独立清理命令
│   ├── ai/                         # AI provider 抽象层
│   │   ├── claude-cli.ts           # claude -p 实现
│   │   ├── anthropic-api.ts        # Anthropic API 实现
│   │   ├── embeddings.ts           # Voyage AI embedding
│   │   ├── vector-store.ts         # 本地 JSON 向量存储
│   │   └── budget.ts               # Token 预算管理
│   ├── mcp/
│   │   └── server.ts               # MCP Server（9 个工具）
│   ├── ingestion/                   # 数据摄入管线
│   │   ├── connect-decisions.ts    # 决策关系连接（PENDING 边管理 + 分组 + LLM 关系分析）
│   │   ├── normalize-keywords.ts   # 全局关键词归一化
│   │   ├── cold-start-v2.ts        # Cold-start 4 轮 pipeline（模板/参考实现）
│   │   ├── ingest-sessions-v2.ts   # Session 摄入 3 阶段 pipeline
│   │   ├── refine.ts               # 后台精炼 5 个子任务
│   │   ├── embed-decisions.ts      # Embedding 生成
│   │   ├── feedback.ts             # 反馈日志
│   │   ├── shared.ts               # 共享工具函数
│   │   ├── ingest-cpg.ts           # CPG → Memgraph
│   │   ├── link-repos.ts           # 跨 repo 调用关系
│   │   ├── link-services.ts        # 跨服务 API 依赖
│   │   ├── link-tables.ts          # 数据库表访问关系
│   │   └── parse-sql.ts            # SQL migration 解析
│   ├── prompts/                     # Prompt 模板
│   ├── db/                          # Memgraph 连接/schema
│   └── dashboard/                   # Dashboard UI + API
│       ├── server.ts
│       └── public/ (16 页面 + sidebar.js)
├── data/                            # 运行状态（git ignored）
└── joern/                           # Joern CPG 脚本
```

---

## 可用命令

```bash
# 基础设施
docker compose up -d               # 启动 Memgraph
npm run db:schema                  # 初始化 schema
npm run db:reset                   # 清空图谱

# 核心 — analyze_function
npm run analyze -- --list-templates                     # 列出模板
npm run analyze -- --function X --file Y --repo Z       # 单函数
npm run analyze -- --repo Z                             # 全量扫描
npm run analyze -- --repo Z --continue                  # 从断点继续
npm run analyze -- --repo Z --force --cleanup           # 强制重跑 + 清理

# 清理 claude -p session
npm run cleanup                    # 删除所有 pipeline session
npm run cleanup -- --dry-run       # 只扫描不删除

# 代码结构
npm run ingest:cpg -- --file X     # 导入 CPG
npm run link:repos                 # 跨 repo 调用
npm run link:services              # 跨服务依赖
npm run link:tables                # 表访问关系

# Legacy pipelines（模板/参考实现）
npm run cold-start:v2 -- --goal X  # Cold-start 4 轮
npm run ingest:sessions            # Session 摄入 v1
npm run ingest:sessions:v2         # Session 摄入 v2

# 决策关系连接
npm run connect                    # 归一化关键词 + 消化 PENDING 边
npm run connect -- --budget 200000 # 带预算限制
npm run connect -- --skip-normalize # 只连接，不归一化

# 后台
npm run refine                     # 精炼管线
npm run embed:decisions            # 生成 embedding

# 服务
npm run mcp                        # MCP Server
npm run dashboard                  # Dashboard (localhost:3001)
```

---

## Status

Working:
- ✅ analyze_function 核心模块 + 模板系统
- ✅ Full-scan runner（暂停恢复、去重、budget、进度预估）
- ✅ MCP Server（9 个工具，五槽位检索 + 渐进披露 + 反馈回路）
- ✅ 后台精炼管线（5 个子任务）
- ✅ Dashboard（16 页面，含模板编辑器）
- ✅ 语义向量搜索模块（Voyage AI + 本地向量存储）
- ✅ Session ingestion v2（3 阶段 pipeline）
- ✅ 代码结构层（Joern CPG + SQL 解析 + 跨 repo/服务/表关系）
- ✅ Pipeline session 清理（标记 + 扫描删除）

Not yet tested in production:
- ⏳ 语义向量搜索（代码写完，需配置 Voyage API key + 跑 embed:decisions）
- ⏳ 后台精炼管线（代码写完，未跑过）
- ⏳ 决策关系边（代码写完，需跑 refine 或 cold-start Round 4）

Not yet implemented:
- ⬜ connect_decisions 独立模块（关系边建立，从 pipeline 解耦）
- ⬜ 团队知识地图（Bus Factor 可视化）
- ⬜ 出题式 KT 系统（核心产品假设验证）
- ⬜ 团队共享 transcript 存储

---

## License

Apache-2.0

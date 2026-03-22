# PRD: Context Knowledge Graph — 基础设施层

> 版本：0.2
> 日期：2026年3月22日
> 范围：覆盖存储架构、核心模块、数据摄入、后台精炼。不涉及消费层（出题系统、知识地图等），除非消费层需求约束底层设计。

---

## 一、产品背景与定位

### 核心问题

在AI写代码的时代，一个人+AI可以独立完成一个微服务。项目按微服务拆分、每人独立负责时效率最高，但由此产生的知识锁死问题（Bus Factor = 1）比传统开发更严重——开发者与AI的对话中包含大量决策理由，这些理由从未被外化，随着对话窗口关闭而永久丢失。

### 产品定位

不是帮AI记住你的项目，而是帮你的团队成员真正理解你的项目。

核心价值用一句话概括：**grep找的是代码写了什么，我们记录的是代码为什么这样写。**

### 架构哲学

系统分三层，每层独立可替换：

1. **图谱层（neutral 存储+检索平台）** — Memgraph 图数据库，五槽位检索模型，不关心数据从哪来
2. **Building block 层** — `analyze_function` 核心模块，高度可配置，用户可以保存多个模板
3. **Runner 层** — 编排 building block 的执行方式。内置 full-scan runner，用户也可以自己写

Pipeline（cold-start、session ingestion）是参考实现/模板，不是必须使用的流程。

---

## 二、核心设计决策

### 决策1：Context的本质是"决策注释层"

我们构建的不是代码分析工具，而是覆盖在所有repo之上的一层**决策历史**。类似git在代码之上维护版本历史，我们在所有repo之上维护决策历史。

### 决策2：Context的寻址是多维的

同一条context可以从不同坐标系被找到：代码坐标（函数、文件）、业务坐标（退款流程、会员体系）、决策坐标（"那次讨论要不要用消息队列"）。每条context携带一个多维指纹。

### 决策3：检索精度分档

三档精度：精确锚定 → 模糊定位 → 语义兜底。不同精度对应不同检索机制，按优先级依次使用。

### 决策4：消费端不区分context来源

消费端不需要知道一条context是Owner主动确认的、AI自动推断的、还是后台精炼生成的。来源标签仅作为内部字段。

### 决策5：Pipeline 不是核心，building block 才是

`analyze_function`（分析单个函数）是整个系统最重要的模块。Pipeline 只是组装 building block 的方式之一。用户可以用我们提供的模板，也可以自己编排。

### 决策6：模块划分用逻辑scope，不物理拆图

每条context和决策节点带scope标签，查询时用scope过滤。效果等同子图，但不增加架构复杂度。

---

## 三、存储架构：五槽位模型

每条context通过五个"槽位"被索引。Hardcode的是检索通道本身，槽位内的值由AI动态提取。

### 槽位1：代码锚点（Code Anchor） —— 走图 ✅ 已实现

精确级（函数名、文件名+行号）或模糊级（目录级、服务级）。图节点索引，由近到远检索。

### 槽位2：关键词（Keywords） —— 走倒排索引 ✅ 已实现

离散精确匹配。MCP 工具 `search_decisions_by_keyword` 先走 keywords 数组匹配，再用 Memgraph 全文搜索兜底。

### 槽位3：关联决策（Decision Links） —— 走图的边 ✅ 已实现

CAUSED_BY / DEPENDS_ON / CONFLICTS_WITH / CO_DECIDED / SUPERSEDES。MCP 工具 `get_decision_relationships` 支持 N 跳展开。后台精炼管线 `refine --only edges` 自动补全同文件决策对关系。

### 槽位4：元数据（Metadata） —— 走结构化过滤 ✅ 已实现

created_at, owner, session_id, commit_hash, source, confidence, staleness, use_count, last_used_at。

### 槽位5：自由语义（Semantic Embedding） —— 走向量 ✅ 代码完成，待配置

Voyage AI embedding + 本地 JSON 向量存储 + 内存余弦相似度搜索。MCP 工具 `search_decisions_semantic`。需要配置 `ai.embedding` 并运行 `npm run embed:decisions`。

### 检索优先级 ✅ 已实现

`get_context_for_code` 按 P0→P4 依次查：精确锚点 → 模糊锚点 → 关键词 → 关系边展开 → 语义兜底。渐进披露：summary → detail → 单条展开+关系链。

---

## 四、核心模块：analyze_function ✅ 已实现

### 设计理念

Pipeline 的每一步不应该是固定 DAG 的节点。真正的核心只有一个 building block：**分析单个函数的 AI session**。全量扫描就是一个 for 循环调这个 building block。

### 配置系统（28 个配置项）

| 类别 | 配置项 |
|------|--------|
| 上下文深度 | caller_depth, callee_depth, max_callers/callees_per_level, include_cross_repo, include_table_access |
| 代码粒度 | target_code, caller_code, callee_code (full/truncated/signature_only/name_only), *_max_lines, include_file_context |
| 输出控制 | finding_types, max_decisions, summary_length, extract_keywords, language |
| Prompt | prompt_template, system_prompt, custom_context |
| Business context | include_business_context |
| AI | ai_provider, model, timeout_ms |

### 模板系统

```
templates/
  _default.json           ← 内置默认值
  quick-scan.json         ← extends _default
  deep-analysis.json      ← extends _default
```

加载逻辑：`deepMerge(_default → 中间继承链 → 目标模板 → runtimeOverrides)`。Dashboard 有可视化模板编辑器。

### Runner

`src/runners/analyze.ts` 支持：
- 单函数分析 / 全量扫描（for 循环）
- 暂停恢复（Ctrl+C → --continue）
- --force 重新分析
- --budget token 限额
- --cleanup 自动清理 claude -p session（通过注入标记 `[CKG-PIPELINE-SESSION]` 识别）
- 去重（分析前删除旧决策）
- 进度预估（ETA）
- 结果汇总（by finding_type）

---

## 五、数据摄入（Ingestion）

### 主通道：analyze_function runner ✅ 已实现

```bash
npm run analyze -- --repo my-repo                    # 全量
npm run analyze -- --repo my-repo --template quick-scan  # 用模板
npm run analyze -- --function X --file Y --repo Z    # 单函数
```

### 辅助通道：Claude Code Session 摄入 ✅ 已实现

v1（`ingest-sessions.ts`）：简单提取，文件级锚定。
v2（`ingest-sessions-v2.ts`）：3 阶段 pipeline（预处理 → LLM 分段 → 逐段深度提取），函数级锚定，Dashboard GUI 支持。

### 参考实现：Cold-start 4 轮 pipeline ✅ 已实现

`cold-start-v2.ts`：Round 1 选文件 → Round 2 Triage → Round 3 深度分析 → Round 4 关系边+关键词归一化。现在定位为模板/参考实现，核心逻辑逐步迁移到 `analyze_function`。

### 代码结构层 ✅ 已实现

- Joern CPG → `ingest-cpg.ts`
- 跨 repo 调用 → `link-repos.ts`
- 跨服务 API 依赖 → `link-services.ts`
- 数据库表访问 → `link-tables.ts`
- SQL migration 解析 → `parse-sql.ts`

---

## 六、冷启动策略

图谱为空时系统没有价值。分层策略：

### 第零层：AST骨架 ✅ 已实现
Joern 解析代码库，建立节点和边骨架。

### 第一层：LLM推断的初始Context ✅ 已实现
`analyze_function` 全量扫描所有函数。

### 第二层：已有文档提取 ✅ 部分实现
从 README、CLAUDE.md 等已有资源提取。Business Context 手动录入支持。

### 第三层：Git History分析 ✅ 已实现
`git-utils.ts` 检测文件变化，增量分析。

### 第四层：持续积累 ✅ 已实现
Session ingestion 持续捕获新的 AI coding session。

---

## 七、后台精炼管线 ✅ 代码完成，待测试

`npm run refine` — 5 个子任务：

1. **Staleness 检测** — 对比 git HEAD，标记代码已变化的决策 + 孤儿决策
2. **锚点精度提升** — APPROXIMATE_TO → ANCHORED_TO（当 summary/keywords 包含函数名时）
3. **关键词归一化** — LLM 合并同义词
4. **决策边补全** — 同文件决策对关系分析
5. **空洞检测** — 高调用量但无决策覆盖的函数，输出报告

支持 `--only` 选择性运行，`--budget` 限额。

---

## 八、反馈回路 ✅ 代码完成，待测试

MCP 工具 `report_context_usage`：
- AI 完成任务后上报 `used_ids` + `task_summary`
- 给决策 +1 `use_count`，更新 `last_used_at`
- JSONL 日志写入 `data/feedback-log.jsonl`
- Dashboard Feedback 页面展示

`get_context_for_code` 返回结果末尾附带 ID 列表，引导 AI 调用反馈。

---

## 九、MCP接口设计 ✅ 已实现

9 个工具，覆盖：

| 类别 | 工具 |
|------|------|
| 代码结构查询 | get_code_structure, get_callers, get_callees |
| 决策检索 | search_decisions_by_keyword, get_context_for_code, search_decisions_semantic |
| 关系查询 | get_decision_relationships, get_cross_repo_dependencies |
| 反馈 | report_context_usage |

---

## 十、Dashboard ✅ 已实现

16 个页面 + 统一 sidebar + 全局搜索（/）：

**Explore**：Overview, Decisions, Relationships, Coverage, Dependencies, Feedback
**Ingest**：Sessions, Templates, Pipeline, Run, Schedule, Cold Start
**Admin**：Query, System

Templates 页面提供可视化模板编辑器：左栏模板列表，右栏编辑器（4 个配置区域 + override 标记 + CLI hint）。

---

## 十一、依赖与约束

| 组件 | 用途 | License |
|------|------|---------|
| Joern | CPG 代码结构分析 | Apache 2.0 |
| Memgraph | 图数据库 | BSL 1.1 / Apache 2.0 |
| Voyage AI | Embedding（可选） | Commercial API |

---

## 十二、开放问题

1. **connect_decisions 独立模块** — 关系边建立逻辑需要从 cold-start pipeline 和 refine 中解耦，变成独立的 building block
2. **Embedding 生产部署** — Voyage API key 管理，向量存储从本地 JSON 扩展到持久化方案
3. **反馈回路闭环** — use_count 数据如何影响检索排序（当前只记录不使用）
4. **团队共享** — Transcript 多人共享存储方案
5. **消费层验证** — 出题式 KT 是否比读文档更有效（核心产品假设，未开始验证）

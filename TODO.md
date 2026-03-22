# CKG TODO

## 已完成 ✅

### 基础设施
- [x] Memgraph schema + 索引 + text search
- [x] 双 AI provider（claude-cli + anthropic-api）
- [x] 可插拔 prompt 模板系统
- [x] Multi-repo 配置（ckg.config.json）

### 数据采集
- [x] Joern CPG 导入（ingest-cpg）
- [x] Cold-start v2 四轮管线（scope → triage → deep analysis → relationships）
- [x] Session 摄入 v1 + v2（3 阶段）
- [x] 跨 repo 函数连接（link-repos）
- [x] 跨服务 API 依赖推断（link-services）
- [x] 数据库表访问关系（link-tables + parse-sql）
- [x] 增量分析 + 变更检测（state.ts + git-utils）
- [x] Embedding 生成管线（embed-decisions）

### MCP Server（9 个工具）
- [x] get_code_structure — 代码结构
- [x] get_callers / get_callees — 调用关系
- [x] search_decisions_by_keyword — 关键词倒排索引
- [x] get_context_for_code — 五槽位融合检索 + 渐进披露
- [x] search_decisions_semantic — 语义向量搜索
- [x] get_decision_relationships — 决策关系链
- [x] get_cross_repo_dependencies — 跨 repo 依赖
- [x] report_context_usage — 反馈回路

### 运维
- [x] Usage tracking（两个 provider）
- [x] Budget 控制（--budget 参数）
- [x] check-quota 脚本
- [x] install-hooks.sh 一键安装
- [x] overnight.sh 夜间管线
- [x] full-pipeline.sh 全量编排
- [x] 后台精炼管线（staleness / 锚点升级 / 关键词归一化 / 边补全 / 空洞检测）
- [x] Dashboard web UI（基础版）

---

## P0 — 本周要做

### 端到端验证
- [ ] 在真实 repo 上跑一次完整 overnight 管线，确认无报错
- [ ] 在 bite-me-website 上 install-hooks，验证 Claude Code 能调通 MCP
- [ ] 验证五槽位融合检索的输出质量（锚点 / 关键词 / 关系 / 向量都有结果）
- [ ] 测试 --budget 控制：设小预算确认管线能安全停止

### 数据质量
- [ ] 跑一次 `npm run refine --only gaps`，看覆盖率报告，识别空洞
- [ ] 检查 Round 4b 关系边质量：CAUSED_BY / DEPENDS_ON 是否合理
- [ ] 检查 keyword normalization 效果：有没有漏合并的同义词

---

## P1 — 近期

### 检索质量提升
- [ ] get_context_for_code 融合排序调优：调整 P0-P4 权重和数量上限
- [ ] 向量搜索阈值调优：当前 0.3 可能太松或太紧
- [ ] 反馈回路闭环：用 use_count / return_count 比率自动降权低质量决策
- [ ] 支持按 repo 过滤 get_context_for_code 结果

### Session 摄入
- [ ] Session v2 Dashboard UI（前端页面 + 审批流程）
- [ ] Session v2 auto-filtering：跳过单轮 pipeline 生成的 session
- [ ] Multi-repo session 处理：cd 切换 repo 的 session 如何锚定
- [ ] Session 摄入加 --budget 控制

### Dashboard
- [ ] 覆盖率可视化（热力图：哪些文件/函数有决策覆盖）
- [ ] 反馈统计页面（use_count 排行、unused 决策列表）
- [ ] 决策关系图可视化（D3.js force graph）
- [ ] 管线运行历史 + token 用量趋势

---

## P2 — 中期

### 自动化深化
- [ ] 夜间管线结果摘要通知（Slack / email / 终端通知）
- [ ] git commit hook：代码提交后自动触发增量分析
- [ ] PR review 集成：PR 涉及的函数有哪些决策需要 reviewer 知道
- [ ] 自动 staleness 恢复：stale 决策的函数代码没变太多时自动恢复为 active

### 数据模型
- [ ] AggregatedSummary 实现：文件级/模块级/repo 级决策摘要
- [ ] 多维度 scope：一个决策可以属于多个 repo
- [ ] 决策版本历史：superseded 决策链（A 被 B 取代）
- [ ] 置信度自动衰减：长时间未确认的 auto_generated 决策降低优先级

### 多用户
- [ ] owner 权限：不同人的决策谁能编辑
- [ ] 团队 session transcript 共享（安全存储 + 访问控制）
- [ ] 知识转移模式：AI 主动提问、开发者确认

---

## P3 — 远期

### 规模化
- [ ] 向量搜索迁移到 Memgraph 原生（如果支持）或 Qdrant
- [ ] 大规模 repo 性能：分片、索引优化、EXPLAIN PLAN
- [ ] npm 发布优化：ctgraph 二进制分发

### 生态集成
- [ ] VS Code 插件：编辑器侧边栏显示当前函数的决策
- [ ] GitHub Action：CI 里自动检查 PR 是否违反已有决策
- [ ] Cursor / Windsurf 等 IDE 的 MCP 集成
- [ ] OpenAI / Gemini provider 适配（不只 Claude）

### 高级分析
- [ ] 决策矛盾自动检测：CONFLICTS_WITH 链上的决策同时被引用时告警
- [ ] 技术债务热力图：suboptimal + bug 类型决策按区域聚合
- [ ] 决策影响传播：改了一个决策后，DEPENDS_ON 链上哪些需要 review

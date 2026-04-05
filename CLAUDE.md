
## CKG 上下文图谱

本项目接入了 Context Knowledge Graph（CKG），提供设计决策上下文。

### 自动查询
修改代码前，用 `get_context_for_code` 查询相关设计决策：
- 输入文件名或函数名
- 默认返回摘要列表，传 `detail=true` 获取完整内容
- 传 `decision_id` 展开单条决策的关系链

`get_context_for_code` 内部融合了锚点、关键词、关系链、向量四通道检索，是唯一需要的工具。

## 测试规则

Runner 会调用 LLM API，消耗 token 预算。**禁止直接全量运行 runner 来验证代码。**

### 验证新代码的正确方式
1. **编译检查**：`npm run build` — 零成本，优先使用
2. **Dry run**：所有 runner 都支持 `--dry-run`，只走逻辑不调 LLM、不写库
3. **限量运行**：需要验证 LLM 交互时，必须加限制：
   - `npm run analyze -- --repo X --budget 50000` (token 上限)
   - `npm run design-analysis -- --repo X --limit 1 --dry-run` (AI 调用次数上限)
   - `npm run connect -- --budget 50000`
   - `npm run localize -- --batch-size 2 --dry-run`
4. **单函数模式**：`npm run analyze -- --repo X --function fnName --file path --dry-run`

### 绝对禁止
- 不加 `--budget` / `--limit` / `--dry-run` 直接运行全量扫描
- 连续多次运行 runner "看看效果"
- 在不确定代码正确性时就跑真实 LLM 调用

## 已知问题 / TODO

### Prompt 数量硬编码
所有 prompt 里的数量约束都是写死的，应改为根据输入规模动态计算：
- `module-discovery.ts:109` — `Aim for 15-30 modules`
- `design-analysis.ts:220` — `Sub-modules should have 3+ functions`
- `design-analysis.ts:221` — `fewer than 5 sub-modules… (minimum 2)`
- `design-analysis.ts:303` — `Group closely related decisions (2-8 each)`
- `design-analysis.ts:305` — `Group related design choices (2-10 each)`
- `scenario-analysis.ts:107` — `Identify 5-15 typical user scenarios`
- `scenario-analysis.ts:144` — `Each scenario should have 3-10 steps`
- `grouping.ts:167` — `Extract 1-3 design decisions`

改进方向：让 prompt 根据函数数量 / 模块规模 / 调用复杂度自适应调整建议范围，而不是固定数字。


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

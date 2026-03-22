#!/bin/bash
# overnight.sh
#
# 夜间自动管线 — 用 50% 剩余额度跑完整分析 + 精炼
# 设计为 crontab 调度或手动启动
#
# 用法:
#   bash scripts/overnight.sh                          # 默认 50% 预算
#   bash scripts/overnight.sh --budget 500000          # 指定绝对预算
#   GOALS="订单流程|支付系统" bash scripts/overnight.sh  # 指定分析目标
#
# crontab 示例（每天凌晨 1 点跑）:
#   0 1 * * * cd /path/to/context-knowledge-graph && bash scripts/overnight.sh >> data/logs/overnight.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$CKG_DIR"

# ── 参数 ──────────────────────────────────────────────
BUDGET="${1:-500000}"            # 默认 50 万 token
GOALS="${GOALS:-核心业务逻辑}"
CONCURRENCY="${CONCURRENCY:-2}"
OWNER="${OWNER:-overnight}"
LOG_DIR="data/logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/overnight-$TIMESTAMP.log"

echo "============================================" | tee "$LOG_FILE"
echo "🌙 CKG 夜间管线 — $(date)" | tee -a "$LOG_FILE"
echo "  预算: $BUDGET tokens" | tee -a "$LOG_FILE"
echo "  目标: $GOALS" | tee -a "$LOG_FILE"
echo "  并发: $CONCURRENCY" | tee -a "$LOG_FILE"
echo "  日志: $LOG_FILE" | tee -a "$LOG_FILE"
echo "============================================" | tee -a "$LOG_FILE"

# ── Phase 1: 查余额 ──────────────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "📊 Phase 1: 查询余额" | tee -a "$LOG_FILE"
npx ts-node --transpile-only scripts/check-quota.ts 2>&1 | tee -a "$LOG_FILE" || true

# ── Phase 2: Cold-start 分析 ──────────────────────────
# 按 | 分割多个目标，每个目标分配 budget 的一份
IFS='|' read -ra GOAL_LIST <<< "$GOALS"
GOAL_COUNT=${#GOAL_LIST[@]}
PER_GOAL_BUDGET=$((BUDGET * 60 / 100 / GOAL_COUNT))  # 60% 给 cold-start

echo "" | tee -a "$LOG_FILE"
echo "🧊 Phase 2: Cold-start ($GOAL_COUNT 个目标, 每个 $PER_GOAL_BUDGET tokens)" | tee -a "$LOG_FILE"

for goal in "${GOAL_LIST[@]}"; do
  goal=$(echo "$goal" | xargs)  # trim whitespace
  echo "" | tee -a "$LOG_FILE"
  echo "  → 目标: $goal" | tee -a "$LOG_FILE"
  npx ts-node --transpile-only src/ingestion/cold-start-v2.ts \
    --goal "$goal" \
    --owner "$OWNER" \
    --concurrency "$CONCURRENCY" \
    --budget "$PER_GOAL_BUDGET" \
    2>&1 | tee -a "$LOG_FILE" || true
done

# ── Phase 3: 精炼管线 ────────────────────────────────
REFINE_BUDGET=$((BUDGET * 20 / 100))  # 20% 给精炼

echo "" | tee -a "$LOG_FILE"
echo "🔧 Phase 3: 精炼 (budget: $REFINE_BUDGET tokens)" | tee -a "$LOG_FILE"
npx ts-node --transpile-only src/ingestion/refine.ts \
  --budget "$REFINE_BUDGET" \
  2>&1 | tee -a "$LOG_FILE" || true

# ── Phase 4: Embedding 更新 ──────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "🧠 Phase 4: 更新 Embedding" | tee -a "$LOG_FILE"
npx ts-node --transpile-only src/ingestion/embed-decisions.ts \
  2>&1 | tee -a "$LOG_FILE" || true

# ── Phase 5: Session 摄入 ────────────────────────────
SESSIONS_BUDGET=$((BUDGET * 20 / 100))  # 20% 给 session

echo "" | tee -a "$LOG_FILE"
echo "💬 Phase 5: Session 摄入" | tee -a "$LOG_FILE"
npx ts-node --transpile-only src/ingestion/ingest-sessions-v2.ts \
  --concurrency "$CONCURRENCY" \
  2>&1 | tee -a "$LOG_FILE" || true

# ── 完成 ─────────────────────────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "============================================" | tee -a "$LOG_FILE"
echo "✅ 夜间管线完成 — $(date)" | tee -a "$LOG_FILE"
echo "  日志: $LOG_FILE" | tee -a "$LOG_FILE"
echo "============================================" | tee -a "$LOG_FILE"

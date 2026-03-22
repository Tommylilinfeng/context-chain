#!/bin/bash
# full-pipeline.sh
#
# 全量分析编排脚本 — 一键完成从 CPG 生成到决策提取的完整流水线
# 适合晚上跑，支持 concurrency、phase 跳过、dry-run 等参数
#
# 用法:
#   bash scripts/full-pipeline.sh [OPTIONS]
#
# 选项:
#   --goals "goal1|goal2|..."     cold-start 分析目标（用 | 分隔多个目标）
#   --concurrency N               LLM 并发数（默认 2）
#   --owner NAME                  决策归属人（默认 me）
#   --repo NAME                   只分析指定 repo（默认全部）
#   --force                       强制重新分析所有文件（忽略变更检测）
#   --deep-check                  依赖变更也触发重新分析
#   --dry-run                     试运行，不写入数据库
#
#   --skip-joern                  跳过 Joern CPG 生成
#   --skip-ingest                 跳过 Memgraph 导入
#   --skip-link                   跳过跨服务连接
#   --skip-cold-start             跳过 cold-start 决策提取
#   --skip-sessions               跳过 session 摄入
#   --only PHASE                  只执行指定阶段: joern|ingest|link|cold-start|sessions
#
#   --reset                       执行前清空数据库（危险！）
#   --no-schema                   跳过 schema 初始化
#   --log-dir DIR                 日志目录（默认 data/logs）
#
# 示例:
#   # 全量跑（跳过 Joern，用已有 CPG）
#   bash scripts/full-pipeline.sh --skip-joern --goals "订单流程|支付系统|优惠券"
#
#   # 高并发 + 只跑决策提取
#   bash scripts/full-pipeline.sh --only cold-start --goals "核心业务逻辑" --concurrency 4
#
#   # dry-run 测试
#   bash scripts/full-pipeline.sh --dry-run --goals "test" --concurrency 1

set -euo pipefail

# ── 常量 ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BITE_DIR="${BITE_DIR:-$(cd "$CKG_DIR/.." && pwd)/bite}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# ── 默认值 ────────────────────────────────────────────
GOALS=""
CONCURRENCY=2
OWNER="me"
TARGET_REPO=""
FORCE=false
DEEP_CHECK=false
DRY_RUN=false
SKIP_JOERN=false
SKIP_INGEST=false
SKIP_LINK=false
SKIP_COLD_START=false
SKIP_SESSIONS=false
ONLY_PHASE=""
RESET_DB=false
NO_SCHEMA=false
LOG_DIR="$CKG_DIR/data/logs"

# ── 参数解析 ──────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --goals)          GOALS="$2"; shift 2 ;;
    --concurrency)    CONCURRENCY="$2"; shift 2 ;;
    --owner)          OWNER="$2"; shift 2 ;;
    --repo)           TARGET_REPO="$2"; shift 2 ;;
    --force)          FORCE=true; shift ;;
    --deep-check)     DEEP_CHECK=true; shift ;;
    --dry-run)        DRY_RUN=true; shift ;;
    --skip-joern)     SKIP_JOERN=true; shift ;;
    --skip-ingest)    SKIP_INGEST=true; shift ;;
    --skip-link)      SKIP_LINK=true; shift ;;
    --skip-cold-start) SKIP_COLD_START=true; shift ;;
    --skip-sessions)  SKIP_SESSIONS=true; shift ;;
    --only)           ONLY_PHASE="$2"; shift 2 ;;
    --reset)          RESET_DB=true; shift ;;
    --no-schema)      NO_SCHEMA=true; shift ;;
    --log-dir)        LOG_DIR="$2"; shift 2 ;;
    *)                echo "未知参数: $1"; exit 1 ;;
  esac
done

# --only 会自动设置跳过其他阶段
if [ -n "$ONLY_PHASE" ]; then
  SKIP_JOERN=true; SKIP_INGEST=true; SKIP_LINK=true; SKIP_COLD_START=true; SKIP_SESSIONS=true
  case $ONLY_PHASE in
    joern)       SKIP_JOERN=false ;;
    ingest)      SKIP_INGEST=false ;;
    link)        SKIP_LINK=false ;;
    cold-start)  SKIP_COLD_START=false ;;
    sessions)    SKIP_SESSIONS=false ;;
    *)           echo "未知阶段: $ONLY_PHASE (可选: joern|ingest|link|cold-start|sessions)"; exit 1 ;;
  esac
fi

# ── 日志 ──────────────────────────────────────────────
mkdir -p "$LOG_DIR"
LOGFILE="$LOG_DIR/pipeline_${TIMESTAMP}.log"

log() {
  local msg="[$(date '+%H:%M:%S')] $1"
  echo "$msg" | tee -a "$LOGFILE"
}

log_phase() {
  echo "" | tee -a "$LOGFILE"
  echo "================================================================" | tee -a "$LOGFILE"
  log "  $1"
  echo "================================================================" | tee -a "$LOGFILE"
}

# 记录阶段耗时
phase_start() {
  PHASE_START_TIME=$(date +%s)
}

phase_end() {
  local elapsed=$(( $(date +%s) - PHASE_START_TIME ))
  local mins=$(( elapsed / 60 ))
  local secs=$(( elapsed % 60 ))
  log "  完成 (${mins}m ${secs}s)"
}

# ── 开始 ──────────────────────────────────────────────
PIPELINE_START=$(date +%s)

log_phase "CKG 全量分析流水线"
log "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
log "  Goals: ${GOALS:-'(无 — 跳过 cold-start)'}"
log "  Concurrency: $CONCURRENCY"
log "  Owner: $OWNER"
log "  Repo: ${TARGET_REPO:-'全部'}"
log "  Force: $FORCE | Deep-check: $DEEP_CHECK | Dry-run: $DRY_RUN"
log "  日志: $LOGFILE"

cd "$CKG_DIR"

# ── 预检 ──────────────────────────────────────────────
log ""
log "预检..."

# 检查 Memgraph 连接
if ! echo "RETURN 1;" | cypher-shell -a bolt://localhost:7687 &>/dev/null 2>&1; then
  # 如果 cypher-shell 不存在或连不上，用 node 检查
  if ! node -e "
    const neo4j = require('neo4j-driver');
    const d = neo4j.driver('bolt://localhost:7687');
    d.verifyConnectivity().then(() => { d.close(); process.exit(0); }).catch(() => process.exit(1));
  " 2>/dev/null; then
    log "ERROR: 无法连接 Memgraph (bolt://localhost:7687)"
    log "  请先运行: docker compose up -d"
    exit 1
  fi
fi
log "  Memgraph: OK"

# 检查 Joern（仅在需要时）
if [ "$SKIP_JOERN" = false ]; then
  if ! command -v joern-parse &>/dev/null; then
    log "WARNING: joern-parse 未安装，将跳过 Joern 阶段"
    SKIP_JOERN=true
  else
    log "  Joern: OK"
  fi
fi

# 检查 repo 路径
for dir in "$BITE_DIR/bite-me-website" "$BITE_DIR/biteme-shared" "$BITE_DIR/biteme-infra"; do
  if [ ! -d "$dir" ]; then
    log "WARNING: 目录不存在: $dir"
  fi
done

# ── Phase 0: Database setup ──────────────────────────
if [ "$RESET_DB" = true ]; then
  log_phase "Phase 0: 重置数据库"
  phase_start
  npm run db:reset 2>&1 | tee -a "$LOGFILE"
  phase_end
fi

if [ "$NO_SCHEMA" = false ]; then
  log ""
  log "初始化 schema..."
  npm run db:schema 2>&1 | tee -a "$LOGFILE"
fi

# ── Phase 1: Joern CPG ──────────────────────────────
if [ "$SKIP_JOERN" = false ]; then
  log_phase "Phase 1: 生成 Joern CPG"
  phase_start

  log "  bite-me-website..."
  joern-parse "$BITE_DIR/bite-me-website/src" \
    --output "$BITE_DIR/bite-me-website.cpg.bin" \
    --language javascript 2>&1 | tee -a "$LOGFILE"

  log "  biteme-shared..."
  joern-parse "$BITE_DIR/biteme-shared/src" \
    --output "$BITE_DIR/biteme-shared/biteme-shared.cpg.bin" \
    --language javascript 2>&1 | tee -a "$LOGFILE"

  log "  提取 JSON: bite-me-website..."
  joern --script "$CKG_DIR/joern/extract-code-entities.sc" \
    --param "cpgFile=$BITE_DIR/bite-me-website.cpg.bin" \
    --param "outFile=$CKG_DIR/data/bite-me-website.json" \
    --param "repoName=bite-me-website" 2>&1 | tee -a "$LOGFILE"

  log "  提取 JSON: biteme-shared..."
  joern --script "$CKG_DIR/joern/extract-code-entities.sc" \
    --param "cpgFile=$BITE_DIR/biteme-shared/biteme-shared.cpg.bin" \
    --param "outFile=$CKG_DIR/data/biteme-shared.json" \
    --param "repoName=biteme-shared" 2>&1 | tee -a "$LOGFILE"

  log "  解析 SQL: biteme-infra..."
  npm run parse:sql -- \
    --repo biteme-infra \
    --sql-dir "$BITE_DIR/biteme-infra/supabase/migrations" \
    --out data/biteme-infra-sql.json 2>&1 | tee -a "$LOGFILE"

  phase_end
else
  log ""
  log "跳过 Phase 1: Joern CPG (--skip-joern)"
fi

# ── Phase 2: Memgraph 导入 ────────────────────────────
if [ "$SKIP_INGEST" = false ]; then
  log_phase "Phase 2: 导入 Memgraph"
  phase_start

  for cpg_file in data/bite-me-website.json data/biteme-shared.json data/biteme-infra-sql.json; do
    if [ -f "$cpg_file" ]; then
      log "  导入 $cpg_file..."
      npm run ingest:cpg -- --file "$cpg_file" 2>&1 | tee -a "$LOGFILE"
    else
      log "  WARNING: $cpg_file 不存在，跳过"
    fi
  done

  phase_end
else
  log ""
  log "跳过 Phase 2: Memgraph 导入 (--skip-ingest)"
fi

# ── Phase 3: 跨服务连接 ──────────────────────────────
if [ "$SKIP_LINK" = false ]; then
  log_phase "Phase 3: 建跨服务连接"
  phase_start

  log "  link:repos..."
  npm run link:repos 2>&1 | tee -a "$LOGFILE"

  log "  link:services..."
  npm run link:services 2>&1 | tee -a "$LOGFILE"

  log "  link:tables..."
  npm run link:tables 2>&1 | tee -a "$LOGFILE"

  phase_end
else
  log ""
  log "跳过 Phase 3: 跨服务连接 (--skip-link)"
fi

# ── Phase 4: Cold-start 决策提取 ──────────────────────
if [ "$SKIP_COLD_START" = false ]; then
  if [ -z "$GOALS" ]; then
    log ""
    log "跳过 Phase 4: 未指定 --goals"
  else
    log_phase "Phase 4: Cold-start 决策提取"
    phase_start

    # 构建 cold-start 额外参数
    CS_EXTRA_ARGS=""
    [ -n "$TARGET_REPO" ] && CS_EXTRA_ARGS="$CS_EXTRA_ARGS --repo $TARGET_REPO"
    [ "$FORCE" = true ]   && CS_EXTRA_ARGS="$CS_EXTRA_ARGS --force"
    [ "$DEEP_CHECK" = true ] && CS_EXTRA_ARGS="$CS_EXTRA_ARGS --deep-check"
    [ "$DRY_RUN" = true ] && CS_EXTRA_ARGS="$CS_EXTRA_ARGS --dry-run"

    # 按 | 分隔多个 goal，依次执行
    IFS='|' read -ra GOAL_ARRAY <<< "$GOALS"
    GOAL_IDX=0
    GOAL_TOTAL=${#GOAL_ARRAY[@]}

    for goal_item in "${GOAL_ARRAY[@]}"; do
      goal_item=$(echo "$goal_item" | xargs)  # trim whitespace
      GOAL_IDX=$((GOAL_IDX + 1))
      log ""
      log "  Goal [$GOAL_IDX/$GOAL_TOTAL]: $goal_item"

      npm run cold-start:v2 -- \
        --goal "$goal_item" \
        --owner "$OWNER" \
        --concurrency "$CONCURRENCY" \
        $CS_EXTRA_ARGS \
        2>&1 | tee -a "$LOGFILE"

      log "  Goal [$GOAL_IDX/$GOAL_TOTAL] 完成"
    done

    phase_end
  fi
else
  log ""
  log "跳过 Phase 4: Cold-start (--skip-cold-start)"
fi

# ── Phase 5: Session 摄入 ─────────────────────────────
if [ "$SKIP_SESSIONS" = false ]; then
  log_phase "Phase 5: Session 决策摄入"
  phase_start

  SESSION_ARGS="--concurrency $CONCURRENCY --owner $OWNER"
  npm run ingest:sessions -- $SESSION_ARGS 2>&1 | tee -a "$LOGFILE"

  phase_end
else
  log ""
  log "跳过 Phase 5: Session 摄入 (--skip-sessions)"
fi

# ── 完成 ──────────────────────────────────────────────
PIPELINE_END=$(date +%s)
TOTAL_ELAPSED=$(( PIPELINE_END - PIPELINE_START ))
TOTAL_MINS=$(( TOTAL_ELAPSED / 60 ))
TOTAL_SECS=$(( TOTAL_ELAPSED % 60 ))

log_phase "全量分析完成"
log "  总耗时: ${TOTAL_MINS}m ${TOTAL_SECS}s"
log "  日志文件: $LOGFILE"

# 如果有 dashboard，提示查看
log ""
log "  查看结果: npm run dashboard  ->  http://localhost:3001"

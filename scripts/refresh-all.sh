#!/bin/bash
# refresh-all.sh
#
# 一键刷新所有 repo 的代码结构数据：
#   - bite-me-website: Joern CPG → JSON → Memgraph
#   - biteme-shared:   Joern CPG → JSON → Memgraph
#   - biteme-infra:    parse-sql → JSON → Memgraph
#   - 跨服务连接:      link:repos + link:services + link:tables
#
# 用法: bash scripts/refresh-all.sh [--skip-joern] [--skip-ingest] [--skip-link]
#
# 前提: Joern 已安装，Memgraph 已启动

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BITE_DIR="${BITE_DIR:-$(cd "$CKG_DIR/.." && pwd)/bite}"

# ── 参数解析 ──────────────────────────────────────────
SKIP_JOERN=false
SKIP_INGEST=false
SKIP_LINK=false

for arg in "$@"; do
  case $arg in
    --skip-joern)  SKIP_JOERN=true ;;
    --skip-ingest) SKIP_INGEST=true ;;
    --skip-link)   SKIP_LINK=true ;;
  esac
done

cd "$CKG_DIR"

# ── Step 1: Joern CPG 生成 ───────────────────────────
if [ "$SKIP_JOERN" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 1: 生成 Joern CPG"
  echo "═══════════════════════════════════════════════════"

  echo ""
  echo "📦 bite-me-website..."
  joern-parse "$BITE_DIR/bite-me-website/src" \
    --output "$BITE_DIR/bite-me-website.cpg.bin" \
    --language javascript
  echo "  ✅ CPG 生成完成"

  echo ""
  echo "📦 biteme-shared..."
  joern-parse "$BITE_DIR/biteme-shared/src" \
    --output "$BITE_DIR/biteme-shared/biteme-shared.cpg.bin" \
    --language javascript
  echo "  ✅ CPG 生成完成"

  # 从 CPG 提取 JSON
  echo ""
  echo "📤 提取 bite-me-website JSON..."
  joern --script "$CKG_DIR/joern/extract-code-entities.sc" \
    --param "cpgFile=$BITE_DIR/bite-me-website.cpg.bin" \
    --param "outFile=$CKG_DIR/data/bite-me-website.json" \
    --param "repoName=bite-me-website"

  echo ""
  echo "📤 提取 biteme-shared JSON..."
  joern --script "$CKG_DIR/joern/extract-code-entities.sc" \
    --param "cpgFile=$BITE_DIR/biteme-shared/biteme-shared.cpg.bin" \
    --param "outFile=$CKG_DIR/data/biteme-shared.json" \
    --param "repoName=biteme-shared"

else
  echo ""
  echo "⏭️  跳过 Joern CPG 生成 (--skip-joern)"
fi

# ── Step 2: parse-sql (biteme-infra) ─────────────────
if [ "$SKIP_JOERN" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 2: 解析 SQL migrations"
  echo "═══════════════════════════════════════════════════"
  echo ""
  npm run parse:sql -- \
    --repo biteme-infra \
    --sql-dir "$BITE_DIR/biteme-infra/supabase/migrations" \
    --out data/biteme-infra-sql.json
fi

# ── Step 3: 导入 Memgraph ────────────────────────────
if [ "$SKIP_INGEST" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 3: 导入 Memgraph"
  echo "═══════════════════════════════════════════════════"

  echo ""
  echo "📥 bite-me-website..."
  npm run ingest:cpg -- --file data/bite-me-website.json

  echo ""
  echo "📥 biteme-shared..."
  npm run ingest:cpg -- --file data/biteme-shared.json

  echo ""
  echo "📥 biteme-infra (SQL)..."
  npm run ingest:cpg -- --file data/biteme-infra-sql.json

else
  echo ""
  echo "⏭️  跳过 Memgraph 导入 (--skip-ingest)"
fi

# ── Step 4: 建跨服务连接 ─────────────────────────────
if [ "$SKIP_LINK" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 4: 建跨服务连接"
  echo "═══════════════════════════════════════════════════"

  echo ""
  echo "🔗 link:repos (跨 repo 函数调用)..."
  npm run link:repos

  echo ""
  echo "🌐 link:services (跨服务 API 依赖)..."
  npm run link:services

  echo ""
  echo "🗂️  link:tables (supabase.from 表访问)..."
  npm run link:tables

else
  echo ""
  echo "⏭️  跳过跨服务连接 (--skip-link)"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ 全部完成"
echo "═══════════════════════════════════════════════════"
echo ""

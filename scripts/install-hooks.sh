#!/bin/bash
# install-hooks.sh
#
# 一键往目标项目注入 CKG MCP 配置 + CLAUDE.md
# 让 Claude Code 在业务项目写代码时自动查询设计决策
#
# 用法:
#   bash scripts/install-hooks.sh /path/to/project
#   bash scripts/install-hooks.sh --all    # 安装到 ckg.config.json 里所有 repo

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 解析参数 ──────────────────────────────────────────

install_to_project() {
  local PROJECT_DIR="$1"
  local PROJECT_NAME="$(basename "$PROJECT_DIR")"

  if [ ! -d "$PROJECT_DIR" ]; then
    echo "❌ 目录不存在: $PROJECT_DIR"
    return 1
  fi

  echo "📦 安装 CKG 到 $PROJECT_NAME ($PROJECT_DIR)"

  # 1. .mcp.json
  local MCP_FILE="$PROJECT_DIR/.mcp.json"
  if [ -f "$MCP_FILE" ]; then
    # 检查是否已有 ckg 配置
    if grep -q '"ckg"' "$MCP_FILE" 2>/dev/null; then
      echo "  ✓ .mcp.json 已有 ckg 配置，跳过"
    else
      echo "  ⚠️ .mcp.json 已存在但没有 ckg 配置"
      echo "  请手动添加以下内容到 mcpServers 中:"
      echo "    \"ckg\": { \"command\": \"node_modules/.bin/ts-node\", \"args\": [\"--transpile-only\", \"$CKG_DIR/src/mcp/server.ts\"], \"cwd\": \"$CKG_DIR\" }"
    fi
  else
    cat > "$MCP_FILE" << MCPEOF
{
  "mcpServers": {
    "ckg": {
      "command": "node_modules/.bin/ts-node",
      "args": ["--transpile-only", "$CKG_DIR/src/mcp/server.ts"],
      "cwd": "$CKG_DIR",
      "env": {
        "CKG_MEMGRAPH_HOST": "localhost"
      }
    }
  }
}
MCPEOF
    echo "  ✓ .mcp.json 已创建"
  fi

  # 2. CLAUDE.md（追加，不覆盖）
  local CLAUDE_FILE="$PROJECT_DIR/CLAUDE.md"
  local CKG_MARKER="## CKG 上下文图谱"

  if [ -f "$CLAUDE_FILE" ] && grep -q "$CKG_MARKER" "$CLAUDE_FILE" 2>/dev/null; then
    echo "  ✓ CLAUDE.md 已有 CKG 段落，跳过"
  else
    cat >> "$CLAUDE_FILE" << 'CLAUDEEOF'

## CKG 上下文图谱

本项目接入了 Context Knowledge Graph（CKG），提供设计决策上下文。

### 自动查询
修改代码前，用 `get_context_for_code` 查询相关设计决策：
- 输入文件名或函数名
- 默认返回摘要列表，传 `detail=true` 获取完整内容
- 传 `decision_id` 展开单条决策的关系链

### 其他工具
- `search_decisions_by_keyword` — 按关键词搜索决策
- `search_decisions_semantic` — 语义搜索（需要向量库）
- `get_decision_relationships` — 查因果/依赖/冲突关系链

### 反馈
完成任务后，调用 `report_context_usage(used_ids=[...])` 报告实际参考了哪些决策 ID。
这帮助系统优化未来的检索排序。
CLAUDEEOF
    echo "  ✓ CLAUDE.md CKG 段落已添加"
  fi

  echo "  ✅ $PROJECT_NAME 安装完成"
  echo ""
}

# ── 入口 ──────────────────────────────────────────────

if [ "${1:-}" = "--all" ]; then
  echo "🔧 安装到所有配置的 repo..."
  echo ""

  # 从 ckg.config.json 读取所有 repo 路径
  if [ ! -f "$CKG_DIR/ckg.config.json" ]; then
    echo "❌ 找不到 ckg.config.json"
    exit 1
  fi

  # 用 node 解析 JSON（避免依赖 jq）
  PATHS=$(node -e "
    const c = require('$CKG_DIR/ckg.config.json');
    c.repos.forEach(r => console.log(r.path));
  ")

  while IFS= read -r repo_path; do
    if [ -n "$repo_path" ]; then
      install_to_project "$repo_path"
    fi
  done <<< "$PATHS"

  echo "✅ 全部安装完成"

elif [ -n "${1:-}" ]; then
  install_to_project "$1"
else
  echo "用法:"
  echo "  bash scripts/install-hooks.sh /path/to/project"
  echo "  bash scripts/install-hooks.sh --all"
  exit 1
fi

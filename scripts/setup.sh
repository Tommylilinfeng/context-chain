#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────
# CKG Setup — Install prerequisites and initialize the system
#
# Usage: bash scripts/setup.sh
# ─────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Context Knowledge Graph — Setup                ║"
echo "║   grep finds what code does,                     ║"
echo "║   we record why it was written that way.         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────────
# Step 1: Check prerequisites
# ─────────────────────────────────────────────────────────

echo -e "${BLUE}[1/6] Checking prerequisites...${NC}"
echo ""

MISSING=0

# Node.js
if command -v node &> /dev/null; then
  NODE_VERSION=$(node --version)
  echo -e "  ${GREEN}✓${NC} Node.js ${NODE_VERSION}"
else
  echo -e "  ${RED}✗ Node.js not found${NC}"
  echo "    Install: https://nodejs.org/ (v18+ required)"
  MISSING=1
fi

# Docker
if command -v docker &> /dev/null; then
  DOCKER_VERSION=$(docker --version | head -1)
  echo -e "  ${GREEN}✓${NC} ${DOCKER_VERSION}"
  
  # Check if Docker daemon is running
  if docker info &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Docker daemon is running"
  else
    echo -e "  ${RED}✗ Docker daemon is not running${NC}"
    echo "    Please start Docker Desktop"
    MISSING=1
  fi
else
  echo -e "  ${RED}✗ Docker not found${NC}"
  echo "    Install: https://www.docker.com/products/docker-desktop/"
  MISSING=1
fi

# Joern (optional — needed for code structure analysis)
if command -v joern &> /dev/null; then
  echo -e "  ${GREEN}✓${NC} Joern ($(which joern))"
else
  echo -e "  ${YELLOW}! Joern not found (optional — needed for code structure analysis)${NC}"
  echo ""
  echo "    To install Joern:"
  echo ""
  echo "    macOS (Homebrew):"
  echo "      brew install joern"
  echo ""
  echo "    Linux / manual:"
  echo "      curl -L https://github.com/joernio/joern/releases/latest/download/joern-install.sh | bash"
  echo ""
  echo "    You can skip Joern for now — CKG will still extract decisions from code,"
  echo "    but without function-level call graph analysis."
  echo ""
fi

# Claude CLI (optional — needed for decision extraction)
if command -v claude &> /dev/null; then
  echo -e "  ${GREEN}✓${NC} Claude CLI ($(which claude))"
else
  echo -e "  ${YELLOW}! Claude CLI not found (needed for cold-start decision extraction)${NC}"
  echo "    Install: npm install -g @anthropic-ai/claude-code"
  echo "    Then: claude login"
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo -e "${RED}Missing required prerequisites. Please install them and re-run this script.${NC}"
  exit 1
fi

# ─────────────────────────────────────────────────────────
# Step 2: Install npm dependencies
# ─────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}[2/6] Installing dependencies (root)...${NC}"
npm install

echo ""
echo -e "${BLUE}[3/6] Installing dependencies (dashboard)...${NC}"
cd "$PROJECT_DIR/dashboard"
npm install
cd "$PROJECT_DIR"

# ─────────────────────────────────────────────────────────
# Step 4: Create data directories
# ─────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}[4/6] Creating directories...${NC}"
mkdir -p data projects
touch data/.gitkeep projects/.gitkeep
echo -e "  ${GREEN}✓${NC} data/ and projects/ ready"

# ─────────────────────────────────────────────────────────
# Step 5: Pull Docker images
# ─────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}[5/6] Pulling Docker images (this may take a few minutes on first run)...${NC}"
echo ""
echo "  Pulling memgraph/memgraph-mage..."
docker pull memgraph/memgraph-mage
echo "  Pulling memgraph/lab..."
docker pull memgraph/lab
echo ""
echo -e "  ${GREEN}✓${NC} Docker images ready"

# ─────────────────────────────────────────────────────────
# Step 6: Done
# ─────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════"
echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Start the Dashboard:"
echo "     cd dashboard && npm run dev"
echo "     Open http://localhost:3001"
echo ""
echo "  2. Create a new project in the Dashboard"
echo "     - Click '+ New Project'"
echo "     - Add your code repositories"
echo "     - Click 'Initialize' to start analysis"
echo ""
echo "  3. Connect Claude Code to your project's graph:"
echo "     Add to your repo's .mcp.json (shown in Dashboard > Settings)"
echo ""
echo "════════════════════════════════════════════════════"
echo ""

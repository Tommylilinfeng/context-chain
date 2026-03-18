#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
"$SCRIPT_DIR/node_modules/.bin/ts-node" --transpile-only src/mcp/server.ts

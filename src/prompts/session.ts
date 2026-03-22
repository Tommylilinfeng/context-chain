/**
 * prompts/session.ts
 *
 * Prompt builders for session ingestion pipeline:
 *   Phase 1 — Segmentation: split conversation into logical segments
 *   Phase 2 — Extraction: deep decision extraction per approved segment
 */

import { BusinessContext } from './cold-start'

// ── Types ───────────────────────────────────────────────

export interface SessionSegment {
  startTurn: number
  endTurn: number
  summary: string
  touchedFiles: string[]
  hasDecisions: boolean
  decisionHints: string[]
}

export interface SessionDecision {
  function: string | null
  file: string | null
  related_functions: string[]
  summary: string
  content: string
  keywords: string[]
  finding_type: 'decision' | 'suboptimal' | 'bug'
  critique?: string
  transcript_range: [number, number]
}

// ── Phase 1: Segmentation ───────────────────────────────

export function buildSegmentationPrompt(
  projectName: string,
  sessionStart: string,
  sessionEnd: string,
  conversationText: string,
  codeStructure: string,
  businessContext: BusinessContext[],
  chunkInfo?: { chunkNumber: number; totalChunks: number; prevSummary?: string }
): string {
  const bizSection = businessContext.length > 0
    ? `\n## Business Context\n${businessContext.map(b => `  - ${b.summary}: ${b.content}`).join('\n')}\n`
    : ''

  const chunkNote = chunkInfo && chunkInfo.totalChunks > 1
    ? `\n**注意：这是一段较长对话的第 ${chunkInfo.chunkNumber}/${chunkInfo.totalChunks} 部分。**${
      chunkInfo.prevSummary ? `\n前一部分最后在做: "${chunkInfo.prevSummary}"` : ''
    }\n`
    : ''

  return `You are segmenting a Claude Code conversation into logical work units.

## Project: ${projectName}
Session: ${sessionStart} → ${sessionEnd}
${chunkNote}${bizSection}
## Code structure (files touched in this session)
${codeStructure || 'No graph data available'}

## Conversation
${conversationText}

## Task

Split this conversation into logical segments. Each segment is a coherent work unit: implementing a feature, fixing a bug, making an architecture decision, refactoring, etc.

For each segment, judge whether it contains **design decisions** (WHY-level choices):
- Pure debug, CSS tweaks, syntax fixes, test runs = **no decisions**
- Architecture choices, trade-off discussions, "why not X", approach comparisons = **has decisions**

Use the turn numbers [N] from the conversation as boundaries.

Return ONLY raw JSON (no markdown, no backticks):
[{
  "startTurn": 0,
  "endTurn": 15,
  "summary": "一句话说清这段在做什么，包含关键决策点",
  "touchedFiles": ["src/store/timeSlotStore.js"],
  "hasDecisions": true,
  "decisionHints": ["为什么选择 X 而不是 Y", "某个 trade-off"]
}]

Return empty array [] if this conversation has no meaningful segments (e.g. just testing MCP tools).`
}

// ── Phase 2: Deep Extraction ────────────────────────────

export function buildExtractionPrompt(
  projectName: string,
  segmentSummary: string,
  decisionHints: string[],
  conversationText: string,
  codeStructure: string,
  callerCalleeSection: string,
  businessContext: BusinessContext[]
): string {
  const bizSection = businessContext.length > 0
    ? `\n## Business Context\n${businessContext.map(b => `  - ${b.summary}: ${b.content}`).join('\n')}\n`
    : ''

  const hintsSection = decisionHints.length > 0
    ? `\n## Decision hints (from segmentation phase)\n${decisionHints.map(h => `  - ${h}`).join('\n')}\n`
    : ''

  return `You are extracting design decisions from a Claude Code conversation segment.

## Project: ${projectName}
${bizSection}
## Segment summary
${segmentSummary}
${hintsSection}
## Code structure (functions in touched files)
${codeStructure || 'No graph data available'}
${callerCalleeSection ? `\n## Caller/Callee code\n${callerCalleeSection}\n` : ''}
## Conversation
${conversationText}

## Task

Extract design decisions from this conversation. Each decision must explain **WHY**, not just WHAT.

For anchoring: pick the most relevant function and file from the code structure above.
If the decision doesn't map to any specific function, set "function" to null.
If it doesn't map to any specific file, set "file" to null.
Only use function/file names that appear in the code structure section — do not invent names.

## Good example
{
  "function": "fetchTimeSlotContext",
  "file": "src/store/timeSlotStore.ts",
  "related_functions": ["getAvailableVendorIds"],
  "summary": "把 timeslot context 查询从前端多次 RPC 合并为一次 get_current_run_context RPC，减少数据库往返",
  "content": "原来前端先调 get_available_vendors 再调 get_current_time_slot 两次 RPC。合并为 get_current_run_context 一次拿到所有信息，减少延迟。代价是 PostgreSQL 函数更复杂，但前端逻辑简化了。",
  "keywords": ["RPC", "timeslot", "run_context", "延迟优化"],
  "finding_type": "decision",
  "transcript_range": [3, 8]
}

## Bad example (describes WHAT, not WHY)
{
  "summary": "Added fetchTimeSlotContext function",
  "content": "Created a new function that calls supabase.rpc to get time slot context."
}

Return ONLY raw JSON array (no markdown, no backticks). Empty array [] if no decisions:
[{
  "function": "functionName or null",
  "file": "path/to/file.ts or null",
  "related_functions": ["other1", "other2"],
  "summary": "20-50 words — the decision with enough context to understand without code",
  "content": "200-600 chars — WHY, trade-offs, alternatives considered",
  "keywords": ["kw1", "kw2", "kw3"],
  "finding_type": "decision|suboptimal|bug",
  "critique": "only for suboptimal/bug",
  "transcript_range": [startTurnIndex, endTurnIndex]
}]`
}

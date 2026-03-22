/**
 * session-parser.ts
 *
 * Phase 0: Parse Claude Code JSONL session files into compressed turns.
 *
 * Compression strategy:
 * - Human text → keep full
 * - AI text → keep full
 * - AI tool_use Write/Edit → keep code content (truncate at 200 lines)
 * - AI tool_use Read/Bash/Glob/MCP → compress to one-line summary
 * - tool_result → skip (AI's subsequent text summarizes results)
 * - thinking → skip (encrypted, unreadable)
 * - queue-operation / file-history-snapshot / progress / last-prompt / isMeta → skip
 */

import fs from 'fs'

// ── Types ───────────────────────────────────────────────

export interface CompressedTurn {
  index: number            // original JSONL line number (for Phase 2 lookback)
  role: 'user' | 'assistant' | 'tool_action'
  content: string
  timestamp: string
  filesReferenced: string[]
}

export interface Phase0Result {
  sessionId: string
  projectName: string
  turns: CompressedTurn[]
  touchedFiles: string[]
  sessionStart: string
  sessionEnd: string
  totalOriginalLines: number
  estimatedTokens: number
}

// ── Constants ───────────────────────────────────────────

const WRITE_TRUNCATE_LINES = 200
const MIN_TEXT_LENGTH = 20

// file path patterns in tool_use inputs
const FILE_PATH_RE = /(?:^|\s|["'`])([\/\w.-]+\/[\w.-]+\.\w{1,10})(?:["'`\s,]|$)/g

// ── Main parse function ─────────────────────────────────

export function parseSession(jsonlPath: string, projectName: string): Phase0Result {
  const raw = fs.readFileSync(jsonlPath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)

  const turns: CompressedTurn[] = []
  let sessionId = ''
  let sessionStart = ''
  let sessionEnd = ''

  for (let i = 0; i < lines.length; i++) {
    let obj: any
    try {
      obj = JSON.parse(lines[i])
    } catch {
      continue
    }

    // capture session metadata
    if (obj.sessionId && !sessionId) sessionId = obj.sessionId
    if (obj.timestamp) {
      if (!sessionStart) sessionStart = obj.timestamp
      sessionEnd = obj.timestamp
    }

    // ── skip non-content lines ──────────────────────
    if (skipLine(obj)) continue

    const msg = obj.message
    if (!msg) continue

    const timestamp = obj.timestamp ?? ''

    // ── user messages ───────────────────────────────
    if (msg.role === 'user') {
      const result = processUserMessage(msg, i, timestamp)
      if (result) turns.push(result)
      continue
    }

    // ── assistant messages ───────────────────────────
    if (msg.role === 'assistant') {
      const results = processAssistantMessage(msg, i, timestamp)
      turns.push(...results)
      continue
    }
  }

  // collect all touched files
  const fileSet = new Set<string>()
  for (const turn of turns) {
    for (const f of turn.filesReferenced) {
      fileSet.add(f)
    }
  }

  // estimate tokens
  const totalChars = turns.reduce((sum, t) => sum + t.content.length, 0)
  const estimatedTokens = Math.ceil(totalChars / 4)

  return {
    sessionId: sessionId || jsonlPath.split('/').pop()?.replace('.jsonl', '') || 'unknown',
    projectName,
    turns,
    touchedFiles: [...fileSet].sort(),
    sessionStart,
    sessionEnd,
    totalOriginalLines: lines.length,
    estimatedTokens,
  }
}

// ── Skip logic ──────────────────────────────────────────

function skipLine(obj: any): boolean {
  // skip system/meta types
  const skipTypes = ['queue-operation', 'file-history-snapshot', 'progress', 'last-prompt']
  if (skipTypes.includes(obj.type)) return true

  // skip meta messages (system commands like /mcp, /exit)
  if (obj.isMeta) return true

  // skip lines without message
  if (!obj.message) return true

  // skip tool_result messages from user (the big payloads)
  if (obj.message?.role === 'user' && isToolResult(obj.message)) return true

  return false
}

function isToolResult(msg: any): boolean {
  if (typeof msg.content === 'string') return false
  if (!Array.isArray(msg.content)) return false
  return msg.content.some((b: any) => b.type === 'tool_result')
}

// ── User message processing ─────────────────────────────

function processUserMessage(msg: any, lineIndex: number, timestamp: string): CompressedTurn | null {
  const text = extractText(msg.content)
  if (text.length < MIN_TEXT_LENGTH) return null

  return {
    index: lineIndex,
    role: 'user',
    content: text,
    timestamp,
    filesReferenced: extractFilePaths(text),
  }
}

// ── Assistant message processing ────────────────────────

function processAssistantMessage(msg: any, lineIndex: number, timestamp: string): CompressedTurn[] {
  const results: CompressedTurn[] = []
  const content = msg.content

  if (!Array.isArray(content)) {
    // simple string content (rare for assistant)
    if (typeof content === 'string' && content.length >= MIN_TEXT_LENGTH) {
      results.push({
        index: lineIndex,
        role: 'assistant',
        content,
        timestamp,
        filesReferenced: extractFilePaths(content),
      })
    }
    return results
  }

  // process each content block
  const textParts: string[] = []
  const textFiles: string[] = []
  const toolActions: CompressedTurn[] = []

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      const cleaned = block.text.replace(/<[^>]+>/g, '').trim()
      if (cleaned.length >= MIN_TEXT_LENGTH) {
        textParts.push(cleaned)
        textFiles.push(...extractFilePaths(cleaned))
      }
    } else if (block.type === 'tool_use') {
      const action = compressToolUse(block, lineIndex, timestamp)
      if (action) toolActions.push(action)
    }
    // skip: thinking (encrypted), tool_result (handled above)
  }

  // combine all text blocks into one assistant turn
  if (textParts.length > 0) {
    results.push({
      index: lineIndex,
      role: 'assistant',
      content: textParts.join('\n\n'),
      timestamp,
      filesReferenced: [...new Set(textFiles)],
    })
  }

  // add tool actions as separate turns
  results.push(...toolActions)

  return results
}

// ── Tool use compression ────────────────────────────────

function compressToolUse(block: any, lineIndex: number, timestamp: string): CompressedTurn | null {
  const toolName = block.name ?? ''
  const input = block.input ?? {}

  // Write / Edit — keep the code content
  if (toolName === 'Write' || toolName === 'write_to_file' || toolName === 'create_file') {
    const filePath = input.path ?? input.file_path ?? ''
    const code = input.content ?? input.file_text ?? ''
    const lines = code.split('\n')
    let truncatedCode = code
    if (lines.length > WRITE_TRUNCATE_LINES) {
      truncatedCode = lines.slice(0, WRITE_TRUNCATE_LINES).join('\n')
        + `\n// [truncated, ${lines.length} total lines]`
    }
    return {
      index: lineIndex,
      role: 'tool_action',
      content: `[Write: ${filePath}]\n${truncatedCode}`,
      timestamp,
      filesReferenced: filePath ? [filePath] : [],
    }
  }

  if (toolName === 'Edit' || toolName === 'str_replace_editor' || toolName === 'edit_file') {
    const filePath = input.path ?? input.file_path ?? ''
    // for edits, keep old_str and new_str which show what changed
    const oldStr = input.old_str ?? ''
    const newStr = input.new_str ?? input.replacement ?? ''
    const content = oldStr && newStr
      ? `[Edit: ${filePath}]\n--- old\n${truncate(oldStr, 50)}\n+++ new\n${truncate(newStr, 50)}`
      : `[Edit: ${filePath}]`
    return {
      index: lineIndex,
      role: 'tool_action',
      content,
      timestamp,
      filesReferenced: filePath ? [filePath] : [],
    }
  }

  // Read
  if (toolName === 'Read' || toolName === 'read_file' || toolName === 'View') {
    const filePath = input.path ?? input.file_path ?? ''
    return {
      index: lineIndex,
      role: 'tool_action',
      content: `[Read: ${filePath}]`,
      timestamp,
      filesReferenced: filePath ? [filePath] : [],
    }
  }

  // Bash
  if (toolName === 'Bash' || toolName === 'execute_command' || toolName === 'bash') {
    const command = input.command ?? input.cmd ?? ''
    return {
      index: lineIndex,
      role: 'tool_action',
      content: `[Bash: ${command.slice(0, 100)}]`,
      timestamp,
      filesReferenced: [],
    }
  }

  // Glob
  if (toolName === 'Glob' || toolName === 'glob' || toolName === 'list_files') {
    const pattern = input.pattern ?? input.glob ?? ''
    return {
      index: lineIndex,
      role: 'tool_action',
      content: `[Glob: ${pattern}]`,
      timestamp,
      filesReferenced: [],
    }
  }

  // MCP tool calls
  if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) {
    const paramSummary = Object.entries(input)
      .map(([k, v]) => `${k}=${String(v).slice(0, 50)}`)
      .join(', ')
    return {
      index: lineIndex,
      role: 'tool_action',
      content: `[MCP: ${toolName}(${paramSummary})]`,
      timestamp,
      filesReferenced: [],
    }
  }

  // ToolSearch (Claude Code internal)
  if (toolName === 'ToolSearch') {
    return null  // not useful for decision extraction
  }

  // Unknown tool — generic one-liner
  return {
    index: lineIndex,
    role: 'tool_action',
    content: `[Tool: ${toolName}]`,
    timestamp,
    filesReferenced: [],
  }
}

// ── Helpers ─────────────────────────────────────────────

function extractText(content: any): string {
  if (typeof content === 'string') {
    return content.replace(/<[^>]+>/g, '').trim()
  }
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
  }
  return ''
}

function extractFilePaths(text: string): string[] {
  const paths: string[] = []
  let match
  const re = new RegExp(FILE_PATH_RE.source, FILE_PATH_RE.flags)
  while ((match = re.exec(text)) !== null) {
    const p = match[1]
    // filter out things that look like URLs or common non-file patterns
    if (p.includes('://') || p.startsWith('http') || p.startsWith('//')) continue
    if (p.startsWith('node_modules/') || p.startsWith('.git/')) continue
    paths.push(p)
  }
  return [...new Set(paths)]
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + `\n// [truncated, ${lines.length} total lines]`
}

// ── Format compressed turns for LLM prompt ──────────────

/**
 * Format turns into a readable string for the LLM prompt.
 * Each turn gets a number prefix for segment boundary references.
 */
export function formatTurnsForPrompt(turns: CompressedTurn[]): string {
  return turns.map((t, i) => {
    const roleLabel = t.role === 'user' ? 'Human'
      : t.role === 'assistant' ? 'AI'
      : 'Action'
    return `[${i}] ${roleLabel}: ${t.content}`
  }).join('\n\n')
}

/**
 * Extract raw (uncompressed) turns from JSONL for Phase 2.
 * Keeps Write/Edit code fully, still compresses tool_result.
 *
 * IMPORTANT: startTurn/endTurn are compressed turn indices (from Phase 1),
 * NOT JSONL line numbers. Use the turns array to map back to JSONL line numbers.
 */
export function extractRawTurnsForSegment(
  jsonlPath: string,
  turns: CompressedTurn[],
  startTurn: number,
  endTurn: number
): string {
  // Map turn indices to JSONL line numbers
  const startLineIdx = turns[startTurn]?.index ?? 0
  const endLineIdx = turns[Math.min(endTurn, turns.length - 1)]?.index ?? Infinity

  const raw = fs.readFileSync(jsonlPath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)
  const parts: string[] = []

  for (let i = startLineIdx; i <= Math.min(endLineIdx, lines.length - 1); i++) {
    let obj: any
    try { obj = JSON.parse(lines[i]) } catch { continue }

    if (skipLine(obj)) continue
    const msg = obj.message
    if (!msg) continue

    if (msg.role === 'user') {
      const text = extractText(msg.content)
      if (text.length >= MIN_TEXT_LENGTH) {
        parts.push(`Human: ${text}`)
      }
    } else if (msg.role === 'assistant') {
      if (!Array.isArray(msg.content)) {
        if (typeof msg.content === 'string') parts.push(`AI: ${msg.content}`)
        continue
      }
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          parts.push(`AI: ${block.text}`)
        } else if (block.type === 'tool_use') {
          const compressed = compressToolUse(block, i, '')
          if (compressed) parts.push(compressed.content)
        }
      }
    }
  }

  return parts.join('\n\n')
}

/**
 * ingestion/feedback.ts
 *
 * 反馈日志：追踪 MCP 返回的 context 哪些被 AI 实际使用了。
 * 用于后续优化检索排序和淘汰无用决策。
 */

import fs from 'fs'
import path from 'path'

const LOG_PATH = path.resolve(__dirname, '../../data/feedback-log.jsonl')

export interface FeedbackEntry {
  timestamp: string
  used_ids: string[]
  task_summary?: string
}

export function appendFeedback(entry: FeedbackEntry): void {
  const dir = path.dirname(LOG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
}

export function readFeedbackLog(): FeedbackEntry[] {
  if (!fs.existsSync(LOG_PATH)) return []
  try {
    return fs.readFileSync(LOG_PATH, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

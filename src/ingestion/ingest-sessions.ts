/**
 * ingest-sessions.ts
 *
 * 读取 ~/.claude/projects/ 下的 Claude Code session 记录，
 * 提取设计决策，写入 Memgraph。
 *
 * 运行方式：
 *   npm run ingest:sessions                          # 处理所有新 session
 *   npm run ingest:sessions -- --project bite-me-website  # 只处理某个项目
 *   npm run ingest:sessions -- --since 2026-03-01   # 只处理某个日期之后的
 *
 * 不需要任何额外配置——脚本作为本地进程直接读 ~/.claude/projects/
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { queryGraphContext, formatGraphContext } from '../db/graphContext'

// ── 常量 ────────────────────────────────────────────────
const CLAUDE_DIR    = path.join(os.homedir(), '.claude', 'projects')
const STATE_FILE    = path.join(__dirname, '../../data/ingested-sessions.json')

// ── CLI 参数 ────────────────────────────────────────────
const args         = process.argv.slice(2)
const getArg       = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const targetProject = getArg('--project')
const sinceDate     = getArg('--since')    // e.g. "2026-03-01"
const owner         = getArg('--owner') ?? 'me'

// ── 状态：记录已处理的 session，避免重复 ─────────────────
function loadProcessed(): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).processed) }
  catch { return new Set() }
}

function saveProcessed(s: Set<string>) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({ processed: [...s] }, null, 2))
}

// ── 解析 JSONL，提取对话文本 ─────────────────────────────
interface Turn { role: 'user' | 'assistant'; text: string; timestamp: string }

function parseJsonl(filePath: string): { turns: Turn[]; cwd: string; sessionId: string } {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
  const turns: Turn[] = []
  let cwd = '', sessionId = ''

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.cwd && !cwd)           cwd = obj.cwd
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId

      // 跳过系统/进度/快照消息
      if (!obj.type || obj.type === 'file-history-snapshot' || obj.type === 'progress') continue
      if (obj.isMeta) continue

      const msg = obj.message
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue

      // 提取纯文本
      let text = ''
      if (typeof msg.content === 'string') {
        text = msg.content
      } else if (Array.isArray(msg.content)) {
        text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
      }

      // 去掉 XML 标签（Claude Code 内部标记），过滤太短的
      text = text.replace(/<[^>]+>/g, '').trim()
      if (text.length < 30) continue

      turns.push({ role: msg.role, text: text.slice(0, 1000), timestamp: obj.timestamp ?? '' })
    } catch { continue }
  }

  return { turns, cwd, sessionId }
}

// ── 从文件路径推断项目名 ─────────────────────────────────
function projectNameFromDir(dirName: string): string {
  // "-Users-zhouyitong-dev-bite-bite-me-website" → "bite-me-website"
  const parts = dirName.split('-').filter(Boolean)
  // 找到最后的有意义的名字（通常是 repo 名）
  return parts.slice(-3).join('-')
}

// ── 构建提取 prompt ──────────────────────────────────────
function buildPrompt(turns: Turn[], projectName: string, graphSection: string): string {
  const dialogue = turns
    .slice(-20)
    .map(t => `${t.role === 'user' ? 'User' : 'Claude'}: ${t.text}`)
    .join('\n\n')

  return `Analyze this Claude Code session and extract 0-3 design decisions.

Project: ${projectName}
${graphSection}
Session:
${dialogue}

A design decision is WHY an approach was chosen, trade-offs discussed, or choices made (including decisions NOT to do something).
Skip trivial syntax fixes or test runs with no architectural insight.

Return ONLY raw JSON (empty array [] if no decisions worth recording):
[{"summary":"one line under 15 words","content":"explanation 100-300 chars","keywords":["kw1","kw2"],"file":"filename.js or null"}]`
}

// ── 调 claude CLI ────────────────────────────────────────
function extractDecisions(turns: Turn[], projectName: string, graphSection: string): any[] {
  if (turns.length < 3) return []
  try {
    const prompt = buildPrompt(turns, projectName, graphSection)
    const tmp = `/tmp/ckg-sess-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    fs.writeFileSync(tmp, prompt)
    const out = execSync(`cat "${tmp}" | claude -p --tools "" --output-format json`, {
      encoding: 'utf-8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe']
    })
    fs.unlinkSync(tmp)
    const raw = JSON.parse(out.trim()).result ?? ''
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// ── 写入 Memgraph ────────────────────────────────────────
async function writeDecisions(decisions: any[], sessionId: string, projectName: string): Promise<number> {
  const session = await getSession()
  const now = new Date().toISOString()
  let anchored = 0
  try {
    for (let i = 0; i < decisions.length; i++) {
      const dc = decisions[i]
      const id = `dc:sess:${sessionId.slice(0, 8)}:${i}:${Date.now()}`
      await session.run(`MERGE (d:DecisionContext {id: $id}) SET d += $props`, {
        id, props: {
          summary: String(dc.summary ?? ''),
          content: String(dc.content ?? ''),
          keywords: Array.isArray(dc.keywords) ? dc.keywords : [],
          scope: [projectName], owner,
          session_id: sessionId,
          commit_hash: 'session-extract',
          source: 'claude_code_session',
          confidence: 'auto_generated',
          staleness: 'active',
          created_at: now, updated_at: now,
        }
      })
      // 按文件名锚定（可选）
      if (dc.file) {
        const fileName = String(dc.file).replace(/\.(ts|tsx)$/, '.js')
        const r = await session.run(
          `MATCH (d:DecisionContext {id: $id})
           MATCH (f:CodeEntity {entity_type: 'file', name: $name})
           MERGE (d)-[:ANCHORED_TO]->(f) RETURN f.id`,
          { id, name: fileName }
        )
        if (r.records.length > 0) anchored++
      }
    }
  } finally { await session.close() }
  return anchored
}

// ── 主流程 ──────────────────────────────────────────────
async function main() {
  console.log('\n📼 Claude Code Session 摄入\n')

  if (!fs.existsSync(CLAUDE_DIR)) {
    console.error(`找不到 ${CLAUDE_DIR}，请确认 Claude Code 已安装并使用过`)
    process.exit(1)
  }

  await verifyConnectivity()
  const processed = loadProcessed()

  // 收集要处理的文件
  const toProcess: { filePath: string; projectName: string }[] = []
  const since = sinceDate ? new Date(sinceDate) : null

  for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const projectName = projectNameFromDir(dir.name)
    if (targetProject && !dir.name.includes(targetProject)) continue

    const dirPath = path.join(CLAUDE_DIR, dir.name)
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
      const sessionId = file.replace('.jsonl', '')
      if (processed.has(sessionId)) continue  // 已处理，跳过

      const filePath = path.join(dirPath, file)
      if (since) {
        const stat = fs.statSync(filePath)
        if (stat.mtime < since) continue
      }

      toProcess.push({ filePath, projectName })
    }
  }

  if (toProcess.length === 0) {
    console.log('没有新的 session 需要处理（所有 session 已处理过）')
    await closeDriver()
    return
  }

  console.log(`找到 ${toProcess.length} 个新 session\n`)

  let totalDecisions = 0, totalAnchored = 0

  for (const { filePath, projectName } of toProcess) {
    const { turns, sessionId } = parseJsonl(filePath)
    const shortId = sessionId.slice(0, 8)

    if (turns.length < 3) {
      console.log(`[${shortId}] ${projectName} — 跳过（对话太短）`)
      processed.add(sessionId)
      continue
    }

    // 查图谱上下文（辅助）
    // 从对话里猜测涉及的文件，取第一个提到的 .js/.ts 文件名
    const mentionedFile = turns
      .flatMap(t => t.text.match(/\b[\w-]+\.(js|ts|tsx|jsx)\b/g) ?? [])
      .find(f => !f.startsWith('node_'))
    const graph = mentionedFile ? await queryGraphContext(mentionedFile.replace(/\.(ts|tsx)$/, '.js')) : null
    const graphSection = formatGraphContext(graph)

    const decisions = extractDecisions(turns, projectName, graphSection)
    processed.add(sessionId)  // 不管有没有决策，都标记为已处理

    if (decisions.length === 0) {
      console.log(`[${shortId}] ${projectName} (${turns.length} 轮) — 无决策`)
      continue
    }

    const anchored = await writeDecisions(decisions, sessionId, projectName)
    totalDecisions += decisions.length
    totalAnchored += anchored
    console.log(`[${shortId}] ${projectName} (${turns.length} 轮) — ${decisions.length} 条决策，${anchored} 条锚定`)
  }

  saveProcessed(processed)
  await closeDriver()
  console.log(`\n✅ 完成：${totalDecisions} 条决策，${totalAnchored} 条锚定`)
}

main().catch(err => { console.error('失败:', err.message); process.exit(1) })

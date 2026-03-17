/**
 * cold-start.ts
 *
 * 冷启动：LLM 读现有代码文件，推断设计决策，写入 DecisionContext 节点。
 *
 * 运行：
 *   npm run cold-start -- \
 *     --repo bite-me-website \
 *     --src /Users/zhouyitong/dev/bite/biteme-shared/src \
 *     --owner me
 *
 * 策略：
 * - 只处理有实质逻辑的文件（services、logic、utils、store、hooks、contexts）
 * - 跳过纯 UI 组件（太多，信噪比低）
 * - 每个文件调一次 Claude API，提取 1-3 条最重要的决策
 * - 写入 DecisionContext，ANCHORED_TO 对应的 CodeEntity
 */

import fs from 'fs'
import path from 'path'
import { getSession, verifyConnectivity, closeDriver } from '../../db/client'
import { Session } from 'neo4j-driver'

// ── CLI 参数 ────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (flag: string) => {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : null
}

const repo = getArg('--repo') ?? 'bite-me-website'
const srcDir = getArg('--src')
const owner = getArg('--owner') ?? 'unknown'

if (!srcDir) {
  console.error('用法: npm run cold-start -- --repo <name> --src <path> --owner <name>')
  process.exit(1)
}

// ── 只处理有逻辑的目录，跳过纯 UI ──────────────────────
const LOGIC_DIRS = ['services', 'logic', 'utils', 'store', 'hooks', 'contexts', 'navigation']
const ALLOWED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const MAX_FILE_SIZE = 15000 // 超过 15KB 的文件截断，避免 token 太多

// ── DecisionContext 数据结构 ────────────────────────────
interface DecisionContext {
  id: string
  summary: string
  content: string
  keywords: string[]
  scope: string[]
  owner: string
  session_id: string
  commit_hash: string
  source: string
  confidence: string
  staleness: string
  created_at: string
  updated_at: string
  anchor_file_id: string   // 要建 ANCHORED_TO 边的 CodeEntity id
}

// ── 主流程 ──────────────────────────────────────────────
async function coldStart(): Promise<void> {
  console.log(`\n🧊 冷启动开始`)
  console.log(`   Repo: ${repo}`)
  console.log(`   源目录: ${srcDir}`)
  console.log(`   Owner: ${owner}`)

  // 1. 收集要处理的文件
  const files = collectFiles(srcDir!)
  console.log(`\n📁 找到 ${files.length} 个逻辑文件`)

  // 2. 确认 Memgraph 连接
  await verifyConnectivity()
  const session = await getSession()

  let successCount = 0
  let skipCount = 0

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const relPath = path.relative(path.dirname(srcDir!), file)
      console.log(`\n[${i + 1}/${files.length}] ${relPath}`)

      // 检查这个文件在图谱里有没有对应节点
      const fileId = buildFileId(file, srcDir!, repo)
      const exists = await checkFileNodeExists(session, fileId)
      if (!exists) {
        console.log(`  ⚠ 图谱里没有这个文件节点，跳过`)
        skipCount++
        continue
      }

      // 读文件内容
      const code = readFileTruncated(file)
      if (code.length < 100) {
        console.log(`  ⚠ 文件太短，跳过`)
        skipCount++
        continue
      }

      // 调 Claude API 推断决策
      const decisions = await inferDecisions(code, relPath, repo)
      if (!decisions || decisions.length === 0) {
        console.log(`  ℹ 未提取到有价值的决策`)
        skipCount++
        continue
      }

      // 写入 Memgraph
      for (const dc of decisions) {
        dc.anchor_file_id = fileId
        dc.owner = owner
        await writeDecisionContext(session, dc)
      }

      console.log(`  ✅ 写入 ${decisions.length} 条决策`)
      successCount += decisions.length

      // 限速：避免 API 调用太快
      await sleep(500)
    }
  } finally {
    await session.close()
    await closeDriver()
  }

  console.log(`\n🎉 冷启动完成`)
  console.log(`   成功写入: ${successCount} 条 DecisionContext`)
  console.log(`   跳过文件: ${skipCount} 个`)
}

// ── 收集文件 ────────────────────────────────────────────
function collectFiles(dir: string): string[] {
  const results: string[] = []

  function walk(current: string) {
    if (!fs.existsSync(current)) return
    const entries = fs.readdirSync(current, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'generated') {
          walk(fullPath)
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name)
        if (!ALLOWED_EXTENSIONS.includes(ext)) continue

        // 检查是否在逻辑目录下（或者根目录的逻辑文件）
        const relativeParts = path.relative(dir, fullPath).split(path.sep)
        const inLogicDir = relativeParts.some(p => LOGIC_DIRS.includes(p))
        if (inLogicDir) {
          results.push(fullPath)
        }
      }
    }
  }

  walk(dir)
  return results
}

function readFileTruncated(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8')
  if (content.length > MAX_FILE_SIZE) {
    return content.slice(0, MAX_FILE_SIZE) + '\n// [文件过长，已截断]'
  }
  return content
}

// ── 构建文件 ID（对应图谱里的 CodeEntity id）────────────
function buildFileId(filePath: string, srcDir: string, repo: string): string {
  // srcDir 是 biteme-shared/src，文件路径是 biteme-shared/src/services/orderService.ts
  // 对应图谱里的 id: file:bite-me-website/services/orderService.ts（Joern 用的是相对路径）
  const repoRoot = path.dirname(srcDir)
  const relPath = path.relative(repoRoot, filePath)
  return `file:${repo}/${relPath}`
}

async function checkFileNodeExists(session: Session, fileId: string): Promise<boolean> {
  const result = await session.run(
    `MATCH (f:CodeEntity {id: $id}) RETURN f.id`,
    { id: fileId }
  )
  return result.records.length > 0
}

// ── 调 Claude API 推断决策 ──────────────────────────────
async function inferDecisions(
  code: string,
  filePath: string,
  repoName: string
): Promise<DecisionContext[]> {
  const prompt = `你是一个代码分析专家。分析以下代码文件，提取其中**隐含的设计决策**。

文件路径：${filePath}
所属项目：${repoName}

代码：
\`\`\`
${code}
\`\`\`

请找出这个文件中最重要的 1-3 个设计决策。

"设计决策"的定义：
- 为什么用这种方式实现，而不是另一种（例如：为什么用 RPC 而不是 REST API）
- 为什么有某些特殊处理（例如：为什么要特别处理 guest 用户）
- 数据结构的设计选择（例如：为什么 cartItemId 包含 customization 信息）
- 错误处理策略（例如：为什么某些错误要 throw，某些要 silent fail）

不要提取：
- 显而易见的实现细节（"这个函数计算总价"）
- 没有决策价值的描述（"这是一个购物车服务"）

请只返回 JSON 数组，不要有任何其他文字：
[
  {
    "summary": "一句话描述这个决策（15字以内）",
    "content": "详细解释：是什么决策、为什么这样做、有什么 trade-off（100-300字）",
    "keywords": ["关键词1", "关键词2", "关键词3"]
  }
]

如果这个文件没有值得记录的设计决策，返回空数组：[]`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      console.error(`  API 错误: ${response.status}`)
      return []
    }

    const data = await response.json() as any
    const text = data.content?.[0]?.text ?? ''

    // 解析 JSON
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const now = new Date().toISOString()

    return parsed.map((item: any, index: number) => ({
      id: `dc:cold:${repo}:${path.basename(filePath, path.extname(filePath))}:${index}:${Date.now()}`,
      summary: item.summary ?? '',
      content: item.content ?? '',
      keywords: item.keywords ?? [],
      scope: [repo],
      owner: '',           // 外面填
      session_id: `cold-start-${new Date().toISOString().slice(0, 10)}`,
      commit_hash: 'cold-start',
      source: 'cold_start',
      confidence: 'auto_generated',
      staleness: 'active',
      created_at: now,
      updated_at: now,
      anchor_file_id: '', // 外面填
    }))
  } catch (err: any) {
    console.error(`  解析失败: ${err.message}`)
    return []
  }
}

// ── 写入 Memgraph ────────────────────────────────────────
async function writeDecisionContext(session: Session, dc: DecisionContext): Promise<void> {
  // 写节点
  await session.run(
    `MERGE (d:DecisionContext {id: $id})
     SET d += $props`,
    {
      id: dc.id,
      props: {
        summary: dc.summary,
        content: dc.content,
        keywords: dc.keywords,
        scope: dc.scope,
        owner: dc.owner,
        session_id: dc.session_id,
        commit_hash: dc.commit_hash,
        source: dc.source,
        confidence: dc.confidence,
        staleness: dc.staleness,
        created_at: dc.created_at,
        updated_at: dc.updated_at,
      },
    }
  )

  // 建 ANCHORED_TO 边（DecisionContext → CodeEntity）
  await session.run(
    `MATCH (d:DecisionContext {id: $dcId})
     MATCH (f:CodeEntity {id: $fileId})
     MERGE (d)-[:ANCHORED_TO]->(f)`,
    { dcId: dc.id, fileId: dc.anchor_file_id }
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

coldStart().catch(err => {
  console.error('\n冷启动失败:', err.message)
  process.exit(1)
})

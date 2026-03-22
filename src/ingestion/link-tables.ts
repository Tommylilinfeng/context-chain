/**
 * link-tables.ts
 *
 * 扫描所有非 infra repo 中的 supabase.from('table') 调用，
 * 确定性地建 ACCESSES_TABLE 边：源函数 → infra 的表节点。
 *
 * 不走 LLM，纯正则 + 图匹配。
 * 用行号把 .from() 调用匹配到 Joern 提取的最内层函数节点。
 *
 * 运行：npm run link:tables
 */

import fs from 'fs'
import path from 'path'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig, RepoConfig } from '../config'

// ── 扫描 ────────────────────────────────────────────────

interface TableAccess {
  repo: string
  file: string       // 相对于 repo root 的路径（src/ 下）
  tableName: string
  line: number
}

function scanFromCalls(repo: RepoConfig): TableAccess[] {
  const results: TableAccess[] = []
  const repoPath = repo.path.replace(/^~/, process.env.HOME || '')

  if (!fs.existsSync(repoPath)) {
    console.log(`  ⚠ ${repo.name}: 路径不存在 ${repoPath}`)
    return results
  }

  // 扫描 src/ 和 lib/ 下的代码
  const srcDir = path.join(repoPath, 'src')
  const scanDirs = [srcDir, path.join(repoPath, 'lib'), path.join(repoPath, 'server')]
    .filter(d => fs.existsSync(d))

  for (const dir of scanDirs) {
    const files = walkFiles(dir, ['.ts', '.tsx', '.js', '.jsx'])
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      // Joern 的 file 节点 path 是相对于 src/ 的（不含 src/ 前缀）
      const relToSrc = fs.existsSync(srcDir) && file.startsWith(srcDir)
        ? path.relative(srcDir, file)
        : path.relative(repoPath, file)

      for (let i = 0; i < lines.length; i++) {
        // 排除 supabase.storage.from('bucket') — 那是文件存储，不是数据库表
        // 可能同行 (.storage.from) 或跨行 (上一行以 .storage 结尾)
        if (lines[i].includes('.storage.from(')) continue
        if (lines[i].match(/^\s*\.from\(/) && i > 0 && lines[i - 1].trimEnd().endsWith('.storage')) continue
        const matches = lines[i].matchAll(/\.from\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)
        for (const m of matches) {
          results.push({
            repo: repo.name,
            file: relToSrc,
            tableName: m[1],
            line: i + 1,
          })
        }
      }
    }
  }

  return results
}

function walkFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = []
  function walk(d: string) {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'generated') {
          walk(full)
        }
      } else if (e.isFile() && extensions.includes(path.extname(e.name))) {
        results.push(full)
      }
    }
  }
  walk(dir)
  return results
}

// ── 函数匹配 ───────────────────────────────────────────

interface FunctionSpan {
  id: string
  name: string
  lineStart: number
  lineEnd: number
}

/**
 * 从 Memgraph 加载某个 repo 某个文件的所有函数节点及其行号范围
 */
async function loadFunctionSpans(
  session: any,
  repo: string,
  filePath: string
): Promise<FunctionSpan[]> {
  const result = await session.run(
    `MATCH (f:CodeEntity {repo: $repo, entity_type: 'function'})
     WHERE f.path = $path AND f.line_start IS NOT NULL AND f.line_end IS NOT NULL
     RETURN f.id AS id, f.name AS name,
            f.line_start AS ls, f.line_end AS le`,
    { repo, path: filePath }
  )
  return result.records.map((r: any) => ({
    id: r.get('id'),
    name: r.get('name'),
    lineStart: typeof r.get('ls') === 'object' ? r.get('ls').toNumber() : r.get('ls'),
    lineEnd: typeof r.get('le') === 'object' ? r.get('le').toNumber() : r.get('le'),
  }))
}

/**
 * 找到包含 line 的最内层函数（span 最小的那个）
 * 排除 :program（顶层包裹，太宽泛）
 */
function findInnermostFunction(spans: FunctionSpan[], line: number): FunctionSpan | null {
  let best: FunctionSpan | null = null
  let bestSize = Infinity

  for (const fn of spans) {
    if (fn.name === ':program') continue
    if (fn.lineStart <= line && line <= fn.lineEnd) {
      const size = fn.lineEnd - fn.lineStart
      if (size < bestSize) {
        best = fn
        bestSize = size
      }
    }
  }
  return best
}

// ── 主流程 ──────────────────────────────────────────────

async function linkTables(): Promise<void> {
  console.log('\n🗂️  supabase.from() 表访问扫描\n')

  const config = loadConfig()

  const infraRepo = config.repos.find(r => r.type === 'infra')
  if (!infraRepo) {
    console.error('❌ 找不到 type=infra 的 repo')
    process.exit(1)
  }
  console.log(`Infra repo: ${infraRepo.name}`)

  const nonInfraRepos = config.repos.filter(r => r.type !== 'infra')
  console.log(`扫描 repos: ${nonInfraRepos.map(r => r.name).join(', ')}\n`)

  // 1. 扫描 .from() 调用
  const allAccesses: TableAccess[] = []
  for (const repo of nonInfraRepos) {
    const accesses = scanFromCalls(repo)
    allAccesses.push(...accesses)
    console.log(`  ${repo.name}: ${accesses.length} 条 .from() 调用`)
  }

  if (allAccesses.length === 0) {
    console.log('\n没有发现 supabase.from() 调用。')
    return
  }

  // 2. 连接 Memgraph
  await verifyConnectivity()
  const session = await getSession()

  try {
    // 加载 infra 表节点
    const tableResult = await session.run(
      `MATCH (t:CodeEntity {repo: $repo})
       WHERE t.entity_type = 'table'
       RETURN t.id AS id, t.name AS name`,
      { repo: infraRepo.name }
    )
    const infraTables = new Map<string, string>()
    for (const r of tableResult.records) {
      infraTables.set(r.get('name'), r.get('id'))
    }
    console.log(`\nInfra 表节点: ${infraTables.size} 个`)

    // 清掉旧的 ACCESSES_TABLE 边
    await session.run(`MATCH ()-[r:ACCESSES_TABLE]->() DELETE r`)

    // 3. 对每条 .from() 调用，匹配函数 + 表，建边
    // 先按 repo+file 分组，减少 Memgraph 查询次数
    const byRepoFile = new Map<string, TableAccess[]>()
    for (const a of allAccesses) {
      const key = `${a.repo}|${a.file}`
      if (!byRepoFile.has(key)) byRepoFile.set(key, [])
      byRepoFile.get(key)!.push(a)
    }

    let written = 0
    let skippedNoTable = 0
    let skippedNoFunction = 0
    let fallbackToFile = 0
    const unmatchedTables = new Set<string>()
    // 去重：同函数→同表只建一条边
    const edgeSeen = new Set<string>()

    interface EdgeToWrite {
      sourceId: string
      sourceName: string
      tableId: string
      tableName: string
      fromRepo: string
      fromFile: string
      line: number
    }
    const edges: EdgeToWrite[] = []

    for (const [key, accesses] of byRepoFile) {
      const [repo, filePath] = key.split('|')
      const spans = await loadFunctionSpans(session, repo, filePath)

      for (const a of accesses) {
        // 匹配表
        const tableId = infraTables.get(a.tableName)
        if (!tableId) {
          unmatchedTables.add(a.tableName)
          skippedNoTable++
          continue
        }

        // 匹配函数
        const fn = findInnermostFunction(spans, a.line)
        let sourceId: string
        let sourceName: string

        if (fn) {
          sourceId = fn.id
          sourceName = fn.name
        } else {
          // 回退到文件级
          sourceId = `file:${repo}/${filePath}`
          sourceName = filePath
          fallbackToFile++
        }

        // 去重：同源→同表只保留一条
        const edgeKey = `${sourceId}→${tableId}`
        if (edgeSeen.has(edgeKey)) continue
        edgeSeen.add(edgeKey)

        edges.push({
          sourceId,
          sourceName,
          tableId,
          tableName: a.tableName,
          fromRepo: repo,
          fromFile: filePath,
          line: a.line,
        })
      }
    }

    // 批量写入
    const BATCH = 50
    for (let i = 0; i < edges.length; i += BATCH) {
      const batch = edges.slice(i, i + BATCH)
      const result = await session.run(
        `UNWIND $batch AS b
         MATCH (src:CodeEntity {id: b.sourceId})
         MATCH (t:CodeEntity {id: b.tableId})
         CREATE (src)-[r:ACCESSES_TABLE {
           from_repo: b.fromRepo,
           from_file: b.fromFile,
           table_name: b.tableName,
           line: b.line
         }]->(t)
         RETURN count(r) AS cnt`,
        { batch }
      )
      const cnt = result.records[0]?.get('cnt')?.toNumber?.() ?? result.records[0]?.get('cnt') ?? 0
      written += cnt
    }

    // 报告
    console.log(`\n✅ ${written} 条 ACCESSES_TABLE 边已创建`)
    console.log(`   原始 .from() 调用: ${allAccesses.length}`)
    console.log(`   去重后唯一 函数→表: ${edges.length}`)
    if (fallbackToFile > 0) {
      console.log(`   ⚠️  ${fallbackToFile} 条回退到文件级（找不到包含的函数节点）`)
    }
    if (skippedNoTable > 0) {
      console.log(`   ⚠️  ${skippedNoTable} 条被跳过（表名在 infra 中不存在）：`)
      for (const t of [...unmatchedTables].sort()) {
        console.log(`       ${t}`)
      }
    }

    // 按表统计
    const statsResult = await session.run(
      `MATCH (src)-[r:ACCESSES_TABLE]->(t)
       RETURN t.name AS table_name, count(r) AS cnt
       ORDER BY cnt DESC`
    )
    if (statsResult.records.length > 0) {
      console.log('\n📊 表访问统计:')
      for (const r of statsResult.records) {
        const cnt = r.get('cnt')?.toNumber?.() ?? r.get('cnt')
        console.log(`   ${r.get('table_name')}: ${cnt} 个函数访问`)
      }
    }

  } finally {
    await session.close()
    await closeDriver()
  }
}

linkTables().catch(err => {
  console.error('失败:', err.message)
  process.exit(1)
})

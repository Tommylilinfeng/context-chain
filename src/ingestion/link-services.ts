/**
 * link-services.ts
 *
 * 扫描所有 repo 的 API 信号（endpoint 定义 + 出站调用），
 * 用 LLM 推断跨服务关系，写入 DEPENDS_ON_API 边。
 *
 * 运行：npm run link:services
 *
 * 工作原理：
 *   1. 读 ckg.config.json 获取所有 repo
 *   2. 从每个 repo 收集 API 信号（route 定义、supabase.functions.invoke、fetch 调用等）
 *   3. 把所有信号喂给 claude -p，让它推断跨服务关系
 *   4. 把推断结果写入 Memgraph 的 DEPENDS_ON_API 边
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig, RepoConfig } from '../config'

// ── 信号收集 ────────────────────────────────────────────

interface ApiSignal {
  repo: string
  type: 'endpoint_definition' | 'outbound_call' | 'webhook_handler' | 'env_variable'
  name: string          // endpoint 名或函数名
  file: string          // 来源文件（相对路径）
  detail: string        // 具体代码片段或描述
}

/**
 * 从一个 repo 里收集 API 信号
 */
function collectSignals(repo: RepoConfig): ApiSignal[] {
  const signals: ApiSignal[] = []
  const repoPath = repo.path.replace(/^~/, process.env.HOME || '')

  if (!fs.existsSync(repoPath)) {
    console.log(`  ⚠ ${repo.name}: 路径不存在 ${repoPath}`)
    return signals
  }

  // 1. Supabase Edge Functions（目录 = endpoint 名）
  // skipEdgeFunctions = true 的 repo 跳过（它的 edge functions 是副本，不是 source of truth）
  const edgeFnDir = path.join(repoPath, 'supabase', 'functions')
  if (fs.existsSync(edgeFnDir) && !repo.skipEdgeFunctions) {
    for (const entry of fs.readdirSync(edgeFnDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
        const indexFile = path.join(edgeFnDir, entry.name, 'index.ts')
        let detail = `Supabase Edge Function: ${entry.name}`
        if (fs.existsSync(indexFile)) {
          // 读前几行获取注释/描述
          const head = fs.readFileSync(indexFile, 'utf-8').slice(0, 500)
          const commentMatch = head.match(/\/\/\s*(.+)/)
          if (commentMatch) detail += ` — ${commentMatch[1]}`
        }
        signals.push({
          repo: repo.name,
          type: 'endpoint_definition',
          name: entry.name,
          file: `supabase/functions/${entry.name}/index.ts`,
          detail,
        })
      }
    }
  }

  // 2. 扫描源码中的出站调用
  const srcDir = path.join(repoPath, 'src')
  if (fs.existsSync(srcDir)) {
    scanOutboundCalls(srcDir, repo.name, repoPath, signals)
  }
  // shared lib 可能在根目录下
  const libDir = path.join(repoPath, 'lib')
  if (fs.existsSync(libDir)) {
    scanOutboundCalls(libDir, repo.name, repoPath, signals)
  }

  // 3. 扫描 API route 定义（Next.js pages/api, Express routes 等）
  const apiDirs = [
    path.join(repoPath, 'pages', 'api'),
    path.join(repoPath, 'app', 'api'),
    path.join(repoPath, 'server', 'routes'),
    path.join(repoPath, 'server', 'api'),
    path.join(repoPath, 'src', 'routes'),
    path.join(repoPath, 'src', 'api'),
  ]
  for (const apiDir of apiDirs) {
    if (fs.existsSync(apiDir)) {
      scanRouteDefinitions(apiDir, repo.name, repoPath, signals)
    }
  }

  // 4. SQL function definitions (PostgreSQL RPC endpoints)
  const migrationDirs = [
    path.join(repoPath, 'supabase', 'migrations'),
    path.join(repoPath, 'sql'),
    path.join(repoPath, 'database', 'migrations'),
  ]
  for (const migDir of migrationDirs) {
    if (fs.existsSync(migDir)) {
      const sqlFiles = walkFiles(migDir, ['.sql'])
      for (const file of sqlFiles) {
        const content = fs.readFileSync(file, 'utf-8')
        const relPath = path.relative(repoPath, file)
        // Match CREATE [OR REPLACE] FUNCTION ["public".]"name"( or public.name( or name(
        const fnMatches = content.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)
        for (const m of fnMatches) {
          signals.push({
            repo: repo.name,
            type: 'endpoint_definition',
            name: m[1],
            file: relPath,
            detail: `PostgreSQL RPC function: ${m[1]}`,
          })
        }
      }
    }
  }

  // 5. 环境变量中的服务 URL
  for (const envFile of ['.env', '.env.production', '.env.local']) {
    const envPath = path.join(repoPath, envFile)
    if (fs.existsSync(envPath)) {
      scanEnvFile(envPath, repo.name, envFile, signals)
    }
  }

  return signals
}

function scanOutboundCalls(dir: string, repoName: string, repoRoot: string, signals: ApiSignal[]): void {
  const files = walkFiles(dir, ['.ts', '.tsx', '.js', '.jsx'])

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8')
    const relPath = path.relative(repoRoot, file)

    // supabase.functions.invoke('xxx')
    const invokeMatches = content.matchAll(/supabase\.functions\.invoke\(\s*['"]([^'"]+)['"]/g)
    for (const m of invokeMatches) {
      signals.push({
        repo: repoName,
        type: 'outbound_call',
        name: m[1],
        file: relPath,
        detail: `supabase.functions.invoke('${m[1]}')`,
      })
    }

    // supabase.rpc('xxx')
    const rpcMatches = content.matchAll(/supabase\.rpc\(\s*['"]([^'"]+)['"]/g)
    for (const m of rpcMatches) {
      signals.push({
        repo: repoName,
        type: 'outbound_call',
        name: m[1],
        file: relPath,
        detail: `supabase.rpc('${m[1]}')`,
      })
    }

    // fetch('/api/xxx') or fetch('https://xxx')
    const fetchMatches = content.matchAll(/fetch\(\s*[`'"]([^`'"]+)[`'"]/g)
    for (const m of fetchMatches) {
      const url = m[1]
      if (url.startsWith('/api/') || url.startsWith('http')) {
        signals.push({
          repo: repoName,
          type: 'outbound_call',
          name: url,
          file: relPath,
          detail: `fetch('${url}')`,
        })
      }
    }

    // axios.get/post/put/delete('xxx')
    const axiosMatches = content.matchAll(/axios\.\w+\(\s*[`'"]([^`'"]+)[`'"]/g)
    for (const m of axiosMatches) {
      signals.push({
        repo: repoName,
        type: 'outbound_call',
        name: m[1],
        file: relPath,
        detail: `axios call to '${m[1]}'`,
      })
    }
  }
}

function scanRouteDefinitions(dir: string, repoName: string, repoRoot: string, signals: ApiSignal[]): void {
  const files = walkFiles(dir, ['.ts', '.tsx', '.js', '.jsx'])
  for (const file of files) {
    const relPath = path.relative(repoRoot, file)
    // 从文件路径推断 route（Next.js 风格）
    const routePath = relPath
      .replace(/^(pages|app)\/api\//, '/api/')
      .replace(/\.(ts|tsx|js|jsx)$/, '')
      .replace(/\/index$/, '')
      .replace(/\/route$/, '')
    signals.push({
      repo: repoName,
      type: 'endpoint_definition',
      name: routePath,
      file: relPath,
      detail: `API route handler: ${routePath}`,
    })
  }
}

function scanEnvFile(envPath: string, repoName: string, envFile: string, signals: ApiSignal[]): void {
  const content = fs.readFileSync(envPath, 'utf-8')
  const lines = content.split('\n')
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+(?:URL|ENDPOINT|HOST|BASE_URL|API_URL)[A-Z_]*)=(.+)/)
    if (match) {
      signals.push({
        repo: repoName,
        type: 'env_variable',
        name: match[1],
        file: envFile,
        detail: `${match[1]}=${match[2].slice(0, 80)}`,
      })
    }
  }
}

function walkFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = []
  function walk(d: string) {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'generated' && e.name !== 'dist') {
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

// ── LLM 推断 ───────────────────────────────────────────

interface InferredConnection {
  from_repo: string
  from_file: string
  to_repo: string
  to_endpoint: string
  connection_type: 'api_call' | 'webhook' | 'edge_function' | 'rpc' | 'message_queue' | 'shared_db'
  description: string
}

function buildInferencePrompt(signals: ApiSignal[]): string {
  // 按 repo 分组展示
  const byRepo = new Map<string, ApiSignal[]>()
  for (const s of signals) {
    if (!byRepo.has(s.repo)) byRepo.set(s.repo, [])
    byRepo.get(s.repo)!.push(s)
  }

  let signalText = ''
  for (const [repo, sigs] of byRepo) {
    signalText += `\n## ${repo}\n`
    for (const s of sigs) {
      signalText += `  [${s.type}] ${s.name} — ${s.detail} (${s.file})\n`
    }
  }

  return `Analyze these API signals from a multi-repo project and infer cross-service connections.

${signalText}

Rules:
- Only output connections where one repo's outbound call matches another repo's endpoint definition
- "supabase.functions.invoke('xxx')" matches a Supabase Edge Function named 'xxx'
- "supabase.rpc('xxx')" matches a PostgreSQL RPC function named 'xxx'
- Webhook handlers are endpoints that receive calls from external services (e.g. Stripe)
- Do NOT infer connections within the same repo
- Do NOT guess connections that aren't supported by the signals above

Return ONLY raw JSON (no markdown, no backticks):
[{"from_repo":"repo-name","from_file":"path/to/file","to_repo":"repo-name","to_endpoint":"endpoint-name","connection_type":"api_call|webhook|edge_function|rpc|message_queue|shared_db","description":"brief explanation"}]

Return [] if no cross-service connections found.`
}

function callClaude(prompt: string): InferredConnection[] {
  try {
    const tmpFile = `/tmp/ckg-svc-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    fs.writeFileSync(tmpFile, prompt, 'utf-8')

    const output = execSync(
      `cat "${tmpFile}" | claude -p --tools "" --output-format json`,
      { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    fs.unlinkSync(tmpFile)

    const wrapper = JSON.parse(output.trim())
    const raw: string = wrapper.result ?? ''
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch (err: any) {
    console.error('LLM 调用失败:', err.message)
    return []
  }
}

// ── 写入图谱 ───────────────────────────────────────────

async function writeConnections(connections: InferredConnection[]): Promise<number> {
  const session = await getSession()
  let written = 0

  try {
    // 清掉旧的 DEPENDS_ON_API 边（幂等）
    await session.run(`MATCH ()-[r:DEPENDS_ON_API]->() DELETE r`)

    for (const conn of connections) {
      // MERGE service 节点（确保存在），但 CREATE 独立的边（不合并）
      const result = await session.run(
        `MERGE (from_svc:CodeEntity {id: $fromId})
         ON CREATE SET from_svc.name = $fromName, from_svc.entity_type = 'service', from_svc.repo = $fromName
         MERGE (to_svc:CodeEntity {id: $toId})
         ON CREATE SET to_svc.name = $toName, to_svc.entity_type = 'service', to_svc.repo = $toName
         CREATE (from_svc)-[r:DEPENDS_ON_API {
           connection_type: $connType,
           description: $desc,
           from_file: $fromFile,
           to_endpoint: $toEndpoint
         }]->(to_svc)
         RETURN from_svc.id, to_svc.id`,
        {
          fromId: `svc:${conn.from_repo}`,
          fromName: conn.from_repo,
          toId: `svc:${conn.to_repo}`,
          toName: conn.to_repo,
          connType: conn.connection_type,
          desc: conn.description,
          fromFile: conn.from_file,
          toEndpoint: conn.to_endpoint,
        }
      )

      if (result.records.length > 0) {
        written++
        console.log(`  ✅ ${conn.from_repo} → ${conn.to_repo}: ${conn.description}`)
      } else {
        console.log(`  ✗ 失败: ${conn.from_repo} → ${conn.to_repo}`)
      }
    }
  } finally {
    await session.close()
  }

  return written
}

// ── 主流程 ──────────────────────────────────────────────

async function linkServices(): Promise<void> {
  console.log('\n🌐 跨服务隐式连接推断\n')

  const config = loadConfig()
  console.log(`Project: ${config.project}`)
  console.log(`Repos: ${config.repos.map(r => r.name).join(', ')}\n`)

  // 1. 收集信号
  console.log('📡 收集 API 信号...\n')
  const allSignals: ApiSignal[] = []
  for (const repo of config.repos) {
    const signals = collectSignals(repo)
    allSignals.push(...signals)
    console.log(`  ${repo.name}: ${signals.length} 个信号`)
  }

  if (allSignals.length === 0) {
    console.log('\n没有发现 API 信号。')
    return
  }

  // 去重：同 repo + 同 name + 同 type 只保留一条
  const seen = new Set<string>()
  const deduped: ApiSignal[] = []
  for (const s of allSignals) {
    const key = `${s.repo}|${s.type}|${s.name}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(s)
    }
  }
  console.log(`\n🔄 去重后：${deduped.length} 个信号（原 ${allSignals.length} 个）`)
  allSignals.length = 0
  allSignals.push(...deduped)

  // 保存信号到文件（方便调试）
  const signalFile = path.resolve(__dirname, '../../data/api-signals.json')
  fs.mkdirSync(path.dirname(signalFile), { recursive: true })
  fs.writeFileSync(signalFile, JSON.stringify(allSignals, null, 2))
  console.log(`\n💾 ${allSignals.length} 个信号已保存到 data/api-signals.json`)

  // 2. LLM 推断
  console.log('\n🤖 调用 LLM 推断跨服务连接...\n')
  const prompt = buildInferencePrompt(allSignals)
  const connections = callClaude(prompt)

  if (connections.length === 0) {
    console.log('LLM 未推断出跨服务连接。')
    return
  }

  console.log(`推断出 ${connections.length} 条跨服务连接：`)
  for (const c of connections) {
    console.log(`  ${c.from_repo} → ${c.to_repo} [${c.connection_type}]: ${c.description}`)
  }

  // 保存推断结果
  const resultFile = path.resolve(__dirname, '../../data/service-connections.json')
  fs.writeFileSync(resultFile, JSON.stringify(connections, null, 2))

  // 3. 写入图谱
  console.log('\n📝 写入图谱...\n')
  await verifyConnectivity()
  const written = await writeConnections(connections)
  await closeDriver()

  console.log(`\n✅ 完成：${written} 条 DEPENDS_ON_API 边已创建`)
}

linkServices().catch(err => {
  console.error('失败:', err.message)
  process.exit(1)
})

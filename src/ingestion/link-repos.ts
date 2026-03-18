/**
 * link-repos.ts
 *
 * 读取 data/unresolved-calls.json，在 Memgraph 中按函数名匹配目标 repo 的节点，
 * 创建 CALLS_CROSS_REPO 边。
 *
 * 前提：所有 repo 的 CPG 都已经通过 ingest:cpg 导入。
 * 运行：npm run link:repos
 *
 * 工作原理：
 *   1. 读 unresolved-calls.json（ingest:cpg 自动生成）
 *   2. 用 ckg.config.json 把 npm package name 映射到 repo name
 *   3. 在图里按 repo + function name 查找目标节点
 *   4. 创建 CALLS_CROSS_REPO 边
 */

import fs from 'fs'
import path from 'path'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig, resolvePackageToRepo } from '../config'

const UNRESOLVED_FILE = path.resolve(__dirname, '../../data/unresolved-calls.json')

interface UnresolvedCall {
  caller_id: string
  callee_id: string
  callee_name: string
  line: number
  source_repo: string
  target_package: string
  target_function: string
}

async function linkRepos(): Promise<void> {
  console.log('\n🔗 跨 Repo 连接\n')

  // 1. 读取 unresolved calls
  if (!fs.existsSync(UNRESOLVED_FILE)) {
    console.log('没有 unresolved-calls.json，跳过。先运行 ingest:cpg。')
    return
  }

  const calls: UnresolvedCall[] = JSON.parse(fs.readFileSync(UNRESOLVED_FILE, 'utf-8'))
  if (calls.length === 0) {
    console.log('没有待解析的跨 repo 调用。')
    return
  }

  console.log(`找到 ${calls.length} 条待解析的外部调用`)

  // 2. 用 config 映射 package → repo
  const config = loadConfig()
  const resolvedCalls: { caller_id: string; target_repo: string; target_function: string; package_name: string; line: number }[] = []
  const unresolvedPackages = new Set<string>()

  for (const call of calls) {
    const targetRepo = resolvePackageToRepo(call.target_package)
    if (targetRepo) {
      resolvedCalls.push({
        caller_id: call.caller_id,
        target_repo: targetRepo,
        target_function: call.target_function,
        package_name: call.target_package,
        line: call.line,
      })
    } else {
      unresolvedPackages.add(call.target_package)
    }
  }

  if (unresolvedPackages.size > 0) {
    console.log(`\n⚠ 以下 package 未在 ckg.config.json 中映射（跳过）:`)
    for (const pkg of unresolvedPackages) {
      const count = calls.filter(c => c.target_package === pkg).length
      console.log(`   ${pkg} (${count} 条调用)`)
    }
  }

  if (resolvedCalls.length === 0) {
    console.log('\n没有可解析的跨 repo 调用。请检查 ckg.config.json 中的 packages 映射。')
    await closeDriver()
    return
  }

  console.log(`\n📎 ${resolvedCalls.length} 条调用可解析`)

  // 3. 在图里匹配并建边
  await verifyConnectivity()
  const session = await getSession()

  let linked = 0
  let missed = 0

  try {
    // 先清掉旧的 CALLS_CROSS_REPO 边（幂等）
    await session.run(`MATCH ()-[r:CALLS_CROSS_REPO]->() DELETE r`)

    // 批量匹配：一条 UNWIND 查询处理所有调用
    const BATCH = 50
    for (let i = 0; i < resolvedCalls.length; i += BATCH) {
      const batch = resolvedCalls.slice(i, i + BATCH)
      const result = await session.run(
        `UNWIND $batch AS c
         MATCH (caller:CodeEntity {id: c.caller_id})
         MATCH (target:CodeEntity {
           entity_type: 'function',
           name: c.target_function,
           repo: c.target_repo
         })
         MERGE (caller)-[r:CALLS_CROSS_REPO]->(target)
         SET r.line = c.line, r.package = c.package_name
         RETURN c.target_function AS fn, target.id AS targetId`,
        { batch }
      )
      linked += result.records.length
    }
    missed = resolvedCalls.length - linked

    // 打印结果
    console.log(`\n📊 结果:`)
    console.log(`   已连接: ${linked}`)
    console.log(`   未找到: ${missed}`)

    if (linked > 0) {
      const overview = await session.run(
        `MATCH (a:CodeEntity)-[r:CALLS_CROSS_REPO]->(b:CodeEntity)
         RETURN a.repo AS from_repo, b.repo AS to_repo, count(r) AS count`
      )
      console.log(`\n🌐 跨 Repo 调用关系:`)
      for (const r of overview.records) {
        console.log(`   ${r.get('from_repo')} → ${r.get('to_repo')}: ${r.get('count')} 条`)
      }
    }

  } finally {
    await session.close()
    await closeDriver()
  }
}

linkRepos().catch(err => {
  console.error('连接失败:', err.message)
  process.exit(1)
})

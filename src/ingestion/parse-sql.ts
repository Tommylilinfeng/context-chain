/**
 * parse-sql.ts
 *
 * 从 Supabase migration SQL 文件中提取数据库实体（表、函数、触发器、类型）
 * 及它们之间的关系，输出 Joern 兼容的 JSON 文件。
 *
 * 纯文件操作，不需要连接任何数据库。输出的 JSON 直接用 ingest:cpg 导入。
 *
 * 运行：npm run parse:sql -- --repo bite-me-website --sql-dir /path/to/supabase/migrations --out data/bite-me-website-sql.json
 *
 * 前提：npm install pgsql-parser
 */

import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }

const repo    = getArg('--repo') ?? 'bite-me-website'
const sqlDir  = getArg('--sql-dir')
const outFile = getArg('--out') ?? `data/${repo}-sql.json`

if (!sqlDir) {
  console.error('用法: npm run parse:sql -- --repo <name> --sql-dir /path/to/migrations --out data/output.json')
  process.exit(1)
}

// ── 输出格式（跟 Joern extract-code-entities.sc 一致）──────

interface CpgNode {
  id: string
  entity_type: string
  name: string
  repo: string
  path: string | null
  line_start?: number
  line_end?: number
  schema?: string      // SQL 特有
}

interface CpgEdge {
  caller_id: string
  callee_id: string
  callee_name: string
  line: number
  edge_type?: string   // 默认 CALLS，也可以是 REFERENCES_TABLE 等
}

const nodes: CpgNode[] = []
const edges: CpgEdge[] = []
const tableNames = new Set<string>()
const functionNames = new Set<string>()

// ── 解析 ────────────────────────────────────────────────

async function parseAllMigrations(): Promise<void> {
  const resolvedDir = path.resolve(sqlDir!)
  if (!fs.existsSync(resolvedDir)) {
    console.error(`目录不存在: ${resolvedDir}`)
    process.exit(1)
  }

  const files = fs.readdirSync(resolvedDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  console.log(`找到 ${files.length} 个 migration 文件\n`)

  // 尝试加载 pgsql-parser
  let parse: ((sql: string) => Promise<any>) | null = null
  try {
    const mod = await import('pgsql-parser')
    parse = mod.parse
    console.log('✅ 使用 pgsql-parser (PostgreSQL WASM parser)\n')
  } catch {
    console.log('⚠ pgsql-parser 不可用，使用正则回退\n')
  }

  // 先添加 service 节点
  nodes.push({
    id: `svc:${repo}`,
    entity_type: 'service',
    name: repo,
    repo,
    path: null,
  })

  for (const file of files) {
    const filePath = path.join(resolvedDir, file)
    const sql = fs.readFileSync(filePath, 'utf-8')
    console.log(`📄 ${file} (${(sql.length / 1024).toFixed(1)} KB)`)

    if (parse) {
      try {
        const result = await parse(sql)
        const stmts = Array.isArray(result) ? result : (result.stmts ?? [])
        let extracted = 0
        for (const entry of stmts) {
          const stmt = entry.stmt ?? entry.RawStmt?.stmt ?? entry
          const lineNo = entry.stmt_location ?? entry.RawStmt?.stmt_location ?? 0
          if (stmt.CreateStmt)         { extractTable(stmt.CreateStmt, file, lineNo); extracted++ }
          if (stmt.CreateFunctionStmt) { extractFunction(stmt.CreateFunctionStmt, file, lineNo); extracted++ }
          if (stmt.CreateTrigStmt)     { extractTrigger(stmt.CreateTrigStmt, file, lineNo); extracted++ }
          if (stmt.CreateEnumStmt)     { extractEnum(stmt.CreateEnumStmt, file, lineNo); extracted++ }
        }
        console.log(`   AST 提取 ${extracted} 个实体`)
      } catch (err: any) {
        console.log(`   ⚠ AST 失败，正则回退: ${err.message?.slice(0, 60)}`)
        fallbackRegexParse(sql, file)
      }
    } else {
      fallbackRegexParse(sql, file)
    }
  }
}

// ── AST 提取器 ──────────────────────────────────────────

function getName(nameList: any[]): { schema: string; name: string } {
  if (!nameList) return { schema: 'public', name: '' }
  const parts = nameList
    .map((n: any) => n.String?.sval ?? n.sval ?? n?.str ?? '')
    .filter(Boolean)
  if (parts.length >= 2) return { schema: parts[0], name: parts[parts.length - 1] }
  return { schema: 'public', name: parts[0] ?? '' }
}

function getRelName(rangeVar: any): { schema: string; name: string } {
  if (!rangeVar) return { schema: 'public', name: '' }
  return { schema: rangeVar.schemaname ?? 'public', name: rangeVar.relname ?? '' }
}

function extractTable(node: any, file: string, lineNo: number): void {
  const rel = getRelName(node.relation)
  if (!rel.name) return

  nodes.push({
    id: `table:${repo}/${rel.schema}.${rel.name}`,
    entity_type: 'table',
    name: rel.name,
    repo, path: file, line_start: lineNo, schema: rel.schema,
  })
  tableNames.add(rel.name)
}

function extractFunction(node: any, file: string, lineNo: number): void {
  const { schema, name } = getName(node.funcname)
  if (!name) return

  nodes.push({
    id: `sqlfn:${repo}/${schema}.${name}`,
    entity_type: 'sql_function',
    name, repo, path: file, line_start: lineNo, schema,
  })
  functionNames.add(name)

  const body = extractFunctionBody(node)
  if (body) extractRefsFromBody(body, `sqlfn:${repo}/${schema}.${name}`, name)
}

function extractFunctionBody(node: any): string | null {
  for (const opt of (node.options ?? [])) {
    const defElem = opt.DefElem ?? opt
    if (defElem.defname === 'as') {
      const arg = defElem.arg
      if (!arg) continue

      // pgsql-parser 返回 { List: { items: [{ String: { sval: "..." } }] } }
      const items = arg?.List?.items ?? (Array.isArray(arg) ? arg : [arg])
      for (const item of items) {
        const body = item?.String?.sval ?? item?.sval ?? item?.str
        if (body && body.length > 10) return body
      }
    }
  }
  return null
}

function extractRefsFromBody(body: string, fnId: string, fnName: string): void {
  // 表引用
  // 注意：PL/pgSQL 里 "SELECT INTO var" 和 "RETURNING INTO var" 的 INTO 后面是变量不是表
  // 所以只用 "INSERT INTO" 来匹配表，不用裸的 INTO
  const tablePatterns = [
    /\bFROM\s+"?(?:public\.)?"?(\w+)"?/gi,
    /\bINSERT\s+INTO\s+"?(?:public\.)?"?(\w+)"?/gi,
    /\bUPDATE\s+"?(?:public\.)?"?(\w+)"?/gi,
    /\bJOIN\s+"?(?:public\.)?"?(\w+)"?/gi,
    /\bDELETE\s+FROM\s+"?(?:public\.)?"?(\w+)"?/gi,
  ]

  const referencedTables = new Set<string>()
  for (const pattern of tablePatterns) {
    for (const m of body.matchAll(pattern)) {
      const t = m[1].toLowerCase()
      // 排除 SQL 关键词、PL/pgSQL 变量（v_ / p_ 开头）、别名（单字母）
      // 排除 set-returning 函数（FROM jsonb_array_elements(...) 不是表）
      // 排除 Supabase schema 名（auth.users 的 auth 不是表）
      if (!SQL_KEYWORDS.has(t) && t.length > 2 && !t.startsWith('v_') && !t.startsWith('p_')
          && !SET_RETURNING_FNS.has(t) && !NON_PUBLIC_SCHEMAS.has(t)) {
        referencedTables.add(t)
      }
    }
  }

  for (const table of referencedTables) {
    edges.push({
      caller_id: fnId,
      callee_id: `table:${repo}/public.${table}`,
      callee_name: table,
      line: 0,
      edge_type: 'REFERENCES_TABLE',
    })
  }

  // 函数调用：匹配 function_name( 但排除已知表名、内置函数、自身
  const calledFns = new Set<string>()
  for (const m of body.matchAll(/\b([a-z_]\w+)\s*\(/gi)) {
    const fn = m[1].toLowerCase()
    if (
      !SQL_BUILTINS.has(fn) &&
      !referencedTables.has(fn) &&   // 排除表名（"INSERT INTO orders (" 会误匹配）
      fn !== fnName.toLowerCase() &&
      !fn.startsWith('v_') &&
      !fn.startsWith('p_') &&
      fn.length > 2
    ) {
      calledFns.add(fn)
    }
  }

  for (const fn of calledFns) {
    edges.push({
      caller_id: fnId,
      callee_id: `sqlfn:${repo}/public.${fn}`,
      callee_name: fn,
      line: 0,
    })
  }
}

function extractTrigger(node: any, file: string, lineNo: number): void {
  const trigName = node.trigname ?? ''
  const table = getRelName(node.relation)
  const { name: fnName } = getName(node.funcname)
  if (!trigName) return

  const id = `trigger:${repo}/${trigName}`
  nodes.push({
    id, entity_type: 'trigger', name: trigName,
    repo, path: file, line_start: lineNo, schema: 'public',
  })

  if (table.name) {
    edges.push({ caller_id: id, callee_id: `table:${repo}/public.${table.name}`, callee_name: table.name, line: 0, edge_type: 'TRIGGERED_ON' })
  }
  if (fnName) {
    edges.push({ caller_id: id, callee_id: `sqlfn:${repo}/public.${fnName}`, callee_name: fnName, line: 0, edge_type: 'TRIGGERS_FUNCTION' })
  }
}

function extractEnum(node: any, file: string, lineNo: number): void {
  const { schema, name } = getName(node.typeName)
  if (!name) return
  nodes.push({
    id: `type:${repo}/${schema}.${name}`, entity_type: 'enum_type', name,
    repo, path: file, line_start: lineNo, schema,
  })
}

// ── 正则回退 ────────────────────────────────────────────

function fallbackRegexParse(sql: string, file: string): void {
  let count = 0

  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?"?(?:public)?"?\."?(\w+)"?/gi)) {
    nodes.push({ id: `table:${repo}/public.${m[1]}`, entity_type: 'table', name: m[1], repo, path: file, line_start: 0 })
    tableNames.add(m[1]); count++
  }

  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?(?:public)?"?\."?(\w+)"?/gi)) {
    nodes.push({ id: `sqlfn:${repo}/public.${m[1]}`, entity_type: 'sql_function', name: m[1], repo, path: file, line_start: 0 })
    functionNames.add(m[1]); count++
  }

  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(\w+)"?\s+.*?\s+ON\s+"?(?:public)?"?\."?(\w+)"?\s+.*?EXECUTE\s+FUNCTION\s+"?(?:public)?"?\."?(\w+)"?/gis)) {
    const [, trig, table, fn] = m
    nodes.push({ id: `trigger:${repo}/${trig}`, entity_type: 'trigger', name: trig, repo, path: file, line_start: 0 })
    edges.push({ caller_id: `trigger:${repo}/${trig}`, callee_id: `table:${repo}/public.${table}`, callee_name: table, line: 0, edge_type: 'TRIGGERED_ON' })
    edges.push({ caller_id: `trigger:${repo}/${trig}`, callee_id: `sqlfn:${repo}/public.${fn}`, callee_name: fn, line: 0, edge_type: 'TRIGGERS_FUNCTION' })
    count++
  }

  for (const m of sql.matchAll(/CREATE\s+TYPE\s+"?(?:public)?"?\."?(\w+)"?\s+AS\s+ENUM/gi)) {
    nodes.push({ id: `type:${repo}/public.${m[1]}`, entity_type: 'enum_type', name: m[1], repo, path: file, line_start: 0 })
    count++
  }

  console.log(`   正则提取 ${count} 个实体`)
}

// ── Set-returning 函数（会出现在 FROM 子句但不是表）─────

const SET_RETURNING_FNS = new Set([
  'jsonb_array_elements', 'jsonb_array_elements_text', 'jsonb_each',
  'jsonb_each_text', 'jsonb_object_keys', 'jsonb_populate_recordset',
  'json_array_elements', 'json_array_elements_text', 'json_each',
  'unnest', 'generate_series', 'regexp_matches', 'regexp_split_to_table',
  'now', 'current_timestamp',
])

// ── Supabase schema 名（不是 public 下的表）─────────────

const NON_PUBLIC_SCHEMAS = new Set(['auth', 'storage', 'realtime', 'extensions', 'supabase_functions'])

// ── SQL 关键词排除 ─────────────────────────────────────

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'drop', 'alter',
  'table', 'index', 'view', 'function', 'trigger', 'type', 'schema', 'database',
  'if', 'then', 'else', 'elsif', 'end', 'case', 'when', 'begin', 'declare',
  'return', 'returns', 'loop', 'for', 'while', 'exit', 'continue', 'raise',
  'exception', 'notice', 'perform', 'execute', 'new', 'old', 'row', 'each',
  'before', 'after', 'instead', 'of', 'on', 'as', 'with', 'recursive',
  'join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'using',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'intersect',
  'except', 'all', 'any', 'some', 'exists', 'between', 'like', 'ilike',
  'primary', 'key', 'foreign', 'references', 'constraint', 'check', 'default',
  'cascade', 'restrict', 'grant', 'revoke', 'public',
  'text', 'integer', 'bigint', 'numeric', 'boolean', 'uuid', 'jsonb', 'json',
  'timestamp', 'date', 'time', 'interval', 'varchar', 'character',
  'found', 'strict', 'record', 'void', 'definer', 'security',
])

const SQL_BUILTINS = new Set([
  ...SQL_KEYWORDS,
  'now', 'current_date', 'current_time', 'current_timestamp', 'localtime',
  'coalesce', 'nullif', 'greatest', 'least', 'cast',
  'count', 'sum', 'avg', 'min', 'max', 'array_agg', 'string_agg',
  'length', 'lower', 'upper', 'trim', 'substring', 'replace', 'regexp_replace',
  'to_jsonb', 'jsonb_build_object', 'jsonb_set', 'jsonb_array_elements', 'jsonb_each',
  'to_char', 'to_number', 'to_date', 'to_timestamp',
  'extract', 'date_trunc', 'age', 'date_part',
  'gen_random_uuid', 'uuid_generate_v4',
  'round', 'ceil', 'floor', 'abs', 'mod', 'power', 'sqrt',
  'concat', 'format', 'chr', 'ascii', 'encode', 'decode',
  'array_length', 'array_append', 'array_remove', 'unnest',
  'row_number', 'rank', 'dense_rank', 'lag', 'lead',
  'pg_catalog', 'set_config', 'current_setting',
  'raise', 'found', 'tg_op', 'sqlerrm',
  // 补充遗漏的 PG 内置函数
  'random', 'substr', 'md5', 'clock_timestamp',
  'jsonb_agg', 'jsonb_array_length', 'jsonb_array_elements_text',
  'row_to_json', 'array', 'http_post', 'decimal',
  // Supabase auth 函数（auth.uid() / auth.users 等）
  'uid', 'users',
])

// ── 输出 ────────────────────────────────────────────────

function writeOutput(): void {
  // 去重（后面的 migration 覆盖前面的 CREATE OR REPLACE）
  const uniqueNodes = new Map<string, CpgNode>()
  for (const n of nodes) uniqueNodes.set(n.id, n)

  // 去重边
  const uniqueEdges = new Map<string, CpgEdge>()
  for (const e of edges) uniqueEdges.set(`${e.caller_id}→${e.callee_id}→${e.edge_type ?? 'CALLS'}`, e)

  // ── 后处理验证：只保留 callee 在已提取节点集合里的边 ──
  // 这样可以干掉 PL/pgSQL 变量误判、表名单复数不匹配等问题
  const nodeIdSet = new Set(uniqueNodes.keys())
  const validEdges: CpgEdge[] = []
  const droppedEdges: CpgEdge[] = []

  for (const e of uniqueEdges.values()) {
    if (nodeIdSet.has(e.caller_id) && nodeIdSet.has(e.callee_id)) {
      validEdges.push(e)
    } else {
      droppedEdges.push(e)
    }
  }

  if (droppedEdges.length > 0) {
    console.log(`\n⚠️  后处理验证丢弃了 ${droppedEdges.length} 条边（目标节点不存在）：`)
    const byReason = new Map<string, number>()
    for (const e of droppedEdges) {
      const missingCaller = !nodeIdSet.has(e.caller_id)
      const missingCallee = !nodeIdSet.has(e.callee_id)
      const missing = missingCaller ? e.caller_id : e.callee_id
      byReason.set(missing, (byReason.get(missing) ?? 0) + 1)
    }
    for (const [id, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${id} (×${count})`)
    }
  }

  const output = {
    repo,
    source: 'sql-migrations',
    nodes: [...uniqueNodes.values()],
    calls: validEdges,
  }

  const outPath = path.resolve(outFile)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))

  console.log(`\n✅ 输出: ${outPath}`)
  console.log(`   节点: ${output.nodes.length}`)
  console.log(`   关系: ${output.calls.length}`)

  // 分类统计
  const byType: Record<string, number> = {}
  for (const n of output.nodes) byType[n.entity_type] = (byType[n.entity_type] ?? 0) + 1
  for (const [t, c] of Object.entries(byType)) console.log(`     ${t}: ${c}`)

  const byEdge: Record<string, number> = {}
  for (const e of output.calls) byEdge[e.edge_type ?? 'CALLS'] = (byEdge[e.edge_type ?? 'CALLS'] ?? 0) + 1
  for (const [t, c] of Object.entries(byEdge)) console.log(`     [${t}]: ${c}`)
}

// ── 主流程 ──────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🗄️  SQL Schema 解析\n   repo=${repo}\n   dir=${sqlDir}\n   out=${outFile}\n`)
  await parseAllMigrations()
  writeOutput()
}

main().catch(err => {
  console.error('失败:', err.message)
  process.exit(1)
})

/**
 * ingestion/shared.ts
 *
 * Shared utility functions used by multiple pipelines.
 * Extracted from cold-start-v2.ts, zero logic change.
 */

import fs from 'fs'
import path from 'path'
import { Session } from 'neo4j-driver'
import { BusinessContext, CallerCalleeCode } from '../prompts/grouping'

// ── Types ───────────────────────────────────────────────

export interface FileInfo {
  filePath: string
  fileName: string
  repo: string
  functions: { name: string; lineStart: number; lineEnd: number }[]
  crossCallers: string[]  // "filePath::funcName"
  crossCallees: string[]  // "filePath::funcName"
}

export interface PerFunctionDeps {
  [fnName: string]: { callers: string[]; callees: string[] }
}

export interface FunctionCodeDetail {
  name: string
  filePath: string
  lineStart: number
  lineEnd: number
}

export interface PendingDecision {
  id: string
  props: Record<string, any>
  functionName: string
  relatedFunctions: string[]
  filePath: string
  fileName: string
  repo: string
}

export interface WorthyFunction {
  name: string
  filePath: string
  fileName: string
  repo: string
  lineStart: number
  lineEnd: number
}

// ── Constants ───────────────────────────────────────────

export const MAX_CALLERS = 8
export const MAX_CALLEES = 8

// ── Utilities ───────────────────────────────────────────

export function toNum(val: any): number {
  if (val === null || val === undefined) return -1
  if (typeof val === 'number') return val
  if (typeof val?.toNumber === 'function') return val.toNumber()
  const n = parseInt(String(val))
  return isNaN(n) ? -1 : n
}

export function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\[[\s\S]*\]/) || raw.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch {}
    }
    return fallback
  }
}

// ── Concurrency ─────────────────────────────────────────

export async function runWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  async function worker() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// ── Source File Helpers ──────────────────────────────────

export function resolveSourcePath(repoPath: string, filePath: string): string | null {
  const candidates = [
    path.join(repoPath, filePath),
    path.join(repoPath, 'src', filePath),
    ...(filePath.startsWith('src/') ? [path.join(repoPath, filePath.slice(4))] : []),
  ]
  return candidates.find(p => fs.existsSync(p)) ?? null
}

export function extractFunctionCode(
  repoPath: string, filePath: string, lineStart: number, lineEnd: number
): string | null {
  const srcPath = resolveSourcePath(repoPath, filePath)
  if (!srcPath) return null
  try {
    const lines = fs.readFileSync(srcPath, 'utf-8').split('\n')
    const start = Math.max(0, lineStart - 1)
    const end = Math.min(lines.length, lineEnd)
    const code = lines.slice(start, end).join('\n')
    return code.length > 5000 ? code.slice(0, 5000) + '\n// [truncated]' : code
  } catch { return null }
}

export function readFullFile(repoPath: string, filePath: string): string | null {
  const srcPath = resolveSourcePath(repoPath, filePath)
  if (!srcPath) return null
  try {
    const code = fs.readFileSync(srcPath, 'utf-8')
    return code.length > 80000 ? code.slice(0, 80000) + '\n// [truncated]' : code
  } catch { return null }
}

// ── Memgraph Queries ────────────────────────────────────

export async function getFilesFromGraph(session: Session, repo: string): Promise<FileInfo[]> {
  const fileResult = await session.run(
    `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})
     RETURN f.path AS filePath, f.name AS fileName
     ORDER BY f.path`,
    { repo }
  )

  const files: FileInfo[] = []

  for (const record of fileResult.records) {
    const filePath = record.get('filePath') as string
    const fileName = record.get('fileName') as string

    const fnResult = await session.run(
      `MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
       WHERE fn.name <> ':program'
       RETURN fn.name AS name, fn.line_start AS ls, fn.line_end AS le
       ORDER BY fn.line_start`,
      { filePath, repo }
    )

    const fns = fnResult.records
      .map(r => ({
        name: r.get('name') as string,
        lineStart: toNum(r.get('ls')),
        lineEnd: toNum(r.get('le')),
      }))
      .filter(f => f.name && f.lineStart > 0)

    if (fns.length === 0) continue

    let crossCallers: string[] = []
    try {
      const callerResult = await session.run(
        `MATCH (caller:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(callee:CodeEntity {entity_type: 'function', repo: $repo})
         MATCH (callerFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(caller)
         MATCH (calleeFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(callee)
         WHERE callerFile.path <> $filePath AND caller.name <> ':program' AND callee.name <> ':program'
         RETURN DISTINCT callerFile.path + '::' + caller.name AS ref
         LIMIT 15`,
        { repo, filePath }
      )
      crossCallers = callerResult.records.map(r => r.get('ref') as string)
    } catch {}

    let crossCallees: string[] = []
    try {
      const calleeResult = await session.run(
        `MATCH (caller:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(callee:CodeEntity {entity_type: 'function', repo: $repo})
         MATCH (callerFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(caller)
         MATCH (calleeFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(callee)
         WHERE calleeFile.path <> $filePath AND caller.name <> ':program' AND callee.name <> ':program'
         RETURN DISTINCT calleeFile.path + '::' + callee.name AS ref
         LIMIT 15`,
        { repo, filePath }
      )
      crossCallees = calleeResult.records.map(r => r.get('ref') as string)
    } catch {}

    files.push({ filePath, fileName, repo, functions: fns, crossCallers, crossCallees })
  }

  return files
}

export async function getBusinessContext(session: Session): Promise<BusinessContext[]> {
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext {source: 'manual_business_context'})
       RETURN d.summary AS summary, d.content AS content
       ORDER BY d.updated_at DESC`
    )
    return result.records.map(r => ({
      summary: r.get('summary') as string,
      content: r.get('content') as string,
    }))
  } catch {
    return []
  }
}

export async function getPerFunctionDeps(
  session: Session, filePath: string, repo: string
): Promise<PerFunctionDeps> {
  const deps: PerFunctionDeps = {}

  try {
    const result = await session.run(
      `MATCH (caller:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
       MATCH (calleeFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(callee)
       MATCH (callerFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(caller)
       WHERE callerFile.path <> $filePath AND caller.name <> ':program' AND callee.name <> ':program'
       RETURN callee.name AS targetFn, callerFile.path + '::' + caller.name AS callerRef`,
      { repo, filePath }
    )
    for (const r of result.records) {
      const fn = r.get('targetFn') as string
      if (!deps[fn]) deps[fn] = { callers: [], callees: [] }
      const ref = r.get('callerRef') as string
      if (!deps[fn].callers.includes(ref)) deps[fn].callers.push(ref)
    }
  } catch {}

  try {
    const result = await session.run(
      `MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee:CodeEntity {entity_type: 'function', repo: $repo})
       MATCH (callerFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(caller)
       MATCH (calleeFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(callee)
       WHERE calleeFile.path <> $filePath AND caller.name <> ':program' AND callee.name <> ':program'
       RETURN caller.name AS sourceFn, calleeFile.path + '::' + callee.name AS calleeRef`,
      { repo, filePath }
    )
    for (const r of result.records) {
      const fn = r.get('sourceFn') as string
      if (!deps[fn]) deps[fn] = { callers: [], callees: [] }
      const ref = r.get('calleeRef') as string
      if (!deps[fn].callees.includes(ref)) deps[fn].callees.push(ref)
    }
  } catch {}

  return deps
}

export async function getFunctionCallersDetail(
  session: Session, fnName: string, filePath: string, repo: string
): Promise<FunctionCodeDetail[]> {
  try {
    const result = await session.run(
      `MATCH (caller:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(callee:CodeEntity {entity_type: 'function', name: $fnName})
       MATCH (calleeFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(callee)
       MATCH (callerFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(caller)
       WHERE caller.name <> ':program'
       RETURN DISTINCT caller.name AS name, callerFile.path AS callerFilePath,
              caller.line_start AS ls, caller.line_end AS le
       LIMIT $limit`,
      { repo, fnName, filePath, limit: MAX_CALLERS }
    )
    return result.records.map(r => ({
      name: r.get('name') as string,
      filePath: r.get('callerFilePath') as string,
      lineStart: toNum(r.get('ls')),
      lineEnd: toNum(r.get('le')),
    })).filter(f => f.lineStart > 0 && f.lineEnd > 0)
  } catch { return [] }
}

export async function getFunctionCalleesDetail(
  session: Session, fnName: string, filePath: string, repo: string
): Promise<FunctionCodeDetail[]> {
  try {
    const result = await session.run(
      `MATCH (caller:CodeEntity {entity_type: 'function', name: $fnName})-[:CALLS]->(callee:CodeEntity {entity_type: 'function', repo: $repo})
       MATCH (callerFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(caller)
       MATCH (calleeFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(callee)
       WHERE callee.name <> ':program'
       RETURN DISTINCT callee.name AS name, calleeFile.path AS calleeFilePath,
              callee.line_start AS ls, callee.line_end AS le
       LIMIT $limit`,
      { repo, fnName, filePath, limit: MAX_CALLEES }
    )
    return result.records.map(r => ({
      name: r.get('name') as string,
      filePath: r.get('calleeFilePath') as string,
      lineStart: toNum(r.get('ls')),
      lineEnd: toNum(r.get('le')),
    })).filter(f => f.lineStart > 0 && f.lineEnd > 0)
  } catch { return [] }
}

// ── Memgraph Write ──────────────────────────────────────

export async function batchWriteDecisions(
  session: Session, decisions: PendingDecision[]
): Promise<{ nodes: number; anchored: number }> {
  if (decisions.length === 0) return { nodes: 0, anchored: 0 }
  const BATCH = 50

  for (let i = 0; i < decisions.length; i += BATCH) {
    const batch = decisions.slice(i, i + BATCH).map(d => ({ id: d.id, ...d.props }))
    await session.run(
      `UNWIND $batch AS d MERGE (n:DecisionContext {id: d.id}) SET n += d`,
      { batch }
    )
  }

  let anchored = 0
  for (const d of decisions) {
    const fnResult = await session.run(
      `MATCH (dc:DecisionContext {id: $dcId})
       MATCH (fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})
       MATCH (f:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(fn)
       MERGE (dc)-[:ANCHORED_TO]->(fn)
       SET dc.anchored_content_hash = fn.content_hash
       RETURN fn.id`,
      { dcId: d.id, fnName: d.functionName, repo: d.repo, filePath: d.filePath }
    )

    if (fnResult.records.length > 0) {
      anchored++
    } else {
      const fileResult = await session.run(
        `MATCH (dc:DecisionContext {id: $dcId})
         MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})
         MERGE (dc)-[:APPROXIMATE_TO]->(f)
         RETURN f.id`,
        { dcId: d.id, filePath: d.filePath, repo: d.repo }
      )
      if (fileResult.records.length > 0) anchored++
    }

    for (const relFn of d.relatedFunctions) {
      try {
        await session.run(
          `MATCH (dc:DecisionContext {id: $dcId})
           MATCH (fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})
           MERGE (dc)-[:MENTIONS]->(fn)`,
          { dcId: d.id, fnName: relFn, repo: d.repo }
        )
      } catch {}
    }
  }

  return { nodes: decisions.length, anchored }
}

export async function deleteOldDecisions(session: Session, decisionIds: string[]): Promise<number> {
  if (decisionIds.length === 0) return 0
  let deleted = 0
  for (const id of decisionIds) {
    try {
      await session.run(`MATCH (d:DecisionContext {id: $id}) DETACH DELETE d`, { id })
      deleted++
    } catch {}
  }
  return deleted
}

// ── Caller/Callee Code Extraction ───────────────────────
// 从图谱查详情 + 从磁盘读代码，组装成 prompt 需要的格式

export async function buildCallerCalleeCodes(
  session: Session, fnName: string, filePath: string, repo: string, repoPath: string
): Promise<{ callerCodes: CallerCalleeCode[]; calleeCodes: CallerCalleeCode[] }> {
  const callersDetail = await getFunctionCallersDetail(session, fnName, filePath, repo)
  const calleesDetail = await getFunctionCalleesDetail(session, fnName, filePath, repo)

  const callerCodes: CallerCalleeCode[] = []
  for (const c of callersDetail) {
    const code = extractFunctionCode(repoPath, c.filePath, c.lineStart, c.lineEnd)
    if (code) callerCodes.push({ name: c.name, filePath: c.filePath, code })
  }

  const calleeCodes: CallerCalleeCode[] = []
  for (const c of calleesDetail) {
    const code = extractFunctionCode(repoPath, c.filePath, c.lineStart, c.lineEnd)
    if (code) calleeCodes.push({ name: c.name, filePath: c.filePath, code })
  }

  return { callerCodes, calleeCodes }
}

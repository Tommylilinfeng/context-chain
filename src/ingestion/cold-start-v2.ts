/**
 * cold-start-v2.ts
 *
 * Four-round pipeline:
 *   Round 1 — Scope Selection: LLM picks relevant files for a goal
 *   Round 2 — Triage: per-file, identify functions worth deep analysis
 *   Round 3 — Deep Analysis: per-function, extract decisions with full caller/callee context
 *   Round 4 — Relationships: group related decisions, then deep-analyze each group for edges + keyword normalization
 *
 * Usage:
 *   npm run cold-start:v2 -- --goal "订单流程和支付" --repo biteme-shared --owner me
 *   npm run cold-start:v2 -- --goal "coupon系统" --concurrency 3
 */

import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig, RepoConfig } from '../config'
import {
  buildScopePrompt, buildTriagePrompt, buildDeepAnalysisPrompt,
  buildGroupingPrompt, buildRelationshipPrompt, buildKeywordNormalizationPrompt,
  FileEntry, FunctionTriageEntry, CallerCalleeCode, BusinessContext,
  DecisionSummaryForGrouping, DecisionFullContent
} from '../prompts/cold-start'
import { Session } from 'neo4j-driver'
import { loadState, saveState, getFileKey, ColdStartState } from './state'
import { getHeadCommit, getChangedFiles, hasFileChanged } from './git-utils'

// ── CLI ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }

const goal        = getArg('--goal')
const targetRepo  = getArg('--repo')
const owner       = getArg('--owner') ?? 'me'
const concurrency = parseInt(getArg('--concurrency') ?? '2')
const dryRun      = args.includes('--dry-run')
const force       = args.includes('--force')
const deepCheck   = args.includes('--deep-check')

if (!goal) {
  console.error('用法: npm run cold-start:v2 -- --goal "目标描述" [--repo name] [--owner me] [--concurrency 2] [--dry-run]')
  process.exit(1)
}

// ── Claude CLI wrapper ──────────────────────────────────

function callClaude(prompt: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmp = `/tmp/ckg-v2-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    fs.writeFileSync(tmp, prompt, 'utf-8')

    exec(`cat "${tmp}" | claude -p --tools "" --output-format json`, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      try { fs.unlinkSync(tmp) } catch {}
      if (err) { reject(new Error(`claude -p failed: ${err.message}`)); return }
      try {
        const wrapper = JSON.parse(stdout.trim())
        const raw: string = wrapper.result ?? ''
        const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
        resolve(cleaned)
      } catch (e: any) {
        reject(new Error(`Failed to parse claude output: ${e.message}`))
      }
    })
  })
}

function parseJsonSafe<T>(raw: string, fallback: T): T {
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

// ── Memgraph queries ────────────────────────────────────

interface FileInfo {
  filePath: string
  fileName: string
  repo: string
  functions: { name: string; lineStart: number; lineEnd: number }[]
  crossCallers: string[]  // "filePath::funcName"
  crossCallees: string[]  // "filePath::funcName"
}

async function getFilesFromGraph(session: Session, repo: string): Promise<FileInfo[]> {
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

function toNum(val: any): number {
  if (val === null || val === undefined) return -1
  if (typeof val === 'number') return val
  if (typeof val?.toNumber === 'function') return val.toNumber()
  return parseInt(String(val)) || -1
}

async function getBusinessContext(session: Session): Promise<BusinessContext[]> {
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

// ── Round 2: Per-function callers/callees (names only) ──

interface PerFunctionDeps {
  [fnName: string]: { callers: string[]; callees: string[] }
}

async function getPerFunctionDeps(session: Session, filePath: string, repo: string): Promise<PerFunctionDeps> {
  const deps: PerFunctionDeps = {}

  // Callers: who calls which function in this file
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

  // Callees: which function in this file calls what
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

// ── Round 3: Full caller/callee code extraction ─────────

interface FunctionCodeDetail {
  name: string
  filePath: string
  lineStart: number
  lineEnd: number
}

const MAX_CALLERS = 8
const MAX_CALLEES = 8

async function getFunctionCallersDetail(
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

async function getFunctionCalleesDetail(
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

// ── Source file helpers ──────────────────────────────────

function resolveSourcePath(repoPath: string, filePath: string): string | null {
  const candidates = [
    path.join(repoPath, filePath),
    path.join(repoPath, 'src', filePath),
    ...(filePath.startsWith('src/') ? [path.join(repoPath, filePath.slice(4))] : []),
  ]
  return candidates.find(p => fs.existsSync(p)) ?? null
}

function extractFunctionCode(repoPath: string, filePath: string, lineStart: number, lineEnd: number): string | null {
  const srcPath = resolveSourcePath(repoPath, filePath)
  if (!srcPath) return null
  try {
    const lines = fs.readFileSync(srcPath, 'utf-8').split('\n')
    // line numbers are 1-based
    const start = Math.max(0, lineStart - 1)
    const end = Math.min(lines.length, lineEnd)
    const code = lines.slice(start, end).join('\n')
    // Cap at 5000 chars per function to avoid huge prompts
    return code.length > 5000 ? code.slice(0, 5000) + '\n// [truncated]' : code
  } catch { return null }
}

function readFullFile(repoPath: string, filePath: string): string | null {
  const srcPath = resolveSourcePath(repoPath, filePath)
  if (!srcPath) return null
  try {
    const code = fs.readFileSync(srcPath, 'utf-8')
    return code.length > 80000 ? code.slice(0, 80000) + '\n// [truncated]' : code
  } catch { return null }
}

// ── Concurrency helper ──────────────────────────────────

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

// ── Batch write ─────────────────────────────────────────

interface PendingDecision {
  id: string
  props: Record<string, any>
  functionName: string
  relatedFunctions: string[]
  filePath: string
  fileName: string
  repo: string
}

async function batchWriteDecisions(session: Session, decisions: PendingDecision[]): Promise<{ nodes: number; anchored: number }> {
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
           MERGE (dc)-[:ANCHORED_TO]->(fn)`,
          { dcId: d.id, fnName: relFn, repo: d.repo }
        )
      } catch {}
    }
  }

  return { nodes: decisions.length, anchored }
}

// ── Delete old decisions ────────────────────────────────

async function deleteOldDecisions(session: Session, decisionIds: string[]): Promise<number> {
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

// ── Change detection ────────────────────────────────────

function isFileChanged(
  repoPath: string, repo: string, filePath: string,
  state: ColdStartState, allChangedFiles: Set<string>
): { changed: boolean; reason: string; oldDecisionIds: string[] } {
  const key = getFileKey(repo, filePath)
  const prev = state.files[key]

  if (!prev) return { changed: true, reason: 'new (never analyzed)', oldDecisionIds: [] }

  if (allChangedFiles.has('__ALL__') || allChangedFiles.has(filePath)) {
    return { changed: true, reason: 'code changed', oldDecisionIds: prev.decisionIds }
  }

  const srcVariant = filePath.startsWith('src/') ? filePath.slice(4) : 'src/' + filePath
  if (allChangedFiles.has(srcVariant)) {
    return { changed: true, reason: 'code changed', oldDecisionIds: prev.decisionIds }
  }

  return { changed: false, reason: 'unchanged', oldDecisionIds: prev.decisionIds }
}

function checkDependencyChanges(
  fileInfo: FileInfo, allChangedFiles: Set<string>, files: FileInfo[], deep: boolean
): boolean {
  for (const calleeRef of fileInfo.crossCallees) {
    const calleeFilePath = calleeRef.split('::')[0]
    const calleeFile = files.find(f => f.filePath === calleeFilePath)
    if (calleeFile && (allChangedFiles.has(calleeFile.filePath) || allChangedFiles.has('__ALL__'))) {
      return true
    }
  }

  if (deep) {
    for (const callerRef of fileInfo.crossCallers) {
      const callerFilePath = callerRef.split('::')[0]
      const callerFile = files.find(f => f.filePath === callerFilePath)
      if (callerFile && (allChangedFiles.has(callerFile.filePath) || allChangedFiles.has('__ALL__'))) {
        return true
      }
    }
  }

  return false
}

// ── Main pipeline ───────────────────────────────────────

interface WorthyFunction {
  name: string
  filePath: string
  fileName: string
  repo: string
  lineStart: number
  lineEnd: number
}

async function main(): Promise<void> {
  const startTime = Date.now()
  const config = loadConfig()
  const repos = targetRepo
    ? config.repos.filter(r => r.name === targetRepo)
    : config.repos

  if (repos.length === 0) {
    console.error(`Repo "${targetRepo}" not found in ckg.config.json`)
    process.exit(1)
  }

  console.log(`\n🧊 Cold-start v2`)
  console.log(`   Goal: "${goal}"`)
  console.log(`   Repos: ${repos.map(r => r.name).join(', ')}`)
  console.log(`   Concurrency: ${concurrency}`)
  if (force) console.log(`   FORCE mode: re-analyzing all files`)
  if (deepCheck) console.log(`   DEEP CHECK: also re-analyze when callers change`)
  if (dryRun) console.log(`   ⚠️  DRY RUN — no writes to Memgraph`)
  console.log()

  const state = loadState()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const allDecisions: PendingDecision[] = []
    const analyzedFiles: { repo: string; filePath: string; decisionIds: string[]; commit: string }[] = []

    for (const repoConfig of repos) {
      console.log(`\n━━━ ${repoConfig.name} ━━━`)

      // ─── Step 0: Get file info from graph ───────────────

      const files = await getFilesFromGraph(session, repoConfig.name)
      console.log(`  📁 ${files.length} files with functions in graph`)

      if (files.length === 0) {
        console.log(`  ⚠️  No files found. Run ingest:cpg first.`)
        continue
      }

      // ─── Round 1: Scope Selection ───────────────────────

      console.log(`\n  🎯 Round 1: Scope Selection`)

      const fileEntries: FileEntry[] = files.map(f => ({
        file: f.filePath,
        functions: f.functions.map(fn => `${fn.name} (${fn.lineStart}-${fn.lineEnd})`),
        callers: f.crossCallers,
        callees: f.crossCallees,
      }))

      const scopePrompt = buildScopePrompt(goal!, fileEntries)
      let selectedFiles: string[]

      try {
        const raw = await callClaude(scopePrompt)
        selectedFiles = parseJsonSafe<string[]>(raw, [])
        if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
          console.log(`  ⚠️  LLM returned no files, falling back to all files`)
          selectedFiles = files.map(f => f.filePath)
        }
      } catch (err: any) {
        console.log(`  ⚠️  Round 1 failed (${err.message}), falling back to all files`)
        selectedFiles = files.map(f => f.filePath)
      }

      const normalize = (p: string) => p.replace(/^\.?\//, '').replace(/^src\//, '')
      const selectedNorm = new Set(selectedFiles.map(normalize))
      const selectedFileInfos = files.filter(f =>
        selectedFiles.includes(f.filePath) || selectedNorm.has(normalize(f.filePath))
      )
      console.log(`  ✓ Selected ${selectedFileInfos.length}/${files.length} files:`)
      for (const f of selectedFileInfos) {
        console.log(`    • ${f.filePath} (${f.functions.length} functions)`)
      }

      if (dryRun) {
        console.log(`\n  [dry-run] Would triage ${selectedFileInfos.length} files`)
        continue
      }

      // ─── Change Detection ─────────────────────────────

      let headCommit = 'unknown'
      let filesToAnalyze = selectedFileInfos

      if (!force) {
        try {
          headCommit = getHeadCommit(repoConfig.path)
          const repoStateEntries = Object.entries(state.files)
            .filter(([k]) => k.startsWith(repoConfig.name + ':'))
          const lastCommit = repoStateEntries.length > 0
            ? repoStateEntries[0][1].lastCommit
            : null

          if (lastCommit && lastCommit !== 'unknown') {
            const changedFiles = new Set(getChangedFiles(repoConfig.path, lastCommit))
            console.log(`\n  git: ${changedFiles.size === 1 && changedFiles.has('__ALL__') ? 'all files (first run or invalid commit)' : changedFiles.size + ' files changed since ' + lastCommit.slice(0, 7)}`)

            const changed: FileInfo[] = []
            const skipped: FileInfo[] = []

            for (const fi of selectedFileInfos) {
              const result = isFileChanged(repoConfig.path, repoConfig.name, fi.filePath, state, changedFiles)
              if (result.changed) {
                changed.push(fi)
              } else if (checkDependencyChanges(fi, changedFiles, files, deepCheck)) {
                changed.push(fi)
              } else {
                skipped.push(fi)
              }
            }

            if (skipped.length > 0) {
              console.log(`  Skipping ${skipped.length} unchanged files:`)
              for (const f of skipped) console.log(`    - ${f.fileName} (unchanged)`)
            }

            filesToAnalyze = changed
            if (filesToAnalyze.length === 0) {
              console.log(`  No changed files to analyze in this repo`)
              continue
            }
          } else {
            console.log(`\n  git: first run, analyzing all selected files`)
          }
        } catch (e: any) {
          console.log(`\n  git: change detection failed (${e.message}), analyzing all`)
        }
      } else {
        console.log(`\n  --force: skipping change detection`)
      }

      // ─── Delete old decisions ─────────────────────────

      for (const fi of filesToAnalyze) {
        const key = getFileKey(repoConfig.name, fi.filePath)
        const prev = state.files[key]
        if (prev && prev.decisionIds.length > 0) {
          const deleted = await deleteOldDecisions(session, prev.decisionIds)
          if (deleted > 0) console.log(`    Replaced ${deleted} old decisions for ${fi.fileName}`)
        }
      }

      // ─── Fetch business context (used by Round 2 and 3) ─

      const bizCtx = await getBusinessContext(session)
      if (bizCtx.length > 0) console.log(`  📋 ${bizCtx.length} business context entries loaded`)

      // ─── Round 2: Triage (per file) ─────────────────────

      console.log(`\n  🔍 Round 2: Triage — ${filesToAnalyze.length} files`)

      const allWorthyFunctions: WorthyFunction[] = []

      const triageResults = await runWithConcurrency(
        filesToAnalyze,
        concurrency,
        async (fileInfo) => {
          const code = readFullFile(repoConfig.path, fileInfo.filePath)
          if (!code) {
            console.log(`    ✗ ${fileInfo.fileName} — file not found`)
            return []
          }

          // Get per-function callers/callees for triage
          const perFnDeps = await getPerFunctionDeps(session, fileInfo.filePath, repoConfig.name)

          const triageEntries: FunctionTriageEntry[] = fileInfo.functions.map(fn => ({
            name: fn.name,
            lines: `${fn.lineStart}-${fn.lineEnd}`,
            callers: perFnDeps[fn.name]?.callers ?? [],
            callees: perFnDeps[fn.name]?.callees ?? [],
          }))

          const prompt = buildTriagePrompt(fileInfo.filePath, code, triageEntries, bizCtx, goal!)

          try {
            const raw = await callClaude(prompt)
            const worthy = parseJsonSafe<string[]>(raw, [])
            if (!Array.isArray(worthy)) return []

            // Map names back to full function info
            const results: WorthyFunction[] = []
            for (const fnName of worthy) {
              const fnInfo = fileInfo.functions.find(f => f.name === fnName)
              if (fnInfo) {
                results.push({
                  name: fnInfo.name,
                  filePath: fileInfo.filePath,
                  fileName: fileInfo.fileName,
                  repo: repoConfig.name,
                  lineStart: fnInfo.lineStart,
                  lineEnd: fnInfo.lineEnd,
                })
              }
            }

            const totalFns = fileInfo.functions.length
            console.log(`    ✓ ${fileInfo.fileName} — ${results.length}/${totalFns} functions worth analyzing`)
            return results
          } catch (err: any) {
            console.log(`    ✗ ${fileInfo.fileName} — triage failed: ${err.message}`)
            return []
          }
        }
      )

      for (const results of triageResults) {
        allWorthyFunctions.push(...results)
      }

      const round2Time = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`\n  📊 Round 2 complete: ${allWorthyFunctions.length} functions selected for deep analysis (${round2Time}s)`)

      if (allWorthyFunctions.length === 0) {
        console.log(`  No functions worth analyzing in this repo`)
        // Still track files as analyzed (with 0 decisions) so we don't re-triage
        for (const fi of filesToAnalyze) {
          analyzedFiles.push({ repo: repoConfig.name, filePath: fi.filePath, decisionIds: [], commit: headCommit })
        }
        continue
      }

      // ─── Round 3: Deep Analysis (per function) ──────────

      console.log(`\n  🔬 Round 3: Deep Analysis — ${allWorthyFunctions.length} functions`)

      const repoDecisions: PendingDecision[] = []

      const round3Results = await runWithConcurrency(
        allWorthyFunctions,
        concurrency,
        async (wf) => {
          // Extract target function code
          const fnCode = extractFunctionCode(repoConfig.path, wf.filePath, wf.lineStart, wf.lineEnd)
          if (!fnCode) {
            console.log(`    ✗ ${wf.name} — could not extract code`)
            return []
          }

          // Get callers/callees with full detail
          const callersDetail = await getFunctionCallersDetail(session, wf.name, wf.filePath, wf.repo)
          const calleesDetail = await getFunctionCalleesDetail(session, wf.name, wf.filePath, wf.repo)

          // Extract caller code
          const callerCodes: CallerCalleeCode[] = []
          for (const c of callersDetail) {
            const code = extractFunctionCode(repoConfig.path, c.filePath, c.lineStart, c.lineEnd)
            if (code) callerCodes.push({ name: c.name, filePath: c.filePath, code })
          }

          // Extract callee code
          const calleeCodes: CallerCalleeCode[] = []
          for (const c of calleesDetail) {
            const code = extractFunctionCode(repoConfig.path, c.filePath, c.lineStart, c.lineEnd)
            if (code) calleeCodes.push({ name: c.name, filePath: c.filePath, code })
          }

          const prompt = buildDeepAnalysisPrompt(
            wf.name, fnCode, wf.filePath,
            callerCodes, calleeCodes, bizCtx, goal!
          )

          try {
            const raw = await callClaude(prompt)
            const decisions = parseJsonSafe<any[]>(raw, [])
            if (!Array.isArray(decisions)) return []

            const now = new Date().toISOString()
            const valid = decisions.filter((d: any) => d.function && d.summary && d.content)

            const ctxInfo = `${callerCodes.length} callers, ${calleeCodes.length} callees`
            console.log(`    ✓ ${wf.fileName}::${wf.name} — ${valid.length} decisions (${ctxInfo})`)

            return valid.map((d: any, i: number) => {
              const pathSlug = wf.filePath.replace(/\//g, '_').replace(/\.[^.]+$/, '')
              const id = `dc:v2:${wf.repo}:${pathSlug}:${d.function}:${Date.now()}-${i}`
              const findingType = ['decision', 'suboptimal', 'bug'].includes(d.finding_type) ? d.finding_type : 'decision'

              return {
                id,
                props: {
                  summary: String(d.summary),
                  content: String(d.content),
                  keywords: Array.isArray(d.keywords) ? d.keywords : [],
                  scope: [wf.repo],
                  owner,
                  session_id: `cold-start-v2-${now.slice(0, 10)}`,
                  commit_hash: 'cold-start-v2',
                  source: 'cold_start_v2',
                  confidence: 'auto_generated',
                  staleness: 'active',
                  finding_type: findingType,
                  ...(d.critique && findingType !== 'decision' ? { critique: String(d.critique) } : {}),
                  created_at: now,
                  updated_at: now,
                },
                functionName: String(d.function),
                relatedFunctions: Array.isArray(d.related_functions) ? d.related_functions.map(String) : [],
                filePath: wf.filePath,
                fileName: wf.fileName,
                repo: wf.repo,
              } as PendingDecision
            })
          } catch (err: any) {
            console.log(`    ✗ ${wf.fileName}::${wf.name} — ${err.message}`)
            return []
          }
        }
      )

      for (const results of round3Results) {
        repoDecisions.push(...results)
        allDecisions.push(...results)
      }

      // Track analyzed files for state update
      for (const fi of filesToAnalyze) {
        const fileDecisionIds = repoDecisions
          .filter(d => d.filePath === fi.filePath && d.repo === repoConfig.name)
          .map(d => d.id)
        analyzedFiles.push({
          repo: repoConfig.name,
          filePath: fi.filePath,
          decisionIds: fileDecisionIds,
          commit: headCommit,
        })
      }
    }

    // ─── Write all decisions to Memgraph ──────────────────

    const round3Time = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`\n  📊 Round 3 complete: ${allDecisions.length} decisions extracted (${round3Time}s)`)

    if (allDecisions.length > 0) {
      const writeStart = Date.now()
      const { nodes, anchored } = await batchWriteDecisions(session, allDecisions)
      const relCount = allDecisions.reduce((s, d) => s + d.relatedFunctions.length, 0)
      const writeTime = ((Date.now() - writeStart) / 1000).toFixed(1)
      console.log(`  📝 Written: ${nodes} decisions, ${anchored} primary anchors, ${relCount} related anchors (${writeTime}s)`)

      // Print classification summary
      const bugs = allDecisions.filter(d => d.props.finding_type === 'bug').length
      const suboptimal = allDecisions.filter(d => d.props.finding_type === 'suboptimal').length
      const normal = allDecisions.length - bugs - suboptimal
      console.log(`  📋 Classified: ${normal} decisions, ${suboptimal} suboptimal, ${bugs} bugs`)
      if (bugs > 0) console.log(`  🐛 ${bugs} potential bug(s) found!`)
      if (suboptimal > 0) console.log(`  ⚡ ${suboptimal} suboptimal pattern(s) found`)
    }

    // ─── Round 4: Relationships + Keyword Normalization ───

    if (allDecisions.length >= 2) {
      console.log(`\n  \x1b[36m🔗 Round 4: Relationships\x1b[0m`)

      // ─── 4a: Grouping (one LLM call with all summaries) ───

      const summariesForGrouping: DecisionSummaryForGrouping[] = allDecisions.map(d => ({
        id: d.id,
        function: d.functionName,
        file: d.filePath,
        summary: d.props.summary,
        keywords: d.props.keywords,
      }))

      // Build CPG hints: which decisions' functions call each other
      const cpgHints: string[] = []
      try {
        // Get CALLS edges between functions that have decisions anchored to them
        const fnNames = allDecisions.map(d => d.functionName)
        const cpgResult = await session.run(
          `MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
           WHERE caller.name IN $names AND callee.name IN $names AND caller.name <> callee.name
           RETURN DISTINCT caller.name + ' CALLS ' + callee.name AS hint
           LIMIT 50`,
          { names: fnNames }
        )
        for (const r of cpgResult.records) {
          cpgHints.push(r.get('hint') as string)
        }
        if (cpgHints.length > 0) console.log(`    📁 ${cpgHints.length} CPG call hints loaded`)
      } catch {}

      try {
        const groupPrompt = buildGroupingPrompt(summariesForGrouping, cpgHints)
        const rawGroups = await callClaude(groupPrompt)
        const groups = parseJsonSafe<{ group: string[]; reason: string }[]>(rawGroups, [])

        if (Array.isArray(groups) && groups.length > 0) {
          console.log(`    ✓ ${groups.length} groups identified`)
          for (const g of groups) {
            console.log(`      • [${g.group.length} decisions] ${g.reason}`)
          }

          // ─── 4b: Deep relationship analysis (per group) ───

          let totalEdges = 0

          const groupResults = await runWithConcurrency(
            groups,
            concurrency,
            async (group) => {
              // Build full content for this group's decisions
              const groupDecisions: DecisionFullContent[] = []
              for (const id of group.group) {
                const d = allDecisions.find(ad => ad.id === id)
                if (d) {
                  groupDecisions.push({
                    id: d.id,
                    function: d.functionName,
                    file: d.filePath,
                    summary: d.props.summary,
                    content: d.props.content,
                    keywords: d.props.keywords,
                  })
                }
              }

              if (groupDecisions.length < 2) return []

              const relPrompt = buildRelationshipPrompt(groupDecisions, group.reason)
              try {
                const rawRel = await callClaude(relPrompt)
                const result = parseJsonSafe<{ edges: any[] }>(rawRel, { edges: [] })
                return Array.isArray(result.edges) ? result.edges : []
              } catch (err: any) {
                console.log(`    ⚠️ Group analysis failed: ${err.message}`)
                return []
              }
            }
          )

          // Write edges to Memgraph
          for (const edges of groupResults) {
            for (const edge of edges) {
              const edgeType = String(edge.type).toUpperCase()
              const allowed = ['CAUSED_BY', 'DEPENDS_ON', 'CONFLICTS_WITH', 'CO_DECIDED']
              if (!allowed.includes(edgeType) || !edge.from || !edge.to) continue

              try {
                await session.run(
                  `MATCH (a:DecisionContext {id: $from})
                   MATCH (b:DecisionContext {id: $to})
                   MERGE (a)-[r:${edgeType}]->(b)
                   SET r.reason = $reason`,
                  { from: edge.from, to: edge.to, reason: String(edge.reason ?? '') }
                )
                totalEdges++
              } catch {}
            }
          }

          console.log(`    📝 ${totalEdges} relationship edges written`)
        } else {
          console.log(`    ○ No meaningful groups found`)
        }
      } catch (err: any) {
        console.log(`    ⚠️ Round 4a failed: ${err.message}`)
      }

      // ─── Keyword Normalization (single lightweight call) ───

      try {
        const allKeywords = allDecisions.flatMap(d => d.props.keywords ?? [])
        if (allKeywords.length > 0) {
          const normPrompt = buildKeywordNormalizationPrompt(allKeywords)
          const rawNorm = await callClaude(normPrompt, 60000)
          const normalizations = parseJsonSafe<{ canonical: string; aliases: string[] }[]>(rawNorm, [])

          if (Array.isArray(normalizations) && normalizations.length > 0) {
            let normalized = 0
            for (const norm of normalizations) {
              if (!norm.canonical || !Array.isArray(norm.aliases)) continue
              for (const alias of norm.aliases) {
                try {
                  const updateResult = await session.run(
                    `MATCH (d:DecisionContext)
                     WHERE ANY(k IN d.keywords WHERE k = $alias)
                       AND NOT ANY(k IN d.keywords WHERE k = $canonical)
                     SET d.keywords = d.keywords + [$canonical]
                     RETURN count(d) AS cnt`,
                    { alias, canonical: norm.canonical }
                  )
                  const cnt = updateResult.records[0]?.get('cnt')
                  if (cnt && (typeof cnt === 'number' ? cnt > 0 : cnt.toNumber() > 0)) normalized++
                } catch {}
              }
            }
            console.log(`    🏷️  ${normalized} keyword normalizations applied`)
            console.log(`      Terms: ${normalizations.map(n => n.canonical).join(', ')}`)
          } else {
            console.log(`    ○ No keyword normalization needed`)
          }
        }
      } catch (err: any) {
        console.log(`    ⚠️ Keyword normalization failed: ${err.message}`)
      }
    } else {
      console.log(`\n  ○ Skipping Round 4 (need ≥2 decisions for relationship analysis)`)
    }

    // ─── Save state ─────────────────────────────────────

    if (!dryRun && analyzedFiles.length > 0) {
      const now = new Date().toISOString()
      for (const af of analyzedFiles) {
        const key = getFileKey(af.repo, af.filePath)
        state.files[key] = {
          lastCommit: af.commit,
          lastAnalyzedAt: now,
          decisionIds: af.decisionIds,
        }
      }
      saveState(state)
      console.log(`  State saved: ${analyzedFiles.length} files tracked`)
    }

    // ─── Done ───────────────────────────────────────────

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`\n✅ Cold-start v2 complete: ${allDecisions.length} decisions (${totalTime}s)\n`)

  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch(err => {
  console.error('失败:', err.message)
  closeDriver()
  process.exit(1)
})

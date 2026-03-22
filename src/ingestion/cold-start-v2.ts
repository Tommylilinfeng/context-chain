/**
 * cold-start-v2.ts
 *
 * Four-round pipeline:
 *   Round 1 — Scope Selection: LLM picks relevant files for a goal
 *   Round 2 — Triage: per-file, identify functions worth deep analysis
 *   Round 3 — Deep Analysis: per-function, extract decisions with full caller/callee context
 *   Round 4 — Relationships: normalize keywords, build PENDING edges, then connect decisions (via building blocks)
 *
 * Usage:
 *   npm run cold-start:v2 -- --goal "订单流程和支付" --repo biteme-shared --owner me
 *   npm run cold-start:v2 -- --goal "coupon系统" --concurrency 3
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import {
  FileEntry, FunctionTriageEntry,
} from '../prompts/cold-start'
import { createCustomPromptBuilders } from '../prompts/prompt-config'
import { createAIProvider } from '../ai'
import { parseBudget, BudgetManager } from '../ai/budget'
import { loadState, saveState, getFileKey, ColdStartState } from './state'
import { getHeadCommit, getChangedFiles } from './git-utils'
import {
  FileInfo, PendingDecision, WorthyFunction,
  parseJsonSafe, runWithConcurrency,
  getFilesFromGraph, getBusinessContext, getPerFunctionDeps,
  extractFunctionCode, readFullFile, buildCallerCalleeCodes,
  batchWriteDecisions, deleteOldDecisions,
} from './shared'
import { normalizeKeywords } from './normalize-keywords'
import { createPendingEdges, connectDecisions } from './connect-decisions'

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
const budgetStr   = getArg('--budget')

if (!goal) {
  console.error('用法: npm run cold-start:v2 -- --goal "目标描述" [--repo name] [--owner me] [--concurrency 2] [--budget 500000] [--dry-run]')
  process.exit(1)
}

// ── Change detection (cold-start specific) ────────────────────

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

// ── Budget-aware AI call ────────────────────────────────

class BudgetExceededError extends Error {
  constructor(summary: string) { super(`⚠️ 预算已用完 (${summary})，停止管线`) }
}

function trackBudget(ai: ReturnType<typeof createAIProvider>, budget: BudgetManager | null): void {
  if (!budget) return
  budget.record(ai.lastUsage)
  if (budget.exceeded) {
    throw new BudgetExceededError(budget.summary())
  }
}

// ── Main pipeline ───────────────────────────────────────

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

  // ── 初始化可插拔组件 ───────────────────────────────
  const ai = createAIProvider(config.ai)
  const prompts = createCustomPromptBuilders('cold-start')
  const budget = parseBudget(budgetStr, ai.rateLimit)

  console.log(`\n🧊 Cold-start v2`)
  console.log(`   Goal: "${goal}"`)
  console.log(`   AI: ${ai.name}${config.ai?.model ? ' (' + config.ai.model + ')' : ''}`)
  console.log(`   Repos: ${repos.map(r => r.name).join(', ')}`)
  if (budget) console.log(`   Budget: ${budget.summary()}`)
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

      const scopePrompt = prompts.scope(goal!, fileEntries)
      let selectedFiles: string[]

      try {
        const raw = await ai.call(scopePrompt)
        trackBudget(ai, budget)
        selectedFiles = parseJsonSafe<string[]>(raw, [])
        if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
          console.log(`  ⚠️  LLM returned no files, falling back to all files`)
          selectedFiles = files.map(f => f.filePath)
        }
      } catch (err: any) {
        if (err instanceof BudgetExceededError) throw err
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

          const prompt = prompts.triage(fileInfo.filePath, code, triageEntries, bizCtx, goal!)

          try {
            const raw = await ai.call(prompt)
            trackBudget(ai, budget)
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

      // Write triage_status on all function nodes in analyzed files
      const worthyNames = new Set(allWorthyFunctions.filter(w => w.repo === repoConfig.name).map(w => `${w.filePath}::${w.name}`))
      let triageMarked = 0
      for (const fileInfo of filesToAnalyze) {
        for (const fn of fileInfo.functions) {
          const key = `${fileInfo.filePath}::${fn.name}`
          const status = worthyNames.has(key) ? 'selected' : 'skipped'
          try {
            await session.run(
              `MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
               SET fn.triage_status = $status, fn.triage_goal = $goal`,
              { filePath: fileInfo.filePath, repo: repoConfig.name, fnName: fn.name, status, goal: goal! }
            )
            triageMarked++
          } catch {}
        }
      }
      console.log(`  📌 Triage status written on ${triageMarked} function nodes`)

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

          // Get callers/callees with full code
          const { callerCodes, calleeCodes } = await buildCallerCalleeCodes(
            session, wf.name, wf.filePath, wf.repo, repoConfig.path
          )

          const prompt = prompts.deepAnalysis(
            wf.name, fnCode, wf.filePath,
            callerCodes, calleeCodes, bizCtx, goal!
          )

          try {
            const raw = await ai.call(prompt)
            trackBudget(ai, budget)
            const decisions = parseJsonSafe<any[]>(raw, [])
            if (!Array.isArray(decisions)) return []

            const now = new Date().toISOString()
            const valid = decisions.filter((d: any) => d.function && d.summary && d.content)

            const ctxInfo = `${callerCodes.length} callers, ${calleeCodes.length} callees`
            console.log(`    ✓ ${wf.fileName}::${wf.name} — ${valid.length} decisions (${ctxInfo})`)

            // Mark function as deeply analyzed
            try {
              await session.run(
                `MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
                 SET fn.analyzed_at = $now, fn.triage_status = 'selected'`,
                { filePath: wf.filePath, repo: wf.repo, fnName: wf.name, now: new Date().toISOString() }
              )
            } catch {}

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

    // ─── Round 4: Normalize + Connect (using building blocks) ───

    if (allDecisions.length >= 2) {
      console.log(`\n  \x1b[36m🔗 Round 4: Relationships\x1b[0m`)

      // 4a. 关键词归一化（在连接之前，让分组更精准）
      try {
        await normalizeKeywords(session, ai, { verbose: true })
        trackBudget(ai, budget)
      } catch (err: any) {
        if (err instanceof BudgetExceededError) throw err
        console.log(`    ⚠️ 关键词归一化失败: ${err.message}`)
      }

      // 4b. 建 PENDING 边（新决策 vs 所有已有决策）
      const newIds = allDecisions.map(d => d.id)
      await createPendingEdges(session, newIds, { verbose: true })

      // 4c. 消化 PENDING 边（分组 + 关系分析）
      try {
        const connectResult = await connectDecisions({
          dbSession: session,
          ai,
          budget,
          batchCapacity: 50,
          concurrency,
        })
        console.log(`    📝 ${connectResult.edgesCreated} relationship edges, ${connectResult.pendingProcessed} PENDING edges processed`)
      } catch (err: any) {
        if (err instanceof BudgetExceededError) throw err
        console.log(`    ⚠️ 关系连接失败: ${err.message}`)
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
    const { totalUsage } = ai
    const totalTokens = totalUsage.input_tokens + totalUsage.output_tokens
    console.log(`\n✅ Cold-start v2 complete: ${allDecisions.length} decisions (${totalTime}s)`)
    console.log(`   📊 Token 用量: input ${totalUsage.input_tokens.toLocaleString()} + output ${totalUsage.output_tokens.toLocaleString()} = ${totalTokens.toLocaleString()} total`)
    if (budget) console.log(`   📊 预算: ${budget.summary()}`)
    console.log()

  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch(err => {
  if (err instanceof BudgetExceededError) {
    console.log(err.message)
    console.log('管线已在预算内安全停止。已完成的工作已保存。')
    closeDriver()
    process.exit(0)
  }
  console.error('失败:', err.message)
  closeDriver()
  process.exit(1)
})

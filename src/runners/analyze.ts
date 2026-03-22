/**
 * runners/analyze.ts
 *
 * CLI runner：分析单个函数或全量扫描 repo。
 *
 * 用法：
 *   # 分析单个函数
 *   npm run analyze -- --function createOrder --file store/orderStore.js --repo bite-me-website
 *
 *   # 全量扫描（逐函数，可暂停恢复）
 *   npm run analyze -- --repo bite-me-website
 *   npm run analyze -- --repo bite-me-website --continue
 *   npm run analyze -- --repo bite-me-website --force          # 忽略状态，全部重新分析
 *
 *   # 指定模板
 *   npm run analyze -- --repo bite-me-website --template quick-scan
 *
 *   # Budget 控制（token 上限）
 *   npm run analyze -- --repo bite-me-website --budget 500000
 *
 *   # 运行时覆盖配置
 *   npm run analyze -- --repo bite-me-website --caller-depth 2 --include-tables
 *
 *   # 列出可用模板
 *   npm run analyze -- --list-templates
 */

import { Session } from 'neo4j-driver'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { analyzeFunction } from '../core/analyze-function'
import { loadTemplate, listTemplates } from '../core/template-loader'
import { AnalyzeFunctionConfig, PendingDecisionOutput } from '../core/types'
import { getFilesFromGraph, batchWriteDecisions, toNum } from '../ingestion/shared'
import { cleanupPipelineSessions } from '../core/session-cleanup'
import fs from 'fs'
import path from 'path'

// ── CLI args ────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const hasFlag = (f: string) => args.includes(f)

// ── List templates ──────────────────────────────────────

if (hasFlag('--list-templates')) {
  const templates = listTemplates()
  console.log('\n📋 Available templates:\n')
  for (const t of templates) {
    const ext = t.extends ? ` (extends: ${t.extends})` : ''
    console.log(`  ${t.name}${ext}`)
    console.log(`    ${t.description}\n`)
  }
  process.exit(0)
}

// ── Parse args ──────────────────────────────────────────

const functionName  = getArg('--function')
const filePath      = getArg('--file')
const repoName      = getArg('--repo')
const templateName  = getArg('--template') ?? '_default'
const owner         = getArg('--owner') ?? 'me'
const goal          = getArg('--goal')
const continueMode  = hasFlag('--continue')
const forceMode     = hasFlag('--force')
const dryRun        = hasFlag('--dry-run')
const concurrency   = parseInt(getArg('--concurrency') ?? '1')
const budgetLimit   = getArg('--budget') ? parseInt(getArg('--budget')!) : null
const cleanupMode   = hasFlag('--cleanup')

// Runtime config overrides from CLI
const cliOverrides: Partial<AnalyzeFunctionConfig> = {}
if (getArg('--caller-depth'))  cliOverrides.caller_depth = parseInt(getArg('--caller-depth')!)
if (getArg('--callee-depth'))  cliOverrides.callee_depth = parseInt(getArg('--callee-depth')!)
if (hasFlag('--include-tables')) cliOverrides.include_table_access = true
if (hasFlag('--include-cross-repo')) cliOverrides.include_cross_repo = true
if (hasFlag('--include-file-context')) cliOverrides.include_file_context = true
if (getArg('--max-decisions'))  cliOverrides.max_decisions = parseInt(getArg('--max-decisions')!)
if (getArg('--language'))       cliOverrides.language = getArg('--language') as any

if (!repoName) {
  console.error('用法:')
  console.error('  npm run analyze -- --repo <n> [--function <n> --file <path>] [--template <n>]')
  console.error('  npm run analyze -- --list-templates')
  process.exit(1)
}

// ── Budget tracker ──────────────────────────────────────

class BudgetTracker {
  private limit: number
  private used = 0

  constructor(limit: number) { this.limit = limit }

  record(tokens: number): void { this.used += tokens }
  get exceeded(): boolean { return this.used >= this.limit }
  get remaining(): number { return Math.max(0, this.limit - this.used) }
  summary(): string { return `${this.used.toLocaleString()} / ${this.limit.toLocaleString()} tokens (${(this.used / this.limit * 100).toFixed(1)}%)` }
}

// ── Progress tracker ────────────────────────────────────

class ProgressTracker {
  private startTime: number
  private durations: number[] = []
  private total: number
  private done = 0

  constructor(total: number) {
    this.startTime = Date.now()
    this.total = total
  }

  record(durationMs: number): void {
    this.durations.push(durationMs)
    this.done++
  }

  get elapsed(): string {
    return this.formatMs(Date.now() - this.startTime)
  }

  get avgMs(): number {
    if (this.durations.length === 0) return 0
    return this.durations.reduce((a, b) => a + b, 0) / this.durations.length
  }

  get eta(): string {
    if (this.durations.length === 0) return '?'
    const remaining = this.total - this.done
    return this.formatMs(remaining * this.avgMs)
  }

  progressLine(current: number, totalAll: number): string {
    const pct = ((current / totalAll) * 100).toFixed(0)
    return `[${current}/${totalAll} ${pct}%]`
  }

  private formatMs(ms: number): string {
    const sec = Math.floor(ms / 1000)
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    const remainSec = sec % 60
    if (min < 60) return `${min}m${remainSec}s`
    const hr = Math.floor(min / 60)
    const remainMin = min % 60
    return `${hr}h${remainMin}m`
  }
}

// ── Results summary ─────────────────────────────────────

class ResultsSummary {
  decisions = 0
  suboptimal = 0
  bugs = 0
  totalAnchored = 0
  totalWritten = 0
  totalTokens = 0
  functionsProcessed = 0
  functionsSkipped = 0
  functionsFailed = 0
  replacedDecisions = 0

  recordDecision(d: PendingDecisionOutput): void {
    const ft = d.props.finding_type
    if (ft === 'bug') this.bugs++
    else if (ft === 'suboptimal') this.suboptimal++
    else this.decisions++
  }

  print(): void {
    console.log('\n━━━ Summary ━━━')
    console.log(`  Functions: ${this.functionsProcessed} analyzed, ${this.functionsSkipped} skipped, ${this.functionsFailed} failed`)
    console.log(`  Decisions: ${this.totalWritten} written, ${this.totalAnchored} anchored`)
    if (this.replacedDecisions > 0) {
      console.log(`  Replaced: ${this.replacedDecisions} old decisions removed`)
    }
    console.log(`  By type: ${this.decisions} decision, ${this.suboptimal} suboptimal, ${this.bugs} bug`)
    if (this.bugs > 0) console.log(`  🐛 ${this.bugs} potential bug(s) found!`)
    if (this.suboptimal > 0) console.log(`  ⚡ ${this.suboptimal} suboptimal pattern(s) found`)
    if (this.totalTokens > 0) console.log(`  Tokens: ${this.totalTokens.toLocaleString()}`)
  }
}

// ── Deduplication: delete old decisions for a function ───

async function deleteOldDecisionsForFunction(
  session: Session, functionName: string, filePath: string, repo: string
): Promise<number> {
  try {
    // Find decisions anchored to this function
    const result = await session.run(
      `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
       MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn)
       WHERE d.source IN ['analyze_function', 'cold_start_v2', 'cold_start']
       DETACH DELETE d
       RETURN count(d) AS cnt`,
      { fnName: functionName, filePath, repo }
    )
    const cnt = result.records[0]?.get('cnt')
    return typeof cnt === 'number' ? cnt : cnt?.toNumber?.() ?? 0
  } catch { return 0 }
}

// ── State persistence (for full scan pause/resume) ──────

const STATE_DIR = path.resolve(__dirname, '../../data')
const STATE_FILE = path.join(STATE_DIR, 'analyze-state.json')

interface ScanState {
  repo: string
  template: string
  analyzed: string[]  // "filePath::functionName" keys
  lastUpdated: string
}

function loadScanState(repo: string): ScanState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state: ScanState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
      if (state.repo === repo) return state
    }
  } catch {}
  return { repo, template: templateName, analyzed: [], lastUpdated: new Date().toISOString() }
}

function saveScanState(state: ScanState): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
  state.lastUpdated = new Date().toISOString()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ── Single function mode ────────────────────────────────

async function analyzeSingle(): Promise<void> {
  if (!functionName || !filePath) {
    console.error('单函数模式需要 --function 和 --file 参数')
    process.exit(1)
  }

  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === repoName)
  if (!repoConfig) {
    console.error(`Repo "${repoName}" not found in ckg.config.json`)
    process.exit(1)
  }

  const { config: templateConfig } = loadTemplate(templateName, cliOverrides)
  console.log(`\n🔬 Analyzing ${functionName}() in ${filePath}`)
  console.log(`   Template: ${templateName}`)
  console.log(`   Caller depth: ${templateConfig.caller_depth}, Callee depth: ${templateConfig.callee_depth}`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    // Dedup: remove old decisions for this function
    if (!dryRun) {
      const removed = await deleteOldDecisionsForFunction(session, functionName, filePath, repoName!)
      if (removed > 0) console.log(`  🔄 Replaced ${removed} old decision(s)`)
    }

    const result = await analyzeFunction(
      {
        functionName,
        filePath,
        repo: repoName!,
        repoPath: repoConfig.path,
        goal: goal ?? undefined,
        owner,
        session,
      },
      cliOverrides,
      templateName,
    )

    const tokens = result.metadata.token_usage
      ? (result.metadata.token_usage.input_tokens ?? 0) + (result.metadata.token_usage.output_tokens ?? 0)
      : 0

    console.log(`\n✅ ${result.decisions.length} decisions extracted (${result.metadata.duration_ms}ms)`)
    console.log(`   Callers: ${result.metadata.caller_count}, Callees: ${result.metadata.callee_count}`)
    if (tokens > 0) console.log(`   Tokens: ${tokens.toLocaleString()}`)

    for (const d of result.decisions) {
      console.log(`\n  ▶ [${d.props.finding_type}] ${d.props.summary}`)
      console.log(`    ${d.props.content}`)
      if (d.props.keywords?.length) console.log(`    Keywords: ${d.props.keywords.join(', ')}`)
    }

    if (!dryRun && result.decisions.length > 0) {
      const { nodes, anchored } = await batchWriteDecisions(session, result.decisions)
      console.log(`\n  📝 Written: ${nodes} decisions, ${anchored} anchored`)
    }
  } finally {
    await session.close()
  }
}

// ── Full scan mode ──────────────────────────────────────

async function fullScan(): Promise<void> {
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === repoName)
  if (!repoConfig) {
    console.error(`Repo "${repoName}" not found in ckg.config.json`)
    process.exit(1)
  }

  const { config: templateConfig } = loadTemplate(templateName, cliOverrides)

  await verifyConnectivity()
  const session = await getSession()

  try {
    // 1. Get all functions from graph
    const files = await getFilesFromGraph(session, repoName!)
    const allFunctions: { name: string; filePath: string; lineStart: number; lineEnd: number }[] = []
    for (const file of files) {
      for (const fn of file.functions) {
        allFunctions.push({ name: fn.name, filePath: file.filePath, lineStart: fn.lineStart, lineEnd: fn.lineEnd })
      }
    }

    console.log(`\n🔍 Full Scan: ${repoName}`)
    console.log(`   Template: ${templateName}`)
    console.log(`   Functions: ${allFunctions.length}`)
    console.log(`   Caller depth: ${templateConfig.caller_depth}, Callee depth: ${templateConfig.callee_depth}`)
    if (budgetLimit) console.log(`   Budget: ${budgetLimit.toLocaleString()} tokens`)
    if (forceMode) console.log(`   FORCE mode: re-analyzing all functions`)

    // 2. Load state (skip if --force)
    const state = (!forceMode && continueMode)
      ? loadScanState(repoName!)
      : { repo: repoName!, template: templateName, analyzed: [] as string[], lastUpdated: new Date().toISOString() }
    const analyzedSet = new Set(state.analyzed)

    const remaining = allFunctions.filter(fn => !analyzedSet.has(`${fn.filePath}::${fn.name}`))
    if (!forceMode && continueMode) {
      console.log(`   Already analyzed: ${analyzedSet.size}`)
    }
    console.log(`   Remaining: ${remaining.length}`)
    if (dryRun) console.log(`   ⚠️ DRY RUN — no writes`)
    console.log()

    if (remaining.length === 0) {
      console.log('✅ All functions already analyzed.')
      if (!forceMode) console.log('   Use --force to re-analyze all functions.')
      return
    }

    // 3. Init trackers
    const progress = new ProgressTracker(remaining.length)
    const summary = new ResultsSummary()
    const budget = budgetLimit ? new BudgetTracker(budgetLimit) : null

    // Graceful shutdown on Ctrl+C
    let interrupted = false
    const onInterrupt = () => {
      if (interrupted) process.exit(1)
      interrupted = true
      console.log('\n\n⏸️  Pausing... (saving state, press Ctrl+C again to force quit)')
    }
    process.on('SIGINT', onInterrupt)

    // 4. Process functions one by one
    for (const fn of remaining) {
      if (interrupted) break

      // Budget check
      if (budget?.exceeded) {
        console.log(`\n  ⚠️ Budget exceeded (${budget.summary()}). Stopping.`)
        break
      }

      const idx = summary.functionsProcessed + analyzedSet.size + 1
      const progressStr = progress.progressLine(idx, allFunctions.length)

      try {
        // Dedup: remove old decisions before re-analyzing
        if (!dryRun) {
          const removed = await deleteOldDecisionsForFunction(session, fn.name, fn.filePath, repoName!)
          if (removed > 0) summary.replacedDecisions += removed
        }

        const result = await analyzeFunction(
          {
            functionName: fn.name,
            filePath: fn.filePath,
            repo: repoName!,
            repoPath: repoConfig.path,
            lineStart: fn.lineStart,
            lineEnd: fn.lineEnd,
            goal: goal ?? undefined,
            owner,
            session,
          },
          cliOverrides,
          templateName,
        )

        // Track tokens
        const tokens = result.metadata.token_usage
          ? (result.metadata.token_usage.input_tokens ?? 0) + (result.metadata.token_usage.output_tokens ?? 0)
          : 0
        summary.totalTokens += tokens
        if (budget && tokens > 0) budget.record(tokens)

        // Write decisions
        if (!dryRun && result.decisions.length > 0) {
          const { nodes, anchored } = await batchWriteDecisions(session, result.decisions)
          summary.totalWritten += nodes
          summary.totalAnchored += anchored
        }

        // Track finding types
        for (const d of result.decisions) {
          summary.recordDecision(d)
        }

        // Progress output
        progress.record(result.metadata.duration_ms)
        const decCount = result.decisions.length
        const callers = result.metadata.caller_count
        const callees = result.metadata.callee_count
        const durSec = (result.metadata.duration_ms / 1000).toFixed(1)
        const etaStr = progress.eta
        console.log(`  ${progressStr} ${fn.filePath}::${fn.name} — ${decCount} dec (${callers}↑ ${callees}↓ ${durSec}s) ETA ${etaStr}`)

        // Update state
        state.analyzed.push(`${fn.filePath}::${fn.name}`)
        summary.functionsProcessed++

        // Save state periodically (every 5 functions)
        if (summary.functionsProcessed % 5 === 0) {
          saveScanState(state)
        }
      } catch (err: any) {
        console.log(`  ${progressStr} ${fn.filePath}::${fn.name} — ✗ ${err.message}`)
        state.analyzed.push(`${fn.filePath}::${fn.name}`)
        summary.functionsFailed++
      }
    }

    // 5. Final save and summary
    saveScanState(state)
    process.removeListener('SIGINT', onInterrupt)

    summary.functionsSkipped = analyzedSet.size
    summary.print()
    console.log(`  Elapsed: ${progress.elapsed}`)
    if (budget) console.log(`  Budget: ${budget.summary()}`)

    if (interrupted) {
      console.log(`\n⏸️  Paused. Run with --continue to resume from where you left off.`)
    }
    if (budget?.exceeded) {
      console.log(`\n⚠️ Stopped due to budget limit. Run with --continue to resume with a new budget.`)
    }
  } finally {
    await session.close()
  }
}

// ── Entry point ─────────────────────────────────────────

async function main(): Promise<void> {
  try {
    if (functionName) {
      await analyzeSingle()
    } else {
      await fullScan()
    }
  } finally {
    // Cleanup: delete all claude -p sessions that contain our pipeline marker
    if (cleanupMode) {
      const { deleted, skipped, totalSizeMB, scanned } = cleanupPipelineSessions()
      if (deleted > 0 || skipped > 0) {
        console.log(`\n🧹 Cleanup: ${deleted}/${scanned} session files removed (${totalSizeMB}MB)${skipped > 0 ? `, ${skipped} skipped (too recent)` : ''}`)
      }
    }
  }
}

main()
  .catch(err => {
    console.error('❌', err.message)
    process.exit(1)
  })
  .finally(() => closeDriver())

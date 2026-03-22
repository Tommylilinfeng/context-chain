/**
 * ingest-sessions-v2.ts
 *
 * Three-phase pipeline:
 *   Phase 0 — Preprocess: parse JSONL → compressed turns + touchedFiles
 *   Phase 1 — Segment: LLM splits conversation into logical segments (user approves)
 *   Phase 2 — Extract: per approved segment, deep decision extraction + anchoring
 *            + Round 4: relationship edges + keyword normalization
 *
 * Usage:
 *   npm run ingest:sessions:v2                                    # all new sessions
 *   npm run ingest:sessions:v2 -- --project bite-me-website       # one project
 *   npm run ingest:sessions:v2 -- --session abc123                # one session
 *   npm run ingest:sessions:v2 -- --auto-approve                  # skip user confirmation
 *   npm run ingest:sessions:v2 -- --dry-run                       # Phase 0 only, no LLM
 *   npm run ingest:sessions:v2 -- --force --session abc123        # re-process
 *   npm run ingest:sessions:v2 -- --concurrency 3
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import {
  PendingDecision,
  parseJsonSafe, runWithConcurrency,
  getFilesFromGraph, getBusinessContext, getPerFunctionDeps,
  buildCallerCalleeCodes,
  batchWriteDecisions, deleteOldDecisions,
} from './shared'
import {
  parseSession, formatTurnsForPrompt, extractRawTurnsForSegment,
  Phase0Result, CompressedTurn,
} from './session-parser'
import {
  buildSegmentationPrompt, buildExtractionPrompt,
  SessionSegment,
} from '../prompts/session'
import {
  buildGroupingPrompt, buildRelationshipPrompt, buildKeywordNormalizationPrompt,
  DecisionSummaryForGrouping, DecisionFullContent, BusinessContext,
} from '../prompts/cold-start'
import { Session } from 'neo4j-driver'

// ── Constants ───────────────────────────────────────────

const CLAUDE_DIR     = path.join(os.homedir(), '.claude', 'projects')
const STATE_FILE     = path.join(__dirname, '../../data/ingested-sessions-v2.json')
const TOKEN_BUDGET   = 80_000  // tokens for conversation content in Phase 1
const OVERLAP_TURNS  = 5       // overlap between chunks in fallback

// ── CLI ─────────────────────────────────────────────────

const args           = process.argv.slice(2)
const getArg         = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const hasFlag        = (f: string) => args.includes(f)

const targetProject  = getArg('--project')
const targetSession  = getArg('--session')
const autoApprove    = hasFlag('--auto-approve')
const dryRun         = hasFlag('--dry-run')
const force          = hasFlag('--force')
const owner          = getArg('--owner') ?? 'me'
const concurrency    = parseInt(getArg('--concurrency') ?? '2')

// ── State management ────────────────────────────────────

interface SessionState {
  processedAt: string
  version: string
  segmentCount: number
  approvedSegments: number
  decisionCount: number
  decisionIds: string[]
}

function loadProcessed(): Record<string, SessionState> {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).processed ?? {}
    }
  } catch {}
  return {}
}

function saveProcessed(processed: Record<string, SessionState>): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({ processed }, null, 2))
}

// ── Project name from directory ─────────────────────────

function projectNameFromDir(dirName: string): string {
  const parts = dirName.split('-').filter(Boolean)
  return parts.slice(-3).join('-')
}

// ── CLI user interaction ────────────────────────────────

async function askUser(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ── Phase 1: Segmentation ───────────────────────────────

async function runPhase1(
  phase0: Phase0Result,
  codeStructure: string,
  bizCtx: BusinessContext[],
  ai: ReturnType<typeof createAIProvider>
): Promise<SessionSegment[]> {
  const conversationText = formatTurnsForPrompt(phase0.turns)

  if (phase0.estimatedTokens <= TOKEN_BUDGET) {
    // normal path: single LLM call
    const prompt = buildSegmentationPrompt(
      phase0.projectName, phase0.sessionStart, phase0.sessionEnd,
      conversationText, codeStructure, bizCtx
    )
    const raw = await ai.call(prompt)
    const segments = parseJsonSafe<SessionSegment[]>(raw, [])
    return Array.isArray(segments) ? segments : []
  }

  // fallback: progressive chunking
  console.log(`    ⚠️  Large session (${phase0.estimatedTokens} tokens), chunking...`)
  return await runChunkedPhase1(phase0, codeStructure, bizCtx, ai)
}

async function runChunkedPhase1(
  phase0: Phase0Result,
  codeStructure: string,
  bizCtx: BusinessContext[],
  ai: ReturnType<typeof createAIProvider>
): Promise<SessionSegment[]> {
  const totalTurns = phase0.turns.length
  let numChunks = Math.ceil(phase0.estimatedTokens / TOKEN_BUDGET)

  // find a chunk count that fits
  while (numChunks <= 10) {
    const turnsPerChunk = Math.ceil(totalTurns / numChunks)

    // build chunks with overlap
    const chunks: { turns: CompressedTurn[]; startIdx: number; endIdx: number }[] = []
    for (let c = 0; c < numChunks; c++) {
      const start = Math.max(0, c * turnsPerChunk - (c > 0 ? OVERLAP_TURNS : 0))
      const end = Math.min(totalTurns - 1, (c + 1) * turnsPerChunk - 1 + (c < numChunks - 1 ? OVERLAP_TURNS : 0))
      chunks.push({
        turns: phase0.turns.slice(start, end + 1),
        startIdx: start,
        endIdx: end,
      })
    }

    // check if largest chunk fits
    const maxChunkTokens = Math.max(...chunks.map(ch =>
      ch.turns.reduce((sum, t) => sum + t.content.length, 0) / 4
    ))

    if (maxChunkTokens <= TOKEN_BUDGET) {
      console.log(`    Splitting into ${numChunks} chunks (overlap ${OVERLAP_TURNS} turns)`)

      // run each chunk
      const allSegments: SessionSegment[] = []
      let prevSummary: string | undefined

      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c]
        const chunkText = formatTurnsForPrompt(chunk.turns)

        const prompt = buildSegmentationPrompt(
          phase0.projectName, phase0.sessionStart, phase0.sessionEnd,
          chunkText, codeStructure, bizCtx,
          { chunkNumber: c + 1, totalChunks: numChunks, prevSummary }
        )

        try {
          const raw = await ai.call(prompt)
          const segments = parseJsonSafe<SessionSegment[]>(raw, [])
          if (Array.isArray(segments) && segments.length > 0) {
            allSegments.push(...segments)
            prevSummary = segments[segments.length - 1].summary
          }
        } catch (err: any) {
          console.log(`    ⚠️  Chunk ${c + 1} failed: ${err.message}`)
        }
      }

      // deduplicate segments from overlap regions
      return deduplicateSegments(allSegments)
    }

    numChunks++
  }

  console.log(`    ⚠️  Session too large even with 10 chunks, skipping`)
  return []
}

function deduplicateSegments(segments: SessionSegment[]): SessionSegment[] {
  if (segments.length <= 1) return segments

  // sort by startTurn
  segments.sort((a, b) => a.startTurn - b.startTurn)

  // remove overlapping segments: if two segments overlap, keep the later one
  const result: SessionSegment[] = [segments[0]]
  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1]
    const curr = segments[i]
    if (curr.startTurn <= prev.endTurn) {
      // overlap — replace prev with curr (later chunk has more context)
      result[result.length - 1] = curr
    } else {
      result.push(curr)
    }
  }

  return result
}

// ── Phase 2: Deep Extraction ────────────────────────────

async function runPhase2(
  phase0: Phase0Result,
  segment: SessionSegment & { approved: boolean },
  dbSession: Session,
  bizCtx: BusinessContext[],
  ai: ReturnType<typeof createAIProvider>,
  jsonlPath: string
): Promise<PendingDecision[]> {
  // get raw conversation for this segment
  // NOTE: startTurn/endTurn are compressed turn indices, not JSONL line numbers
  const rawConversation = extractRawTurnsForSegment(
    jsonlPath, phase0.turns, segment.startTurn, segment.endTurn
  )

  // build code structure for touched files
  const config = loadConfig()
  const repoConfig = config.repos.find(r =>
    phase0.projectName.includes(r.name) || r.name.includes(phase0.projectName)
  )

  let codeStructureSection = ''
  let callerCalleeSection = ''

  if (repoConfig) {
    // get functions for touched files from graph
    const allFiles = await getFilesFromGraph(dbSession, repoConfig.name)
    const relevantFiles = allFiles.filter(f =>
      segment.touchedFiles.some(tf =>
        f.filePath.includes(tf) || tf.includes(f.filePath) || f.fileName === path.basename(tf)
      )
    )

    if (relevantFiles.length > 0) {
      codeStructureSection = relevantFiles.map(f =>
        `### ${f.filePath}\nFunctions: ${f.functions.map(fn => `${fn.name} (${fn.lineStart}-${fn.lineEnd})`).join(', ')}`
      ).join('\n\n')

      // build caller/callee code for the most important functions
      const callerCalleeParts: string[] = []
      for (const file of relevantFiles.slice(0, 3)) { // limit to top 3 files
        for (const fn of file.functions.slice(0, 3)) { // limit to top 3 functions per file
          try {
            const { callerCodes, calleeCodes } = await buildCallerCalleeCodes(
              dbSession, fn.name, file.filePath, file.repo, repoConfig.path
            )
            if (callerCodes.length > 0) {
              callerCalleeParts.push(
                `#### Callers of ${fn.name}:\n` +
                callerCodes.map(c => `${c.filePath}::${c.name}:\n\`\`\`\n${c.code}\n\`\`\``).join('\n')
              )
            }
            if (calleeCodes.length > 0) {
              callerCalleeParts.push(
                `#### Callees of ${fn.name}:\n` +
                calleeCodes.map(c => `${c.filePath}::${c.name}:\n\`\`\`\n${c.code}\n\`\`\``).join('\n')
              )
            }
          } catch {}
        }
      }
      callerCalleeSection = callerCalleeParts.join('\n\n')
    }
  }

  // LLM call
  const prompt = buildExtractionPrompt(
    phase0.projectName,
    segment.summary,
    segment.decisionHints,
    rawConversation,
    codeStructureSection,
    callerCalleeSection,
    bizCtx
  )

  const raw = await ai.call(prompt)
  const decisions = parseJsonSafe<any[]>(raw, [])
  if (!Array.isArray(decisions)) return []

  const now = new Date().toISOString()
  const repo = repoConfig?.name ?? phase0.projectName

  return decisions
    .filter((d: any) => d.summary && d.content)
    .map((d: any, i: number): PendingDecision => {
      const fnName = d.function ?? ''
      const filePath = d.file ?? ''
      const pathSlug = filePath ? filePath.replace(/\//g, '_').replace(/\.[^.]+$/, '') : 'no-file'
      const id = `dc:sess:${phase0.sessionId.slice(0, 8)}:${pathSlug}:${i}:${Date.now()}`
      const findingType = ['decision', 'suboptimal', 'bug'].includes(d.finding_type)
        ? d.finding_type : 'decision'

      const transcriptRange = Array.isArray(d.transcript_range)
        ? `${phase0.sessionId}:${d.transcript_range[0]}-${d.transcript_range[1]}`
        : `${phase0.sessionId}:${segment.startTurn}-${segment.endTurn}`

      return {
        id,
        props: {
          summary: String(d.summary),
          content: String(d.content),
          keywords: Array.isArray(d.keywords) ? d.keywords : [],
          scope: [repo],
          owner,
          session_id: phase0.sessionId,
          commit_hash: 'session-extract',
          source: 'session_ingestion',
          confidence: 'auto_generated',
          staleness: 'active',
          finding_type: findingType,
          transcript_range: transcriptRange,
          ...(d.critique && findingType !== 'decision' ? { critique: String(d.critique) } : {}),
          created_at: now,
          updated_at: now,
        },
        functionName: fnName,
        relatedFunctions: Array.isArray(d.related_functions) ? d.related_functions.map(String) : [],
        filePath,
        fileName: filePath ? path.basename(filePath) : '',
        repo,
      }
    })
}

// ── Round 4: Relationships + Keywords ───────────────────

async function runRound4(
  allDecisions: PendingDecision[],
  dbSession: Session,
  ai: ReturnType<typeof createAIProvider>
): Promise<void> {
  if (allDecisions.length < 2) {
    console.log(`\n  ○ Skipping Round 4 (need ≥2 decisions)`)
    return
  }

  console.log(`\n  🔗 Round 4: Relationships`)

  // 4a: Grouping
  const summaries: DecisionSummaryForGrouping[] = allDecisions.map(d => ({
    id: d.id,
    function: d.functionName,
    file: d.filePath,
    summary: d.props.summary,
    keywords: d.props.keywords,
  }))

  // CPG hints
  const cpgHints: string[] = []
  try {
    const fnNames = allDecisions.map(d => d.functionName).filter(Boolean)
    if (fnNames.length >= 2) {
      const cpgResult = await dbSession.run(
        `MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
         WHERE caller.name IN $names AND callee.name IN $names AND caller.name <> callee.name
         RETURN DISTINCT caller.name + ' CALLS ' + callee.name AS hint
         LIMIT 50`,
        { names: fnNames }
      )
      for (const r of cpgResult.records) {
        cpgHints.push(r.get('hint') as string)
      }
    }
  } catch {}

  try {
    const groupPrompt = buildGroupingPrompt(summaries, cpgHints)
    const rawGroups = await ai.call(groupPrompt)
    const groups = parseJsonSafe<{ group: string[]; reason: string }[]>(rawGroups, [])

    if (Array.isArray(groups) && groups.length > 0) {
      console.log(`    ✓ ${groups.length} groups identified`)

      // 4b: Relationship edges per group
      let totalEdges = 0
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi]
        process.stdout.write(`    Group ${gi + 1}/${groups.length}: ${group.reason.slice(0, 60)}...`)
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
        if (groupDecisions.length < 2) {
          console.log(` skipped (< 2 decisions)`)
          continue
        }

        try {
          const relPrompt = buildRelationshipPrompt(groupDecisions, group.reason)
          const rawRel = await ai.call(relPrompt)
          const result = parseJsonSafe<{ edges: any[] }>(rawRel, { edges: [] })
          const edges = Array.isArray(result.edges) ? result.edges : []

          let groupEdges = 0
          for (const edge of edges) {
            const edgeType = String(edge.type).toUpperCase()
            const allowed = ['CAUSED_BY', 'DEPENDS_ON', 'CONFLICTS_WITH', 'CO_DECIDED']
            if (!allowed.includes(edgeType) || !edge.from || !edge.to) continue
            try {
              await dbSession.run(
                `MATCH (a:DecisionContext {id: $from})
                 MATCH (b:DecisionContext {id: $to})
                 MERGE (a)-[r:${edgeType}]->(b)
                 SET r.reason = $reason`,
                { from: edge.from, to: edge.to, reason: String(edge.reason ?? '') }
              )
              groupEdges++
              totalEdges++
            } catch {}
          }
          console.log(` ${groupEdges} edges`)
        } catch (err: any) {
          console.log(` failed: ${err.message}`)
        }
      }
      console.log(`    📝 ${totalEdges} relationship edges written`)
    }
  } catch (err: any) {
    console.log(`    ⚠️ Round 4a failed: ${err.message}`)
  }

  // 4c: Keyword normalization
  try {
    const allKeywords = allDecisions.flatMap(d => d.props.keywords ?? [])
    if (allKeywords.length > 0) {
      const normPrompt = buildKeywordNormalizationPrompt(allKeywords)
      const rawNorm = await ai.call(normPrompt, { timeoutMs: 60000 })
      const normalizations = parseJsonSafe<{ canonical: string; aliases: string[] }[]>(rawNorm, [])

      if (Array.isArray(normalizations) && normalizations.length > 0) {
        let normalized = 0
        for (const norm of normalizations) {
          if (!norm.canonical || !Array.isArray(norm.aliases)) continue
          for (const alias of norm.aliases) {
            try {
              const res = await dbSession.run(
                `MATCH (d:DecisionContext)
                 WHERE ANY(k IN d.keywords WHERE k = $alias)
                   AND NOT ANY(k IN d.keywords WHERE k = $canonical)
                 SET d.keywords = d.keywords + [$canonical]
                 RETURN count(d) AS cnt`,
                { alias, canonical: norm.canonical }
              )
              const cnt = res.records[0]?.get('cnt')
              if (cnt && (typeof cnt === 'number' ? cnt > 0 : cnt.toNumber() > 0)) normalized++
            } catch {}
          }
        }
        console.log(`    🏷️  ${normalized} keyword normalizations applied`)
      }
    }
  } catch (err: any) {
    console.log(`    ⚠️ Keyword normalization failed: ${err.message}`)
  }
}

// ── Build code structure string from graph ──────────────

async function buildCodeStructure(
  dbSession: Session,
  touchedFiles: string[],
  projectName: string,
  config: ReturnType<typeof loadConfig>
): Promise<string> {
  const repoConfig = config.repos.find(r =>
    projectName.includes(r.name) || r.name.includes(projectName)
  )
  if (!repoConfig) return ''

  try {
    const allFiles = await getFilesFromGraph(dbSession, repoConfig.name)
    const relevant = allFiles.filter(f =>
      touchedFiles.some(tf =>
        f.filePath.includes(tf) || tf.includes(f.filePath) || f.fileName === path.basename(tf)
      )
    )

    if (relevant.length === 0) return ''

    return relevant.map(f => {
      const fns = f.functions.map(fn => `${fn.name} (${fn.lineStart}-${fn.lineEnd})`).join(', ')
      const deps = []
      if (f.crossCallers.length > 0) deps.push(`Called by: ${f.crossCallers.slice(0, 5).join(', ')}`)
      if (f.crossCallees.length > 0) deps.push(`Calls: ${f.crossCallees.slice(0, 5).join(', ')}`)
      const depStr = deps.length > 0 ? `\n  Dependencies: ${deps.join(' | ')}` : ''
      return `${f.filePath}\n  Functions: ${fns}${depStr}`
    }).join('\n\n')
  } catch {
    return ''
  }
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now()
  const config = loadConfig()
  const ai = createAIProvider(config.ai)

  console.log(`\n📼 Session Ingestion v2`)
  console.log(`   AI: ${ai.name}`)
  if (dryRun) console.log(`   ⚠️  DRY RUN — Phase 0 only, no LLM calls`)
  if (autoApprove) console.log(`   Auto-approve: analyzing all segments with decisions`)
  console.log()

  if (!fs.existsSync(CLAUDE_DIR)) {
    console.error(`找不到 ${CLAUDE_DIR}，请确认 Claude Code 已安装并使用过`)
    process.exit(1)
  }

  const processed = loadProcessed()

  // ── Collect sessions to process ─────────────────────

  const toProcess: { jsonlPath: string; projectName: string }[] = []

  for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const projectName = projectNameFromDir(dir.name)
    if (targetProject && !dir.name.includes(targetProject)) continue

    const dirPath = path.join(CLAUDE_DIR, dir.name)
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
      const sessionId = file.replace('.jsonl', '')
      if (targetSession && !sessionId.includes(targetSession)) continue
      if (!force && processed[sessionId]) continue

      toProcess.push({ jsonlPath: path.join(dirPath, file), projectName })
    }
  }

  if (toProcess.length === 0) {
    console.log('没有新的 session 需要处理')
    if (!dryRun) await closeDriver()
    return
  }

  console.log(`找到 ${toProcess.length} 个 session\n`)

  // ── Connect to Memgraph (unless dry-run without graph queries) ──
  if (!dryRun) await verifyConnectivity()

  // ── Process each session ────────────────────────────

  for (const { jsonlPath, projectName } of toProcess) {

    // ─── Phase 0: Preprocess ──────────────────────────
    const phase0 = parseSession(jsonlPath, projectName)
    const shortId = phase0.sessionId.slice(0, 8)

    if (phase0.turns.length < 3) {
      console.log(`[${shortId}] ${projectName} — 跳过（对话太短: ${phase0.turns.length} turns）`)
      continue
    }

    console.log(`[${shortId}] ${projectName}`)
    console.log(`    ${phase0.turns.length} turns | ${phase0.touchedFiles.length} files | ~${phase0.estimatedTokens} tokens`)

    if (dryRun) {
      // show a preview of compressed turns
      const preview = phase0.turns.slice(0, 5).map((t, i) =>
        `    [${i}] ${t.role}: ${t.content.slice(0, 80)}${t.content.length > 80 ? '...' : ''}`
      ).join('\n')
      console.log(`    Preview:\n${preview}`)
      if (phase0.turns.length > 5) console.log(`    ... and ${phase0.turns.length - 5} more turns`)
      console.log()
      continue
    }

    // ─── Phase 1: Segmentation ────────────────────────
    const dbSession = await getSession()
    try {
      const bizCtx = await getBusinessContext(dbSession)
      const codeStructure = await buildCodeStructure(dbSession, phase0.touchedFiles, projectName, config)

      console.log(`    🔍 Phase 1: Segmenting...`)
      const segments = await runPhase1(phase0, codeStructure, bizCtx, ai)

      if (segments.length === 0) {
        console.log(`    ○ No meaningful segments found`)
        // still mark as processed
        processed[phase0.sessionId] = {
          processedAt: new Date().toISOString(),
          version: 'v2',
          segmentCount: 0,
          approvedSegments: 0,
          decisionCount: 0,
          decisionIds: [],
        }
        saveProcessed(processed)
        continue
      }

      // display segments
      const withDecisions = segments.filter(s => s.hasDecisions)
      console.log(`    ✓ ${segments.length} segments (${withDecisions.length} with decisions):`)
      segments.forEach((s, i) => {
        const marker = s.hasDecisions ? '✅' : '❌'
        console.log(`    [${i + 1}] ${marker} Turn ${s.startTurn}-${s.endTurn}: ${s.summary}`)
        if (s.decisionHints.length > 0) {
          console.log(`        Hints: ${s.decisionHints.join(', ')}`)
        }
      })

      // user approval
      let approvedSegments: (SessionSegment & { approved: boolean })[]
      if (autoApprove) {
        approvedSegments = segments.map(s => ({ ...s, approved: s.hasDecisions }))
        console.log(`    Auto-approved ${withDecisions.length} segments`)
      } else {
        console.log()
        const answer = await askUser(`    分析哪些？(all / 1,${segments.length > 1 ? '3' : ''} / none): `)

        if (answer === 'none' || answer === 'n') {
          approvedSegments = segments.map(s => ({ ...s, approved: false }))
        } else if (answer === 'all' || answer === 'a') {
          approvedSegments = segments.map(s => ({ ...s, approved: true }))
        } else {
          const selected = new Set(answer.split(/[,，]/).map(s => parseInt(s.trim())).filter(n => !isNaN(n)))
          approvedSegments = segments.map((s, i) => ({ ...s, approved: selected.has(i + 1) }))
        }
      }

      const approved = approvedSegments.filter(s => s.approved)
      if (approved.length === 0) {
        console.log(`    ○ No segments approved, skipping`)
        processed[phase0.sessionId] = {
          processedAt: new Date().toISOString(),
          version: 'v2',
          segmentCount: segments.length,
          approvedSegments: 0,
          decisionCount: 0,
          decisionIds: [],
        }
        saveProcessed(processed)
        continue
      }

      // ─── Delete old decisions if re-processing ──────
      if (force && processed[phase0.sessionId]) {
        const oldIds = processed[phase0.sessionId].decisionIds
        if (oldIds.length > 0) {
          const deleted = await deleteOldDecisions(dbSession, oldIds)
          if (deleted > 0) console.log(`    Replaced ${deleted} old decisions`)
        }
      }

      // ─── Phase 2: Deep Extraction ───────────────────
      console.log(`\n    🔬 Phase 2: Deep extraction (${approved.length} segments)`)

      const allDecisions: PendingDecision[] = []

      const phase2Results = await runWithConcurrency(
        approved,
        concurrency,
        async (segment) => {
          try {
            const decisions = await runPhase2(
              phase0, segment, dbSession, bizCtx, ai, jsonlPath
            )
            const ctxInfo = segment.touchedFiles.length > 0
              ? segment.touchedFiles.slice(0, 2).join(', ')
              : 'no files'
            console.log(`    ✓ Turn ${segment.startTurn}-${segment.endTurn}: ${decisions.length} decisions (${ctxInfo})`)
            return decisions
          } catch (err: any) {
            console.log(`    ✗ Turn ${segment.startTurn}-${segment.endTurn}: ${err.message}`)
            return []
          }
        }
      )

      for (const decisions of phase2Results) {
        allDecisions.push(...decisions)
      }

      // ─── Write to Memgraph ──────────────────────────
      if (allDecisions.length > 0) {
        const writeStart = Date.now()
        const { nodes, anchored } = await batchWriteDecisions(dbSession, allDecisions)
        const writeTime = ((Date.now() - writeStart) / 1000).toFixed(1)
        console.log(`    📝 Written: ${nodes} decisions, ${anchored} anchored (${writeTime}s)`)
      }

      // ─── Round 4: Relationships ─────────────────────
      await runRound4(allDecisions, dbSession, ai)

      // ─── Save state ─────────────────────────────────
      processed[phase0.sessionId] = {
        processedAt: new Date().toISOString(),
        version: 'v2',
        segmentCount: segments.length,
        approvedSegments: approved.length,
        decisionCount: allDecisions.length,
        decisionIds: allDecisions.map(d => d.id),
      }
      saveProcessed(processed)

      console.log()

    } finally {
      await dbSession.close()
    }
  }

  // ── Done ────────────────────────────────────────────

  if (!dryRun) await closeDriver()
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ Session ingestion v2 complete (${totalTime}s)\n`)
}

main().catch(err => {
  console.error('失败:', err.message)
  closeDriver().catch(() => {})
  process.exit(1)
})

/**
 * run-history.ts
 *
 * Persistent store for pipeline run statistics.
 * Each completed run (analyze, session-ingest, connect, keyword-normalize)
 * is recorded with token usage, duration, output counts, and template info.
 *
 * Stored in data/run-history.json as a JSON array (append-only).
 */

import fs from 'fs'
import path from 'path'

// ── Types ───────────────────────────────────────────────

export type RunType =
  | 'analyze'           // per-function deep analysis
  | 'analyze-batch'     // full-scan batch analysis
  | 'session-ingest'    // session pipeline (phase1 + phase2)
  | 'connect'           // grouping + relationship
  | 'keyword-normalize' // keyword normalization

export interface RunRecord {
  id: string                  // unique run id
  type: RunType
  startedAt: string           // ISO timestamp
  completedAt: string         // ISO timestamp
  durationMs: number

  // Token usage
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheCreationTokens?: number   // tokens written to KV cache
  cacheReadTokens?: number       // tokens read from KV cache (cache hits)

  // Output metrics
  decisionsCreated: number
  edgesCreated: number
  functionsAnalyzed: number
  segmentsProcessed: number

  // Context
  repo?: string
  template?: string           // prompt template used
  model?: string              // AI model used
  sessionId?: string          // for session-ingest runs
  goal?: string

  // Per-function fields (type === 'analyze')
  functionName?: string       // e.g. "createOrder"
  filePath?: string           // e.g. "store/orderStore.ts"
  batchId?: string            // links to parent analyze-batch record

  // Errors
  errors: number
  aborted: boolean
}

export interface RunHistoryStats {
  totalRuns: number
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalDecisions: number
  totalEdges: number
  byType: Record<string, { count: number; tokens: number; decisions: number }>
  byTemplate: Record<string, { count: number; tokens: number; decisions: number; avgTokensPerDecision: number }>
  byDay: { date: string; runs: number; tokens: number; decisions: number }[]
  recentRuns: RunRecord[]
}

// ── File path ───────────────────────────────────────────

const HISTORY_FILE = path.resolve(__dirname, '../../data/run-history.json')

// ── CRUD ────────────────────────────────────────────────

function ensureDir(): void {
  const dir = path.dirname(HISTORY_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function loadRunHistory(): RunRecord[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

export function saveRunHistory(records: RunRecord[]): void {
  ensureDir()
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(records, null, 2))
}

export function appendRunRecord(record: RunRecord): void {
  const records = loadRunHistory()
  records.push(record)
  saveRunHistory(records)
}

/** Create a new RunRecord with defaults, ready to be filled in */
export function createRunRecord(type: RunType, opts?: Partial<RunRecord>): RunRecord {
  return {
    id: `run:${type}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    type,
    startedAt: new Date().toISOString(),
    completedAt: '',
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    decisionsCreated: 0,
    edgesCreated: 0,
    functionsAnalyzed: 0,
    segmentsProcessed: 0,
    errors: 0,
    aborted: false,
    ...opts,
  }
}

/** Finalize a run record and persist it */
export function finalizeAndSave(record: RunRecord): void {
  record.completedAt = new Date().toISOString()
  record.durationMs = new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime()
  // Total = our input + output only (excludes system prompt cache overhead)
  record.totalTokens = record.inputTokens + record.outputTokens
  appendRunRecord(record)
}

// ── Stats computation ───────────────────────────────────

export function computeRunHistoryStats(
  records: RunRecord[],
  filters?: { type?: RunType; template?: string; repo?: string; days?: number }
): RunHistoryStats {
  let filtered = records

  if (filters?.type) filtered = filtered.filter(r => r.type === filters.type)
  if (filters?.template) filtered = filtered.filter(r => r.template === filters.template)
  if (filters?.repo) filtered = filtered.filter(r => r.repo === filters.repo)
  if (filters?.days) {
    const cutoff = Date.now() - filters.days * 24 * 60 * 60 * 1000
    filtered = filtered.filter(r => new Date(r.startedAt).getTime() >= cutoff)
  }

  const byType: Record<string, { count: number; tokens: number; decisions: number }> = {}
  const byTemplate: Record<string, { count: number; tokens: number; decisions: number; avgTokensPerDecision: number }> = {}
  const dayMap: Record<string, { runs: number; tokens: number; decisions: number }> = {}

  for (const r of filtered) {
    // by type
    const t = r.type
    if (!byType[t]) byType[t] = { count: 0, tokens: 0, decisions: 0 }
    byType[t].count++
    byType[t].tokens += r.totalTokens
    byType[t].decisions += r.decisionsCreated

    // by template — skip analyze-batch to avoid double-counting with individual analyze records
    if (r.type !== 'analyze-batch') {
      const tmpl = r.template || '(none)'
      if (!byTemplate[tmpl]) byTemplate[tmpl] = { count: 0, tokens: 0, decisions: 0, avgTokensPerDecision: 0 }
      byTemplate[tmpl].count++
      byTemplate[tmpl].tokens += r.totalTokens
      byTemplate[tmpl].decisions += r.decisionsCreated
    }

    // by day — skip analyze-batch to avoid double-counting
    if (r.type !== 'analyze-batch') {
      const day = r.startedAt.slice(0, 10) // YYYY-MM-DD
      if (!dayMap[day]) dayMap[day] = { runs: 0, tokens: 0, decisions: 0 }
      dayMap[day].runs++
      dayMap[day].tokens += r.totalTokens
      dayMap[day].decisions += r.decisionsCreated
    }
  }

  // compute avg tokens per decision for templates
  for (const tmpl of Object.values(byTemplate)) {
    tmpl.avgTokensPerDecision = tmpl.decisions > 0 ? Math.round(tmpl.tokens / tmpl.decisions) : 0
  }

  const byDay = Object.entries(dayMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }))

  return {
    totalRuns: filtered.length,
    totalTokens: filtered.reduce((s, r) => s + r.totalTokens, 0),
    totalInputTokens: filtered.reduce((s, r) => s + r.inputTokens, 0),
    totalOutputTokens: filtered.reduce((s, r) => s + r.outputTokens, 0),
    totalCacheCreationTokens: filtered.reduce((s, r) => s + (r.cacheCreationTokens ?? 0), 0),
    totalCacheReadTokens: filtered.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
    totalDecisions: filtered.reduce((s, r) => s + r.decisionsCreated, 0),
    totalEdges: filtered.reduce((s, r) => s + r.edgesCreated, 0),
    byType,
    byTemplate,
    byDay,
    recentRuns: filtered.slice(-20).reverse(),
  }
}

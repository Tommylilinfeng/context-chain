/**
 * localization/localize-decisions.ts
 *
 * Core logic for translating decision summary/content to a target locale.
 * Independent pipeline — does not touch original fields.
 */

import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import { parseJsonSafe } from '../ingestion/shared'
import {
  buildTranslationPrompt,
  estimateChars,
  DecisionToTranslate,
} from '../prompts/localize'

// ── Types ───────────────────────────────────────────────

export interface LocalizeOptions {
  locale: string              // e.g. 'zh'
  repo?: string               // optional: filter by repo scope
  batchSize?: number          // max decisions per AI call (default 20)
  maxCharsPerBatch?: number   // char budget per batch (default 80000 ≈ 20k tokens)
  force?: boolean             // re-translate even if already localized
  dryRun?: boolean            // don't write to DB
}

export interface LocalizeCallbacks {
  onBatchStart?: (batch: number, count: number) => void
  onBatchDone?: (batch: number, translated: number) => void
  onBatchError?: (batch: number, error: string) => void
  onProgress?: (translated: number, total: number) => void
  shouldAbort?: () => boolean
}

export interface LocalizeResult {
  translated: number
  skipped: number
  failed: number
  total: number
  durationMs: number
}

// ── Fetch untranslated decisions ────────────────────────

export async function fetchDecisionsToLocalize(
  session: Session,
  locale: string,
  repo?: string,
  force?: boolean,
): Promise<DecisionToTranslate[]> {
  const summaryField = `summary_${locale}`
  // Memgraph: property-exists check
  const forceClause = force ? '' : `AND d.${summaryField} IS NULL`
  const repoClause = repo ? `AND ANY(s IN d.scope WHERE s = $repo)` : ''

  const query = `
    MATCH (d:DecisionContext)
    WHERE d.summary IS NOT NULL
      AND d.source <> 'manual_business_context'
      ${forceClause}
      ${repoClause}
    RETURN d.id AS id, d.summary AS summary, d.content AS content
    ORDER BY d.created_at DESC`

  const result = await session.run(query, repo ? { repo } : {})
  return result.records.map(r => ({
    id: r.get('id') as string,
    summary: r.get('summary') as string,
    content: (r.get('content') as string) ?? '',
  }))
}

// ── Pack decisions into batches ─────────────────────────

export function packBatches(
  decisions: DecisionToTranslate[],
  batchSize: number,
  maxChars: number,
): DecisionToTranslate[][] {
  const batches: DecisionToTranslate[][] = []
  let current: DecisionToTranslate[] = []
  let currentChars = 0

  for (const d of decisions) {
    const chars = (d.summary?.length ?? 0) + (d.content?.length ?? 0)
    if (current.length > 0 && (current.length >= batchSize || currentChars + chars > maxChars)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(d)
    currentChars += chars
  }
  if (current.length > 0) batches.push(current)
  return batches
}

// ── Translate a single batch (with recursive split on token error) ──

interface TranslatedDecision {
  id: string
  [key: string]: string  // summary_zh, content_zh, etc.
}

function isTokenLimitError(err: any): boolean {
  const msg = String(err?.message ?? '').toLowerCase()
  return msg.includes('too many tokens') ||
    msg.includes('context length') ||
    msg.includes('maximum.*tokens') ||
    msg.includes('token limit') ||
    msg.includes('request too large')
}

async function translateBatch(
  decisions: DecisionToTranslate[],
  locale: string,
  ai: AIProvider,
): Promise<TranslatedDecision[]> {
  const prompt = buildTranslationPrompt(decisions, locale)
  try {
    const raw = await ai.call(prompt, { timeoutMs: 180_000 })
    const parsed = parseJsonSafe<TranslatedDecision[]>(raw, [])
    // Validate: only return entries whose id we sent
    const sentIds = new Set(decisions.map(d => d.id))
    const filtered = parsed.filter(p => sentIds.has(p.id))
    // If large batch lost results, split and retry missing ones
    if (filtered.length < decisions.length && decisions.length > 1) {
      const gotIds = new Set(filtered.map(f => f.id))
      const missing = decisions.filter(d => !gotIds.has(d.id))
      if (missing.length > 0 && missing.length < decisions.length) {
        const retried = await translateBatch(missing, locale, ai)
        return [...filtered, ...retried]
      }
    }
    return filtered
  } catch (err: any) {
    if (isTokenLimitError(err) && decisions.length > 1) {
      // Split in half and retry
      const mid = Math.ceil(decisions.length / 2)
      const left = await translateBatch(decisions.slice(0, mid), locale, ai)
      const right = await translateBatch(decisions.slice(mid), locale, ai)
      return [...left, ...right]
    }
    throw err
  }
}

// ── Write translations back to Memgraph ─────────────────

async function writeTranslations(
  session: Session,
  translations: TranslatedDecision[],
  locale: string,
): Promise<number> {
  if (translations.length === 0) return 0

  const summaryKey = `summary_${locale}`
  const contentKey = `content_${locale}`
  const now = new Date().toISOString()

  let written = 0
  // Batch in groups of 50 to avoid huge UNWIND
  const CHUNK = 50
  for (let i = 0; i < translations.length; i += CHUNK) {
    const batch = translations.slice(i, i + CHUNK).map(t => ({
      id: t.id,
      summary_l: t[summaryKey] ?? '',
      content_l: t[contentKey] ?? '',
    }))

    await session.run(
      `UNWIND $batch AS d
       MATCH (n:DecisionContext {id: d.id})
       SET n.${summaryKey} = d.summary_l,
           n.${contentKey} = d.content_l,
           n.localized_at = $now`,
      { batch, now },
    )
    written += batch.length
  }
  return written
}

// ── Main entry point ────────────────────────────────────

export async function localizeDecisions(
  session: Session,
  ai: AIProvider,
  options: LocalizeOptions,
  callbacks?: LocalizeCallbacks,
): Promise<LocalizeResult> {
  const {
    locale,
    repo,
    batchSize = 5,
    maxCharsPerBatch = 40_000,
    force = false,
    dryRun = false,
  } = options

  const start = Date.now()

  // 1. Fetch decisions
  const decisions = await fetchDecisionsToLocalize(session, locale, repo, force)
  const total = decisions.length

  if (total === 0) {
    return { translated: 0, skipped: 0, failed: 0, total: 0, durationMs: Date.now() - start }
  }

  // 2. Pack into batches
  const batches = packBatches(decisions, batchSize, maxCharsPerBatch)

  let translated = 0
  let failed = 0

  // 3. Process each batch
  for (let i = 0; i < batches.length; i++) {
    if (callbacks?.shouldAbort?.()) break

    const batch = batches[i]
    callbacks?.onBatchStart?.(i, batch.length)

    try {
      const results = await translateBatch(batch, locale, ai)

      if (!dryRun) {
        await writeTranslations(session, results, locale)
      }

      translated += results.length
      failed += batch.length - results.length
      callbacks?.onBatchDone?.(i, results.length)
    } catch (err: any) {
      failed += batch.length
      callbacks?.onBatchError?.(i, err.message)
    }

    callbacks?.onProgress?.(translated, total)
  }

  return {
    translated,
    skipped: 0,
    failed,
    total,
    durationMs: Date.now() - start,
  }
}

// ── Single decision translation ─────────────────────────

export async function localizeSingleDecision(
  session: Session,
  ai: AIProvider,
  decisionId: string,
  locale: string,
): Promise<boolean> {
  const result = await session.run(
    `MATCH (d:DecisionContext {id: $id})
     RETURN d.summary AS summary, d.content AS content`,
    { id: decisionId },
  )

  if (result.records.length === 0) return false

  const d: DecisionToTranslate = {
    id: decisionId,
    summary: result.records[0].get('summary') as string,
    content: (result.records[0].get('content') as string) ?? '',
  }

  const translations = await translateBatch([d], locale, ai)
  if (translations.length === 0) return false

  await writeTranslations(session, translations, locale)
  return true
}

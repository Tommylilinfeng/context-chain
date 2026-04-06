/**
 * ingestion/noise-filter.ts
 *
 * Generalized noise function detection — marks structurally insignificant
 * CodeEntity nodes in the graph BEFORE module discovery runs.
 *
 * ═══════════════════════════════════════════════════════════
 * Design
 * ════════════════════════���════════════════════════════���═════
 *
 *   Two independent criteria (OR):
 *
 *   A. Parser artifacts — name starts with a character that is NOT
 *      a valid JS/TS identifier start ([a-zA-Z_$#]).
 *      Catches tree-sitter `:program`, `:expression`, etc.
 *      Private fields (#foo) are preserved.
 *
 *   B. Trivial + isolated — body ≤ threshold lines AND zero CALLS
 *      edges in either direction. Catches getters, setters,
 *      re-exports, one-liner wrappers that have no graph presence.
 *      The threshold is data-driven: derived from the repo's
 *      function size distribution (low percentile).
 *
 *   Functions matching either criterion get `noise: true` on the node.
 *   Downstream pipelines (module discovery, design analysis) can
 *   filter with `WHERE fn.noise IS NULL OR fn.noise <> true`.
 *
 *   Safety: Criterion B requires BOTH conditions (tiny AND isolated).
 *   A 2-line function with 50 callers is kept. A 200-line function
 *   with 0 edges is kept. Only truly insignificant functions are marked.
 *
 * ═══════════════════════════════════════════════════════════
 */

import { Session } from 'neo4j-driver'
import { toNum } from './shared'

// ── Types ──────────────────────────────────────────────

export interface NoiseFilterResult {
  parserArtifacts: number
  trivialIsolated: number
  totalNoise: number       // unique (some overlap between criteria)
  totalFunctions: number
  bodyThreshold: number    // computed from data
}

// ── Threshold Computation ──────���───────────────────────

/**
 * Compute the body-size threshold for "trivial" from the distribution.
 * Returns the value at a low percentile (p10) of all function body sizes,
 * clamped to a reasonable minimum (1) and maximum (5).
 *
 * The max clamp prevents over-filtering in repos where most functions
 * are short (e.g. functional-style codebases).
 */
async function computeTrivialThreshold(
  session: Session,
  repo: string,
): Promise<number> {
  // Get all body sizes (line_end - line_start) sorted ascending
  const result = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE fn.line_start > 0 AND fn.line_end > 0
     WITH fn.line_end - fn.line_start AS bodyLines
     ORDER BY bodyLines ASC
     WITH collect(bodyLines) AS allSizes
     WITH allSizes, size(allSizes) AS n
     RETURN allSizes[toInteger(n * 0.1)] AS p10,
            allSizes[toInteger(n * 0.25)] AS p25,
            n AS total`,
    { repo },
  )

  if (result.records.length === 0) return 2

  const p10 = toNum(result.records[0].get('p10'))
  // Clamp between 1 and 5 to be safe
  return Math.max(1, Math.min(5, p10))
}

// ── Main Filter ��───────────────────────────────────────

export async function markNoiseFunctions(
  session: Session,
  repo: string,
  onProgress?: (msg: string) => void,
): Promise<NoiseFilterResult> {
  const log = onProgress ?? (() => {})

  // Total function count
  const totalRes = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo}) RETURN count(fn) AS cnt`,
    { repo },
  )
  const totalFunctions = toNum(totalRes.records[0]?.get('cnt'))

  // Clear previous noise marks
  await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE fn.noise = true
     REMOVE fn.noise`,
    { repo },
  )

  // ── Criterion A: Parser artifacts ──
  // Name does NOT start with a valid JS/TS identifier character.
  // Valid starts: a-z, A-Z, _, $, # (private fields)
  const artifactRes = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE NOT fn.name =~ '^[a-zA-Z_$#].*'
     SET fn.noise = true
     RETURN count(fn) AS cnt`,
    { repo },
  )
  const parserArtifacts = toNum(artifactRes.records[0]?.get('cnt'))
  log(`  Criterion A (parser artifacts): ${parserArtifacts} functions`)

  // ─�� Criterion B: Trivial body + isolated in call graph ──
  const bodyThreshold = await computeTrivialThreshold(session, repo)
  log(`  Body threshold (from distribution): ≤ ${bodyThreshold} lines`)

  // Mark functions that are:
  //   - body ≤ threshold lines
  //   - zero outgoing CALLS edges
  //   - zero incoming CALLS edges
  //   - not already marked (avoid double-counting in stats)
  const trivialRes = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE (fn.noise IS NULL OR fn.noise <> true)
       AND fn.line_start > 0 AND fn.line_end > 0
       AND (fn.line_end - fn.line_start) <= $threshold
       AND NOT EXISTS { MATCH (fn)-[:CALLS]->() }
       AND NOT EXISTS { MATCH ()-[:CALLS]->(fn) }
     SET fn.noise = true
     RETURN count(fn) AS cnt`,
    { repo, threshold: bodyThreshold },
  )
  const trivialIsolated = toNum(trivialRes.records[0]?.get('cnt'))
  log(`  Criterion B (trivial + isolated, ≤ ${bodyThreshold} lines): ${trivialIsolated} functions`)

  // Total noise count (unique)
  const noiseRes = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE fn.noise = true
     RETURN count(fn) AS cnt`,
    { repo },
  )
  const totalNoise = toNum(noiseRes.records[0]?.get('cnt'))

  log(`  Total noise: ${totalNoise}/${totalFunctions} (${(totalNoise / totalFunctions * 100).toFixed(1)}%)`)
  log(`  Signal functions remaining: ${totalFunctions - totalNoise}`)

  return { parserArtifacts, trivialIsolated, totalNoise, totalFunctions, bodyThreshold }
}

// ── Query Helper ──────────────────────��────────────────

/** Standard WHERE clause fragment to exclude noise functions. */
export const NOISE_FILTER = `(fn.noise IS NULL OR fn.noise <> true)`

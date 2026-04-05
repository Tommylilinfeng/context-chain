/**
 * Module Discovery — Prompt Templates
 *
 * Export-based architecture discovery:
 *   Phase 1 — Chunk Analysis: directory exports → subsystem candidates (concurrent)
 *   Phase 2 — Merge: deduplicate + unify into final architecture
 *
 * Functions are assigned to modules by directory membership, not individually.
 */

// ── Types ────────────────────────────────────────────────

export interface DirGroup {
  dir: string
  files: { name: string; exports: string[] }[]
}

export interface DiscoveredModule {
  moduleId: string
  name: string
  description: string
  directories: string[]
  /** For file-level modules (split from a flat directory like utils/) */
  files?: string[]
  /** The parent directory when files[] is used */
  parentDir?: string
  keyExports: string[]
  confidence: number
}

export interface DiscoveryResult {
  modules: DiscoveredModule[]
  stats: {
    totalFiles: number
    totalExports: number
    totalDirs: number
    chunksUsed: number
    modulesDiscovered: number
    phase1Tokens: number
    phase2Tokens: number
    totalTokens: number
    durationMs: number
  }
}

// ── Prompt Builders ──────────────────────────────────────

function formatChunk(groups: DirGroup[]): string {
  const lines: string[] = []
  for (const g of groups) {
    lines.push(`[${g.dir}/] ${g.files.length} files`)
    for (const f of g.files) {
      const shown = f.exports.slice(0, 12)
      const suffix = f.exports.length > 12 ? ` (+${f.exports.length - 12} more)` : ''
      lines.push(`  ${f.name}: ${shown.join(', ')}${suffix}`)
    }
  }
  return lines.join('\n')
}

export function buildChunkPrompt(
  chunk: DirGroup[],
  chunkIndex: number,
  totalChunks: number,
  allDirSummary: string,
  repoName: string,
): string {
  return `You are analyzing part ${chunkIndex + 1}/${totalChunks} of a TypeScript project "${repoName}".

Full directory overview (all parts):
${allDirSummary}

Detailed exports for YOUR part:
${formatChunk(chunk)}

Identify architectural subsystems visible in YOUR part. For each:
1. Name (architectural concept, not folder name)
2. One-line description
3. Which directories from your part belong to it
4. 3-5 key exports that define this subsystem's interface
5. Cross-references to directories in OTHER parts if applicable

Respond ONLY in JSON:
{
  "subsystems": [
    {
      "name": "...",
      "description": "...",
      "directories": ["..."],
      "keyExports": ["..."],
      "crossReferences": ["..."]
    }
  ]
}`
}

export function buildMergePrompt(
  chunkResults: string[],
  repoName: string,
): string {
  return `You analyzed a TypeScript project "${repoName}" in ${chunkResults.length} parts. Below are the subsystems identified from each part.

Merge into a final unified architecture:
- Merge duplicates (same subsystem found in different parts)
- Keep 12-20 final subsystems
- Every directory must belong to at least one subsystem
- Name subsystems by architectural concept, not by folder name
- Each module needs a short snake_case ID (e.g. "tool_framework", "permission_system")

${chunkResults.map((r, i) => `=== Part ${i + 1} ===\n${r}`).join('\n\n')}

Respond ONLY in JSON:
{
  "subsystems": [
    {
      "moduleId": "snake_case_id",
      "name": "Human Readable Name",
      "description": "one-line description",
      "directories": ["dir1/", "dir2/sub/"],
      "keyExports": ["export1", "export2"]
    }
  ]
}`
}

export function buildSplitPrompt(
  mod: DiscoveredModule,
  dirExports: DirGroup[],
  stats: { median: number; upperFence: number },
): string {
  // For single-directory modules (like utils/), list files individually
  const isSingleDir = dirExports.length === 1 && dirExports[0].files.length > 20
  let contentSection: string
  if (isSingleDir) {
    const g = dirExports[0]
    const fileLines = g.files.map((f, i) => {
      const shown = f.exports.slice(0, 8)
      const suffix = f.exports.length > 8 ? ` (+${f.exports.length - 8} more)` : ''
      return `  [${i}] ${f.name}: ${shown.join(', ')}${suffix}`
    }).join('\n')
    contentSection = `This module is a single flat directory "${g.dir}/" with ${g.files.length} files.

Each file is numbered [0]-[${g.files.length - 1}]:
${fileLines}

You MUST assign every file to exactly one module using file indices.`
  } else {
    contentSection = `Directories and their exports:
${formatChunk(dirExports)}`
  }

  const assignUnit = isSingleDir ? 'file' : 'directory or file'

  return `This module is statistically too large and needs to be split into separate, independent modules.

Module: "${mod.name}"
Description: ${mod.description}

Project stats from round 1:
- Median module size: ~${stats.median} exports
- Statistical upper bound (IQR): ~${stats.upperFence} exports
- This module is well above the upper bound

${contentSection}

Split this into architecturally meaningful modules. Guidelines:
- Each new module should represent a distinct responsibility
- Aim for each module to be near or below the upper bound (~${stats.upperFence} exports)
- Assign every ${assignUnit} to exactly one module
- Use descriptive snake_case IDs (e.g. "auth_credentials", "session_management")
- Let the content dictate how many modules — don't force a number
- IMPORTANT: If this module is a cross-cutting foundation/infrastructure layer (generic utilities like logging, errors, formatting, data structures used by everything), it is OK to keep it as ONE module. Return it as-is with moduleId "foundation". Not everything needs splitting.

Respond ONLY in JSON:
{
  "modules": [
    {
      "moduleId": "snake_case_id",
      "name": "Human Readable Name",
      "description": "one-line description",
      ${isSingleDir ? '"fileIndices": [0, 1, 5, 12],' : '"directories": ["dir1/", "dir2/"],'}
      "keyExports": ["export1", "export2"]
    }
  ]
}${isSingleDir ? `\n\nCRITICAL: Every index from 0 to ${dirExports[0].files.length - 1} must appear in exactly one module's fileIndices array. Do not skip any.` : ''}`
}

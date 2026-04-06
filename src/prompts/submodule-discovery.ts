/**
 * Sub-Module Discovery — Prompt Templates
 *
 * File-level architecture discovery within a module.
 * Same philosophy as module-discovery: exports as signal, files as unit.
 */

export interface FileExportGroup {
  path: string       // relative file path within repo
  exports: string[]  // export names
}

export interface DiscoveredSubModule {
  subModuleId: string
  name: string
  description: string
  fileIndices: number[]
  keyExports: string[]
  confidence: number
}

// ── Prompt Builders ──────────────────────────────────────

export function buildSubModuleChunkPrompt(
  files: FileExportGroup[],
  chunkIndex: number,
  totalChunks: number,
  allFileSummary: string,
  moduleName: string,
  moduleDescription: string,
): string {
  const fileLines = files.map((f, i) => {
    const shown = f.exports.slice(0, 10)
    const suffix = f.exports.length > 10 ? ` (+${f.exports.length - 10} more)` : ''
    return `  [${i}] ${f.path}: ${shown.join(', ')}${suffix}`
  }).join('\n')

  return `You are analyzing part ${chunkIndex + 1}/${totalChunks} of the "${moduleName}" module.

Module description: ${moduleDescription}

All files in this module (all parts):
${allFileSummary}

Detailed exports for YOUR part (${files.length} files):
${fileLines}

Identify cohesive sub-modules visible in YOUR part. Each sub-module groups files that share a responsibility.

For each sub-module:
1. Name (responsibility-based, not file/path names)
2. One-line description
3. Which file indices from YOUR part belong to it
4. 3-5 key exports that define this sub-module's interface

Respond ONLY in JSON:
{
  "subModules": [
    {
      "name": "...",
      "description": "...",
      "fileIndices": [0, 3, 7],
      "keyExports": ["..."],
      "crossReferences": ["files from other parts that relate"]
    }
  ]
}`
}

export function buildSubModuleMergePrompt(
  chunkResults: string[],
  moduleName: string,
  moduleDescription: string,
  totalFiles: number,
): string {
  return `You analyzed the "${moduleName}" module in ${chunkResults.length} parts. Below are the sub-modules identified from each part.

Module description: ${moduleDescription}
Total files: ${totalFiles}

Merge into final sub-modules:
- Merge duplicates (same responsibility found in different parts)
- Every file must belong to exactly one sub-module
- Name sub-modules by responsibility, not by file path
- Each sub-module should have a short snake_case ID
- Let the content dictate how many sub-modules — don't force a number
- If a group of files is truly shared infrastructure within this module (error helpers, type definitions, constants), group them as one sub-module

${chunkResults.map((r, i) => `=== Part ${i + 1} ===\n${r}`).join('\n\n')}

Respond ONLY in JSON:
{
  "subModules": [
    {
      "subModuleId": "snake_case_id",
      "name": "Human Readable Name",
      "description": "one-line description",
      "keyExports": ["export1", "export2"]
    }
  ]
}`
}

export function buildSubModuleAssignPrompt(
  subModules: { subModuleId: string; name: string; description: string }[],
  files: FileExportGroup[],
  moduleName: string,
): string {
  const subModList = subModules.map((s, i) =>
    `  [${i}] ${s.subModuleId}: ${s.name} — ${s.description}`
  ).join('\n')

  const fileLines = files.map((f, i) => {
    const shown = f.exports.slice(0, 8)
    const suffix = f.exports.length > 8 ? ` (+${f.exports.length - 8} more)` : ''
    return `  [${i}] ${f.path}: ${shown.join(', ')}${suffix}`
  }).join('\n')

  return `Assign every file in the "${moduleName}" module to exactly one sub-module.

## Sub-Modules

${subModList}

## Files (${files.length} total)

${fileLines}

For each sub-module, list the file indices that belong to it.

Respond ONLY in JSON:
{
  "assignments": [
    {
      "subModuleId": "snake_case_id",
      "fileIndices": [0, 3, 7, 12]
    }
  ]
}

CRITICAL: Every file index from 0 to ${files.length - 1} must appear in exactly one sub-module's fileIndices array. Do not skip any.`
}

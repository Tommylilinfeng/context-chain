/**
 * state.ts
 *
 * Tracks which files have been analyzed and when.
 * Used by cold-start-v2 to detect changes and avoid re-analyzing unchanged code.
 *
 * State is stored per-file (not per-function) because Round 2 analyzes entire files.
 * Each entry records: what commit was the code at when we last analyzed it,
 * and which decision IDs were produced.
 */

import fs from 'fs'
import path from 'path'

const STATE_PATH = path.resolve(__dirname, '../../data/cold-start-state.json')

export interface FileState {
  lastCommit: string              // HEAD commit when this file was last analyzed
  lastAnalyzedAt: string          // ISO timestamp
  decisionIds: string[]           // IDs produced from this file
}

export interface ColdStartState {
  files: Record<string, FileState>   // key: "repo:filePath" e.g. "biteme-shared:services/orderService.ts"
}

export function loadState(): ColdStartState {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'))
    }
  } catch {}
  return { files: {} }
}

export function saveState(state: ColdStartState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

export function getFileKey(repo: string, filePath: string): string {
  return `${repo}:${filePath}`
}

/**
 * session-state.ts
 *
 * Persists pipeline state for each session across server restarts.
 * Each session gets its own JSON file in data/session-states/{id}.json.
 *
 * State machine:
 *   new → phase0_done → phase1_done → phase2_running → completed
 */

import fs from 'fs'
import path from 'path'
import { Phase0Result } from './session-parser'
import { SessionSegment } from '../prompts/session'

// ── Types ───────────────────────────────────────────────

export type SessionStatus =
  | 'new'
  | 'phase0_done'
  | 'phase1_running'
  | 'phase1_done'
  | 'phase2_running'
  | 'completed'
  | 'error'

export interface StoredPhase0 {
  sessionId: string
  projectName: string
  turnCount: number
  touchedFiles: string[]
  sessionStart: string
  sessionEnd: string
  estimatedTokens: number
  // turns are stored separately (can be large) — we only store summary here
  // full turns are re-parsed from JSONL when needed
}

export interface StoredSegment extends SessionSegment {
  approved?: boolean
}

export interface StoredPhase2Result {
  segmentIndex: number
  decisionCount: number
  decisionIds: string[]
  anchored: number
}

export interface SessionPipelineState {
  sessionId: string
  tool: string
  project: string
  filePath: string
  status: SessionStatus
  error?: string

  phase0?: StoredPhase0
  phase1?: {
    segments: StoredSegment[]
    chunksUsed: number
    completedAt: string
  }
  phase2?: {
    approvedIndices: number[]
    results: StoredPhase2Result[]
    totalDecisions: number
    totalAnchored: number
    totalEdges: number
    completedAt?: string
  }

  createdAt: string
  updatedAt: string
}

// ── File paths ──────────────────────────────────────────

const STATES_DIR = path.resolve(__dirname, '../../data/session-states')

function statePath(sessionId: string): string {
  return path.join(STATES_DIR, `${sessionId}.json`)
}

// ── CRUD ────────────────────────────────────────────────

export function loadSessionState(sessionId: string): SessionPipelineState | null {
  try {
    const p = statePath(sessionId)
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    }
  } catch {}
  return null
}

export function saveSessionState(state: SessionPipelineState): void {
  fs.mkdirSync(STATES_DIR, { recursive: true })
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(statePath(state.sessionId), JSON.stringify(state, null, 2))
}

export function deleteSessionState(sessionId: string): void {
  try {
    const p = statePath(sessionId)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {}
}

export function listSessionStates(): SessionPipelineState[] {
  fs.mkdirSync(STATES_DIR, { recursive: true })
  const states: SessionPipelineState[] = []
  for (const file of fs.readdirSync(STATES_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      states.push(JSON.parse(fs.readFileSync(path.join(STATES_DIR, file), 'utf-8')))
    } catch { continue }
  }
  return states
}

// ── Convenience constructors ────────────────────────────

export function createInitialState(
  sessionId: string, tool: string, project: string, filePath: string
): SessionPipelineState {
  const now = new Date().toISOString()
  return {
    sessionId, tool, project, filePath,
    status: 'new',
    createdAt: now,
    updatedAt: now,
  }
}

export function setPhase0Done(
  state: SessionPipelineState,
  phase0: Phase0Result
): void {
  state.phase0 = {
    sessionId: phase0.sessionId,
    projectName: phase0.projectName,
    turnCount: phase0.turns.length,
    touchedFiles: phase0.touchedFiles,
    sessionStart: phase0.sessionStart,
    sessionEnd: phase0.sessionEnd,
    estimatedTokens: phase0.estimatedTokens,
  }
  state.status = 'phase0_done'
}

export function setPhase1Done(
  state: SessionPipelineState,
  segments: SessionSegment[],
  chunksUsed: number
): void {
  state.phase1 = {
    segments: segments.map(s => ({ ...s })),
    chunksUsed,
    completedAt: new Date().toISOString(),
  }
  state.status = 'phase1_done'
}

export function setPhase2Started(
  state: SessionPipelineState,
  approvedIndices: number[]
): void {
  state.phase2 = {
    approvedIndices,
    results: [],
    totalDecisions: 0,
    totalAnchored: 0,
    totalEdges: 0,
  }
  state.status = 'phase2_running'
  // also mark segments as approved/not
  if (state.phase1) {
    state.phase1.segments.forEach((s, i) => {
      s.approved = approvedIndices.includes(i)
    })
  }
}

export function addPhase2SegmentResult(
  state: SessionPipelineState,
  segmentIndex: number,
  decisionCount: number,
  decisionIds: string[],
  anchored: number
): void {
  if (!state.phase2) return
  state.phase2.results.push({ segmentIndex, decisionCount, decisionIds, anchored })
  state.phase2.totalDecisions += decisionCount
  state.phase2.totalAnchored += anchored
}

export function setPhase2Done(
  state: SessionPipelineState,
  totalEdges: number
): void {
  if (!state.phase2) return
  state.phase2.totalEdges = totalEdges
  state.phase2.completedAt = new Date().toISOString()
  state.status = 'completed'
}

export function setError(state: SessionPipelineState, error: string): void {
  state.error = error
  state.status = 'error'
}

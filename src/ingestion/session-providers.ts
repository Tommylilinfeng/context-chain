/**
 * session-providers.ts
 *
 * Abstracts session discovery across different AI coding tools.
 * Each provider knows where a tool stores sessions and how to list them.
 *
 * Supported:
 *   - Claude Code: ~/.claude/projects/{hash}/*.jsonl
 *   - Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Adding a new tool: implement SessionProvider and register in getAllProviders().
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

// ── Types ───────────────────────────────────────────────

export interface SessionInfo {
  id: string               // unique session ID (from file content or derived from path)
  tool: string             // "claude-code" | "codex" | ...
  project: string          // project name (derived from directory structure)
  filePath: string         // absolute path to session file
  fileSize: number         // bytes
  modifiedAt: string       // ISO timestamp (from file stat)
  turnCount?: number       // populated after parsing (cached)
  estimatedTokens?: number // populated after parsing (cached)
}

export interface SessionProvider {
  tool: string
  isAvailable(): boolean
  listSessions(projectFilter?: string): SessionInfo[]
}

// ── Scan cache ──────────────────────────────────────────

const CACHE_PATH = path.resolve(__dirname, '../../data/session-scan-cache.json')

interface ScanCache {
  sessions: Record<string, { turnCount: number; estimatedTokens: number }>
}

let _cache: ScanCache | null = null

function loadCache(): ScanCache {
  if (_cache) return _cache
  try {
    if (fs.existsSync(CACHE_PATH)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
      return _cache!
    }
  } catch {}
  _cache = { sessions: {} }
  return _cache
}

export function saveCache(): void {
  if (!_cache) return
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
  fs.writeFileSync(CACHE_PATH, JSON.stringify(_cache, null, 2))
}

export function updateCacheEntry(sessionId: string, turnCount: number, estimatedTokens: number): void {
  const cache = loadCache()
  cache.sessions[sessionId] = { turnCount, estimatedTokens }
}

// ── Claude Code Provider ────────────────────────────────

class ClaudeCodeProvider implements SessionProvider {
  tool = 'claude-code'
  private baseDir = path.join(os.homedir(), '.claude', 'projects')

  isAvailable(): boolean {
    return fs.existsSync(this.baseDir)
  }

  listSessions(projectFilter?: string): SessionInfo[] {
    if (!this.isAvailable()) return []
    const cache = loadCache()
    const sessions: SessionInfo[] = []

    for (const dir of fs.readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue

      const project = this.projectNameFromDir(dir.name)
      if (projectFilter && !dir.name.includes(projectFilter) && !project.includes(projectFilter)) continue

      const dirPath = path.join(this.baseDir, dir.name)
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue

        const filePath = path.join(dirPath, file)
        const sessionId = file.replace('.jsonl', '')

        try {
          const stat = fs.statSync(filePath)
          if (stat.size < 500) continue // skip tiny files

          const cached = cache.sessions[sessionId]
          sessions.push({
            id: sessionId,
            tool: this.tool,
            project,
            filePath,
            fileSize: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            turnCount: cached?.turnCount,
            estimatedTokens: cached?.estimatedTokens,
          })
        } catch { continue }
      }
    }

    return sessions
  }

  private projectNameFromDir(dirName: string): string {
    const parts = dirName.split('-').filter(Boolean)
    return parts.slice(-3).join('-')
  }
}

// ── Codex CLI Provider ──────────────────────────────────

class CodexProvider implements SessionProvider {
  tool = 'codex'
  private baseDir = path.join(os.homedir(), '.codex', 'sessions')

  isAvailable(): boolean {
    return fs.existsSync(this.baseDir)
  }

  listSessions(projectFilter?: string): SessionInfo[] {
    if (!this.isAvailable()) return []
    const cache = loadCache()
    const sessions: SessionInfo[] = []

    // Walk YYYY/MM/DD directory structure
    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith('.jsonl')) return

      const fileName = path.basename(filePath)
      // rollout-2025-01-22T10-30-00-abc123.jsonl → extract ID
      const sessionId = fileName.replace('.jsonl', '')

      try {
        const stat = fs.statSync(filePath)
        if (stat.size < 500) return

        // Codex doesn't organize by project, derive from content or use "codex"
        const project = projectFilter ?? 'codex-session'
        if (projectFilter && !project.includes(projectFilter)) return

        const cached = cache.sessions[sessionId]
        sessions.push({
          id: sessionId,
          tool: this.tool,
          project,
          filePath,
          fileSize: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          turnCount: cached?.turnCount,
          estimatedTokens: cached?.estimatedTokens,
        })
      } catch {}
    })

    return sessions
  }

  private walkDir(dir: string, callback: (filePath: string) => void): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          this.walkDir(full, callback)
        } else {
          callback(full)
        }
      }
    } catch {}
  }
}

// ── Provider registry ───────────────────────────────────

const PROVIDERS: SessionProvider[] = [
  new ClaudeCodeProvider(),
  new CodexProvider(),
]

export function getAllProviders(): SessionProvider[] {
  return PROVIDERS.filter(p => p.isAvailable())
}

export function listAllSessions(projectFilter?: string): SessionInfo[] {
  const all: SessionInfo[] = []
  for (const provider of PROVIDERS) {
    if (!provider.isAvailable()) continue
    all.push(...provider.listSessions(projectFilter))
  }
  // sort by modified date, newest first
  all.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
  return all
}

export function findSession(sessionId: string): SessionInfo | null {
  for (const provider of PROVIDERS) {
    if (!provider.isAvailable()) continue
    const sessions = provider.listSessions()
    const found = sessions.find(s => s.id === sessionId || s.id.startsWith(sessionId))
    if (found) return found
  }
  return null
}

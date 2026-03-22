/**
 * core/session-cleanup.ts
 *
 * 清理 claude -p 调用产生的 session 文件。
 *
 * 原理：claude-cli.ts 在每个 prompt 前注入 [CKG-PIPELINE-SESSION] 标记。
 * 清理时扫描 ~/.claude/projects/ 下的 .jsonl 文件，
 * 内容包含该标记的就是 pipeline 产生的，可以安全删除。
 *
 * 用法：
 *   import { cleanupPipelineSessions } from '../core/session-cleanup'
 *   const result = cleanupPipelineSessions()
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { CKG_SESSION_MARKER } from '../ai/claude-cli'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

/** 读文件前 2KB 检查是否包含标记（避免读完整个大文件） */
function fileContainsMarker(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(2048)
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0)
    fs.closeSync(fd)
    return buf.slice(0, bytesRead).toString('utf-8').includes(CKG_SESSION_MARKER)
  } catch {
    return false
  }
}

/**
 * 扫描并删除所有包含 CKG pipeline 标记的 session 文件。
 *
 * @param safetyMinutes 不删最近 N 分钟内修改的文件（默认 2 分钟）
 */
export function cleanupPipelineSessions(safetyMinutes = 2, dryRun = false): {
  deleted: number
  skipped: number
  totalSizeMB: number
  scanned: number
} {
  let deleted = 0
  let skipped = 0
  let totalBytes = 0
  let scanned = 0

  const safetyMs = safetyMinutes * 60 * 1000
  const now = Date.now()

  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return { deleted: 0, skipped: 0, totalSizeMB: 0, scanned: 0 }
  }

  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'memory')

    for (const dir of dirs) {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir.name)

      let files: string[]
      try {
        files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
      } catch { continue }

      for (const f of files) {
        const fullPath = path.join(dirPath, f)
        scanned++

        if (!fileContainsMarker(fullPath)) continue

        try {
          const stat = fs.statSync(fullPath)

          // 安全检查：不删太新的文件（可能还在写入中）
          if (now - stat.mtimeMs < safetyMs) {
            skipped++
            continue
          }

          totalBytes += stat.size
          if (!dryRun) fs.unlinkSync(fullPath)
          deleted++
        } catch {
          skipped++
        }
      }

      // 清理 claude -p 产生的空子目录（有时会创建跟 session 同名的目录）
      if (dryRun) continue
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === 'memory') continue
          const subDir = path.join(dirPath, entry.name)
          try {
            const subEntries = fs.readdirSync(subDir)
            if (subEntries.length === 0) fs.rmdirSync(subDir)
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return {
    deleted,
    skipped,
    totalSizeMB: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
    scanned,
  }
}

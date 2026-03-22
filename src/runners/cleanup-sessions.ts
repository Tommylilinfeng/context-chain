/**
 * runners/cleanup-sessions.ts
 *
 * 独立清理命令：删除所有 CKG pipeline 产生的 Claude Code session 文件。
 *
 * 用法：
 *   npm run cleanup               # 扫描并删除
 *   npm run cleanup -- --dry-run   # 只扫描不删除
 */

import { cleanupPipelineSessions } from '../core/session-cleanup'

const dryRun = process.argv.includes('--dry-run')

console.log(dryRun
  ? '\n🔍 Dry run: scanning for CKG pipeline sessions...\n'
  : '\n🧹 Cleaning up CKG pipeline sessions...\n'
)

const result = cleanupPipelineSessions(dryRun ? 0 : 2, dryRun)

console.log(`Scanned: ${result.scanned} session files`)
if (dryRun) {
  console.log(`Would delete: ${result.deleted} pipeline sessions (${result.totalSizeMB}MB)`)
  if (result.skipped > 0) console.log(`Would skip: ${result.skipped} (modified < 2min ago)`)
} else {
  console.log(`Deleted: ${result.deleted} pipeline sessions (${result.totalSizeMB}MB)`)
  if (result.skipped > 0) console.log(`Skipped: ${result.skipped} (modified < 2min ago)`)
}

if (result.deleted === 0) console.log(`No pipeline sessions found.`)
console.log()

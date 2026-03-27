/**
 * ai/claude-cli.ts
 *
 * AIProvider 实现：通过 claude -p（Claude Code CLI）调用。
 * 走 Claude Max subscription，不消耗 API 配额。
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { AIProvider, AIProviderOptions, AIConfig, TokenUsage } from './types'

/** Marker injected into every claude -p prompt so we can identify and clean up pipeline sessions */
export const CKG_SESSION_MARKER = '[CKG-PIPELINE-SESSION]'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

export class ClaudeCLIProvider implements AIProvider {
  name = 'claude-cli'
  lastUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  private model: string | undefined

  constructor(config: AIConfig) {
    this.model = config.model
  }

  cleanup(): void {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return
    const now = Date.now()
    const safetyMs = 2 * 60 * 1000
    try {
      const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== 'memory')
      for (const dir of dirs) {
        const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir.name)
        let files: string[]
        try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')) } catch { continue }
        for (const f of files) {
          const fullPath = path.join(dirPath, f)
          try {
            const fd = fs.openSync(fullPath, 'r')
            const buf = Buffer.alloc(2048)
            const bytesRead = fs.readSync(fd, buf, 0, 2048, 0)
            fs.closeSync(fd)
            if (!buf.slice(0, bytesRead).toString('utf-8').includes(CKG_SESSION_MARKER)) continue
            const stat = fs.statSync(fullPath)
            if (now - stat.mtimeMs < safetyMs) continue
            fs.unlinkSync(fullPath)
          } catch {}
        }
      }
    } catch {}
  }

  call(prompt: string, options?: AIProviderOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? 120000

    return new Promise((resolve, reject) => {
      const tmp = `/tmp/ckg-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
      // Inject marker so we can identify and clean up pipeline sessions later
      fs.writeFileSync(tmp, `${CKG_SESSION_MARKER}\n${prompt}`, 'utf-8')

      const modelFlag = this.model ? ` --model ${this.model}` : ''
      const cmd = `cat "${tmp}" | claude -p --tools ""${modelFlag} --output-format json`

      exec(cmd, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout) => {
        try { fs.unlinkSync(tmp) } catch {}

        if (err) {
          reject(new Error(`claude -p failed: ${err.message}`))
          return
        }

        try {
          const wrapper = JSON.parse(stdout.trim())
          const raw: string = wrapper.result ?? ''

          // 追踪 token 用量（claude -p --output-format json 返回 usage 字段）
          if (wrapper.usage) {
            this.lastUsage = {
              input_tokens: wrapper.usage.input_tokens ?? 0,
              output_tokens: wrapper.usage.output_tokens ?? 0,
              cache_creation_input_tokens: wrapper.usage.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: wrapper.usage.cache_read_input_tokens ?? 0,
            }
            this.totalUsage.input_tokens += this.lastUsage.input_tokens
            this.totalUsage.output_tokens += this.lastUsage.output_tokens
            this.totalUsage.cache_creation_input_tokens = (this.totalUsage.cache_creation_input_tokens ?? 0) + (this.lastUsage.cache_creation_input_tokens ?? 0)
            this.totalUsage.cache_read_input_tokens = (this.totalUsage.cache_read_input_tokens ?? 0) + (this.lastUsage.cache_read_input_tokens ?? 0)
          }

          const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
          resolve(cleaned)
        } catch (e: any) {
          reject(new Error(`Failed to parse claude output: ${e.message}`))
        }
      })
    })
  }
}

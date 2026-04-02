/**
 * ai/claude-cli.ts
 *
 * AIProvider 实现：通过 claude -p（Claude Code CLI）调用。
 * 走 Claude Max subscription，不消耗 API 配额。
 *
 * Uses --output-format stream-json --verbose to capture rate_limit_event
 * for quota-aware pacing (5h rolling window).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { AIProvider, AIProviderOptions, AIConfig, TokenUsage, RateLimitEvent } from './types'

/** Marker injected into every claude -p prompt so we can identify and clean up pipeline sessions */
export const CKG_SESSION_MARKER = '[CKG-PIPELINE-SESSION]'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

const RATE_LIMITS_FILE = path.join(os.homedir(), '.claude', 'rate-limits.json')

/**
 * Pacer: dynamic delay between calls based on 5h quota utilization.
 * Shared across all ClaudeCLIProvider instances in the process.
 *
 * Two data sources (in priority order):
 * 1. ~/.claude/rate-limits.json — precise %, written by statusline script (optional)
 * 2. rate_limit_event from stream-json — status only (allowed/allowed_warning/rejected)
 */
class Pacer {
  private _lastEvent: RateLimitEvent | null = null
  private _delaySec: number = 0
  private _preciseUtilization: number | null = null

  get lastEvent() { return this._lastEvent }
  get delaySec() { return this._delaySec }
  get preciseUtilization() { return this._preciseUtilization }

  /** Try to read precise utilization from statusline file */
  private _readPreciseFile(): number | null {
    try {
      if (!fs.existsSync(RATE_LIMITS_FILE)) return null
      const data = JSON.parse(fs.readFileSync(RATE_LIMITS_FILE, 'utf-8'))
      const ageSec = Math.floor(Date.now() / 1000 - (data.ts ?? 0))
      if (ageSec > 300) return null // stale after 5 min
      const pct = data.rate_limits?.five_hour?.used_percentage
      if (typeof pct === 'number') return pct / 100 // normalize to 0-1
      return null
    } catch { return null }
  }

  update(event: RateLimitEvent) {
    this._lastEvent = event

    // Try precise file first
    const precise = this._readPreciseFile()
    if (precise !== null) {
      this._preciseUtilization = precise
      this._computeDelay(precise, event.resetsAt)
      return
    }

    this._preciseUtilization = null

    if (event.status === 'allowed') {
      this._delaySec = 0
      return
    }

    if (event.status === 'rejected') {
      const waitMs = Math.max(0, event.resetsAt * 1000 - Date.now())
      this._delaySec = Math.ceil(waitMs / 1000)
      return
    }

    // allowed_warning — use utilization from event if available, else assume 0.85
    const utilization = event.utilization ?? 0.85
    this._computeDelay(utilization, event.resetsAt)
  }

  private _computeDelay(utilization: number, resetsAt: number) {
    const remainingMs = Math.max(0, resetsAt * 1000 - Date.now())
    const remainingMin = remainingMs / 60000

    if (utilization >= 0.95) {
      this._delaySec = Math.min(60, Math.ceil(remainingMin * 2))
    } else if (utilization >= 0.8) {
      this._delaySec = Math.min(30, Math.ceil(remainingMin * 0.5))
    } else if (utilization >= 0.6) {
      this._delaySec = Math.min(10, Math.ceil(remainingMin * 0.1))
    } else {
      this._delaySec = 0
    }
  }
}

// Singleton pacer shared across all CLI provider instances
const pacer = new Pacer()

/** Get current pacer state (for dashboard display) */
export function getPacerState(): { delaySec: number; lastEvent: RateLimitEvent | null } {
  return { delaySec: pacer.delaySec, lastEvent: pacer.lastEvent }
}

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

  async call(prompt: string, options?: AIProviderOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? 120000

    // Apply pacer delay if needed
    if (pacer.delaySec > 0) {
      const delay = pacer.delaySec
      options?.onRateLimit?.(pacer.lastEvent!)
      await new Promise(r => setTimeout(r, delay * 1000))
    }

    const tmp = `/tmp/ckg-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    fs.writeFileSync(tmp, `${CKG_SESSION_MARKER}\n${prompt}`, 'utf-8')

    try {
      const result = await this._execStreamJson(tmp, timeoutMs, options)
      return result
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
    }
  }

  private _execStreamJson(tmpFile: string, timeoutMs: number, options?: AIProviderOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--tools', '', '--output-format', 'stream-json', '--verbose']
      if (this.model) args.push('--model', this.model)

      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      })

      // Pipe prompt via stdin
      const inputStream = fs.createReadStream(tmpFile)
      inputStream.pipe(child.stdin)

      let stdout = ''
      let stderr = ''
      let resultText: string | null = null
      let rateLimitEvent: RateLimitEvent | null = null

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()

        // Parse complete lines
        const lines = stdout.split('\n')
        stdout = lines.pop() ?? '' // keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line)

            if (parsed.type === 'rate_limit_event' && parsed.rate_limit_info) {
              const info = parsed.rate_limit_info
              rateLimitEvent = {
                status: info.status ?? 'allowed',
                rateLimitType: info.rateLimitType ?? 'five_hour',
                resetsAt: info.resetsAt ?? 0,
                utilization: info.utilization,
              }
              pacer.update(rateLimitEvent)
              options?.onRateLimit?.(rateLimitEvent)
            }

            if (parsed.type === 'result') {
              resultText = parsed.result ?? ''

              // Track token usage
              if (parsed.usage) {
                this.lastUsage = {
                  input_tokens: parsed.usage.input_tokens ?? 0,
                  output_tokens: parsed.usage.output_tokens ?? 0,
                  cache_creation_input_tokens: parsed.usage.cache_creation_input_tokens ?? 0,
                  cache_read_input_tokens: parsed.usage.cache_read_input_tokens ?? 0,
                }
                this.totalUsage.input_tokens += this.lastUsage.input_tokens
                this.totalUsage.output_tokens += this.lastUsage.output_tokens
                this.totalUsage.cache_creation_input_tokens = (this.totalUsage.cache_creation_input_tokens ?? 0) + (this.lastUsage.cache_creation_input_tokens ?? 0)
                this.totalUsage.cache_read_input_tokens = (this.totalUsage.cache_read_input_tokens ?? 0) + (this.lastUsage.cache_read_input_tokens ?? 0)
              }
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('close', (code) => {
        // Process any remaining stdout
        if (stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim())
            if (parsed.type === 'result') {
              resultText = parsed.result ?? ''
              if (parsed.usage) {
                this.lastUsage = {
                  input_tokens: parsed.usage.input_tokens ?? 0,
                  output_tokens: parsed.usage.output_tokens ?? 0,
                  cache_creation_input_tokens: parsed.usage.cache_creation_input_tokens ?? 0,
                  cache_read_input_tokens: parsed.usage.cache_read_input_tokens ?? 0,
                }
                this.totalUsage.input_tokens += this.lastUsage.input_tokens
                this.totalUsage.output_tokens += this.lastUsage.output_tokens
                this.totalUsage.cache_creation_input_tokens = (this.totalUsage.cache_creation_input_tokens ?? 0) + (this.lastUsage.cache_creation_input_tokens ?? 0)
                this.totalUsage.cache_read_input_tokens = (this.totalUsage.cache_read_input_tokens ?? 0) + (this.lastUsage.cache_read_input_tokens ?? 0)
              }
            }
            if (parsed.type === 'rate_limit_event' && parsed.rate_limit_info) {
              const info = parsed.rate_limit_info
              rateLimitEvent = {
                status: info.status ?? 'allowed',
                rateLimitType: info.rateLimitType ?? 'five_hour',
                resetsAt: info.resetsAt ?? 0,
                utilization: info.utilization,
              }
              pacer.update(rateLimitEvent)
              options?.onRateLimit?.(rateLimitEvent)
            }
          } catch {}
        }

        if (code !== 0 && resultText === null) {
          reject(new Error(`claude -p failed (exit ${code}): ${stderr.slice(0, 500)}`))
          return
        }

        if (resultText === null) {
          reject(new Error('claude -p returned no result'))
          return
        }

        const cleaned = resultText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
        resolve(cleaned)
      })

      child.on('error', (err) => {
        reject(new Error(`claude -p spawn failed: ${err.message}`))
      })

      // Timeout handling
      setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
        reject(new Error(`claude -p timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
  }
}

/**
 * config.ts
 *
 * Reads ckg.config.json and provides project configuration.
 */

import fs from 'fs'
import path from 'path'
import { AIConfig } from './ai/types'

export interface RepoConfig {
  name: string
  path: string
  type: string
  cpgFile: string
  packages: string[]  // npm package names that map to this repo
  skipEdgeFunctions?: boolean  // true = edge functions are copies, not source of truth
  language?: string   // Joern language param: javascript, python, java, etc.
  srcDir?: string     // subdirectory to scan (default: 'src')
}

export interface AnalysisConfig {
  summaryWords: number   // target word count for decision summary
  contentWords: number   // target word count for decision content
}

const DEFAULT_ANALYSIS: AnalysisConfig = {
  summaryWords: 30,
  contentWords: 150,
}

export interface ProjectConfig {
  project: string
  repos: RepoConfig[]
  ai?: AIConfig
  analysis?: AnalysisConfig
  memgraph?: {
    host?: string   // default: 'localhost'
    port?: number   // default: 7687
  }
  dashboard?: {
    port?: number   // default: 3001
  }
}

const CONFIG_PATH = path.resolve(__dirname, '../ckg.config.json')

let _cache: ProjectConfig | null = null

export function loadConfig(): ProjectConfig {
  if (_cache) return _cache
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}\nPlease create ckg.config.json first`)
  }
  _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  return _cache!
}

export function getAnalysisConfig(): AnalysisConfig {
  const config = loadConfig()
  return {
    ...DEFAULT_ANALYSIS,
    ...config.analysis,
  }
}

export function clearConfigCache(): void {
  _cache = null
}

/** Stable project identifier for lock files, state files, etc. */
export function getProjectId(): string {
  try {
    const config = loadConfig()
    if (config.project) return config.project
  } catch {}
  return path.basename(path.resolve(__dirname, '..'))
}

/**
 * Resolve an npm package name to the corresponding repo name.
 * e.g. "@biteme-bot/shared" → "biteme-shared"
 */
export function resolvePackageToRepo(packageName: string): string | null {
  const config = loadConfig()
  for (const repo of config.repos) {
    if (repo.packages.includes(packageName)) {
      return repo.name
    }
  }
  return null
}

/**
 * Parse package name and function name from a Joern callee_id.
 *
 * Input format: "fn:bite-me-website/@biteme-bot/shared:createOrderService"
 * Output: { package: "@biteme-bot/shared", functionName: "createOrderService" }
 *
 * Returns null if not a cross-package call.
 */
export function parseExternalCallee(calleeId: string): { package: string; functionName: string } | null {
  const slashIdx = calleeId.indexOf('/')
  if (slashIdx === -1) return null
  const afterRepo = calleeId.slice(slashIdx + 1)

  if (!afterRepo.includes(':')) return null
  if (afterRepo.startsWith('<')) return null

  const isScoped = afterRepo.startsWith('@')
  if (isScoped) {
    const slashParts = afterRepo.split('/')
    if (slashParts.length > 2) return null
  } else {
    if (afterRepo.includes('/')) return null
  }

  const lastColon = afterRepo.lastIndexOf(':')
  const packageName = afterRepo.slice(0, lastColon)
  const functionName = afterRepo.slice(lastColon + 1)

  if (!packageName || !functionName) return null

  return { package: packageName, functionName }
}

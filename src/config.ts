/**
 * config.ts
 *
 * 读取 ckg.config.json，提供项目配置。
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
  skipEdgeFunctions?: boolean  // true = edge functions 是副本，不是 source of truth
}

export interface ProjectConfig {
  project: string
  repos: RepoConfig[]
  ai?: AIConfig
}

const CONFIG_PATH = path.resolve(__dirname, '../ckg.config.json')

let _cache: ProjectConfig | null = null

export function loadConfig(): ProjectConfig {
  if (_cache) return _cache
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`找不到配置文件: ${CONFIG_PATH}\n请先创建 ckg.config.json`)
  }
  _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  return _cache!
}

/**
 * 根据 npm package name 找到对应的 repo name。
 * 例如 "@biteme-bot/shared" → "biteme-shared"
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
 * 从 Joern 生成的 callee_id 中解析出 package name 和 function name。
 *
 * 输入格式: "fn:bite-me-website/@biteme-bot/shared:createOrderService"
 * 输出: { package: "@biteme-bot/shared", functionName: "createOrderService" }
 *
 * 如果不是跨包调用，返回 null。
 */
export function parseExternalCallee(calleeId: string): { package: string; functionName: string } | null {
  // 去掉 "fn:repoName/" 前缀
  const slashIdx = calleeId.indexOf('/')
  if (slashIdx === -1) return null
  const afterRepo = calleeId.slice(slashIdx + 1)  // "@biteme-bot/shared:createOrderService"

  // 跳过非外部包的调用（本 repo 内的路径、<empty> 等）
  if (!afterRepo.includes(':')) return null
  if (afterRepo.startsWith('<')) return null

  // 本 repo 内的文件路径包含 / 或 .（如 "services/orderService.js::fn"）
  // 外部包要么以 @ 开头（scoped），要么不含 /（unscoped like "lodash:merge"）
  const isScoped = afterRepo.startsWith('@')
  if (isScoped) {
    // @scope/name:fn → split by / 应该只有 2 部分
    const slashParts = afterRepo.split('/')
    if (slashParts.length > 2) return null
  } else {
    // 非 scoped 且包含 / → 是本 repo 内的路径，不是外部包
    if (afterRepo.includes('/')) return null
  }

  // 用最后一个 : 分割 package 和 function name
  const lastColon = afterRepo.lastIndexOf(':')
  const packageName = afterRepo.slice(0, lastColon)
  const functionName = afterRepo.slice(lastColon + 1)

  if (!packageName || !functionName) return null

  return { package: packageName, functionName }
}

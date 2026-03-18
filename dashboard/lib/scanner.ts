/**
 * lib/scanner.ts — Repo 自动检测
 *
 * 扫描一个本地目录，判断：
 * - 语言（TypeScript / JavaScript / Python / Go / ...）
 * - 项目类型（frontend / backend / shared-lib / infra）
 * - 有哪些逻辑目录值得分析
 * - 有没有数据库代码，在哪
 */

import fs from 'fs'
import path from 'path'

export interface ScanResult {
  name: string           // repo 名（目录名）
  path: string           // 绝对路径
  language: string       // 主要语言
  type: string           // frontend / backend / shared-lib / infra / unknown
  src_dirs: string[]     // 推荐分析的目录
  exclude_dirs: string[] // 推荐排除的目录
  has_db_code: boolean   // 是否检测到数据库代码
  db_dirs: string[]      // 数据库代码所在目录
  file_count: number     // 代码文件总数
  warnings: string[]     // 扫描时的提示信息
}

// 数据库代码检测模式
const DB_DIR_PATTERNS = [
  'migrations', 'db/migrations', 'database/migrations',
  'supabase/migrations', 'supabase/functions',
  'prisma', 'drizzle',
  'db/seeds', 'seeds',
  'sql', 'db/sql',
]
const DB_FILE_PATTERNS = [
  'schema.prisma', 'drizzle.config.ts', 'drizzle.config.js',
  'knexfile.ts', 'knexfile.js',
]
const DB_EXTENSIONS = ['.sql']

// 逻辑目录（值得分析的）
const LOGIC_DIRS = [
  'services', 'service', 'logic', 'utils', 'util', 'helpers',
  'store', 'stores', 'hooks', 'contexts', 'context',
  'lib', 'api', 'controllers', 'middleware',
  'models', 'schemas', 'validators',
  'workers', 'jobs', 'queues',
]

// 排除目录（UI 组件、样式等）
const SKIP_DIRS = [
  'components', 'ui', 'pages', 'views',
  'styles', 'css', 'assets', 'public', 'static',
  '__tests__', '__test__', 'test', 'tests', 'spec',
  '.next', '.nuxt', 'dist', 'build', 'out',
  'node_modules', '.git', '.svn',
  'generated', 'gen', '__generated__',
]

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rb', '.rs']

export function scanRepo(repoPath: string): ScanResult {
  const absPath = path.resolve(repoPath)
  const name = path.basename(absPath)
  const warnings: string[] = []

  if (!fs.existsSync(absPath)) {
    return {
      name, path: absPath, language: 'unknown', type: 'unknown',
      src_dirs: [], exclude_dirs: [], has_db_code: false, db_dirs: [],
      file_count: 0, warnings: [`路径不存在: ${absPath}`],
    }
  }

  // 1. 检测语言
  const language = detectLanguage(absPath)

  // 2. 检测项目类型
  const type = detectType(absPath, language)

  // 3. 扫描目录结构
  const { srcDirs, excludeDirs, dbDirs, fileCount } = scanDirectories(absPath)

  // 4. 检测数据库代码
  const hasDbCode = dbDirs.length > 0 || hasDbFiles(absPath)

  if (hasDbCode) {
    warnings.push(`检测到数据库代码，将使用单独管线处理`)
  }

  if (fileCount === 0) {
    warnings.push(`未找到代码文件`)
  }

  if (srcDirs.length === 0 && fileCount > 0) {
    warnings.push(`未检测到标准逻辑目录，将扫描所有代码文件`)
  }

  return {
    name, path: absPath, language, type,
    src_dirs: srcDirs, exclude_dirs: excludeDirs,
    has_db_code: hasDbCode, db_dirs: dbDirs,
    file_count: fileCount, warnings,
  }
}

function detectLanguage(repoPath: string): string {
  const checks: [string, string][] = [
    ['tsconfig.json', 'typescript'],
    ['package.json', 'javascript'],  // 会被 tsconfig 覆盖
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['go.mod', 'go'],
    ['Cargo.toml', 'rust'],
    ['pom.xml', 'java'],
    ['build.gradle', 'java'],
    ['Gemfile', 'ruby'],
  ]

  let lang = 'unknown'
  for (const [file, language] of checks) {
    if (fs.existsSync(path.join(repoPath, file))) {
      lang = language
    }
  }

  // tsconfig 优先于 package.json
  if (fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
    lang = 'typescript'
  }

  return lang
}

function detectType(repoPath: string, language: string): string {
  // 检查 package.json 的依赖
  const pkgPath = path.join(repoPath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

      if (allDeps['next'] || allDeps['nuxt'] || allDeps['react'] || allDeps['vue'] || allDeps['svelte']) {
        return 'frontend'
      }
      if (allDeps['express'] || allDeps['fastify'] || allDeps['hono'] || allDeps['koa']) {
        return 'backend'
      }
    } catch {}
  }

  // 检查特定目录
  if (fs.existsSync(path.join(repoPath, 'supabase')) || fs.existsSync(path.join(repoPath, 'terraform'))) {
    return 'infra'
  }

  // 有 src 但没有框架依赖 → shared lib
  if (fs.existsSync(path.join(repoPath, 'src'))) {
    return 'shared-lib'
  }

  return 'unknown'
}

function scanDirectories(repoPath: string): {
  srcDirs: string[]
  excludeDirs: string[]
  dbDirs: string[]
  fileCount: number
} {
  const srcDirs: string[] = []
  const excludeDirs: string[] = []
  const dbDirs: string[] = []
  let fileCount = 0

  function walk(dir: string, depth: number) {
    if (depth > 4) return  // 不要递归太深
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue

        const fullPath = path.join(dir, entry.name)
        const relPath = path.relative(repoPath, fullPath)

        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue

          // 检查是否是 DB 目录
          if (DB_DIR_PATTERNS.some(p => relPath === p || relPath.endsWith('/' + p))) {
            dbDirs.push(relPath)
            continue
          }

          // 检查是否是逻辑目录
          if (LOGIC_DIRS.includes(entry.name.toLowerCase())) {
            srcDirs.push(relPath)
          }

          // 检查是否是应排除的目录
          if (SKIP_DIRS.includes(entry.name.toLowerCase())) {
            excludeDirs.push(relPath)
          }

          walk(fullPath, depth + 1)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (CODE_EXTENSIONS.includes(ext)) {
            fileCount++
          }
          if (DB_EXTENSIONS.includes(ext)) {
            // 如果 SQL 文件不在已知 DB 目录中，也标记
            const parentRel = path.relative(repoPath, dir)
            if (!dbDirs.includes(parentRel) && parentRel !== '.') {
              // 不重复添加
              if (!dbDirs.some(d => parentRel.startsWith(d))) {
                dbDirs.push(parentRel)
              }
            }
          }
        }
      }
    } catch {}
  }

  walk(repoPath, 0)
  return { srcDirs, excludeDirs, dbDirs, fileCount }
}

function hasDbFiles(repoPath: string): boolean {
  return DB_FILE_PATTERNS.some(f => {
    try {
      return fs.existsSync(path.join(repoPath, f))
    } catch { return false }
  })
}

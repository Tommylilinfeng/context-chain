/**
 * lib/db.ts — SQLite 项目元数据存储
 *
 * 存的是项目配置信息（项目名、repo 列表、端口分配等）。
 * 图谱数据在各自项目的 Memgraph 实例里，不在这里。
 */

import Database from 'better-sqlite3'
import path from 'path'
import crypto from 'crypto'

const DB_PATH = path.resolve(process.cwd(), '..', 'ckg-meta.db')
let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH)
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    initSchema(_db)
  }
  return _db
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      memgraph_port INTEGER NOT NULL,
      lab_port INTEGER NOT NULL,
      status TEXT DEFAULT 'stopped',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT DEFAULT 'unknown',
      language TEXT DEFAULT 'unknown',
      src_dirs TEXT DEFAULT '[]',
      exclude_dirs TEXT DEFAULT '[]',
      has_db_code INTEGER DEFAULT 0,
      db_dirs TEXT DEFAULT '[]',
      cpg_file TEXT,
      owner TEXT DEFAULT 'unknown',
      last_ingested_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

// ── 端口分配 ─────────────────────────────────────────
// Memgraph Bolt: 7687, 7688, 7689, ...
// Memgraph Lab:  3002, 3003, 3004, ...  (3001 留给 Dashboard)

function nextAvailablePorts(): { memgraph: number; lab: number } {
  const db = getDb()
  const row = db.prepare(
    `SELECT MAX(memgraph_port) as max_mg, MAX(lab_port) as max_lab FROM projects`
  ).get() as any

  const memgraph = (row?.max_mg ?? 7686) + 1
  const lab = (row?.max_lab ?? 3001) + 1  // 3001 是 Dashboard，第一个项目从 3002 开始
  return { memgraph, lab }
}

// ── Projects CRUD ────────────────────────────────────

export interface Project {
  id: string
  name: string
  description: string
  memgraph_port: number
  lab_port: number
  status: string
  created_at: string
  updated_at: string
}

export function listProjects(): Project[] {
  return getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[]
}

export function getProject(id: string): Project | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
}

export function createProject(name: string, description: string = ''): Project {
  const db = getDb()
  const id = crypto.randomUUID().slice(0, 8)
  const { memgraph, lab } = nextAvailablePorts()

  db.prepare(
    `INSERT INTO projects (id, name, description, memgraph_port, lab_port, status)
     VALUES (?, ?, ?, ?, ?, 'stopped')`
  ).run(id, name, description, memgraph, lab)

  return getProject(id)!
}

export function updateProjectStatus(id: string, status: string) {
  getDb().prepare(
    `UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, id)
}

export function updateProjectPorts(id: string, memgraphPort: number, labPort: number) {
  getDb().prepare(
    `UPDATE projects SET memgraph_port = ?, lab_port = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(memgraphPort, labPort, id)
}

export function deleteProject(id: string) {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

// ── Repos CRUD ───────────────────────────────────────

export interface Repo {
  id: string
  project_id: string
  name: string
  path: string
  type: string
  language: string
  src_dirs: string
  exclude_dirs: string
  has_db_code: number
  db_dirs: string
  cpg_file: string | null
  owner: string
  last_ingested_at: string | null
  created_at: string
}

export function listRepos(projectId: string): Repo[] {
  return getDb().prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY name').all(projectId) as Repo[]
}

export function getRepo(id: string): Repo | undefined {
  return getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id) as Repo | undefined
}

export function createRepo(projectId: string, data: {
  name: string
  path: string
  type: string
  language: string
  src_dirs: string[]
  exclude_dirs: string[]
  has_db_code: boolean
  db_dirs: string[]
  owner?: string
}): Repo {
  const db = getDb()
  const id = crypto.randomUUID().slice(0, 8)

  db.prepare(
    `INSERT INTO repos (id, project_id, name, path, type, language, src_dirs, exclude_dirs, has_db_code, db_dirs, owner)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, projectId, data.name, data.path, data.type, data.language,
    JSON.stringify(data.src_dirs), JSON.stringify(data.exclude_dirs),
    data.has_db_code ? 1 : 0, JSON.stringify(data.db_dirs),
    data.owner ?? 'unknown'
  )

  return getRepo(id)!
}

export function deleteRepo(id: string) {
  getDb().prepare('DELETE FROM repos WHERE id = ?').run(id)
}

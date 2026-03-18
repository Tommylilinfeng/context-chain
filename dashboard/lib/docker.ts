/**
 * lib/docker.ts — Docker Compose 生成与容器管理
 *
 * 每个项目生成独立的 docker-compose.yml，管理自己的 Memgraph 实例。
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import type { Project } from './db'

const PROJECTS_DIR = path.resolve(process.cwd(), '..', 'projects')

/** 获取项目的工作目录 */
export function getProjectDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId)
}

/** 生成 docker-compose.yml */
export function generateCompose(project: Project): string {
  const compose = `services:
  memgraph:
    image: memgraph/memgraph-mage
    container_name: ckg-${project.id}-memgraph
    ports:
      - "${project.memgraph_port}:7687"
      - "${project.memgraph_port + 1000}:7444"
    volumes:
      - memgraph-data:/var/lib/memgraph
      - memgraph-log:/var/log/memgraph
    environment:
      - MEMGRAPH_STORAGE_MODE=IN_MEMORY_TRANSACTIONAL
    restart: unless-stopped

  memgraph-lab:
    image: memgraph/lab
    container_name: ckg-${project.id}-lab
    ports:
      - "${project.lab_port}:3000"
    depends_on:
      - memgraph
    environment:
      - QUICK_CONNECT_MG_HOST=memgraph
      - QUICK_CONNECT_MG_PORT=7687
    restart: unless-stopped

volumes:
  memgraph-data:
  memgraph-log:
`
  return compose
}

/** 确保项目目录和 docker-compose.yml 存在 */
export function ensureProjectFiles(project: Project) {
  const projectDir = getProjectDir(project.id)
  const dataDir = path.join(projectDir, 'data')

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true })
  }
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  const composePath = path.join(projectDir, 'docker-compose.yml')
  fs.writeFileSync(composePath, generateCompose(project), 'utf-8')
}

/** 启动项目的 Memgraph 容器 */
export function startProject(project: Project): { success: boolean; message: string } {
  try {
    ensureProjectFiles(project)
    const projectDir = getProjectDir(project.id)

    execSync('docker compose up -d', {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    return { success: true, message: `Memgraph 已启动 (bolt://localhost:${project.memgraph_port})` }
  } catch (err: any) {
    return { success: false, message: err.stderr || err.message }
  }
}

/** 停止项目的 Memgraph 容器 */
export function stopProject(project: Project): { success: boolean; message: string } {
  try {
    const projectDir = getProjectDir(project.id)
    if (!fs.existsSync(path.join(projectDir, 'docker-compose.yml'))) {
      return { success: true, message: '没有运行中的容器' }
    }

    execSync('docker compose down', {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    return { success: true, message: 'Memgraph 已停止' }
  } catch (err: any) {
    return { success: false, message: err.stderr || err.message }
  }
}

/** 停止并清除数据 */
export function resetProject(project: Project): { success: boolean; message: string } {
  try {
    const projectDir = getProjectDir(project.id)
    if (fs.existsSync(path.join(projectDir, 'docker-compose.yml'))) {
      execSync('docker compose down -v', {
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    }
    return { success: true, message: 'Memgraph 已停止并清除数据' }
  } catch (err: any) {
    return { success: false, message: err.stderr || err.message }
  }
}

/** 检查容器是否运行中 */
export function isProjectRunning(project: Project): boolean {
  try {
    const output = execSync(
      `docker ps --filter "name=ckg-${project.id}-memgraph" --format "{{.Status}}"`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
    return output.length > 0 && output.includes('Up')
  } catch {
    return false
  }
}

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'

export async function GET(req: NextRequest) {
  const dirPath = req.nextUrl.searchParams.get('path') || os.homedir()

  try {
    const absPath = path.resolve(dirPath)

    if (!fs.existsSync(absPath)) {
      return NextResponse.json({ error: '路径不存在' }, { status: 404 })
    }

    const stat = fs.statSync(absPath)
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: '不是目录' }, { status: 400 })
    }

    const entries = fs.readdirSync(absPath, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => ({
        name: e.name,
        path: path.join(absPath, e.name),
        hasChildren: hasSubdirs(path.join(absPath, e.name)),
        isRepo: isLikelyRepo(path.join(absPath, e.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const parent = path.dirname(absPath)

    return NextResponse.json({
      current: absPath,
      parent: parent !== absPath ? parent : null,
      dirs,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

function hasSubdirs(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries.some(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
  } catch {
    return false
  }
}

function isLikelyRepo(dirPath: string): boolean {
  const markers = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', '.git']
  return markers.some(m => fs.existsSync(path.join(dirPath, m)))
}

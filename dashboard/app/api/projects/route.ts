import { NextRequest, NextResponse } from 'next/server'
import { listProjects, createProject } from '@/lib/db'
import { isProjectRunning } from '@/lib/docker'

export async function GET() {
  const projects = listProjects()

  // 检查每个项目的实际运行状态
  const withStatus = projects.map(p => ({
    ...p,
    status: isProjectRunning(p) ? 'running' : 'stopped',
  }))

  return NextResponse.json(withStatus)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, description } = body

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: '项目名称不能为空' }, { status: 400 })
  }

  const project = createProject(name.trim(), description?.trim() ?? '')
  return NextResponse.json(project, { status: 201 })
}

import { NextRequest, NextResponse } from 'next/server'
import { getProject, deleteProject, updateProjectStatus, listRepos } from '@/lib/db'
import { startProject, stopProject, resetProject, isProjectRunning } from '@/lib/docker'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const project = getProject(id)
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 })
  }

  const repos = listRepos(id)
  const running = isProjectRunning(project)

  return NextResponse.json({
    ...project,
    status: running ? 'running' : 'stopped',
    repos: repos.map(r => ({
      ...r,
      src_dirs: JSON.parse(r.src_dirs),
      exclude_dirs: JSON.parse(r.exclude_dirs),
      db_dirs: JSON.parse(r.db_dirs),
    })),
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const project = getProject(id)
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 })
  }

  const body = await req.json()
  const { action } = body

  switch (action) {
    case 'start': {
      const result = startProject(project)
      if (result.success) updateProjectStatus(id, 'running')
      return NextResponse.json(result)
    }
    case 'stop': {
      const result = stopProject(project)
      if (result.success) updateProjectStatus(id, 'stopped')
      return NextResponse.json(result)
    }
    case 'reset': {
      const result = resetProject(project)
      if (result.success) updateProjectStatus(id, 'stopped')
      return NextResponse.json(result)
    }
    default:
      return NextResponse.json({ error: `未知操作: ${action}` }, { status: 400 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const project = getProject(id)
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 })
  }

  // 先停容器
  stopProject(project)
  // 再删数据库记录
  deleteProject(id)

  return NextResponse.json({ status: 'deleted' })
}

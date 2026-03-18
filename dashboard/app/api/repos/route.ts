import { NextRequest, NextResponse } from 'next/server'
import { getProject, listRepos, createRepo } from '@/lib/db'

/** 添加 repo 到项目 */
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { project_id, repos } = body

  if (!project_id || !repos || !Array.isArray(repos)) {
    return NextResponse.json({ error: 'project_id 和 repos 是必填项' }, { status: 400 })
  }

  const project = getProject(project_id)
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 })
  }

  const created = []
  for (const r of repos) {
    const repo = createRepo(project_id, {
      name: r.name,
      path: r.path,
      type: r.type ?? 'unknown',
      language: r.language ?? 'unknown',
      src_dirs: r.src_dirs ?? [],
      exclude_dirs: r.exclude_dirs ?? [],
      has_db_code: r.has_db_code ?? false,
      db_dirs: r.db_dirs ?? [],
      owner: r.owner ?? 'unknown',
    })
    created.push(repo)
  }

  return NextResponse.json({ created: created.length, repos: created }, { status: 201 })
}

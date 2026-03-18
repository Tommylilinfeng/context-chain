import { NextRequest, NextResponse } from 'next/server'
import { scanRepo } from '@/lib/scanner'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { path: repoPath } = body

  if (!repoPath || typeof repoPath !== 'string') {
    return NextResponse.json({ error: '请提供 repo 路径' }, { status: 400 })
  }

  const result = scanRepo(repoPath.trim())
  return NextResponse.json(result)
}

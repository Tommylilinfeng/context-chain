import { NextRequest, NextResponse } from 'next/server'
import { getProject } from '@/lib/db'
import { getProjectSession, num } from '@/lib/memgraph'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const project = getProject(id)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const q = req.nextUrl.searchParams.get('q') || ''
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '50')

  let session
  try {
    session = await getProjectSession(project.memgraph_port)

    let result
    if (q) {
      result = await session.run(
        `MATCH (d:DecisionContext)
         WHERE d.summary CONTAINS $q OR d.content CONTAINS $q
         RETURN d ORDER BY d.created_at DESC LIMIT ${limit}`,
        { q }
      )
    } else {
      result = await session.run(
        `MATCH (d:DecisionContext) RETURN d ORDER BY d.created_at DESC LIMIT ${limit}`
      )
    }

    const decisions = []
    for (const r of result.records) {
      const d = r.get('d').properties
      const anchorResult = await session.run(
        `MATCH (d:DecisionContext {id: $id})-[:ANCHORED_TO]->(ce:CodeEntity) RETURN ce.name AS name`,
        { id: d.id }
      )
      decisions.push({
        id: d.id,
        summary: d.summary,
        content: d.content,
        keywords: d.keywords,
        source: d.source,
        confidence: d.confidence,
        owner: d.owner,
        scope: d.scope,
        created_at: d.created_at,
        anchors: anchorResult.records.map(ar => ar.get('name')),
      })
    }

    return NextResponse.json(decisions)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  } finally {
    await session?.close()
  }
}

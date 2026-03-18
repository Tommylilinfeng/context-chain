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

  let session
  try {
    session = await getProjectSession(project.memgraph_port)

    const [entities, decisions, edges, anchored] = await Promise.all([
      session.run(`MATCH (n:CodeEntity) RETURN n.entity_type AS type, count(n) AS count ORDER BY count DESC`),
      session.run(`MATCH (d:DecisionContext) RETURN count(d) AS total,
        sum(CASE WHEN d.confidence = 'auto_generated' THEN 1 ELSE 0 END) AS auto,
        sum(CASE WHEN d.source = 'manual_business_context' THEN 1 ELSE 0 END) AS biz`),
      session.run(`MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC`),
      session.run(`MATCH (d:DecisionContext)-[:ANCHORED_TO]->(ce:CodeEntity) RETURN count(DISTINCT d) AS anchored`),
    ])

    const d = decisions.records[0]
    return NextResponse.json({
      entities: entities.records.map(r => ({ type: r.get('type'), count: num(r.get('count')) })),
      edges: edges.records.map(r => ({ type: r.get('type'), count: num(r.get('count')) })),
      decisions: {
        total: num(d?.get('total')),
        auto: num(d?.get('auto')),
        business: num(d?.get('biz')),
        anchored: num(anchored.records[0]?.get('anchored')),
      },
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  } finally {
    await session?.close()
  }
}

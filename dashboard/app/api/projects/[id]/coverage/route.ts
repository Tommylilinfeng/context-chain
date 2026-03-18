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

  const repo = req.nextUrl.searchParams.get('repo') || ''

  let session
  try {
    session = await getProjectSession(project.memgraph_port)

    // Get repos list
    const repoResult = await session.run(
      `MATCH (svc:CodeEntity {entity_type: 'service'})
       OPTIONAL MATCH (svc)-[:CONTAINS]->(child:CodeEntity)
       RETURN svc.name AS repo, count(child) AS entity_count ORDER BY repo`
    )
    const repos = repoResult.records.map(r => ({
      repo: r.get('repo'),
      entities: num(r.get('entity_count')),
    }))

    // Get file coverage for selected repo
    const targetRepo = repo || repos[0]?.repo || ''
    let files: any[] = []
    if (targetRepo) {
      const fileResult = await session.run(
        `MATCH (f:CodeEntity {repo: $repo, entity_type: 'file'})
         OPTIONAL MATCH (d:DecisionContext)-[:ANCHORED_TO]->(f)
         RETURN f.name AS name, f.path AS path, count(d) AS decisions
         ORDER BY decisions DESC, f.name`,
        { repo: targetRepo }
      )
      files = fileResult.records.map(r => ({
        name: r.get('name'),
        path: r.get('path'),
        decisions: num(r.get('decisions')),
      }))
    }

    return NextResponse.json({ repos, files, selectedRepo: targetRepo })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  } finally {
    await session?.close()
  }
}

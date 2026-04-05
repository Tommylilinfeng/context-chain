/**
 * Quick test: Louvain with/without hub removal + zero-edge analysis
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { toNum } from '../ingestion/shared'

const repo = process.argv.find((_, i, a) => a[i - 1] === '--repo') || 'claudecode'

async function main() {
  await verifyConnectivity()
  const session = await getSession()

  try {
    // ── Total ──
    const totalRes = await session.run(
      `MATCH (f:CodeEntity {entity_type: 'function', repo: $repo}) WHERE f.name <> ':program' RETURN count(f) AS cnt`,
      { repo },
    )
    const total = toNum(totalRes.records[0]?.get('cnt'))
    console.log(`Total functions (excl :program): ${total}`)

    // ── Zero-edge analysis ──
    console.log(`\n━━━ Zero-Edge Analysis ━━━`)

    // Functions with NO outgoing CALLS and NO incoming CALLS
    const zeroRes = await session.run(
      `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
       WHERE fn.name <> ':program'
       OPTIONAL MATCH (fn)-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
       OPTIONAL MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(fn)
       WITH fn, count(DISTINCT callee) AS outDeg, count(DISTINCT caller) AS inDeg
       WITH fn, outDeg, inDeg, outDeg + inDeg AS totalDeg
       RETURN
        count(CASE WHEN totalDeg = 0 THEN 1 END) AS zeroBoth,
        count(CASE WHEN outDeg = 0 AND inDeg > 0 THEN 1 END) AS zeroOut,
        count(CASE WHEN inDeg = 0 AND outDeg > 0 THEN 1 END) AS zeroIn,
        count(CASE WHEN totalDeg > 0 THEN 1 END) AS hasEdges`,
      { repo },
    )
    const zeroBoth = toNum(zeroRes.records[0]?.get('zeroBoth'))
    const zeroOut = toNum(zeroRes.records[0]?.get('zeroOut'))
    const zeroIn = toNum(zeroRes.records[0]?.get('zeroIn'))
    const hasEdges = toNum(zeroRes.records[0]?.get('hasEdges'))

    console.log(`  No calls at all (in=0, out=0): ${zeroBoth}`)
    console.log(`  Only called, never calls (in>0, out=0): ${zeroOut}`)
    console.log(`  Only calls, never called (in=0, out>0): ${zeroIn}`)
    console.log(`  Has both in+out edges: ${hasEdges - zeroOut - zeroIn}`)
    console.log(`  Has any edge: ${hasEdges}`)

    // What are these zero-edge functions? Sample them
    const zeroSampleRes = await session.run(
      `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function', repo: $repo})
       WHERE fn.name <> ':program'
       OPTIONAL MATCH (fn)-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
       OPTIONAL MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(fn)
       WITH fn, f.path AS filePath, count(DISTINCT callee) AS outDeg, count(DISTINCT caller) AS inDeg
       WHERE outDeg = 0 AND inDeg = 0
       WITH fn.name AS name, filePath,
            CASE WHEN fn.line_end IS NOT NULL AND fn.line_start IS NOT NULL
                 THEN fn.line_end - fn.line_start ELSE 0 END AS lineCount
       ORDER BY lineCount DESC
       RETURN name, filePath, lineCount
       LIMIT 30`,
      { repo },
    )
    console.log(`\n  Top 30 zero-edge functions (by size):`)
    for (const r of zeroSampleRes.records) {
      console.log(`    ${r.get('name')} (${r.get('lineCount')} lines) — ${r.get('filePath')}`)
    }

    // Size distribution of zero-edge functions
    const zeroDist = await session.run(
      `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
       WHERE fn.name <> ':program'
       OPTIONAL MATCH (fn)-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
       OPTIONAL MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(fn)
       WITH fn, count(DISTINCT callee) AS outDeg, count(DISTINCT caller) AS inDeg
       WHERE outDeg = 0 AND inDeg = 0
       WITH CASE
         WHEN fn.line_end - fn.line_start <= 3 THEN '1-3 lines'
         WHEN fn.line_end - fn.line_start <= 10 THEN '4-10 lines'
         WHEN fn.line_end - fn.line_start <= 30 THEN '11-30 lines'
         WHEN fn.line_end - fn.line_start <= 100 THEN '31-100 lines'
         ELSE '100+ lines'
       END AS sizeGroup, count(*) AS cnt
       RETURN sizeGroup, cnt ORDER BY cnt DESC`,
      { repo },
    )
    console.log(`\n  Zero-edge function size distribution:`)
    for (const r of zeroDist.records) {
      console.log(`    ${r.get('sizeGroup')}: ${toNum(r.get('cnt'))}`)
    }

    // ── Louvain WITHOUT hub removal ──
    console.log(`\n━━━ Louvain WITHOUT hub removal ━━━`)
    const noHubRes = await session.run(
      `MATCH (a:CodeEntity {entity_type: 'function', repo: $repo})-[r:CALLS]->(b:CodeEntity {entity_type: 'function', repo: $repo})
       WHERE a.name <> ':program' AND b.name <> ':program'
       WITH collect(DISTINCT a) + collect(DISTINCT b) AS nodes, collect(r) AS rels

       CALL community_detection.get_subgraph(nodes, rels)
       YIELD node, community_id
       RETURN community_id, count(node) AS size
       ORDER BY size DESC`,
      { repo },
    )

    const noHubComms: { id: number; size: number }[] = []
    for (const r of noHubRes.records) {
      noHubComms.push({ id: toNum(r.get('community_id')), size: toNum(r.get('size')) })
    }
    const noHubTotal = noHubComms.reduce((s, c) => s + c.size, 0)
    const noHubBig = noHubComms.filter(c => c.size >= 10)
    const noHubMed = noHubComms.filter(c => c.size >= 3 && c.size < 10)
    const noHubSmall = noHubComms.filter(c => c.size < 3)

    console.log(`Nodes in subgraph: ${noHubTotal}`)
    console.log(`Not in subgraph (no CALLS edges): ${total - noHubTotal}`)
    console.log(`Communities >= 10: ${noHubBig.length} (${noHubBig.reduce((s, c) => s + c.size, 0)} fns)`)
    console.log(`Communities 3-9: ${noHubMed.length} (${noHubMed.reduce((s, c) => s + c.size, 0)} fns)`)
    console.log(`Communities < 3: ${noHubSmall.length} (${noHubSmall.reduce((s, c) => s + c.size, 0)} fns)`)

    console.log(`\nTop 30 communities:`)
    for (const c of noHubBig.slice(0, 30)) {
      console.log(`  C${c.id}: ${c.size} functions`)
    }

    // ── Louvain WITH hub removal (for comparison) ──
    console.log(`\n━━━ Louvain WITH hub removal (threshold=26) ━━━`)
    const hubRes = await session.run(
      `MATCH (hub:CodeEntity {entity_type: 'function', repo: $repo})<-[:CALLS]-(caller:CodeEntity {entity_type: 'function', repo: $repo})
       WHERE hub.name <> ':program'
       WITH hub, count(DISTINCT caller) AS inDeg
       WITH collect(CASE WHEN inDeg > 26 THEN hub END) AS hubNodes

       MATCH (a:CodeEntity {entity_type: 'function', repo: $repo})-[r:CALLS]->(b:CodeEntity {entity_type: 'function', repo: $repo})
       WHERE a.name <> ':program' AND b.name <> ':program'
         AND NOT a IN hubNodes AND NOT b IN hubNodes
       WITH collect(DISTINCT a) + collect(DISTINCT b) AS nodes, collect(r) AS rels

       CALL community_detection.get_subgraph(nodes, rels)
       YIELD node, community_id
       RETURN community_id, count(node) AS size
       ORDER BY size DESC`,
      { repo },
    )

    const hubComms: { id: number; size: number }[] = []
    for (const r of hubRes.records) {
      hubComms.push({ id: toNum(r.get('community_id')), size: toNum(r.get('size')) })
    }
    const hubTotal = hubComms.reduce((s, c) => s + c.size, 0)
    const hubBig = hubComms.filter(c => c.size >= 10)

    console.log(`Nodes in subgraph: ${hubTotal}`)
    console.log(`Communities >= 10: ${hubBig.length} (${hubBig.reduce((s, c) => s + c.size, 0)} fns)`)

    // ── Summary ──
    console.log(`\n━━━ Comparison ━━━`)
    console.log(`                        No Hub    Hub=26`)
    console.log(`  In subgraph:          ${noHubTotal.toString().padStart(6)}    ${hubTotal.toString().padStart(6)}`)
    console.log(`  Communities >= 10:    ${noHubBig.length.toString().padStart(6)}    ${hubBig.length.toString().padStart(6)}`)
    console.log(`  Fns in >= 10:         ${noHubBig.reduce((s, c) => s + c.size, 0).toString().padStart(6)}    ${hubBig.reduce((s, c) => s + c.size, 0).toString().padStart(6)}`)
    console.log(`  Largest community:    ${noHubBig[0]?.size.toString().padStart(6)}    ${hubBig[0]?.size.toString().padStart(6)}`)
    console.log(`  Zero-edge functions:  ${zeroBoth.toString().padStart(6)}`)
    console.log(`\n  Effective coverage (excl zero-edge ${zeroBoth}):`)
    const effectiveTotal = total - zeroBoth
    console.log(`    No Hub: ${noHubBig.reduce((s, c) => s + c.size, 0)}/${effectiveTotal} = ${(noHubBig.reduce((s, c) => s + c.size, 0) / effectiveTotal * 100).toFixed(1)}%`)
    console.log(`    Hub=26: ${hubBig.reduce((s, c) => s + c.size, 0)}/${effectiveTotal} = ${(hubBig.reduce((s, c) => s + c.size, 0) / effectiveTotal * 100).toFixed(1)}%`)

  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1) })

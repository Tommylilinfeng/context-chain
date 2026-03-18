/**
 * lib/memgraph.ts — Connect to a project's Memgraph instance
 */

import neo4j, { Session } from 'neo4j-driver'

export async function getProjectSession(port: number): Promise<Session> {
  const driver = neo4j.driver(
    `bolt://localhost:${port}`,
    neo4j.auth.basic('', ''),
    { maxConnectionPoolSize: 5, connectionAcquisitionTimeout: 5000 }
  )
  return driver.session({ database: 'memgraph' })
}

export function num(val: any): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'number') return val
  if (typeof val?.toNumber === 'function') return val.toNumber()
  return parseInt(String(val)) || 0
}

import neo4j, { Driver, Session } from 'neo4j-driver'

// Memgraph 兼容 Neo4j 的 Bolt 协议，直接用 neo4j-driver
const driver: Driver = neo4j.driver(
  'bolt://localhost:7687',
  neo4j.auth.basic('', ''), // Memgraph 默认无需鉴权
  {
    maxConnectionPoolSize: 10,
    connectionAcquisitionTimeout: 5000,
  }
)

export async function getSession(): Promise<Session> {
  return driver.session({ database: 'memgraph' })
}

export async function verifyConnectivity(): Promise<void> {
  await driver.verifyConnectivity()
  console.log('✅ Memgraph 连接成功')
}

export async function closeDriver(): Promise<void> {
  await driver.close()
}

export default driver

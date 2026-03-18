import neo4j, { Driver, Session } from 'neo4j-driver'

// 支持通过环境变量指定端口（多项目场景下每个项目有自己的 Memgraph 实例）
const port = process.env.CKG_MEMGRAPH_PORT || '7687'
const uri = `bolt://localhost:${port}`

const driver: Driver = neo4j.driver(
  uri,
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
  console.log(`✅ Memgraph 连接成功 (${uri})`)
}

export async function closeDriver(): Promise<void> {
  await driver.close()
}

export default driver

import neo4j, { Driver, Session } from 'neo4j-driver'

// Lazy-init: driver created on first use so config can be loaded first
let _driver: Driver | null = null
let _uri = ''

function getDriver(): Driver {
  if (!_driver) {
    // Try to read config (may not exist yet during initial setup)
    let configHost: string | undefined
    let configPort: number | undefined
    try {
      const { loadConfig } = require('../config')
      const config = loadConfig()
      configHost = config.memgraph?.host
      configPort = config.memgraph?.port
    } catch {}

    // Env vars override config, config overrides defaults
    const host = process.env.CKG_MEMGRAPH_HOST || configHost || 'localhost'
    const port = process.env.CKG_MEMGRAPH_PORT || String(configPort || 7687)
    _uri = process.env.CKG_MEMGRAPH_URI || `bolt://${host}:${port}`

    _driver = neo4j.driver(
      _uri,
      neo4j.auth.basic('', ''), // Memgraph 默认无需鉴权
      {
        maxConnectionPoolSize: 10,
        connectionAcquisitionTimeout: 5000,
      }
    )
  }
  return _driver
}

export async function getSession(): Promise<Session> {
  return getDriver().session({ database: 'memgraph' })
}

export async function verifyConnectivity(): Promise<void> {
  const driver = getDriver()
  await driver.verifyConnectivity()
  process.stderr.write(`✅ Memgraph 连接成功 (${_uri})\n`)
}

export async function closeDriver(): Promise<void> {
  if (_driver) await _driver.close()
}

export default { getSession, verifyConnectivity, closeDriver }

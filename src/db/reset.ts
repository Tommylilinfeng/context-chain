/**
 * 重置脚本 - 清空所有节点和边
 * 运行：npm run db:reset
 * 警告：会删除所有数据！
 */
import { getSession, verifyConnectivity, closeDriver } from './client'

async function reset(): Promise<void> {
  await verifyConnectivity()
  const session = await getSession()
  try {
    await session.run('MATCH (n) DETACH DELETE n')
    console.log('✅ 图谱已清空')
  } finally {
    await session.close()
    await closeDriver()
  }
}

reset().catch((err) => {
  console.error('Reset 失败:', err)
  process.exit(1)
})

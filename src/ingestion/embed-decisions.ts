/**
 * ingestion/embed-decisions.ts
 *
 * 批量为 DecisionContext 生成 embedding 并存入本地向量存储。
 * 增量模式：只为没有 embedding 的新决策生成。
 *
 * 运行：npm run embed:decisions
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createEmbeddingProvider, EmbeddingConfig } from '../ai/embeddings'
import { LocalVectorStore } from '../ai/vector-store'

async function main() {
  const config = loadConfig()
  const embeddingConfig = config.ai?.embedding
  if (!embeddingConfig) {
    console.error('❌ 未配置 embedding provider。请在 ckg.config.json 的 ai.embedding 中配置。')
    console.error('示例:')
    console.error('  "ai": { "embedding": { "provider": "voyage", "apiKey": "pa-..." } }')
    process.exit(1)
  }

  const provider = createEmbeddingProvider(embeddingConfig as EmbeddingConfig)
  const store = new LocalVectorStore()
  await store.load()

  await verifyConnectivity()
  const session = await getSession()

  try {
    // 1. 读取所有 active 决策
    const result = await session.run(
      `MATCH (d:DecisionContext)
       WHERE d.staleness = 'active'
       RETURN d.id AS id, d.summary AS summary, d.content AS content`
    )

    const allDecisions = result.records.map(r => ({
      id: r.get('id') as string,
      summary: r.get('summary') as string,
      content: r.get('content') as string,
    }))

    console.log(`📊 共 ${allDecisions.length} 条 active 决策`)

    // 2. 过滤出没有 embedding 的决策
    const needEmbed = allDecisions.filter(d => !store.has(d.id))
    console.log(`🆕 需要生成 embedding: ${needEmbed.length} 条`)

    // 3. 清理已删除的决策
    const validIds = new Set(allDecisions.map(d => d.id))
    const pruned = store.prune(validIds)
    if (pruned > 0) console.log(`🗑️  清理过期向量: ${pruned} 条`)

    if (needEmbed.length === 0) {
      console.log('✅ 所有决策已有 embedding，无需更新。')
      await store.save()
      return
    }

    // 4. 生成 embedding（批量）
    const BATCH = 32
    let processed = 0

    for (let i = 0; i < needEmbed.length; i += BATCH) {
      const batch = needEmbed.slice(i, i + BATCH)
      const texts = batch.map(d => `${d.summary}\n${d.content}`)

      console.log(`  ⏳ Embedding batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(needEmbed.length / BATCH)} (${batch.length} 条)...`)

      const embeddings = await provider.embed(texts, 'document')

      for (let j = 0; j < batch.length; j++) {
        store.index(batch[j].id, embeddings[j])
      }

      processed += batch.length
    }

    // 5. 保存
    await store.save()
    console.log(`\n✅ 完成: ${processed} 条新 embedding，共 ${store.size} 条`)

  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch(err => {
  console.error('❌ Embedding 生成失败:', err.message)
  process.exit(1)
})

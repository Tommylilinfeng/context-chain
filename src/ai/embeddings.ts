/**
 * ai/embeddings.ts
 *
 * Embedding provider 接口 + Voyage AI 实现。
 * 用于语义向量搜索（槽位 5）。
 */

export interface EmbeddingProvider {
  name: string
  dimensions: number
  embed(texts: string[], inputType?: 'document' | 'query'): Promise<number[][]>
}

export interface EmbeddingConfig {
  provider: 'voyage'
  apiKey?: string   // 或 env VOYAGE_API_KEY
  model?: string    // 默认 voyage-3-lite
}

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const DEFAULT_MODEL = 'voyage-3-lite'
const MAX_BATCH = 128  // Voyage API 单次最大输入数

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  name = 'voyage'
  dimensions = 1024
  private apiKey: string
  private model: string

  constructor(config: EmbeddingConfig) {
    const key = config.apiKey ?? process.env.VOYAGE_API_KEY
    if (!key) {
      throw new Error(
        'Voyage API key 未设置。在 ckg.config.json 的 ai.embedding.apiKey 里填，或设置环境变量 VOYAGE_API_KEY'
      )
    }
    this.apiKey = key
    this.model = config.model ?? DEFAULT_MODEL
  }

  async embed(texts: string[], inputType: 'document' | 'query' = 'document'): Promise<number[][]> {
    const allEmbeddings: number[][] = []

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH)
      const response = await fetch(VOYAGE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          input_type: inputType,
        }),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Voyage API ${response.status}: ${body}`)
      }

      const data = await response.json() as {
        data: { embedding: number[] }[]
      }

      allEmbeddings.push(...data.data.map(d => d.embedding))
    }

    return allEmbeddings
  }
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'voyage':
      return new VoyageEmbeddingProvider(config)
    default:
      throw new Error(`未知的 embedding provider: ${(config as any).provider}`)
  }
}

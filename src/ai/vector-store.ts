/**
 * ai/vector-store.ts
 *
 * 本地 JSON 向量存储 + 内存余弦相似度搜索。
 * 决策数量 <5000 条，向量维度 1024，内存占用 ~20MB，完全可行。
 */

import fs from 'fs'
import path from 'path'

export interface VectorEntry {
  id: string
  embedding: number[]
}

export interface SearchResult {
  id: string
  score: number
}

export class LocalVectorStore {
  private vectors: Map<string, number[]> = new Map()
  private storePath: string
  private dirty = false

  constructor(storePath?: string) {
    this.storePath = storePath ?? path.resolve(__dirname, '../../data/vectors.json')
  }

  async load(): Promise<void> {
    if (!fs.existsSync(this.storePath)) {
      this.vectors = new Map()
      return
    }
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8')
      const entries: VectorEntry[] = JSON.parse(raw)
      this.vectors = new Map(entries.map(e => [e.id, e.embedding]))
    } catch {
      this.vectors = new Map()
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    const dir = path.dirname(this.storePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const entries: VectorEntry[] = [...this.vectors.entries()].map(([id, embedding]) => ({
      id,
      embedding,
    }))
    fs.writeFileSync(this.storePath, JSON.stringify(entries))
    this.dirty = false
  }

  index(id: string, embedding: number[]): void {
    this.vectors.set(id, embedding)
    this.dirty = true
  }

  has(id: string): boolean {
    return this.vectors.has(id)
  }

  get size(): number {
    return this.vectors.size
  }

  /** 获取所有已索引的 ID */
  get indexedIds(): string[] {
    return [...this.vectors.keys()]
  }

  /** 删除不再存在的决策的向量 */
  prune(validIds: Set<string>): number {
    let removed = 0
    for (const id of this.vectors.keys()) {
      if (!validIds.has(id)) {
        this.vectors.delete(id)
        this.dirty = true
        removed++
      }
    }
    return removed
  }

  search(queryEmbedding: number[], topK: number = 5): SearchResult[] {
    if (this.vectors.size === 0) return []

    const results: SearchResult[] = []

    for (const [id, embedding] of this.vectors) {
      const score = cosineSimilarity(queryEmbedding, embedding)
      results.push({ id, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

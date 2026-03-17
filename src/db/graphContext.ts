/**
 * graphContext.ts
 *
 * 从 Memgraph 查询文件的调用关系，作为辅助上下文喂给 LLM。
 * 这是可选的——查不到不影响任何流程，只是 prompt 少一些背景。
 *
 * 所有摄入管线（cold-start、git-ai、手动录入等）都可以引用这个模块。
 */

import { getSession } from './client'

export interface GraphContext {
  functions: string[]   // 文件里有哪些函数
  calledBy: string[]    // 谁调用了这个文件里的函数（上游）
  calls: string[]       // 这个文件调用了谁（下游）
}

/**
 * 查某个文件的图谱上下文。
 * @param fileName 文件名，如 "orderService.js"（图谱里的 CodeEntity name 字段）
 * @returns GraphContext，或 null（找不到 / 查询失败时）
 */
export async function queryGraphContext(fileName: string): Promise<GraphContext | null> {
  try {
    const session = await getSession()
    try {
      // 文件里的函数列表
      const fnResult = await session.run(
        `MATCH (f:CodeEntity {entity_type: 'file', name: $name})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
         RETURN fn.name AS name LIMIT 20`,
        { name: fileName }
      )

      if (fnResult.records.length === 0) return null  // 图谱里没有这个文件

      // 上游：谁调用了这个文件里的函数
      const callerResult = await session.run(
        `MATCH (f:CodeEntity {entity_type: 'file', name: $name})-[:CONTAINS]->(fn:CodeEntity)
         MATCH (caller:CodeEntity)-[:CALLS]->(fn)
         WHERE NOT (caller)<-[:CONTAINS]-(f)
         RETURN DISTINCT caller.name AS name LIMIT 15`,
        { name: fileName }
      )

      // 下游：这个文件调用了谁
      const calleeResult = await session.run(
        `MATCH (f:CodeEntity {entity_type: 'file', name: $name})-[:CONTAINS]->(fn:CodeEntity)
         MATCH (fn)-[:CALLS]->(callee:CodeEntity)
         WHERE NOT (callee)<-[:CONTAINS]-(f)
         RETURN DISTINCT callee.name AS name LIMIT 15`,
        { name: fileName }
      )

      return {
        functions: fnResult.records.map(r => r.get('name') as string),
        calledBy:  callerResult.records.map(r => r.get('name') as string),
        calls:     calleeResult.records.map(r => r.get('name') as string),
      }
    } finally {
      await session.close()
    }
  } catch {
    return null  // 静默失败，不影响主流程
  }
}

/**
 * 把 GraphContext 格式化成 prompt 里的一段文字。
 * 返回空字符串表示没有上下文。
 */
export function formatGraphContext(graph: GraphContext | null): string {
  if (!graph) return ''
  return `
## Code Graph Context (from static analysis — optional hint only)
Functions in this file: ${graph.functions.join(', ') || 'none'}
Called by (upstream callers): ${graph.calledBy.join(', ') || 'none detected'}
Calls into (downstream): ${graph.calls.join(', ') || 'none detected'}
`
}

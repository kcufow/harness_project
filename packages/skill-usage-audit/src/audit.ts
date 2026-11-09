/**
 * 报告编排：列会话 → 读事件 → 聚合 → 渲染。
 *
 * 与数据源解耦（{@link SessionSource}），所以 `ctx.sessionQuery` 路线和 jsonl 文件路线
 * 走同一套统计逻辑，单测可以直接塞内存数据源。
 *
 * @module skill-usage-audit/audit
 */
import { aggregate, formatReport, type AggregateResult } from './report.js'
import type { LoadedSession, SessionSource } from './types.js'

/** 生成报告的全部参数。 */
export interface GenerateOptions {
  /** 统计最近 N 天。 */
  days: number
  source: SessionSource
  skillPrefix?: string
  includeSessions?: boolean
  /** 最多读取多少个会话（按创建时间倒序），默认 200。 */
  maxSessions?: number
  dispatcherTools?: readonly string[]
  includeGenericTools?: boolean
  knownSkills?: readonly string[]
  maxRows?: number
  /** 取消信号；中止后返回已统计到的部分。 */
  signal?: AbortSignal
  now?: number
}

/** 生成结果：文本报告 + 结构化统计（便于二次消费/测试断言）。 */
export interface GenerateOutcome {
  report: string
  result: AggregateResult
}

/** 一天毫秒数。 */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 生成技能使用报告。
 * @param options - 数据源与统计参数。
 * @returns 报告文本与聚合结果。
 */
export async function generateUsageReport(options: GenerateOptions): Promise<GenerateOutcome> {
  const now = options.now ?? Date.now()
  const since = now - Math.max(1, options.days) * DAY_MS
  const maxSessions = Math.max(1, options.maxSessions ?? 200)

  const metas = (await options.source.list())
    .filter((meta) => typeof meta.id === 'string' && meta.id.length > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, maxSessions)

  const sessions: LoadedSession[] = []
  let failedSessions = 0

  for (const meta of metas) {
    if (options.signal?.aborted) break
    try {
      const events = await options.source.read(meta.id)
      sessions.push({ id: meta.id, events })
    } catch {
      failedSessions++
    }
  }

  const result = aggregate(sessions, {
    since,
    ...(options.skillPrefix !== undefined ? { skillPrefix: options.skillPrefix } : {}),
    ...(options.includeSessions !== undefined ? { includeSessions: options.includeSessions } : {}),
    ...(options.dispatcherTools !== undefined ? { dispatcherTools: options.dispatcherTools } : {}),
    ...(options.includeGenericTools !== undefined
      ? { includeGenericTools: options.includeGenericTools }
      : {}),
    ...(options.knownSkills !== undefined ? { knownSkills: options.knownSkills } : {}),
  })
  result.failedSessions = failedSessions

  const report = formatReport(result, {
    days: options.days,
    ...(options.includeSessions !== undefined ? { includeSessions: options.includeSessions } : {}),
    ...(options.skillPrefix !== undefined ? { skillPrefix: options.skillPrefix } : {}),
    ...(options.knownSkills !== undefined ? { knownSkills: options.knownSkills } : {}),
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
    sourceLabel: options.source.label,
    now,
  })

  return { report, result }
}

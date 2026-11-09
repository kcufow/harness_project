/**
 * 技能使用审计工具（只读）。
 *
 * 注册模型可调用的 `skill_usage_report` 工具：统计最近 N 天各技能的调用次数、
 * 成功/失败/未完成数和最近调用时间。数据源优先 `ctx.sessionQuery`，缺席时退回
 * 直接读 jsonl 存档。插件不改任何核心状态，也不写会话日志。
 *
 * @module skill-usage-audit
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { generateUsageReport } from './audit.js'
import {
  createQuerySource,
  defaultSessionsRoot,
  resolveFileSource,
} from './sources.js'
import type { SessionQueryLike, SessionSource } from './types.js'

/** 插件名。 */
export const name = 'skill-usage-audit'

/** 只硬依赖工具注册表；`sessionQuery` 用 `ctx.get()` 按需探测。 */
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** jsonl 存档根目录；默认 `~/.dsh/sessions`（仅兜底路线使用）。 */
  sessionsRoot?: string
  /** 默认统计天数，默认 7。 */
  defaultDays?: number
  /** 已知技能全名，用于报告“零调用技能”，也用于把独立注册的技能计入统计。 */
  knownSkills?: string[]
  /** 技能调度器工具名，默认 `['skill']`。 */
  dispatcherTools?: string[]
  /** 非调度器工具是否按工具名一并统计，默认 false。 */
  includeGenericTools?: boolean
  /** 单次最多读取多少个会话（按创建时间倒序），默认 200。 */
  maxSessions?: number
  /** 表格最多列多少行，默认 50。 */
  maxRows?: number
}

export const Config: Schema<Config> = Schema.object({
  sessionsRoot: Schema.string()
    .default('')
    .description('jsonl 存档根目录，留空用 ~/.dsh/sessions'),
  defaultDays: Schema.number().default(7).description('默认统计天数'),
  knownSkills: Schema.array(Schema.string())
    .default([])
    .description('技能包完整技能列表，用于报告零调用技能'),
  dispatcherTools: Schema.array(Schema.string())
    .default(['skill'])
    .description('技能调度器工具名，支持 * 通配'),
  includeGenericTools: Schema.boolean()
    .default(false)
    .description('非调度器工具是否按工具名统计'),
  maxSessions: Schema.number().default(200).description('单次最多扫描的会话数'),
  maxRows: Schema.number().default(50).description('报告最多列出的技能行数'),
})

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * 选择数据源：优先 sessionQuery，其次 jsonl 存档。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @returns 数据源。
 * @throws 两条路线都不可用时，抛出带修复指引的错误。
 */
async function resolveSource(ctx: Context, config: Config): Promise<SessionSource> {
  const query = ctx.get('sessionQuery') as unknown as SessionQueryLike | undefined
  if (
    query &&
    typeof query.listSessions === 'function' &&
    typeof query.readSession === 'function'
  ) {
    return createQuerySource(query)
  }

  const root = config.sessionsRoot?.trim() || defaultSessionsRoot()
  const fileSource = await resolveFileSource(root)
  if (!fileSource) {
    throw new Error(
      '没有可用的会话数据源：ctx.sessionQuery 未提供，且存档目录不存在（' +
        root +
        '）。请把插件配置的 sessionsRoot 指向 jsonl 持久化插件的 root 目录。',
    )
  }
  return fileSource
}

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 * @param config - 已校验配置。
 */
export function apply(ctx: Context, config: Config): void {
  const defaultDays = clampInt(config.defaultDays, 7, 1, 365)
  const maxSessions = clampInt(config.maxSessions, 200, 1, 5000)
  const maxRows = clampInt(config.maxRows, 50, 1, 500)
  const knownSkills = config.knownSkills ?? []
  const dispatcherTools = config.dispatcherTools?.length ? config.dispatcherTools : ['skill']

  ctx.tools.register(
    defineTool({
      name: 'skill_usage_report',
      description:
        '生成技能/预设的使用审计报告：统计最近 N 天各技能的调用次数、成功/失败次数与最近调用时间。' +
        '只读会话日志，不修改任何状态。技能调用按调度器工具（默认 skill）的参数解析技能名。',
      parameters: {
        days: {
          type: 'number',
          description: `统计最近 N 天，默认 ${defaultDays}`,
        },
        skillPrefix: {
          type: 'string',
          description: '只统计名称匹配此前的技能（前缀匹配）',
        },
        includeSessions: {
          type: 'boolean',
          description: '是否在报告中附带会话 ID 列表',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const days = clampInt(args.days, defaultDays, 1, 365)
        const skillPrefix = args.skillPrefix?.trim()
        const source = await resolveSource(ctx, config)

        const outcome = await generateUsageReport({
          days,
          source,
          maxSessions,
          maxRows,
          dispatcherTools,
          knownSkills,
          includeGenericTools: config.includeGenericTools === true,
          ...(skillPrefix ? { skillPrefix } : {}),
          ...(args.includeSessions !== undefined ? { includeSessions: args.includeSessions } : {}),
          signal: exec.signal,
        })
        return outcome.report
      },
    }),
  )
}

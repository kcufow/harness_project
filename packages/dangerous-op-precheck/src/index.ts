/**
 * 危险操作预检清单（通用版）。
 *
 * 挂接 `tools/pre-execute` 瀑布，在工具真正执行前按用户自定义规则拦截：
 * - `mode: 'ask'` → 返回 `{ kind: 'ask', reason }`，由 registry 走原生 `ctx.approval` 审批通道，
 *   检查清单塞在 reason 里逐条展示；用户拒绝 / 取消 / 无审批通道时，registry 一律按拒绝处理。
 * - `mode: 'block'` → 返回 `{ kind: 'deny', reason }`，直接把理由回给模型。
 *
 * 组合原则：始终先调用 `next()` 取得下游决策，只有下游是 `allow` 时才施加本插件的决策，
 * 因此本插件永远不会“放宽”其他守卫（如 tool-guard）的拒绝。
 *
 * @module dangerous-op-precheck
 */
import type { Context } from '@deepseek-ai/cordis'
// 这个 type-only import 同时把 dsh-tools 对 cordis 的 `tools/*` 事件增强带进来，
// 否则 ctx.on('tools/pre-execute', ...) 的类型无法解析。
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import {
  compileRules,
  findMatchingRule,
  toDecision,
  type Rule,
  type RuleTarget,
} from './rules.js'

/** 插件名（cordis 用名字做去重与日志标识）。 */
export const name = 'dangerous-op-precheck'

/** 依赖：只需要工具注册表；审批通道由 registry 内部按需查找。 */
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 预检规则列表，默认空（不拦截任何操作）。 */
  rules?: Rule[]
  /** 是否输出命中/放行日志，默认 true。 */
  logDecisions?: boolean
}

/** 不配置任何规则时插件是“空转”的，这是安全默认值。 */
export const Config: Schema<Config> = Schema.object({
  rules: Schema.array(
    Schema.object({
      id: Schema.string().description('规则标识，出现在拒绝理由与日志中'),
      match: Schema.object({
        tool: Schema.union([Schema.string(), Schema.array(Schema.string())]).description(
          '工具名，精确匹配，支持 * 通配，也可给数组',
        ),
        commandPattern: Schema.string().description('命令文本正则（bash 的 command 等）'),
        pathPattern: Schema.string().description('文件路径正则（write/edit/read 的 file_path 等）'),
        argsPattern: Schema.string().description('整个参数 JSON 的正则，用于自定义工具'),
      }).description('触发条件，多个条件同时满足才命中'),
      mode: Schema.union(['ask', 'block'])
        .default('ask')
        .description('ask：走原生审批并要求逐项确认；block：直接拒绝'),
      checklist: Schema.array(Schema.string()).description('ask 模式下展示的检查项'),
      message: Schema.string().description('block 模式返回给模型的理由'),
    }),
  )
    .default([])
    .description('预检规则，按顺序匹配，先命中先用'),
  logDecisions: Schema.boolean().default(true).description('是否记录命中与放行日志'),
})

/** 插件用到的日志最小接口。 */
interface DecisionLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

const NOOP_LOGGER: DecisionLogger = { info() {}, warn() {} }

/**
 * 取一个带名字的 logger。cordis 的 `ctx.logger` 是可调用的拦截器，
 * 拿不到时退化为空实现，绝不让日志问题影响拦截逻辑。
 * @param ctx - 插件上下文。
 * @param enabled - 是否启用日志。
 * @returns 日志对象。
 */
function createLogger(ctx: Context, enabled: boolean): DecisionLogger {
  if (!enabled) return NOOP_LOGGER
  try {
    const service = (ctx as unknown as { logger?: unknown }).logger
    if (typeof service !== 'function') return NOOP_LOGGER
    const named = (service as (loggerName: string) => Partial<DecisionLogger> | undefined)(name)
    if (!named || typeof named.info !== 'function' || typeof named.warn !== 'function') {
      return NOOP_LOGGER
    }
    return {
      info: (...args) => named.info!(...args),
      warn: (...args) => named.warn!(...args),
    }
  } catch {
    return NOOP_LOGGER
  }
}

/**
 * 插件入口。
 * @param ctx - 插件上下文（`inject: ['tools']` 保证 `ctx.tools` 可用）。
 * @param config - 已按 {@link Config} 校验过的配置。
 */
export function apply(ctx: Context, config: Config): void {
  // 加载期编译：正则或字段写错会在这里抛出，让插件直接加载失败并暴露原因。
  const rules = compileRules(config.rules)
  const logger = createLogger(ctx, config.logDecisions !== false)

  if (rules.length === 0) {
    logger.warn('未配置任何预检规则，插件不会拦截任何操作')
  } else {
    logger.info(`已加载 ${rules.length} 条预检规则：${rules.map((rule) => rule.ruleId).join(', ')}`)
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    // 先让下游监听器决策：本插件只能在 allow 的基础上收紧，不能覆盖别人的 deny/ask。
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream

    const target: RuleTarget = { toolName: exec.name, args: exec.arguments }
    const rule = findMatchingRule(rules, target)
    if (!rule) return downstream

    const decision: PreToolDecision = toDecision(rule, target)
    if (decision.kind === 'deny') {
      logger.warn(`拦截 ${target.toolName}：规则「${rule.ruleId}」（block）`)
    } else {
      logger.info(`请求确认 ${target.toolName}：规则「${rule.ruleId}」（ask，${rule.checklist?.length ?? 0} 项）`)
    }
    return decision
  })
}

/**
 * 预检规则的编译与匹配（纯函数，不依赖 Harness 运行时）。
 *
 * 设计要点：
 * - 规则在插件加载时一次性编译成正则，正则语法错误立刻抛 {@link RuleConfigError}，
 *   避免“配置写错 → 静默不拦截”。
 * - `match` 中任一条件写错（拼错字段名）同样抛错，避免整条规则退化成“匹配所有调用”。
 * - 匹配顺序按配置数组，先命中先用（first match wins）。
 *
 * @module dangerous-op-precheck/rules
 */

/** 命中规则后的处理模式：ask 走原生审批通道，block 直接拒绝。 */
export type RuleMode = 'ask' | 'block'

/** 触发条件：所有已给出的条件必须同时满足（AND）。 */
export interface RuleMatch {
  /** 工具名，精确匹配；支持 `*` 通配（如 `bash*`），也可给数组表示多选。 */
  tool?: string | string[]
  /** 命令类正则，对工具参数里的命令文本生效（bash 的 `command`、`cmd` 等）。 */
  commandPattern?: string
  /** 路径类正则，对工具参数里的文件路径生效（write/edit/read 的 `file_path` 等）。 */
  pathPattern?: string
  /** 兜底正则：对整个参数的 JSON 文本生效，用于自定义工具。 */
  argsPattern?: string
}

/** 一条用户配置的预检规则。 */
export interface Rule {
  /** 规则标识，出现在拒绝理由与日志里；省略时按序号生成。 */
  id?: string
  match: RuleMatch
  /** 默认 `ask`。 */
  mode?: RuleMode
  /** mode=ask 时展示给用户的检查项，逐条列出。 */
  checklist?: string[]
  /** mode=block 时返回给模型的理由。 */
  message?: string
}

/** 编译后的规则：原始配置 + 预编译正则。 */
export interface CompiledRule extends Omit<Rule, 'match' | 'mode'> {
  readonly ruleId: string
  readonly match: RuleMatch
  readonly mode: RuleMode
  readonly toolRe?: RegExp
  readonly commandRe?: RegExp
  readonly pathRe?: RegExp
  readonly argsRe?: RegExp
}

/** 一次待决策的工具调用。 */
export interface RuleTarget {
  toolName: string
  args: unknown
}

/** 预检决策，与 `tools/pre-execute` 的 PreToolDecision 结构一致。 */
export type PrecheckDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** 配置错误：插件加载阶段直接抛出，带出出错规则的定位信息。 */
export class RuleConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleConfigError'
  }
}

/** 命令文本可能出现的参数键（bash / shell / 自定义脚本工具）。 */
const COMMAND_KEYS: ReadonlySet<string> = new Set([
  'command',
  'cmd',
  'script',
  'shell',
  'code',
  'input',
  'query',
])

/** 文件路径可能出现的参数键（write / edit / read / 自定义文件工具）。 */
const PATH_KEYS: ReadonlySet<string> = new Set([
  'path',
  'file_path',
  'filePath',
  'filepath',
  'file',
  'paths',
  'files',
  'target',
  'target_path',
  'targetPath',
  'source',
  'destination',
  'from',
  'to',
  'dir',
  'directory',
  'cwd',
  'workdir',
  'root',
])

const MATCH_KEYS = new Set(['tool', 'commandPattern', 'pathPattern', 'argsPattern'])

/** 遍历参数树时最多收集多少条候选文本，防止超大参数拖慢预检。 */
const MAX_CANDIDATES = 64
/** 递归深度上限。 */
const MAX_DEPTH = 8

/**
 * 收集参数中所有字符串候选值。
 * @param value - 任意参数值（已由 registry 保证是无损 JSON）。
 * @param keys - 关心的键名集合。
 * @param out - 输出数组（会去重）。
 * @param depth - 当前递归深度。
 */
function collectStrings(
  value: unknown,
  keys: ReadonlySet<string>,
  out: string[],
  depth: number,
): void {
  if (out.length >= MAX_CANDIDATES || depth > MAX_DEPTH) return
  if (value === null || typeof value !== 'object') return

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        pushUnique(out, item)
      } else {
        collectStrings(item, keys, out, depth + 1)
      }
      if (out.length >= MAX_CANDIDATES) return
    }
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string') {
      if (keys.has(key)) pushUnique(out, child)
      continue
    }
    // 命中键且是数组时，数组里的字符串也算候选（如 paths: ["a", "b"]）。
    if (Array.isArray(child) && keys.has(key)) {
      for (const item of child) {
        if (typeof item === 'string') pushUnique(out, item)
      }
    }
    collectStrings(child, keys, out, depth + 1)
    if (out.length >= MAX_CANDIDATES) return
  }
}

function pushUnique(out: string[], value: string): void {
  const trimmed = value.trim()
  if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed)
}

/** 提取参数中的命令候选文本。 */
export function collectCommands(args: unknown): string[] {
  const out: string[] = []
  collectStrings(args, COMMAND_KEYS, out, 0)
  return out
}

/** 提取参数中的路径候选文本。 */
export function collectPaths(args: unknown): string[] {
  const out: string[] = []
  collectStrings(args, PATH_KEYS, out, 0)
  return out
}

/**
 * 编译工具名匹配正则：非通配字符一律转义，`*` 展开为 `.*`，整体锚定。
 * @param tool - 单个或多个工具名模式。
 * @param ruleId - 出错的规则标识。
 * @returns 锚定正则；未配置工具名时为 undefined。
 */
function compileToolPattern(tool: string | string[] | undefined, ruleId: string): RegExp | undefined {
  if (tool === undefined) return undefined
  const patterns = (Array.isArray(tool) ? tool : [tool])
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (patterns.length === 0) {
    throw new RuleConfigError(`规则「${ruleId}」的 match.tool 为空字符串或空数组`)
  }
  for (const pattern of patterns) {
    if (pattern === '*') return /^.*$/
  }
  const source = patterns
    .map((pattern) => pattern.split('*').map(escapeRegExp).join('.*'))
    .join('|')
  try {
    return new RegExp(`^(?:${source})$`)
  } catch (error) {
    throw new RuleConfigError(
      `规则「${ruleId}」的 match.tool 无法编译为匹配式：${(error as Error).message}`,
    )
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 编译单个用户正则，错误信息带字段定位。
 * @param source - 用户写的正则源码。
 * @param field - 字段名（写进错误信息）。
 * @returns 正则；未配置时为 undefined。
 */
function compileUserPattern(source: string | undefined, field: string): RegExp | undefined {
  if (source === undefined || source.trim().length === 0) return undefined
  try {
    return new RegExp(source)
  } catch (error) {
    throw new RuleConfigError(
      `${field} 不是合法正则（${source}）：${(error as Error).message}。` +
        '请在插件配置中修正，或删掉该字段。',
    )
  }
}

/**
 * 编译全部规则。任何一条不合法都会抛错，让插件加载失败而不是静默失效。
 * @param rules - 用户配置的规则数组。
 * @returns 编译后的规则数组，顺序保持与配置一致。
 */
export function compileRules(rules: readonly Rule[] | undefined): CompiledRule[] {
  if (!rules || rules.length === 0) return []

  const compiled: CompiledRule[] = []
  rules.forEach((rule, index) => {
    const ruleId = rule.id?.trim() || `rule-${index + 1}`
    if (rule === null || typeof rule !== 'object') {
      throw new RuleConfigError(`第 ${index + 1} 条规则不是对象`)
    }
    const match = rule.match
    if (match === null || typeof match !== 'object') {
      throw new RuleConfigError(`规则「${ruleId}」缺少 match 配置`)
    }

    const unknown = Object.keys(match).filter((key) => !MATCH_KEYS.has(key))
    if (unknown.length > 0) {
      throw new RuleConfigError(
        `规则「${ruleId}」的 match 含未知字段：${unknown.join(', ')}。` +
          `可用字段为 ${[...MATCH_KEYS].join(', ')}（注意拼写，避免规则静默失效）。`,
      )
    }

    const toolRe = compileToolPattern(match.tool, ruleId)
    const commandRe = compileUserPattern(match.commandPattern, `规则「${ruleId}」的 match.commandPattern`)
    const pathRe = compileUserPattern(match.pathPattern, `规则「${ruleId}」的 match.pathPattern`)
    const argsRe = compileUserPattern(match.argsPattern, `规则「${ruleId}」的 match.argsPattern`)

    if (!toolRe && !commandRe && !pathRe && !argsRe) {
      throw new RuleConfigError(
        `规则「${ruleId}」的 match 没有任何触发条件，会匹配所有调用。` +
          '如果确实想拦截全部调用，请显式写 match.tool: "*"。',
      )
    }

    const mode = rule.mode ?? 'ask'
    if (mode !== 'ask' && mode !== 'block') {
      throw new RuleConfigError(`规则「${ruleId}」的 mode 只能是 ask 或 block，收到 ${String(mode)}`)
    }

    compiled.push({
      ruleId,
      match,
      mode,
      ...(rule.checklist !== undefined ? { checklist: rule.checklist } : {}),
      ...(rule.message !== undefined ? { message: rule.message } : {}),
      ...(toolRe ? { toolRe } : {}),
      ...(commandRe ? { commandRe } : {}),
      ...(pathRe ? { pathRe } : {}),
      ...(argsRe ? { argsRe } : {}),
    })
  })
  return compiled
}

/** 参数序列化后用正则匹配时的兜底；参数不是 JSON 时返回空串。 */
function stringifyArgs(args: unknown): string {
  if (args === undefined) return ''
  try {
    return JSON.stringify(args) ?? ''
  } catch {
    return ''
  }
}

/**
 * 判断一条编译后的规则是否命中。
 * @param rule - 编译后的规则。
 * @param target - 待决策的调用。
 * @returns 是否命中。
 */
export function matchesRule(rule: CompiledRule, target: RuleTarget): boolean {
  if (rule.toolRe && !rule.toolRe.test(target.toolName)) return false

  if (rule.commandRe) {
    const commands = collectCommands(target.args)
    if (!commands.some((command) => rule.commandRe!.test(command))) return false
  }

  if (rule.pathRe) {
    const paths = collectPaths(target.args)
    if (!paths.some((path) => rule.pathRe!.test(path))) return false
  }

  if (rule.argsRe && !rule.argsRe.test(stringifyArgs(target.args))) return false

  return true
}

/**
 * 按配置顺序返回第一条命中的规则。
 * @param rules - 编译后的规则数组。
 * @param target - 待决策的调用。
 * @returns 命中的规则，或 undefined。
 */
export function findMatchingRule(
  rules: readonly CompiledRule[],
  target: RuleTarget,
): CompiledRule | undefined {
  for (const rule of rules) {
    try {
      if (matchesRule(rule, target)) return rule
    } catch {
      // 匹配阶段的异常不应让工具调用失败，按“未命中”处理。
    }
  }
  return undefined
}

/** 从调用参数中挑一条最能说明“要动什么”的文本，用于弹窗标题行。 */
export function describeTarget(target: RuleTarget, maxLength = 200): string {
  const commands = collectCommands(target.args)
  const paths = collectPaths(target.args)
  const argsText = stringifyArgs(target.args)
  // 空对象没有信息量，宁可直接显示工具名。
  const fallback = argsText === '{}' || argsText === '' ? '' : argsText
  const picked = commands[0] ?? paths[0] ?? fallback
  const oneLine = picked.replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return target.toolName
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine
}

/**
 * 构造 ask 模式的审批理由：标题 + 定位信息 + 编号检查清单。
 * 审批通道只支持一段文本，因此这里用编号列表承载多个检查项。
 * @param rule - 命中的规则。
 * @param target - 待决策的调用。
 * @returns 多行理由文本。
 */
export function buildAskReason(rule: CompiledRule, target: RuleTarget): string {
  const lines: string[] = [
    `危险操作预检：规则「${rule.ruleId}」要求逐项确认`,
    `工具：${target.toolName}`,
    `目标：${describeTarget(target)}`,
    '',
  ]
  const checklist = (rule.checklist ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
  if (checklist.length > 0) {
    lines.push('请逐项确认，全部确认后选择「允许」：')
    checklist.forEach((item, index) => lines.push(`${index + 1}. ${item}`))
  } else {
    lines.push(rule.message?.trim() || '请确认是否继续执行该操作。')
  }
  return lines.join('\n')
}

/**
 * 构造 block 模式的拒绝理由。
 * @param rule - 命中的规则。
 * @param target - 待决策的调用。
 * @returns 单行/多行理由文本。
 */
export function buildBlockReason(rule: CompiledRule, target: RuleTarget): string {
  const message = rule.message?.trim()
  if (message) return message
  return `操作被预检规则「${rule.ruleId}」拒绝：${target.toolName} ${describeTarget(target, 120)}`
}

/**
 * 把命中的规则翻译成 pre-execute 决策。
 * @param rule - 命中的规则。
 * @param target - 待决策的调用。
 * @returns deny（block）或 ask（ask）。
 */
export function toDecision(rule: CompiledRule, target: RuleTarget): PrecheckDecision {
  if (rule.mode === 'block') return { kind: 'deny', reason: buildBlockReason(rule, target) }
  return { kind: 'ask', reason: buildAskReason(rule, target) }
}

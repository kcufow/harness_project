/**
 * 技能使用聚合与报告渲染（纯函数）。
 *
 * 关键事实（对齐 dsh-tool-skill 的真实实现）：技能不是独立工具，而是走**同一个**
 * `skill` 工具，技能名在参数 `name` 里。所以不能像方案文档初稿那样“按 tool/call 的
 * name 聚合就完事”，必须先按 dispatcher 工具 + 参数解析出技能名。
 *
 * @module skill-usage-audit/report
 */
import type { LoadedSession, SessionEventLike } from './types.js'

/** 一个技能的统计条目。 */
export interface UsageEntry {
  skillName: string
  callCount: number
  successCount: number
  failureCount: number
  /** 有调用但没等到结果（会话中断、工具仍未返回）。 */
  pendingCount: number
  /** 窗口内最近一次调用时间（epoch ms）。 */
  lastCalledAt: number
  /** 涉及会话（仅 includeSessions=true 时收集）。 */
  sessionIds: string[]
}

/** 聚合选项。 */
export interface AggregateOptions {
  /** 窗口起点（epoch ms，含）。 */
  since: number
  /** 只统计以此前缀开头的技能名。 */
  skillPrefix?: string
  /** 是否收集会话 ID 列表。 */
  includeSessions?: boolean
  /** 视为“技能调度器”的工具名，默认 `['skill']`。 */
  dispatcherTools?: readonly string[]
  /** 从 dispatcher 参数里取技能名的键名，默认 `['name', 'skill', 'skillName', 'skill_name']`。 */
  skillArgKeys?: readonly string[]
  /** 是否把非 dispatcher 的工具调用也按工具名计入（默认 false）。 */
  includeGenericTools?: boolean
  /** 已知技能全名，用于把“以独立工具注册的技能”计入，以及报告零调用技能。 */
  knownSkills?: readonly string[]
}

/** 聚合结果。 */
export interface AggregateResult {
  entries: UsageEntry[]
  /** 计入统计的调用总数。 */
  callsInWindow: number
  /** dispatcher 调用但解析不出技能名的次数。 */
  unresolvedCalls: number
  scannedSessions: number
  scannedEvents: number
  /** 读取失败被跳过的会话数。 */
  failedSessions: number
}

const DEFAULT_DISPATCHERS: readonly string[] = ['skill']
const DEFAULT_ARG_KEYS: readonly string[] = ['name', 'skill', 'skillName', 'skill_name']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** dispatcher 支持 `skill*` 形式的通配。 */
function isDispatcher(toolName: string, dispatchers: readonly string[]): boolean {
  return dispatchers.some((pattern) =>
    pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : toolName === pattern,
  )
}

/** 从 dispatcher 参数中取技能名。 */
function pickSkillArg(args: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(args)) return undefined
  for (const key of keys) {
    const value = asString(args[key])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * 把一次工具调用解析成“技能名”。
 * @param toolName - 工具名。
 * @param args - 已解析的参数。
 * @param options - 聚合选项。
 * @returns 技能名；`null` 表示这次调用不计入技能统计。
 */
export function resolveSkillName(
  toolName: string,
  args: unknown,
  options: AggregateOptions = { since: 0 },
): string | null {
  const dispatchers = options.dispatcherTools ?? DEFAULT_DISPATCHERS
  if (isDispatcher(toolName, dispatchers)) {
    return pickSkillArg(args, options.skillArgKeys ?? DEFAULT_ARG_KEYS) ?? null
  }
  if (options.includeGenericTools) return toolName
  if (options.knownSkills?.includes(toolName)) return toolName
  return null
}

/** 解析 `tool/call` 事件里的参数字符串（模型产出的原始 JSON 文本）。 */
function parseCallArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 从 `tool/result` 事件里取配对的 callId。 */
export function resultCallId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const message = data['message']
  if (isRecord(message)) {
    const blocks = message['content']
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (isRecord(block)) {
          const id = asString(block['toolCallId'])
          if (id !== undefined) return id
        }
      }
    }
    const fallback = asString(message['callId'])
    if (fallback !== undefined) return fallback
  }
  return asString(data['callId'])
}

/**
 * 判断一个 `tool/result` 是否失败。
 * 优先看事件自带的 `error`（`{name, code}`），其次看结果块/消息的 `isError`。
 */
export function isFailureResult(data: unknown): boolean {
  if (!isRecord(data)) return false
  if (isRecord(data['error'])) return true
  const message = data['message']
  if (!isRecord(message)) return false
  if (message['isError'] === true) return true
  const blocks = message['content']
  if (Array.isArray(blocks)) {
    return blocks.some((block) => isRecord(block) && block['isError'] === true)
  }
  return false
}

/**
 * 聚合多个会话的技能使用情况。
 * @param sessions - 已加载的会话日志。
 * @param options - 聚合选项。
 * @returns 排序后的统计结果（调用次数降序，同数按技能名升序）。
 */
export function aggregate(
  sessions: readonly LoadedSession[],
  options: AggregateOptions,
): AggregateResult {
  const usage = new Map<string, UsageEntry>()
  let unresolvedCalls = 0
  let scannedEvents = 0

  for (const session of sessions) {
    /** 本会话内 callId → 技能名，用于和 tool/result 配对。 */
    const pending = new Map<string, string>()

    for (const event of session.events) {
      if (!isRecord(event) || typeof event.type !== 'string') continue
      scannedEvents++

      const time = typeof event.time === 'number' ? event.time : undefined
      if (time !== undefined && time < options.since) continue
      if (event.type !== 'tool/call' && event.type !== 'tool/result') continue

      const data = event.data
      if (!isRecord(data)) continue

      if (event.type === 'tool/call') {
        const callId = asString(data['callId'])
        const toolName = asString(data['name'])
        if (callId === undefined || toolName === undefined) continue

        const args = parseCallArguments(data['arguments'])
        const skillName = resolveSkillName(toolName, args, options)
        if (skillName === null) {
          const dispatchers = options.dispatcherTools ?? DEFAULT_DISPATCHERS
          if (isDispatcher(toolName, dispatchers)) unresolvedCalls++
          continue
        }
        if (options.skillPrefix && !skillName.startsWith(options.skillPrefix)) continue

        pending.set(callId, skillName)
        let entry = usage.get(skillName)
        if (!entry) {
          entry = {
            skillName,
            callCount: 0,
            successCount: 0,
            failureCount: 0,
            pendingCount: 0,
            lastCalledAt: 0,
            sessionIds: [],
          }
          usage.set(skillName, entry)
        }
        entry.callCount++
        if (time !== undefined && time > entry.lastCalledAt) entry.lastCalledAt = time
        if (options.includeSessions && !entry.sessionIds.includes(session.id)) {
          entry.sessionIds.push(session.id)
        }
        continue
      }

      const callId = resultCallId(data)
      if (callId === undefined) continue
      const skillName = pending.get(callId)
      if (skillName === undefined) continue
      pending.delete(callId)

      const entry = usage.get(skillName)
      if (!entry) continue
      if (isFailureResult(data)) entry.failureCount++
      else entry.successCount++
    }
  }

  const entries = [...usage.values()].map((entry) => ({
    ...entry,
    pendingCount: Math.max(0, entry.callCount - entry.successCount - entry.failureCount),
  }))

  entries.sort((a, b) => (b.callCount - a.callCount) || a.skillName.localeCompare(b.skillName))

  return {
    entries,
    callsInWindow: entries.reduce((sum, entry) => sum + entry.callCount, 0),
    unresolvedCalls,
    scannedSessions: sessions.length,
    scannedEvents,
    failedSessions: 0,
  }
}

/* ------------------------------------------------------------------ 渲染 */

/** 渲染选项。 */
export interface FormatOptions {
  /** 统计天数，用于标题。 */
  days: number
  includeSessions?: boolean
  skillPrefix?: string
  /** 已知技能全名，用于报告零调用技能。 */
  knownSkills?: readonly string[]
  /** 数据源标识。 */
  sourceLabel?: string
  /** 表格最多列多少行，默认 50。 */
  maxRows?: number
  /** 生成时间（epoch ms），默认 Date.now()。 */
  now?: number
}

const WIDE_REGEX =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

/**
 * 计算终端显示宽度：CJK 全角字符按 2 列算，否则表格会错位。
 * @param text - 待测量文本。
 * @returns 显示宽度。
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += WIDE_REGEX.test(char) ? 2 : 1
  return width
}

function padEndWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function padStartWidth(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text
}

/** 本地时间 `MM-DD HH:mm`。 */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 三位数加千分位，便于读大数。 */
function groupNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * 渲染纯文本报告。
 * @param result - 聚合结果。
 * @param options - 渲染选项。
 * @returns 面向模型/终端的多行文本。
 */
export function formatReport(result: AggregateResult, options: FormatOptions): string {
  const now = options.now ?? Date.now()
  const maxRows = Math.max(1, options.maxRows ?? 50)
  const lines: string[] = []

  const header = `技能使用报告（最近 ${options.days} 天）`
  lines.push(header)
  const meta = [`生成时间：${formatTime(now)}`]
  if (options.sourceLabel) meta.push(`数据源：${options.sourceLabel}`)
  meta.push(`扫描 ${groupNumber(result.scannedSessions)} 个会话 / ${groupNumber(result.scannedEvents)} 条事件`)
  lines.push(meta.join(' · '))
  lines.push('')

  if (result.entries.length === 0) {
    lines.push(`最近 ${options.days} 天没有技能调用记录。`)
  } else {
    const showPending = result.entries.some((entry) => entry.pendingCount > 0)
    const visible = result.entries.slice(0, maxRows)

    const nameWidth = Math.max(
      displayWidth('技能名称'),
      ...visible.map((entry) => displayWidth(entry.skillName)),
    )
    const calls = visible.map((entry) => groupNumber(entry.callCount))
    const successes = visible.map((entry) => groupNumber(entry.successCount))
    const failures = visible.map((entry) => groupNumber(entry.failureCount))
    const pendings = visible.map((entry) => groupNumber(entry.pendingCount))

    const columnWidth = (title: string, values: string[]) =>
      Math.max(displayWidth(title), ...values.map((value) => displayWidth(value)))

    const callsWidth = columnWidth('调用', calls)
    const successWidth = columnWidth('成功', successes)
    const failureWidth = columnWidth('失败', failures)
    const pendingWidth = columnWidth('待定', pendings)

    const row = (
      name: string,
      callsText: string,
      successText: string,
      failureText: string,
      pendingText: string,
      lastText: string,
    ) => {
      const parts = [
        padEndWidth(name, nameWidth),
        padStartWidth(callsText, callsWidth),
        padStartWidth(successText, successWidth),
        padStartWidth(failureText, failureWidth),
      ]
      if (showPending) parts.push(padStartWidth(pendingText, pendingWidth))
      if (lastText.length > 0) parts.push(lastText)
      return parts.join('  ').replace(/\s+$/, '')
    }

    lines.push(row('技能名称', '调用', '成功', '失败', '待定', '最近调用'))
    visible.forEach((entry, index) => {
      lines.push(
        row(
          entry.skillName,
          calls[index] ?? '0',
          successes[index] ?? '0',
          failures[index] ?? '0',
          pendings[index] ?? '0',
          formatTime(entry.lastCalledAt),
        ),
      )
    })

    if (result.entries.length > visible.length) {
      lines.push(`… 另有 ${result.entries.length - visible.length} 个技能未列出（可加 skillPrefix 过滤或提高 maxRows）`)
    }

    lines.push('')
    const failureTotal = result.entries.reduce((sum, entry) => sum + entry.failureCount, 0)
    const pendingTotal = result.entries.reduce((sum, entry) => sum + entry.pendingCount, 0)
    const summary = [
      `共 ${result.entries.length} 个技能被调用，${groupNumber(result.callsInWindow)} 次调用`,
      `${groupNumber(failureTotal)} 次失败`,
    ]
    if (pendingTotal > 0) summary.push(`${groupNumber(pendingTotal)} 次未拿到结果`)
    lines.push(`${summary.join('，')}。`)
  }

  if (options.skillPrefix) {
    lines.push(`（仅统计名称以「${options.skillPrefix}」开头的技能）`)
  }

  const zeroCall = (options.knownSkills ?? []).filter(
    (skill) =>
      skill.length > 0 &&
      (!options.skillPrefix || skill.startsWith(options.skillPrefix)) &&
      !result.entries.some((entry) => entry.skillName === skill),
  )
  if (zeroCall.length > 0) {
    lines.push(`未被调用的技能：${zeroCall.join(', ')}（共 ${zeroCall.length} 个）`)
  }

  if (result.unresolvedCalls > 0) {
    lines.push(
      `另有 ${groupNumber(result.unresolvedCalls)} 次技能调度未能解析出技能名（参数缺 name），未计入统计。`,
    )
  }
  if (result.failedSessions > 0) {
    lines.push(`有 ${groupNumber(result.failedSessions)} 个会话读取失败，已跳过。`)
  }

  if (result.entries.length === 0 && zeroCall.length === 0 && result.unresolvedCalls === 0) {
    lines.push('提示：确认技能调用是否经由 dispatcher 工具（默认 skill），或打开 includeGenericTools。')
  }

  return lines.join('\n')
}

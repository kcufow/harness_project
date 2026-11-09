/**
 * 会话存档文本的宽容解析（纯函数）。
 *
 * jsonl 后端一个会话一个文件（`session.jsonl` / `session.jsonl.zstd`），一行一条记录：
 * - 头行：`{ session: { id, createdAt, ... } }`
 * - 事件行：`{ type, seq, time, data }`
 * - 压缩行：`{ 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks': {...} }`（审计无关，直接忽略）
 *
 * 解析策略是“能读多少读多少”：坏行跳过，不因为一行脏数据让整个报告失败。
 *
 * @module skill-usage-audit/logfile
 */
import type { SessionEventLike } from './types.js'

/** 解析结果。 */
export interface ParsedSessionLog {
  header?: { id?: string; createdAt?: number }
  events: SessionEventLike[]
  /** 无法解析（或被忽略）的行数，用于报告里的诊断行。 */
  skippedLines: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 判断一个对象是否像会话事件。 */
export function looksLikeEvent(value: unknown): value is SessionEventLike {
  return isRecord(value) && typeof value['type'] === 'string'
}

/**
 * 解析整个会话存档文本。
 * @param text - 已解压的存档文本（每行一条 JSON）。
 * @returns 头信息、事件数组与被跳过的行数。
 */
export function parseSessionLog(text: string): ParsedSessionLog {
  const events: SessionEventLike[] = []
  let header: ParsedSessionLog['header']
  let skippedLines = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      skippedLines++
      continue
    }

    if (Array.isArray(parsed)) {
      let accepted = 0
      for (const item of parsed) {
        if (looksLikeEvent(item)) {
          events.push(item)
          accepted++
        }
      }
      if (accepted === 0) skippedLines++
      continue
    }

    if (!isRecord(parsed)) {
      skippedLines++
      continue
    }

    // 包装形态：{ session, events: [...] }
    if (Array.isArray(parsed['events'])) {
      for (const item of parsed['events']) {
        if (looksLikeEvent(item)) events.push(item)
        else skippedLines++
      }
    }

    const sessionRecord = parsed['session']
    if (isRecord(sessionRecord)) {
      const id = asString(sessionRecord['id'])
      const createdAt = asNumber(sessionRecord['createdAt'])
      header = {
        ...(id !== undefined ? { id } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      }
      if (!Array.isArray(parsed['events'])) continue
    }

    if (looksLikeEvent(parsed)) {
      events.push(parsed)
      continue
    }

    // 压缩块行（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）与审计无关，静默忽略。
    const keys = Object.keys(parsed)
    if (keys.length > 0 && keys.every((key) => key.endsWith('-chunks'))) continue

    // 既不是头行也不是事件行：多为压缩块行，静默忽略。
    if (!isRecord(sessionRecord) && !Array.isArray(parsed['events'])) skippedLines++
  }

  return {
    ...(header !== undefined ? { header } : {}),
    events,
    skippedLines,
  }
}

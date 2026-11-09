/**
 * 会话事件与数据源的最小结构定义。
 *
 * 这里刻意不 import `@deepseek-ai/dsh-session` 的类型：插件既要能接
 * `ctx.sessionQuery`，也要能在它缺席时退回读 jsonl 存档，所以只用结构化子集，
 * 任何形状兼容的实现都能塞进来（也便于单测造假数据）。
 *
 * @module skill-usage-audit/types
 */

/** 一条会话事件（只关心审计要用到的字段）。 */
export interface SessionEventLike {
  /** 事件类型，如 `tool/call`、`tool/result`。 */
  type: string
  /** 会话内单调序号。 */
  seq?: number
  /** Unix epoch 毫秒。 */
  time?: number
  /** 事件负载。 */
  data?: unknown
}

/** 会话元信息，用于排序与截断。 */
export interface SessionMeta {
  id: string
  /** 会话创建时间（Unix epoch 毫秒），未知时可用文件 mtime 近似。 */
  createdAt: number
}

/** 已加载的会话日志。 */
export interface LoadedSession {
  id: string
  events: readonly SessionEventLike[]
}

/** 会话数据源：列出会话 + 读取某个会话的完整事件流。 */
export interface SessionSource {
  /** 数据源标识，会出现在报告里（如 `sessionQuery` / `jsonl:<root>`）。 */
  readonly label: string
  list(): Promise<SessionMeta[]>
  read(sessionId: string): Promise<SessionEventLike[]>
}

/** `ctx.sessionQuery` 的结构化子集（`@deepseek-ai/dsh-session-query` 的 SessionQueryService）。 */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionQueryRecord[]>
  readSession(sessionId: string): Promise<SessionQueryLog>
}

/** `listSessions()` 返回的记录。 */
export interface SessionQueryRecord {
  header?: { id?: string; createdAt?: number }
}

/** `readSession()` 返回的日志快照。 */
export interface SessionQueryLog {
  session?: { id?: string; createdAt?: number }
  events: readonly SessionEventLike[]
}

/**
 * 会话数据源实现。
 *
 * 1. {@link createQuerySource}：走 `ctx.sessionQuery`（首选）。后端无关，跨 live/持久化，
 *    也不受存档格式（JSONL / zstd / 其他）影响。
 * 2. {@link createFileSource}：`sessionQuery` 不可用时的兜底，直接扫 jsonl 持久化目录
 *    （`<root>/<project>/<session>/session.jsonl[.zstd]`），支持旧的平铺布局。
 *
 * @module skill-usage-audit/sources
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSessionLog } from './logfile.js'
import type { SessionMeta, SessionQueryLike, SessionSource } from './types.js'

/** 审计用的默认存档根目录（部署真实值以 jsonl 持久化插件的 `root` 配置为准）。 */
export function defaultSessionsRoot(): string {
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * 用 `ctx.sessionQuery` 构造数据源。
 * @param query - `SessionQueryService` 的结构化子集。
 * @returns 数据源。
 */
export function createQuerySource(query: SessionQueryLike): SessionSource {
  return {
    label: 'sessionQuery',
    async list(): Promise<SessionMeta[]> {
      const records = await query.listSessions()
      const metas: SessionMeta[] = []
      for (const record of records) {
        const id = record.header?.id
        if (typeof id !== 'string' || id.length === 0) continue
        metas.push({ id, createdAt: record.header?.createdAt ?? 0 })
      }
      return metas
    },
    async read(sessionId: string) {
      const snapshot = await query.readSession(sessionId)
      return [...snapshot.events]
    },
  }
}

/** 一个会话日志文件。 */
interface DiscoveredLog {
  id: string
  path: string
  createdAt: number
}

/**
 * 认的存档后缀。目录式布局早期是 `session.jsonl[.zstd]`，官方当前世代是
 * `session.v3.jsonl.zstd`；按后缀匹配而不是硬编码文件名，世代升级后不会漏读。
 */
const LOG_FILE_RE = /\.jsonl(\.zstd)?$/

/** 在一个会话目录里挑出该用的存档；新旧世代并存时取修改时间最新的那个。 */
async function findSessionLog(sessionDir: string, id: string): Promise<DiscoveredLog | undefined> {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates: DiscoveredLog[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !LOG_FILE_RE.test(entry.name)) continue
    const path = join(sessionDir, entry.name)
    const info = await stat(path).catch(() => undefined)
    if (info?.isFile()) candidates.push({ id, path, createdAt: info.mtimeMs })
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt)
  return candidates[0]
}

/** 递归两层扫描 jsonl 存档目录。 */
async function discoverLogs(root: string): Promise<DiscoveredLog[]> {
  const found: DiscoveredLog[] = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const log = await findSessionLog(join(projectDir, entry.name), entry.name)
        if (log) found.push(log)
        continue
      }
      // 兼容旧的平铺布局：<root>/<project>/<id>.jsonl
      if (entry.isFile() && LOG_FILE_RE.test(entry.name)) {
        const path = join(projectDir, entry.name)
        const info = await stat(path).catch(() => undefined)
        if (info) {
          found.push({ id: entry.name.replace(LOG_FILE_RE, ''), path, createdAt: info.mtimeMs })
        }
      }
    }
  }
  return found
}

/** zstd 解压（Node 22.15+ 内置；流式解码可处理多个连续 frame）。 */
async function zstdDecompress(buffer: Buffer): Promise<Buffer> {
  const zlib = (await import('node:zlib')) as unknown as {
    createZstdDecompress?: () => NodeJS.ReadWriteStream
    zstdDecompressSync?: (input: Buffer) => Buffer
  }

  if (typeof zlib.createZstdDecompress === 'function') {
    const chunks: Buffer[] = []
    const stream = zlib.createZstdDecompress()
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve())
      stream.on('error', reject)
      stream.end(buffer)
    })
    return Buffer.concat(chunks)
  }

  if (typeof zlib.zstdDecompressSync === 'function') {
    return zlib.zstdDecompressSync(buffer)
  }

  throw new Error(
    `会话存档是 zstd 压缩格式，但当前 Node（${process.version}）没有 zstd 解压 API。` +
      '请升级到 Node 22.15+，或把 jsonl 持久化的 compression 设为 none。',
  )
}

/** 读一个存档文件为文本（自动解压）。 */
async function readLogText(path: string): Promise<string> {
  const buffer = await readFile(path)
  if (!path.endsWith('.zstd')) return buffer.toString('utf8')
  return (await zstdDecompress(buffer)).toString('utf8')
}

/**
 * 目录存在时才构造 jsonl 数据源，避免把“目录不存在”误报成“没有调用记录”。
 * @param root - 存档根目录。
 * @returns 数据源；目录不存在时返回 undefined。
 */
export async function resolveFileSource(root: string): Promise<SessionSource | undefined> {
  const info = await stat(root).catch(() => undefined)
  return info?.isDirectory() ? createFileSource(root) : undefined
}

/**
 * 用 jsonl 存档目录构造数据源。
 * @param root - 存档根目录。
 * @returns 数据源（首次 list 时建立索引并缓存）。
 */
export function createFileSource(root: string): SessionSource {
  let index: Map<string, DiscoveredLog> | undefined

  const ensureIndex = async (): Promise<Map<string, DiscoveredLog>> => {
    if (!index) {
      const discovered = await discoverLogs(root)
      index = new Map(discovered.map((log) => [log.id, log]))
    }
    return index
  }

  return {
    label: `jsonl:${root}`,
    async list(): Promise<SessionMeta[]> {
      const map = await ensureIndex()
      return [...map.values()].map((log) => ({ id: log.id, createdAt: log.createdAt }))
    },
    async read(sessionId: string) {
      const map = await ensureIndex()
      const log = map.get(sessionId)
      if (!log) throw new Error(`找不到会话 ${sessionId} 的存档文件`)
      return parseSessionLog(await readLogText(log.path)).events
    },
  }
}

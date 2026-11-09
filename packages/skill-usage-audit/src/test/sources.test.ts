import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as zlib from 'node:zlib'
import { createFileSource, createQuerySource, resolveFileSource } from '../sources.js'
import type { SessionQueryLike } from '../types.js'

const header = JSON.stringify({ session: { id: 'session-1', createdAt: 1_760_000_000_000 } })
const call = (callId: string, name: string) =>
  JSON.stringify({ type: 'tool/call', seq: 1, time: 1_760_000_001_000, data: { callId, name, arguments: '{}' } })

let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-audit-'))
  // 目录布局：<root>/<project>/<session>/session.jsonl
  await mkdir(join(root, 'proj-a', 'session-1'), { recursive: true })
  await writeFile(join(root, 'proj-a', 'session-1', 'session.jsonl'), [header, call('c1', 'skill')].join('\n'))
  // 旧的平铺布局：<root>/<project>/<id>.jsonl
  await mkdir(join(root, 'proj-b'), { recursive: true })
  await writeFile(join(root, 'proj-b', 'legacy.jsonl'), call('c2', 'skill'))
})

after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('createFileSource', () => {
  it('列出目录布局与平铺布局的会话', async () => {
    const source = createFileSource(root)
    const metas = await source.list()
    const ids = metas.map((meta) => meta.id).sort()
    assert.deepEqual(ids, ['legacy', 'session-1'])
    assert.ok(metas.every((meta) => meta.createdAt > 0))
  })

  it('读取会话事件', async () => {
    const source = createFileSource(root)
    const events = await source.read('session-1')
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'tool/call')
  })

  it('未知会话抛错', async () => {
    const source = createFileSource(root)
    await assert.rejects(() => source.read('nope'), /找不到会话/)
  })

  it('标签包含根目录，便于在报告里定位', () => {
    assert.match(createFileSource(root).label, /^jsonl:/)
  })

  it('目录不存在时 resolveFileSource 返回 undefined', async () => {
    assert.equal(await resolveFileSource(join(root, 'missing')), undefined)
    assert.ok(await resolveFileSource(root))
  })
})

const zstd = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync

describe('zstd 存档', { skip: typeof zstd !== 'function' ? '当前 Node 无 zstd 压缩 API' : false }, () => {
  it('能解压 session.jsonl.zstd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-audit-zstd-'))
    const sessionDir = join(dir, 'proj', 'z-1')
    await mkdir(sessionDir, { recursive: true })
    const text = [header, call('c1', 'skill')].join('\n')
    await writeFile(join(sessionDir, 'session.jsonl.zstd'), (zstd as (input: Buffer) => Buffer)(Buffer.from(text)))

    const source = createFileSource(dir)
    const events = await source.read('z-1')
    assert.equal(events.length, 1)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('createQuerySource', () => {
  const query: SessionQueryLike = {
    async listSessions() {
      return [{ header: { id: 's-1', createdAt: 10 } }, { header: {} }, { header: { id: 's-2', createdAt: 20 } }]
    },
    async readSession(sessionId: string) {
      return { session: { id: sessionId }, events: [{ type: 'tool/call', time: 1, data: {} }] }
    },
  }

  it('过滤掉没有 id 的记录并保留时间', async () => {
    const metas = await createQuerySource(query).list()
    assert.deepEqual(metas, [
      { id: 's-1', createdAt: 10 },
      { id: 's-2', createdAt: 20 },
    ])
  })

  it('read 返回事件副本', async () => {
    const events = await createQuerySource(query).read('s-1')
    assert.equal(events.length, 1)
  })

  it('标签为 sessionQuery', () => {
    assert.equal(createQuerySource(query).label, 'sessionQuery')
  })
})

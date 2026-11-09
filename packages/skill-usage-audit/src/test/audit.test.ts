import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { generateUsageReport } from '../audit.js'
import type { SessionEventLike, SessionSource } from '../types.js'

const T0 = Date.UTC(2026, 10, 8, 6, 0)

const events: SessionEventLike[] = [
  {
    type: 'tool/call',
    time: T0,
    data: { callId: 'c1', name: 'skill', arguments: '{"name":"game-studio-concept"}' },
  },
  {
    type: 'tool/result',
    time: T0 + 1000,
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false }] } },
  },
  {
    type: 'tool/call',
    time: T0 + 2000,
    data: { callId: 'c2', name: 'skill', arguments: '{"name":"game-studio-design"}' },
  },
  {
    type: 'tool/result',
    time: T0 + 3000,
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2', isError: true }] } },
  },
]

function fakeSource(options: { failOn?: string } = {}): SessionSource {
  return {
    label: 'fake',
    async list() {
      return [
        { id: 'newer', createdAt: T0 },
        { id: 'older', createdAt: T0 - 3600_000 },
      ]
    },
    async read(id: string) {
      if (options.failOn === id) throw new Error('读取失败')
      return events
    },
  }
}

describe('generateUsageReport', () => {
  it('聚合结果与报告文本一致', async () => {
    const outcome = await generateUsageReport({
      days: 7,
      source: fakeSource(),
      now: T0 + 600_000,
    })
    assert.equal(outcome.result.entries.length, 2)
    // 两个会话读的都是同一批事件，各调用一次 → 2 次
    assert.equal(outcome.result.callsInWindow, 4)
    assert.match(outcome.report, /数据源：fake/)
    assert.match(outcome.report, /game-studio-concept/)
  })

  it('maxSessions 限制读取的会话数量（按创建时间倒序）', async () => {
    const seen: string[] = []
    const source = fakeSource()
    const outcome = await generateUsageReport({
      days: 7,
      source: {
        label: 'fake',
        list: source.list,
        async read(id) {
          seen.push(id)
          return events
        },
      },
      maxSessions: 1,
      now: T0 + 600_000,
    })
    assert.deepEqual(seen, ['newer'])
    assert.equal(outcome.result.scannedSessions, 1)
  })

  it('单个会话读取失败时跳过并计数', async () => {
    const outcome = await generateUsageReport({
      days: 7,
      source: fakeSource({ failOn: 'older' }),
      now: T0 + 600_000,
    })
    assert.equal(outcome.result.failedSessions, 1)
    assert.equal(outcome.result.scannedSessions, 1)
    assert.match(outcome.report, /有 1 个会话读取失败/)
  })

  it('取消信号生效后停止读取更多会话', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await generateUsageReport({
      days: 7,
      source: fakeSource(),
      signal: controller.signal,
      now: T0 + 600_000,
    })
    assert.equal(outcome.result.scannedSessions, 0)
  })

  it('skillPrefix 透传到统计与报告', async () => {
    const outcome = await generateUsageReport({
      days: 7,
      source: fakeSource(),
      skillPrefix: 'game-studio-d',
      now: T0 + 600_000,
    })
    assert.deepEqual(
      outcome.result.entries.map((entry) => entry.skillName),
      ['game-studio-design'],
    )
    assert.match(outcome.report, /仅统计名称以「game-studio-d」开头的技能/)
  })
})

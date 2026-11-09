import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { looksLikeEvent, parseSessionLog } from '../logfile.js'

const header = JSON.stringify({ session: { id: 'session-1', createdAt: 1_760_000_000_000, version: 0 } })
const call = JSON.stringify({
  type: 'tool/call',
  seq: 1,
  time: 1_760_000_001_000,
  data: { turn: 1, step: 1, callId: 'c1', name: 'skill', arguments: '{"name":"x"}' },
})
const result = JSON.stringify({
  type: 'tool/result',
  seq: 2,
  time: 1_760_000_002_000,
  data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } },
})

describe('parseSessionLog', () => {
  it('解析头行与事件行', () => {
    const parsed = parseSessionLog([header, call, result].join('\n'))
    assert.equal(parsed.header?.id, 'session-1')
    assert.equal(parsed.header?.createdAt, 1_760_000_000_000)
    assert.equal(parsed.events.length, 2)
    assert.equal(parsed.events[0]?.type, 'tool/call')
    assert.equal(parsed.skippedLines, 0)
  })

  it('忽略压缩块行，不计入坏行', () => {
    const packed = JSON.stringify({ 'tool-call-chunks': { seq0: 3, time0: 1, members: [] } })
    const parsed = parseSessionLog([header, packed, call].join('\n'))
    assert.equal(parsed.events.length, 1)
    assert.equal(parsed.skippedLines, 0)
  })

  it('坏行跳过并计数，不影响其余事件', () => {
    const parsed = parseSessionLog([header, '{not json', call, '42'].join('\n'))
    assert.equal(parsed.events.length, 1)
    assert.equal(parsed.skippedLines, 2)
  })

  it('支持 { session, events } 包装形态', () => {
    const wrapper = JSON.stringify({
      session: { id: 'session-2', createdAt: 123 },
      events: [JSON.parse(call), JSON.parse(result)],
    })
    const parsed = parseSessionLog(wrapper)
    assert.equal(parsed.header?.id, 'session-2')
    assert.equal(parsed.events.length, 2)
  })

  it('纯事件行数组', () => {
    const parsed = parseSessionLog(JSON.stringify([JSON.parse(call)]))
    assert.equal(parsed.events.length, 1)
  })

  it('空文本返回空结果', () => {
    const parsed = parseSessionLog('\n\n')
    assert.deepEqual(parsed.events, [])
    assert.equal(parsed.header, undefined)
  })

  it('looksLikeEvent 只认带 type 的对象', () => {
    assert.equal(looksLikeEvent({ type: 'tool/call' }), true)
    assert.equal(looksLikeEvent({ session: {} }), false)
    assert.equal(looksLikeEvent(null), false)
    assert.equal(looksLikeEvent([{ type: 'x' }]), false)
  })
})

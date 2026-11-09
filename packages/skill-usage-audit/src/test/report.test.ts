import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregate,
  displayWidth,
  formatReport,
  formatTime,
  isFailureResult,
  resolveSkillName,
  resultCallId,
  type AggregateOptions,
} from '../report.js'
import type { LoadedSession, SessionEventLike } from '../types.js'

const T0 = Date.UTC(2026, 10, 8, 6, 23) // 2026-11-08T06:23Z

function call(callId: string, tool: string, args: unknown, time = T0): SessionEventLike {
  return {
    type: 'tool/call',
    time,
    data: { turn: 1, step: 1, callId, name: tool, arguments: JSON.stringify(args) },
  }
}

function result(callId: string, isError: boolean, time = T0 + 1000): SessionEventLike {
  return {
    type: 'tool/result',
    time,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }] },
    },
  }
}

function skillCall(callId: string, skill: string, time = T0): SessionEventLike {
  return call(callId, 'skill', { name: skill }, time)
}

function session(id: string, events: SessionEventLike[]): LoadedSession {
  return { id, events }
}

const baseOptions: AggregateOptions = { since: 0 }

describe('resolveSkillName', () => {
  it('从 skill 调度器的 name 参数解析技能名', () => {
    assert.equal(resolveSkillName('skill', { name: 'game-studio-design' }, baseOptions), 'game-studio-design')
  })

  it('调度器缺少技能名参数时返回 null', () => {
    assert.equal(resolveSkillName('skill', {}, baseOptions), null)
    assert.equal(resolveSkillName('skill', undefined, baseOptions), null)
  })

  it('普通工具默认不计入技能统计', () => {
    assert.equal(resolveSkillName('bash', { command: 'ls' }, baseOptions), null)
  })

  it('knownSkills 里列出的独立工具会计入', () => {
    const options: AggregateOptions = { since: 0, knownSkills: ['game-studio-build'] }
    assert.equal(resolveSkillName('game-studio-build', {}, options), 'game-studio-build')
  })

  it('includeGenericTools=true 时所有工具按工具名计入', () => {
    const options: AggregateOptions = { since: 0, includeGenericTools: true }
    assert.equal(resolveSkillName('bash', {}, options), 'bash')
  })

  it('支持调度器通配', () => {
    const options: AggregateOptions = { since: 0, dispatcherTools: ['skill*'] }
    assert.equal(resolveSkillName('skill-v2', { name: 'x' }, options), 'x')
  })
})

describe('事件解析', () => {
  it('从结果块取 callId', () => {
    assert.equal(resultCallId(result('c9', false).data), 'c9')
  })

  it('从事件 error 字段判断失败', () => {
    assert.equal(isFailureResult({ error: { name: 'Error', code: 'X' } }), true)
  })

  it('从结果块 isError 判断失败', () => {
    assert.equal(isFailureResult(result('c1', true).data), true)
    assert.equal(isFailureResult(result('c1', false).data), false)
  })
})

describe('aggregate', () => {
  it('统计调用、成功、失败与最近调用时间', () => {
    const events = [
      skillCall('c1', 'game-studio-concept'),
      result('c1', false),
      skillCall('c2', 'game-studio-design', T0 + 5000),
      result('c2', true, T0 + 6000),
      skillCall('c3', 'game-studio-build', T0 + 7000),
      result('c3', false, T0 + 8000),
      skillCall('c4', 'game-studio-build', T0 + 9000),
      result('c4', false, T0 + 9500),
    ]
    const result_ = aggregate([session('s1', events)], baseOptions)
    const byName = new Map(result_.entries.map((entry) => [entry.skillName, entry]))

    assert.equal(result_.entries.length, 3)
    assert.equal(result_.callsInWindow, 4)
    assert.equal(byName.get('game-studio-concept')?.callCount, 1)
    assert.equal(byName.get('game-studio-design')?.failureCount, 1)
    assert.equal(byName.get('game-studio-build')?.callCount, 2)
    assert.equal(byName.get('game-studio-build')?.lastCalledAt, T0 + 9000)
    // 调用次数降序
    assert.equal(result_.entries[0]?.skillName, 'game-studio-build')
  })

  it('没有结果的调用记为待定，不计入成功或失败', () => {
    const events = [skillCall('c1', 'x'), result('c1', false), skillCall('c2', 'x')]
    const entry = aggregate([session('s1', events)], baseOptions).entries[0]
    assert.equal(entry?.callCount, 2)
    assert.equal(entry?.successCount, 1)
    assert.equal(entry?.pendingCount, 1)
  })

  it('窗口外的事件被忽略', () => {
    const events = [
      skillCall('old', 'x', T0 - 10 * 24 * 3600_000),
      skillCall('new', 'x', T0),
      result('new', false),
    ]
    const result_ = aggregate([session('s1', events)], { since: T0 - 3600_000 })
    assert.equal(result_.callsInWindow, 1)
    assert.equal(result_.entries[0]?.callCount, 1)
  })

  it('skillPrefix 过滤技能名', () => {
    const events = [
      skillCall('c1', 'game-studio-concept'),
      result('c1', false),
      skillCall('c2', 'other-tool'),
      result('c2', false),
    ]
    const result_ = aggregate([session('s1', events)], { since: 0, skillPrefix: 'game-studio-' })
    assert.deepEqual(
      result_.entries.map((entry) => entry.skillName),
      ['game-studio-concept'],
    )
  })

  it('includeSessions 收集去重后的会话 ID', () => {
    const events = [skillCall('c1', 'x'), result('c1', false), skillCall('c2', 'x'), result('c2', false)]
    const withSessions = aggregate(
      [session('s1', events), session('s2', [skillCall('c9', 'x'), result('c9', false)])],
      { since: 0, includeSessions: true },
    )
    assert.deepEqual(withSessions.entries[0]?.sessionIds.sort(), ['s1', 's2'])

    const withoutSessions = aggregate([session('s1', events)], baseOptions)
    assert.deepEqual(withoutSessions.entries[0]?.sessionIds, [])
  })

  it('调度器调用缺 name 时计入 unresolved，而非静默丢弃', () => {
    const events = [call('c1', 'skill', {})]
    const result_ = aggregate([session('s1', events)], baseOptions)
    assert.equal(result_.entries.length, 0)
    assert.equal(result_.unresolvedCalls, 1)
  })

  it('参数不是合法 JSON 时按缺省处理', () => {
    const events: SessionEventLike[] = [
      { type: 'tool/call', time: T0, data: { callId: 'c1', name: 'skill', arguments: '{oops' } },
    ]
    const result_ = aggregate([session('s1', events)], baseOptions)
    assert.equal(result_.unresolvedCalls, 1)
  })

  it('空会话返回空结果', () => {
    const result_ = aggregate([], baseOptions)
    assert.deepEqual(result_.entries, [])
    assert.equal(result_.callsInWindow, 0)
  })
})

describe('formatReport', () => {
  const options = { days: 7, now: T0, sourceLabel: 'sessionQuery' }

  it('空结果给出明确文案', () => {
    const report = formatReport(aggregate([], baseOptions), options)
    assert.match(report, /技能使用报告（最近 7 天）/)
    assert.match(report, /没有技能调用记录/)
    assert.match(report, /数据源：sessionQuery/)
  })

  it('输出表头、数据行与汇总行', () => {
    const events = [
      skillCall('c1', 'game-studio-concept'),
      result('c1', false),
      skillCall('c2', 'game-studio-concept'),
      result('c2', true),
    ]
    const report = formatReport(aggregate([session('s1', events)], baseOptions), options)
    assert.match(report, /技能名称\s+调用\s+成功\s+失败\s+最近调用/)
    assert.match(report, /game-studio-concept\s+2\s+1\s+1/)
    assert.match(report, /共 1 个技能被调用，2 次调用，1 次失败/)
  })

  it('有待定调用时增加「待定」列', () => {
    const events = [skillCall('c1', 'x'), result('c1', false), skillCall('c2', 'x')]
    const report = formatReport(aggregate([session('s1', events)], baseOptions), options)
    assert.match(report, /待定/)
    assert.match(report, /1 次未拿到结果/)
  })

  it('报告零调用的已知技能', () => {
    const events = [skillCall('c1', 'game-studio-concept'), result('c1', false)]
    const report = formatReport(aggregate([session('s1', events)], baseOptions), {
      ...options,
      knownSkills: ['game-studio-concept', 'game-studio-qa', 'game-studio-release'],
    })
    assert.match(report, /未被调用的技能：game-studio-qa, game-studio-release（共 2 个）/)
  })

  it('超过 maxRows 时截断并提示', () => {
    const events: SessionEventLike[] = []
    for (let index = 0; index < 5; index++) {
      events.push(skillCall(`c${index}`, `skill-${index}`), result(`c${index}`, false))
    }
    const report = formatReport(aggregate([session('s1', events)], baseOptions), {
      ...options,
      maxRows: 2,
    })
    assert.match(report, /另有 3 个技能未列出/)
  })

  it('提前缀提示与失败会话提示', () => {
    const result_ = aggregate([session('s1', [skillCall('c1', 'game-studio-concept'), result('c1', false)])], {
      since: 0,
      skillPrefix: 'game-studio-',
    })
    result_.failedSessions = 2
    const report = formatReport(result_, { ...options, skillPrefix: 'game-studio-' })
    assert.match(report, /仅统计名称以「game-studio-」开头的技能/)
    assert.match(report, /有 2 个会话读取失败/)
  })

  it('中文技能名按显示宽度对齐，不串列', () => {
    const events = [
      skillCall('c1', '文档排版'),
      result('c1', false),
      skillCall('c2', 'pdf'),
      result('c2', false),
    ]
    const report = formatReport(aggregate([session('s1', events)], baseOptions), options)
    const rows = report.split('\n').filter((line) => line.startsWith('文档排版') || line.startsWith('pdf'))
    assert.equal(rows.length, 2)
    const numbers = rows.map((line) => line.match(/\s+(\d+)\s+(\d+)\s+(\d+)\s/)?.[1])
    assert.deepEqual(numbers, ['1', '1'])
  })
})

describe('工具函数', () => {
  it('displayWidth 把 CJK 算作两列', () => {
    assert.equal(displayWidth('abc'), 3)
    assert.equal(displayWidth('技能'), 4)
    assert.equal(displayWidth('a技b'), 4)
  })

  it('formatTime 输出 MM-DD HH:mm，非法值返回占位符', () => {
    assert.match(formatTime(T0), /^\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.equal(formatTime(0), '-')
  })
})

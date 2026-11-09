import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../index.js'
import type { SessionQueryLike } from '../types.js'

const T0 = Date.UTC(2026, 10, 8, 6, 0)

const query: SessionQueryLike = {
  async listSessions() {
    return [{ header: { id: 's-1', createdAt: T0 } }]
  },
  async readSession(sessionId: string) {
    return {
      session: { id: sessionId },
      events: [
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
      ],
    }
  },
}

interface Harness {
  ctx: Context
  definition: () => ToolDefinition
}

function createHarness(options: { query?: SessionQueryLike; sessionsRoot?: string } = {}): Harness {
  const registered: ToolDefinition[] = []
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        registered.push(definition)
        return () => {}
      },
    },
    get(name: string) {
      return name === 'sessionQuery' ? options.query : undefined
    },
    on() {
      return () => true
    },
  } as unknown as Context

  const config: Config = {
    knownSkills: ['game-studio-concept', 'game-studio-qa'],
    ...(options.sessionsRoot !== undefined ? { sessionsRoot: options.sessionsRoot } : {}),
  }
  apply(ctx, config)

  return {
    ctx,
    definition: () => {
      const definition = registered[0]
      assert.ok(definition, 'apply 应注册 skill_usage_report 工具')
      return definition
    },
  }
}

const exec = { signal: new AbortController().signal } as never

describe('skill_usage_report 工具', () => {
  it('注册正确的工具名与参数', () => {
    const harness = createHarness({ query })
    const definition = harness.definition()
    assert.equal(definition.name, 'skill_usage_report')
    const properties = (definition.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    assert.deepEqual(Object.keys(properties).sort(), ['days', 'includeSessions', 'skillPrefix'])
  })

  it('走 sessionQuery 生成报告，并把字符串渲染成文本块', async () => {
    const harness = createHarness({ query })
    const definition = harness.definition()
    const value = (await definition.execute({ days: 7 }, exec)) as string

    assert.match(value, /技能使用报告（最近 7 天）/)
    assert.match(value, /数据源：sessionQuery/)
    assert.match(value, /game-studio-concept/)
    assert.match(value, /未被调用的技能：game-studio-qa/)

    const blocks = definition.output.render({ days: 7 }, value)
    assert.deepEqual(blocks, [{ type: 'text', text: value }])
  })

  it('参数 days 缺省时用配置默认值', async () => {
    const harness = createHarness({ query })
    const value = (await harness.definition().execute({}, exec)) as string
    assert.match(value, /最近 7 天/)
  })

  it('没有 sessionQuery 且存档目录不存在时给出修复指引', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'skill-audit-missing-'))
    const harness = createHarness({ sessionsRoot: join(missing, 'nope') })
    await assert.rejects(
      () => harness.definition().execute({ days: 1 }, exec),
      /没有可用的会话数据源/,
    )
    await rm(missing, { recursive: true, force: true })
  })
})

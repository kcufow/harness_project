import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../index.js'
import { RuleConfigError } from '../rules.js'

type Decision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
type Handler = (exec: unknown, next: () => Promise<Decision>) => Promise<Decision>

/**
 * 最小假上下文：只实现 apply 用到的 `ctx.on`。
 * 目的是验证“预检只收紧、不放宽下游决策”这一组合不变量。
 */
function createHarness(): {
  ctx: Context
  run: (exec: { name: string; arguments: unknown }, downstream?: Decision) => Promise<Decision>
} {
  const handlers: Handler[] = []
  const ctx = {
    on: (_event: string, handler: Handler) => {
      handlers.push(handler)
      return () => true
    },
  } as unknown as Context

  return {
    ctx,
    run: async (exec, downstream) => {
      const handler = handlers[0]
      assert.ok(handler, 'apply 应注册 tools/pre-execute 监听器')
      return handler(exec, async () => downstream ?? { kind: 'allow' })
    },
  }
}

const config: Config = {
  rules: [
    {
      id: 'rm-recursive',
      match: { tool: 'bash', commandPattern: 'rm\\s+-[a-z]*r' },
      mode: 'ask',
      checklist: ['已确认目标路径正确', '已确认有回滚方案'],
    },
    {
      id: 'deny-env',
      match: { tool: 'write', pathPattern: '\\.env$' },
      mode: 'block',
      message: '拒绝写入敏感文件。',
    },
  ],
  logDecisions: false,
}

describe('apply', () => {
  it('命中 ask 规则时返回 ask，并把检查清单写进 reason', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    const decision = await harness.run({ name: 'bash', arguments: { command: 'rm -rf /tmp/x' } })
    assert.equal(decision.kind, 'ask')
    const reason = decision.kind === 'ask' ? (decision.reason ?? '') : ''
    assert.match(reason, /已确认目标路径正确/)
  })

  it('命中 block 规则时返回 deny', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    const decision = await harness.run({ name: 'write', arguments: { file_path: '.env', content: 'x' } })
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.kind === 'deny' ? decision.reason : '', '拒绝写入敏感文件。')
  })

  it('未命中规则时放行', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    const decision = await harness.run({ name: 'bash', arguments: { command: 'ls -la' } })
    assert.equal(decision.kind, 'allow')
  })

  it('下游已 deny 时原样返回，绝不放宽成 ask', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    const decision = await harness.run(
      { name: 'bash', arguments: { command: 'rm -rf /tmp/x' } },
      { kind: 'deny', reason: 'tool-guard 已拒绝' },
    )
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.kind === 'deny' ? decision.reason : '', 'tool-guard 已拒绝')
  })

  it('下游已 ask 时原样返回，不覆盖其他插件的确认流程', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    const decision = await harness.run(
      { name: 'bash', arguments: { command: 'rm -rf /tmp/x' } },
      { kind: 'ask', reason: '另一个插件的确认' },
    )
    assert.equal(decision.kind, 'ask')
    assert.equal(decision.kind === 'ask' ? decision.reason : '', '另一个插件的确认')
  })

  it('配置里正则写错时加载即失败（fail fast）', () => {
    const harness = createHarness()
    assert.throws(
      () => apply(harness.ctx, { rules: [{ id: 'bad', match: { commandPattern: '(unclosed' } }] }),
      RuleConfigError,
    )
  })

  it('空规则集加载后不拦截任何调用', async () => {
    const harness = createHarness()
    apply(harness.ctx, { rules: [], logDecisions: false })
    const decision = await harness.run({ name: 'bash', arguments: { command: 'rm -rf /' } })
    assert.equal(decision.kind, 'allow')
  })
})

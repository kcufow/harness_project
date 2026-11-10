/**
 * 端到端冒烟：不依赖 dsh CLI，直接加载两个插件的已编译产物（lib/），
 * 用最小 cordis 风格上下文走一遍「插件 apply → 拦截生效 / 工具注册 → 报告生成」。
 *
 * 与单元测试的差别：这里按包名解析真实入口，跨模块串联真实的规则编译、
 * defineTool、数据源与报告渲染，能抓到单测里被 mock 掉的接线问题。
 *
 * 注意：事件与会话是构造数据，本脚本不能替代真实 Harness 集成验证。
 * 使用前需先 npm run build。
 */
import assert from 'node:assert/strict'
import { apply as applyPrecheck } from 'dangerous-op-precheck'
import { apply as applyAudit } from 'skill-usage-audit'

const passed = []

async function step(label, fn) {
  await fn()
  passed.push(label)
  console.log(`ok - ${label}`)
}

async function smokePrecheck() {
  let handler
  const ctx = {
    on(event, fn) {
      assert.equal(event, 'tools/pre-execute', '预检插件应挂在 tools/pre-execute')
      handler = fn
    },
  }

  applyPrecheck(ctx, {
    logDecisions: false,
    rules: [
      {
        id: 'rm-recursive',
        match: { tool: 'bash', commandPattern: 'rm\\s+-[a-z]*r' },
        mode: 'ask',
        checklist: ['确认目标路径正确', '确认有可用备份'],
      },
      {
        id: 'deny-secrets',
        match: { tool: ['write', 'edit'], pathPattern: '\\.env(\\..*)?$' },
        mode: 'block',
        message: '拒绝写入敏感文件',
      },
    ],
  })

  await step('预检插件加载并挂上 pre-execute 监听', () => {
    assert.equal(typeof handler, 'function')
  })

  const allow = async () => ({ kind: 'allow' })

  await step('ask 规则命中返回审批决策且带编号检查清单', async () => {
    const decision = await handler({ name: 'bash', arguments: { command: 'rm -rf /tmp/demo' } }, allow)
    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /1\. 确认目标路径正确/)
    assert.match(decision.reason, /2\. 确认有可用备份/)
  })

  await step('block 规则命中直接拒绝', async () => {
    const decision = await handler({ name: 'write', arguments: { file_path: '/app/.env.local' } }, allow)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /拒绝写入敏感文件/)
  })

  await step('未命中规则时放行', async () => {
    const decision = await handler({ name: 'read', arguments: { file_path: '/app/README.md' } }, allow)
    assert.equal(decision.kind, 'allow')
  })

  await step('下游已拒绝时只收紧不放宽', async () => {
    const downstream = { kind: 'deny', reason: '来自其他守卫' }
    const decision = await handler(
      { name: 'bash', arguments: { command: 'rm -rf /tmp/demo' } },
      async () => downstream,
    )
    assert.deepEqual(decision, downstream)
  })
}

async function smokeAudit() {
  const now = Date.now()
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      time: now - 4000,
      data: { callId: 'c1', name: 'skill', arguments: JSON.stringify({ name: 'game-studio-concept' }) },
    },
    {
      type: 'tool/result',
      seq: 2,
      time: now - 3000,
      data: { message: { content: [{ toolCallId: 'c1' }] } },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: now - 2000,
      data: { callId: 'c2', name: 'skill', arguments: JSON.stringify({ name: 'game-studio-design' }) },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: now - 1000,
      data: {
        error: { name: 'Error', code: 'E_FAIL' },
        message: { content: [{ toolCallId: 'c2' }] },
      },
    },
  ]

  const query = {
    async listSessions() {
      return [{ header: { id: 's1', createdAt: now } }]
    },
    async readSession(id) {
      assert.equal(id, 's1')
      return { session: { id }, events }
    },
  }

  let tool
  const ctx = {
    get(service) {
      return service === 'sessionQuery' ? query : undefined
    },
    tools: {
      register(registered) {
        tool = registered
      },
    },
  }

  applyAudit(ctx, {
    knownSkills: ['game-studio-concept', 'game-studio-design', 'game-studio-release'],
  })

  await step('审计插件加载并注册 skill_usage_report 工具', () => {
    assert.equal(tool?.name, 'skill_usage_report')
  })

  await step('走 sessionQuery 数据源生成报告，成功/失败/零调用统计正确', async () => {
    const report = await tool.execute({ days: 7 }, {})
    assert.match(report, /sessionQuery/)
    assert.match(report, /game-studio-concept/)
    assert.match(report, /game-studio-design/)
    assert.match(report, /共 2 个技能被调用/)
    assert.match(report, /1 次失败/)
    assert.match(report, /未被调用的技能：game-studio-release/)
  })
}

console.log('端到端冒烟（构造数据，非真实 Harness）')
try {
  await smokePrecheck()
  await smokeAudit()
  console.log(`\n通过 ${passed.length} 项检查`)
} catch (error) {
  console.error(`\n冒烟失败：${error?.stack ?? error}`)
  process.exitCode = 1
}

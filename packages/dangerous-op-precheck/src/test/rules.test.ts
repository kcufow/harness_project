import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  RuleConfigError,
  buildAskReason,
  collectCommands,
  collectPaths,
  compileRules,
  describeTarget,
  findMatchingRule,
  toDecision,
  type Rule,
} from '../rules.js'

const rmRule: Rule = {
  id: 'rm-recursive',
  match: { tool: 'bash', commandPattern: 'rm\\s+-[a-z]*r|mkfs|dd\\s+if=' },
  mode: 'ask',
  checklist: ['已确认目标路径正确', '已确认有回滚方案', '已确认删除范围不超出预期'],
}

const envRule: Rule = {
  id: 'deny-env',
  match: { tool: 'write', pathPattern: '\\.env(\\..*)?$|id_rsa' },
  mode: 'block',
  message: '拒绝写入敏感文件。',
}

describe('compileRules', () => {
  it('编译合法规则并保留配置顺序', () => {
    const compiled = compileRules([rmRule, envRule])
    assert.equal(compiled.length, 2)
    assert.deepEqual(
      compiled.map((rule) => rule.ruleId),
      ['rm-recursive', 'deny-env'],
    )
    assert.equal(compiled[0]?.mode, 'ask')
  })

  it('mode 缺省为 ask', () => {
    const compiled = compileRules([{ id: 'x', match: { tool: 'bash' } }])
    assert.equal(compiled[0]?.mode, 'ask')
  })

  it('正则语法错误时抛出带字段定位的错误', () => {
    assert.throws(
      () => compileRules([{ id: 'bad', match: { commandPattern: 'rm (unclosed' } }]),
      (error: unknown) => {
        assert.ok(error instanceof RuleConfigError)
        assert.match(error.message, /commandPattern/)
        assert.match(error.message, /bad/)
        return true
      },
    )
  })

  it('match 含未知字段时抛错，避免规则静默失效', () => {
    assert.throws(
      () => compileRules([{ id: 'typo', match: { commandPatern: 'rm' } as never }]),
      /未知字段：commandPatern/,
    )
  })

  it('match 为空时抛错（防止误拦截所有调用）', () => {
    assert.throws(() => compileRules([{ id: 'empty', match: {} }]), /没有任何触发条件/)
  })

  it('match.tool 为 "*" 时视为拦截全部', () => {
    const compiled = compileRules([{ id: 'all', match: { tool: '*' } }])
    const hit = findMatchingRule(compiled, { toolName: 'read', args: {} })
    assert.equal(hit?.ruleId, 'all')
  })

  it('空配置返回空数组', () => {
    assert.deepEqual(compileRules(undefined), [])
    assert.deepEqual(compileRules([]), [])
  })
})

describe('findMatchingRule', () => {
  const compiled = compileRules([rmRule, envRule])

  it('命令正则命中 bash 调用', () => {
    const hit = findMatchingRule(compiled, {
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/build', description: '删除构建目录' },
    })
    assert.equal(hit?.ruleId, 'rm-recursive')
  })

  it('工具名不同则不命中', () => {
    const hit = findMatchingRule(compiled, {
      toolName: 'read',
      args: { command: 'rm -rf /tmp/build' },
    })
    assert.equal(hit, undefined)
  })

  it('没有命令参数时不命中（避免空字符串误匹配）', () => {
    const hit = findMatchingRule(compiled, { toolName: 'bash', args: { description: 'rm 相关' } })
    assert.equal(hit, undefined)
  })

  it('路径正则命中 write 的 file_path', () => {
    const hit = findMatchingRule(compiled, {
      toolName: 'write',
      args: { file_path: '/repo/.env.local', content: 'SECRET=1' },
    })
    assert.equal(hit?.ruleId, 'deny-env')
  })

  it('嵌套数组中的路径也参与匹配', () => {
    const hit = findMatchingRule(compiled, {
      toolName: 'write',
      args: { files: [{ path: 'keys/id_rsa' }] },
    })
    assert.equal(hit?.ruleId, 'deny-env')
  })

  it('先命中先用（first match wins）', () => {
    const overlapping = compileRules([
      { id: 'first', match: { tool: 'bash' }, mode: 'block' },
      { id: 'second', match: { tool: 'bash' }, mode: 'ask' },
    ])
    const hit = findMatchingRule(overlapping, { toolName: 'bash', args: { command: 'ls' } })
    assert.equal(hit?.ruleId, 'first')
  })

  it('支持工具名通配', () => {
    const glob = compileRules([{ id: 'glob', match: { tool: 'bash*' } }])
    assert.equal(findMatchingRule(glob, { toolName: 'bash-persistent', args: {} })?.ruleId, 'glob')
  })

  it('argsPattern 对整个参数 JSON 生效', () => {
    const byArgs = compileRules([{ id: 'by-args', match: { argsPattern: 'production' } }])
    const hit = findMatchingRule(byArgs, {
      toolName: 'deploy',
      args: { env: 'production', version: '1.2.3' },
    })
    assert.equal(hit?.ruleId, 'by-args')
  })
})

describe('决策文本', () => {
  const compiled = compileRules([rmRule, envRule])

  it('ask 理由包含编号清单与目标命令', () => {
    const rule = compiled[0]!
    const reason = buildAskReason(rule, {
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/build' },
    })
    assert.match(reason, /危险操作预检：规则「rm-recursive」/)
    assert.match(reason, /工具：bash/)
    assert.match(reason, /rm -rf \/tmp\/build/)
    assert.match(reason, /1\. 已确认目标路径正确/)
    assert.match(reason, /3\. 已确认删除范围不超出预期/)
  })

  it('ask 无 checklist 时退回 message 或默认文案', () => {
    const rule = compileRules([{ id: 'bare', match: { tool: 'bash' } }])[0]!
    const reason = buildAskReason(rule, { toolName: 'bash', args: { command: 'ls' } })
    assert.match(reason, /请确认是否继续执行该操作/)
  })

  it('toDecision：block 模式给出 deny 与自定义理由', () => {
    const decision = toDecision(compiled[1]!, {
      toolName: 'write',
      args: { file_path: '.env' },
    })
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.kind === 'deny' ? decision.reason : '', '拒绝写入敏感文件。')
  })

  it('toDecision：block 未配置 message 时自动生成理由', () => {
    const rule = compileRules([{ id: 'no-msg', match: { tool: 'bash' }, mode: 'block' }])[0]!
    const decision = toDecision(rule, { toolName: 'bash', args: { command: 'shutdown now' } })
    assert.equal(decision.kind, 'deny')
    assert.match(decision.kind === 'deny' ? decision.reason : '', /no-msg/)
  })

  it('toDecision：ask 模式返回 ask 决策', () => {
    const decision = toDecision(compiled[0]!, { toolName: 'bash', args: { command: 'rm -rf x' } })
    assert.equal(decision.kind, 'ask')
  })
})

describe('参数提取', () => {
  it('收集命令键（command / cmd / script）', () => {
    assert.deepEqual(collectCommands({ command: 'ls -la', cmd: 'pwd' }), ['ls -la', 'pwd'])
  })

  it('收集路径键（file_path / path / 数组）', () => {
    const paths = collectPaths({ file_path: 'a.txt', files: ['b.txt', { path: 'c.txt' }] })
    assert.deepEqual(paths.sort(), ['a.txt', 'b.txt', 'c.txt'])
  })

  it('去重并忽略空串', () => {
    assert.deepEqual(collectPaths({ path: 'a', target: ' a ' }), ['a'])
    assert.deepEqual(collectCommands({ command: '   ' }), [])
  })

  it('参数为 undefined / null 时返回空数组', () => {
    assert.deepEqual(collectCommands(undefined), [])
    assert.deepEqual(collectPaths(null), [])
  })

  it('describeTarget 折叠空白并截断', () => {
    const long = `rm -rf ${'x'.repeat(300)}`
    const text = describeTarget({ toolName: 'bash', args: { command: `  rm   -rf \n ${'x'.repeat(300)}` } }, 40)
    assert.ok(text.length <= 41)
    assert.ok(!text.includes('\n'))
    assert.ok(long.startsWith('rm -rf'))
    assert.ok(text.startsWith('rm -rf x'))
  })

  it('无可用参数时退回工具名', () => {
    assert.equal(describeTarget({ toolName: 'bash', args: {} }), 'bash')
  })
})

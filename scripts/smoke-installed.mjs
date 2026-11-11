/**
 * 真机验证冒烟：加载 dsh web profile 里由 tarball 解包出来的插件产物，
 * 验证入口可解析、apply 可用、pre-execute 拦截与工具注册生效。
 *
 * 与 `npm run smoke` 的区别：
 * - `smoke` 加载 workspace 的 lib/，走包名解析，验证源码接线；
 * - `smoke:installed` 加载 ~/.dsh/profiles/web/node_modules 下的**发布产物**，
 *   能抓到 npm pack 漏文件、exports 指错、peer 依赖在宿主缺失等问题。
 *
 * 前置：npm ci && npm run build && npm pack --workspaces，
 *      并用 `dsh plugin --profile web add <tgz>` 装好两个插件。
 *
 * 注意：会话数据仍是构造数据，本脚本不能替代真实 Harness 交互验证。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileRoot =
  process.env.DSH_PROFILE_NODE_MODULES ||
  join(homedir(), '.dsh', 'profiles', 'web', 'node_modules')

const packages = ['dangerous-op-precheck', 'skill-usage-audit']
const missing = packages.filter((name) => !existsSync(join(profileRoot, name, 'lib', 'index.js')))
if (missing.length > 0) {
  console.error(`未找到已安装的插件产物：${missing.join(', ')}`)
  console.error(`查找目录：${profileRoot}`)
  console.error('请先执行：npm pack --workspaces && npx @deepseek-ai/dsh plugin --profile web add <tgz>')
  console.error('或设置 DSH_PROFILE_NODE_MODULES 指向其它 profile 的 node_modules。')
  process.exit(1)
}

const url = (name) => pathToFileURL(join(profileRoot, name, 'lib', 'index.js')).href
const passed = []

async function step(label, fn) {
  await fn()
  passed.push(label)
  console.log(`ok - ${label}`)
}

const precheck = await import(url('dangerous-op-precheck'))
const audit = await import(url('skill-usage-audit'))

await step('两个插件的安装产物可加载，name / apply / Config 齐全', () => {
  assert.equal(precheck.name, 'dangerous-op-precheck')
  assert.equal(audit.name, 'skill-usage-audit')
  assert.equal(typeof precheck.apply, 'function')
  assert.equal(typeof audit.apply, 'function')
  assert.ok(precheck.Config, '预检插件应导出 Config schema')
  assert.ok(audit.Config, '审计插件应导出 Config schema')
})

let handler
precheck.apply(
  {
    on(event, fn) {
      assert.equal(event, 'tools/pre-execute', '预检插件应挂在 tools/pre-execute')
      handler = fn
    },
  },
  {
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
  },
)

await step('安装产物挂上 pre-execute，ask 规则返回带编号清单的审批决策', async () => {
  assert.equal(typeof handler, 'function')
  const decision = await handler(
    { name: 'bash', arguments: { command: 'rm -rf /tmp/demo' } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /1\. 确认目标路径正确/)
  assert.match(decision.reason, /2\. 确认有可用备份/)
})

await step('安装产物的 block 规则直接拒绝、未命中放行', async () => {
  const denied = await handler(
    { name: 'write', arguments: { file_path: '/app/.env.local' } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(denied.kind, 'deny')
  const allowed = await handler(
    { name: 'read', arguments: { file_path: '/app/README.md' } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(allowed.kind, 'allow')
})

const now = Date.now()
const events = [
  {
    type: 'tool/call',
    seq: 1,
    time: now - 3000,
    data: { callId: 'c1', name: 'skill', arguments: JSON.stringify({ name: 'alpha-skill' }) },
  },
  {
    type: 'tool/result',
    seq: 2,
    time: now - 2000,
    data: { message: { content: [{ toolCallId: 'c1' }] } },
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
audit.apply(
  {
    get(service) {
      return service === 'sessionQuery' ? query : undefined
    },
    tools: {
      register(registered) {
        tool = registered
      },
    },
  },
  { knownSkills: ['alpha-skill', 'beta-skill'] },
)

await step('安装产物注册 skill_usage_report 工具', () => {
  assert.equal(tool?.name, 'skill_usage_report')
})

await step('安装产物走 sessionQuery 生成报告，含零调用技能', async () => {
  const report = await tool.execute({ days: 7 }, {})
  assert.match(report, /sessionQuery/)
  assert.match(report, /alpha-skill/)
  assert.match(report, /beta-skill/)
})

console.log(`\n通过 ${passed.length} 项检查（dsh profile 安装产物）`)

# harness_project

两个 Harness 插件（cordis plugin）的完整实现，对应仓库里的两份方案文档：

| 插件 | 对应文档 | 定位 |
| --- | --- | --- |
| [`dangerous-op-precheck`](packages/dangerous-op-precheck) | `危险操作预检清单（通用版）.md` | 在工具执行前按**用户自定义规则**拦截，并把检查项逐条摆进原生审批界面 |
| [`skill-usage-audit`](packages/skill-usage-audit) | `技能使用审计工具.md` | 跨会话统计技能调用次数/成功率/最近调用，回答“装了这么多技能到底用没用” |

两个插件都不改核心逻辑、不写会话状态：一个只做拦截决策，一个只读会话日志。

## 目录

```
packages/
  dangerous-op-precheck/
    src/rules.ts        规则编译与匹配（零依赖纯函数）
    src/index.ts        插件入口：挂 tools/pre-execute
    src/test/           单测
    cordis.example.yml  配置示例
  skill-usage-audit/
    src/types.ts        会话事件/数据源的最小结构
    src/logfile.ts      jsonl 存档宽容解析
    src/report.ts       聚合与表格渲染（CJK 宽度对齐）
    src/audit.ts        编排：列会话 → 读事件 → 聚合 → 渲染
    src/sources.ts      sessionQuery / jsonl 两条数据源
    src/index.ts        插件入口：注册 skill_usage_report 工具
    src/test/
scripts/clean.mjs
```

## 快速开始

```bash
npm ci
npm run build      # 两个包各自 tsc 编译到 lib/
npm test           # node --test，共 84 个用例
npm run smoke      # 端到端冒烟：加载 lib/ 验证插件接线（构造数据）
npm run check      # build + test + smoke，CI 跑这条
npm run clean      # 删除 lib/
```

`npm run smoke` 只验证模块间接线，事件与会话是构造数据；真实审批弹窗与会话日志仍需在装有 `dsh` CLI 的 Harness 环境里验证。

打包与安装（以 web profile 为例）：

```bash
cd packages/dangerous-op-precheck && npm pack && cd -
dsh plugin --profile web add ./packages/dangerous-op-precheck/dangerous-op-precheck-0.1.0.tgz

cd packages/skill-usage-audit && npm pack && cd -
dsh plugin --profile web add ./packages/skill-usage-audit/skill-usage-audit-0.1.0.tgz
```

## 实现要点

### 危险操作预检

- 挂接 `tools/pre-execute` 瀑布，而不是注册成模型可调用的工具——拦截点必须在工具执行前。
- `ask` 返回 `{ kind: 'ask', reason }`，由 registry 转成 `ctx.approval.request()`；检查清单以编号列表塞进 `reason`。用户拒绝/取消/无审批通道时一律 fail-closed。
- `block` 返回 `{ kind: 'deny', reason }`。
- **只收紧、不放宽**：先 `await next()` 取下游决策，只有下游 allow 时才施加本插件决策，绝不覆盖 tool-guard 等其他插件的拒绝。
- 加载期校验正则、字段拼写与空 `match`，写错就加载失败——宁可报错，也不要静默放行。

### 技能使用审计

- 技能名**不在工具名里**：所有技能共用 `skill` 工具，名字在参数 `name` 里，必须按 dispatcher 解析。
- 数据源双轨：`ctx.sessionQuery`（首选，后端无关）→ jsonl 存档兜底（`<root>/<project>/<session>/session.jsonl[.zstd]`，含 zstd 解压与旧平铺布局兼容）。
- `tool/call` 与 `tool/result` 按 `callId` 配对；失败优先看事件 `error`，其次 `isError`；没有结果的调用单独记“待定”，不算成功也不算失败。
- 报告是纯文本表格，中文技能名按显示宽度（CJK=2 列）对齐。

## 两份文档里被证伪的假设

落地时对着 `@deepseek-ai/*` 已发布包的真实类型逐个核对过（`dsh-tools@0.0.1-rc.1`、`dsh-user-approval@0.0.1-rc.1`、`dsh-session-query@0.0.1-rc.1`、`dsh-tool-skill@0.0.1-rc.1`），文档示例代码有几处与真实 API 不一致：

| 文档写法 | 真实情况 | 处理 |
| --- | --- | --- |
| `throw new Error(...)` 拒绝工具调用 | `tools/pre-execute` 是 waterfall，决策是**返回值**；throw 会被包成工具错误（模型看到崩溃而非“用户拒绝”） | 返回 `{ kind: 'deny' }` / `{ kind: 'ask' }` |
| `ctx.approval.request({ callId, reason, displayReason })` | 真实签名 `{ agent, toolName, callId?, reason?, signal? }`：`agent` 必填、无 `displayReason`、要求当前有打开的 turn | 不自己调，交给 registry 的 ask 通道 |
| `inject = ['tools', 'approval']` | `approval` 由 registry 用 `ctx.get('approval')` 按需查找 | `inject` 只留 `tools` |
| `ctx.sessionQuery.readHistory(id)` / `listSessions({ since })` | 真实 API 是 `listSessions(signal?)` + `readSession(id)`，没有 since 过滤 | 按 `createdAt` 倒序 + `maxSessions` 截断，再按事件 `time` 过滤 |
| “技能调用 name 即技能标识” | 所有技能走同一个 `skill` 工具 | 从 `arguments.name` 解析 |
| 结果事件顶层有 `callId` | 在 `data.message.content[].toolCallId` | 两处都读，兼容不同形态 |

## 已知限制

- 预检的检查项只是文字，不支持表单校验（审批通道只有一段 reason 文本）。
- 预检的参数提取依赖键名约定；自定义工具（如 `sql` / `url`）请用 `argsPattern` 兜底。
- 审计只判断“是否报错”，评不了调用质量；`knownSkills` 需手填，插件无法自动发现技能包全部技能。
- 审计的 jsonl 兜底路线在 Node < 22.15 上无法解压 zstd 存档，会给出明确报错。

## 发布

源码推到 GitHub 公开仓库 → 在 `awesome-dsh-plugin` 提 PR（市场自动抓取）→ `npm publish --access public`。
官方扶持申请材料可参考两个插件 README 里的“与方案文档的校正”一节：强调「不预设规则的检查流程」与「只读不写的存量用户信息缺口补位」。

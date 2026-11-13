# harness_project

[![CI](https://github.com/kcufow/harness_project/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/kcufow/harness_project/actions/workflows/ci.yml)

> 本仓库是 npm workspaces monorepo：两个可安装的 dsh 插件分别在 `packages/dangerous-op-precheck` 与 `packages/skill-usage-audit`，各自声明 `dsh.bundle` 并附带 `cordis.patch.yml`；根 `package.json` 是 `private: true` 的容器包，不发布、也不是插件。

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
    cordis.patch.yml    dsh.bundle 默认配置（安装即自动挂载）
    cordis.example.yml  完整配置示例
  skill-usage-audit/
    src/types.ts        会话事件/数据源的最小结构
    src/logfile.ts      jsonl 存档宽容解析
    src/report.ts       聚合与表格渲染（CJK 宽度对齐）
    src/audit.ts        编排：列会话 → 读事件 → 聚合 → 渲染
    src/sources.ts      sessionQuery / jsonl 两条数据源
    src/index.ts        插件入口：注册 skill_usage_report 工具
    src/test/
    cordis.patch.yml    dsh.bundle 默认配置
    cordis.example.yml  完整配置示例
scripts/
  clean.mjs             删除 lib/
  smoke.mjs              端到端冒烟（workspace lib/）
  smoke-installed.mjs    dsh profile 安装产物冒烟
  dsh-register.mjs       注册 ESM resolve hook
  dsh-module-hook.mjs    复现 dsh 运行时的 peer 依赖解析
docs/真机验证.md         dsh 安装、配置与真机验证清单
CHANGELOG.md             版本策略与变更记录
.npmrc / .github/workflows/  npm 发布配置与 CI / publish workflow
```

## 快速开始

```bash
npm ci
npm run build      # 两个包各自 tsc 编译到 lib/
npm test           # node --test，共 87 个用例
npm run smoke      # 端到端冒烟：加载 lib/ 验证插件接线（构造数据）
npm run smoke:installed  # 验证 dsh profile 里的 tgz 安装产物（需先装插件，见下）
npm run check      # build + test + smoke，CI 跑这条
npm run clean      # 删除 lib/
```

`npm run smoke` 只验证模块间接线，事件与会话是构造数据。`npm run smoke:installed` 进一步加载 `~/.dsh/profiles/web/node_modules` 下由 tgz 解包的**发布产物**，能抓到 `npm pack` 漏文件、`exports` 指错、peer 依赖在宿主缺失等问题；它默认用仓库根 `node_modules` 提供 peer，可用 `DSH_RUNTIME_NODE_MODULES` 指向 dsh 安装目录，用 `DSH_PROFILE_NODE_MODULES` 覆盖 profile 路径。该命令依赖本机 dsh profile，因此**不并入 `npm run check`**。两者都不能替代真实审批弹窗与会话日志验证，环境配置与完整步骤见 [docs/真机验证.md](docs/真机验证.md)。

打包与安装（以 web profile 为例；npx 零安装方式没有全局 `dsh` 命令，需写全）：

```bash
npm ci && npm run build && npm pack --workspaces
# tgz 产物落在仓库根目录；dsh plugin 要求 pnpm 在 PATH 上
npx @deepseek-ai/dsh plugin --profile web add ./dangerous-op-precheck-0.1.0.tgz
npx @deepseek-ai/dsh plugin --profile web add ./skill-usage-audit-0.1.0.tgz
# 两个包都声明了 dsh.bundle，装完自动成为 profile layer，无需手写 cordis.patch.yml
npx @deepseek-ai/dsh web --dump-config   # 不带 --patch 也能看到两个插件
npm run smoke:installed                 # 确认安装产物可加载且接线正确
```

`dsh.bundle` 指向各包内的 `cordis.patch.yml`（默认配置，已包含基本规则）。自定义配置时在 profile 的 `cordis.patch.yml` 里按同一 `id` 重写整行 `config`——patch 是**整行替换**而非逐字段合并，用户层最后写入、优先级更高；随包附带的 `cordis.example.yml` 是更完整的示例。市场的 registry 安装路径会直接拒绝没有 `dsh.bundle` 声明的包，所以这也是上架必需项。

版本口径要分清：**构建/测试**两个插件包用 `engines.node >=22.15`；**真机运行 dsh 0.2.2-rc.1** 需要 Node `>=24.9.0`。

## 实现要点

### 危险操作预检

- 挂接 `tools/pre-execute` 瀑布，而不是注册成模型可调用的工具——拦截点必须在工具执行前。
- `ask` 返回 `{ kind: 'ask', reason }`，由 registry 转成 `ctx.approval.request()`；检查清单以编号列表塞进 `reason`。用户拒绝/取消/无审批通道时一律 fail-closed。
- `block` 返回 `{ kind: 'deny', reason }`。
- **只收紧、不放宽**：先 `await next()` 取下游决策，只有下游 allow 时才施加本插件决策，绝不覆盖 tool-guard 等其他插件的拒绝。
- 加载期校验正则、字段拼写与空 `match`，写错就加载失败——宁可报错，也不要静默放行。

### 技能使用审计

- 技能名**不在工具名里**：所有技能共用 `skill` 工具，名字在参数 `name` 里，必须按 dispatcher 解析。
- 数据源双轨：`ctx.sessionQuery`（首选，后端无关）→ jsonl 存档兜底（`<root>/<project>/<session>/*.jsonl[.zstd]`，按后缀识别任意世代如 `session.v3.jsonl.zstd`，含 zstd 解压与旧平铺布局兼容）。
- `tool/call` 与 `tool/result` 按 `callId` 配对；失败优先看事件 `error`，其次 `isError`；没有结果的调用单独记“待定”，不算成功也不算失败。
- 报告是纯文本表格，中文技能名按显示宽度（CJK=2 列）对齐。

## 两份文档里被证伪的假设

落地时对着 `@deepseek-ai/*` 已发布包的真实类型逐个核对过（dsh 0.2.2-rc.1 运行时的 `dsh-tools@0.2.2-rc.1` 及 `dsh-user-approval` / `dsh-session-query` / `dsh-tool-skill` 同版本线），文档示例代码有几处与真实 API 不一致：

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
- **上游依赖审计**：`npm audit --omit=dev` 报 8 个 high，根源是 `@deepseek-ai/dsh-tools` 传递依赖里的 `zod <4.6.6`（GHSA-mrhx-c7xc-m3w5）。这是 dsh 0.2.2-rc.1 运行时的上游问题，**不要跑 `npm audit fix --force`**（会破坏与 dsh 的 peer 版本对齐，且提示 `Will install undefined@undefined`）。等上游升级后同步处理；CI / publish workflow 只跑 `npm run check`，不把 audit 设为门禁。

## 发布

**仓库**：Gitee `origin`（私有）与 GitHub `github`（公开，`kcufow/harness_project`，`master`）双远程同步，两端 HEAD 一致。GitHub Actions 只在 GitHub 侧触发，改完代码两边都要推：

```bash
git push origin master && git push github master
```

**已就绪的工程配置**：`.npmrc`（`access=public`）、`.github/workflows/publish.yml`（推 `vX.Y.Z` tag 或手动触发）、`CHANGELOG.md`（版本策略与变更记录）、两个包的 `dsh.bundle` 声明。发布 workflow 会先跑 `npm run check`，再按 workspace 分别 `npm publish` 两个包（根包 `private` 不会发布），需要仓库 secret `NPM_TOKEN`。

**已完成**：

- GitHub 公开仓库已创建并推送，CI 首次运行成功（`npm ci && npm run check`，run `43350271592` / `success`）；根 `LICENSE` 被识别为 MIT。
- 两包发布元数据指向该仓库；`npm pack --workspaces`、`npm publish --dry-run`（两包）、`npm run check`、`npm run smoke:installed` 均通过。

**仍待账号授权（尚未执行）**：

1. 在 GitHub 仓库页 **About → Topics** 加 `dsh-plugin`（市场自动收录的入场券）。
2. **Settings → Secrets and variables → Actions → New repository secret**：名称 `NPM_TOKEN`，值为具备 publish 权限的 npm automation token。
3. 按 `CHANGELOG.md` 的版本策略改两个包版本号，`npm install` 同步 lock、更新 CHANGELOG，推 `v0.1.0` tag 触发 publish workflow（或在 Actions 页手动 `workflow_dispatch`）；也可本地 `npm publish --workspace <name> --access public`。
4. 在 `awesome-dsh-plugin` 提 PR（市场自动抓取），申请官方插件作者扶持计划。

> `publish.yml` 只在 GitHub 侧生效，且必须先有 `NPM_TOKEN`；缺 secret 时打 tag 会因 `NODE_AUTH_TOKEN` 为空而失败。Gitee 私有仓库不会执行 `.github/workflows/`，如需在 Gitee 侧校验请改用 Gitee Go 跑等效的 `npm ci && npm run check`。

官方扶持申请材料可参考两个插件 README 里的“与方案文档的校正”一节：强调「不预设规则的检查流程」与「只读不写的存量用户信息缺口补位」。

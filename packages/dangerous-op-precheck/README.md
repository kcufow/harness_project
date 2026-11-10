# dangerous-op-precheck

危险操作预检清单（通用版）· Harness 插件。在工具执行前，按**用户自己写的规则**拦截，并把检查项逐条摆到审批界面里。

不做安全规则引擎（黑名单/白名单交给 `dsh-plugin-tool-guard` 这类插件），做的是**把确认习惯固化成流程**：每次删文件前你都想确认的三件事，写在配置里，从此每次都会问。

## 安装

```bash
# 打包后在目标 profile 里安装
npm pack                         # 产出 dangerous-op-precheck-0.1.0.tgz
dsh plugin --profile web add ./dangerous-op-precheck-0.1.0.tgz
dsh plugin --profile desktop add ./dangerous-op-precheck-0.1.0.tgz
```

`dsh plugin` 要求 `pnpm` 在 PATH 上，且会把包作为普通依赖安装；要真正挂载，需把 `cordis.example.yml` 合入 profile 的 `cordis.patch.yml`（或启动时用 `--patch` 传入）。完整流程见 [`docs/真机验证.md`](../../docs/真机验证.md)。

插件导出标准的 cordis 插件字段（`name` / `inject` / `Config` / `apply`），任何 loader 条目都可以插入它，配置片段见 `cordis.example.yml`。

## 配置

```yaml
id: dangerous-op-precheck
name: 'dangerous-op-precheck'
config:
  logDecisions: true
  rules:
    - id: rm-recursive
      match:
        tool: bash
        commandPattern: 'rm\s+-[a-z]*r|mkfs|dd\s+if='
      mode: ask
      checklist:
        - 已确认目标路径正确，不是根目录或重要数据目录
        - 已确认有可用的备份或回滚方案
        - 已确认本次删除范围不超出预期
    - id: deny-secrets
      match:
        tool: [write, edit]
        pathPattern: '\.env(\..*)?$|id_rsa|\.pem$'
      mode: block
      message: 拒绝写入敏感文件。如需修改，请手动操作或先临时调整配置。
```

| 字段 | 说明 |
| --- | --- |
| `rules[].id` | 规则标识，出现在拒绝理由与日志里；省略时按 `rule-<序号>` 生成 |
| `rules[].match.tool` | 工具名，精确匹配；支持 `*` 通配（`bash*`），也可给数组 |
| `rules[].match.commandPattern` | 命令文本正则，作用于参数里的命令（`command` / `cmd` / `script` / `shell` / `code` / `query`） |
| `rules[].match.pathPattern` | 路径正则，作用于参数里的路径（`file_path` / `path` / `files` / `target` / `cwd` 等，含嵌套对象与数组） |
| `rules[].match.argsPattern` | 兜底：对整个参数 JSON 做正则，适合自定义工具 |
| `rules[].mode` | `ask`（默认，走原生审批并要求逐项确认）或 `block`（直接拒绝） |
| `rules[].checklist` | `ask` 模式下展示的检查项，逐条编号 |
| `rules[].message` | `block` 模式的理由；`ask` 模式无 checklist 时作为提示文案 |
| `logDecisions` | 是否输出命中日志，默认 `true` |

`match` 里多个条件同时给出时必须**全部满足**；规则按数组顺序匹配，**先命中先用**。

## 行为语义

- `mode: ask` → `tools/pre-execute` 返回 `{ kind: 'ask', reason }`，registry 转成 `ctx.approval.request()`；`allowed-once` 才放行，`rejected` / `cancelled` / `unavailable` 一律拦下（无审批通道时 fail-closed）。
- `mode: block` → 返回 `{ kind: 'deny', reason }`，理由直接回给模型。
- **只收紧、不放宽**：监听器先 `await next()` 取下游决策，只有下游是 `allow` 时才施加本插件决策。因此它不会覆盖 tool-guard 等插件的拒绝，也不会顶掉别的插件的确认流程。
- **加载即校验**：正则语法错误、`match` 字段拼错、`match` 为空，都会在插件加载时抛错并指出是哪条规则哪个字段。宁可加载失败，也不要静默放行。
- 未配置任何规则时插件空转，只在日志里提示一句。

## 与方案文档的三处校正

文档里的示例代码是按伪 API 写的，落地时对齐了 `@deepseek-ai/*` 已发布的真实类型（`dsh-tools@0.0.1-rc.1`、`dsh-user-approval@0.0.1-rc.1`）：

1. **不自己调 `ctx.approval.request()`**。真实签名是 `request({ agent, toolName, callId?, reason?, signal? })`：`agent` 必填、没有 `displayReason`、且要求当前有打开的 turn，插件层直接调很容易在空闲时抛错。pre-execute 返回 `{ kind: 'ask', reason }` 就是官方通道——registry 内部会带着 `agent`/`callId`/`signal` 去调 approval 并翻译结果，策略（`never`）也自动生效。
2. **决策是返回值，不是 `throw`**。`tools/pre-execute` 是 waterfall，`throw` 会被 registry 包成工具错误（模型看到的是崩溃而不是“用户拒绝”）。
3. **`inject` 只声明 `tools`**。审批通道由 registry 用 `ctx.get('approval')` 按需查找，插件不必也不应强依赖它。

## 开发

```bash
npm run build   # tsc 编译到 lib/
npm test        # node --test lib/test/
```

`src/rules.ts` 是零依赖纯函数（编译、匹配、文案），单测覆盖正则校验、嵌套参数提取、first-match-wins、决策文案；`src/test/index.test.ts` 用假上下文验证上面那条“只收紧不放宽”的组合不变量。

## 已知限制

- 检查项只是**文字**，不支持表单校验；审批通道只有一段 `reason` 文本，所以用编号列表承载。
- 不做危险操作识别，命中什么完全取决于配置。
- 参数提取靠**键名约定**（命令键 / 路径键两套内置列表）。自定义工具如果用了别的键名（如 `sql`、`url`），用 `argsPattern` 兜底，或提 issue 补键名。

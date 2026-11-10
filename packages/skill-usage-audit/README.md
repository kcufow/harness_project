# skill-usage-audit

技能使用审计 · Harness 插件。回答一个很实际的问题：**装了这么多技能包，到底哪些被真正用过？**

注册一个模型可调用的工具 `skill_usage_report`，跨会话统计最近 N 天每个技能的调用次数、成功/失败/未完成数和最近调用时间。只读会话日志，不写任何状态。

## 安装

```bash
npm pack                         # 产出 skill-usage-audit-0.1.0.tgz
dsh plugin --profile web add ./skill-usage-audit-0.1.0.tgz
dsh plugin --profile desktop add ./skill-usage-audit-0.1.0.tgz
```

## 工具

```text
skill_usage_report(days?: number, skillPrefix?: string, includeSessions?: boolean) -> string
```

| 参数 | 说明 |
| --- | --- |
| `days` | 统计最近 N 天，默认取配置 `defaultDays`（7） |
| `skillPrefix` | 只统计名称以此前缀开头的技能，例如 `game-studio-` |
| `includeSessions` | 报告中附带会话 ID 列表（默认关闭，避免报告过长） |

输出示例：

```text
技能使用报告（最近 7 天）
生成时间：11-08 14:23 · 数据源：sessionQuery · 扫描 42 个会话 / 18,204 条事件

技能名称               调用  成功  失败  最近调用
game-studio-concept     12    12     0  11-08 14:23
game-studio-design       8     7     1  11-07 09:15
game-studio-build        3     3     0  11-06 18:40

共 3 个技能被调用，23 次调用，1 次失败。
未被调用的技能：game-studio-release, game-studio-qa（共 2 个）
```

## 配置

```yaml
id: skill-usage-audit
name: 'skill-usage-audit'
config:
  defaultDays: 7
  maxSessions: 200
  maxRows: 50
  includeGenericTools: false
  dispatcherTools: [skill]
  knownSkills:
    - game-studio-concept
    - game-studio-design
    - game-studio-build
    - game-studio-release
    - game-studio-qa
  sessionsRoot: ''   # 留空用 ~/.dsh/sessions，仅 jsonl 兜底路线使用
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultDays` | `7` | 默认统计天数 |
| `maxSessions` | `200` | 单次最多读多少个会话（按创建时间倒序），防止一次扫太久 |
| `maxRows` | `50` | 表格最多列多少行 |
| `dispatcherTools` | `['skill']` | 技能调度器工具名，支持 `*` 通配 |
| `includeGenericTools` | `false` | 非调度器工具是否也按工具名统计 |
| `knownSkills` | `[]` | 技能包完整技能列表，用于报告“零调用技能” |
| `sessionsRoot` | `''` | jsonl 存档根目录，仅兜底路线使用 |

## 数据来源

**首选 `ctx.sessionQuery`**（`@deepseek-ai/dsh-session-query`）：`listSessions()` 拿会话列表，`readSession(id)` 拿完整事件流。后端无关、跨 live/持久化，也不用关心存档是 JSONL 还是 zstd。

**兜底：直接读 jsonl 存档**（`ctx.sessionQuery` 未提供时）：扫 `<root>/<project>/<session>/session.jsonl[.zstd]`，兼容旧的平铺 `<root>/<project>/<id>.jsonl`，`.zstd` 用 Node 内置 zstd 流式解压。此时会话 ID 用目录名，创建时间用文件 mtime 近似。

## 与方案文档的四处校正

文档假设“技能调用就是 tool/call，name 即技能标识”。对齐 `dsh-tool-skill@0.0.1-rc.1` 的真实实现后，有四处必须改：

1. **技能名不在工具名里**。所有技能共用同一个 `skill` 工具（参数 `{ name: '<技能名>' }`），所以必须从参数解析。只看 `name` 字段会得到一条 `skill` 的统计，等于没统计。
2. **`ctx.sessionQuery` 没有 `readHistory()`**。真实 API 是 `listSessions(signal?)` → `readSession(id)` → `{ session, events }`，且 `listSessions` 不接受 `since` 过滤，所以这里按 `header.createdAt` 倒序 + `maxSessions` 截断，再按事件 `time` 做窗口过滤。
3. **结果的 callId 在 `data.message.content[].toolCallId`**，不在事件顶层；失败标记优先看事件自带的 `error: { name, code }`。
4. **`inject` 不写死 `sessionQuery`**。写死会让“没有查询后端”的部署直接加载失败，而本插件有存档兜底，所以用 `ctx.get('sessionQuery')` 运行时探测。

## 开发

```bash
npm run build   # tsc 编译到 lib/
npm test        # node --test lib/test/
```

`src/report.ts` 是零依赖纯函数（技能名解析、聚合、表格渲染，含 CJK 宽度对齐），`src/logfile.ts` 是存档解析，`src/sources.ts` 是两条数据源，`src/audit.ts` 负责编排——每层都能单独测。

## 已知限制

- 只能判断“调用是否报错”，评不了调用质量。
- `knownSkills` 需要手填，插件无法自动发现技能包全部技能。
- 兜底路线下，压缩存档靠 Node 内置 zstd（需 Node 22.15+）；老版本 Node 会给出明确报错而不是静默零结果。
- 一个会话内 `tool/call` 与 `tool/result` 按 callId 配对；跨会话不会错配。

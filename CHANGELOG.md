# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## 版本策略

- 两个插件包 `dangerous-op-precheck` / `skill-usage-audit` **共用同一版本号一起发布**，避免出现「一个装了新版、另一个还是旧版」的 peer 组合。
- 根包 `harness-plugin-pack` 是 `private: true` 的 npm workspaces 容器，**不发布**。
- 依赖 `@deepseek-ai/dsh-tools` 等 peer 的版本必须对齐目标 dsh 运行时（当前 `0.2.2-rc.1`）；升级 dsh 大版本时视为 breaking change，需同步更新 `peerDependencies` 并重跑真机验证。
- 版本号变更顺序：改两个包的 `package.json` → 跑 `npm install` 同步 lock → 更新本文件 → 打 `vX.Y.Z` tag 触发发布 workflow（tag 需推到 GitHub，Gitee 侧不执行 Actions）。

## [Unreleased]

### Changed

- 两个包补齐 `author` / `repository` / `homepage` / `bugs` / `publishConfig` 发布元数据，目标仓库定为 `kcufow/harness_project`。
- 仓库已同步到 GitHub 公开仓库 `kcufow/harness_project`（`master`，与 Gitee `origin/master` 同为 `5266462`），CI workflow 首次在 GitHub Actions 跑通（`npm ci && npm run check`，run `43350271592` / `success`），根 `LICENSE` 被识别为 MIT。
- 校正 README / CI / publish workflow 中「GitHub 仓库尚未创建」「Gitee 私有仓库不会触发 Actions」「workflow 未运行过」等过时口径；README 增加 CI 状态徽章与双远程同步说明。

### 待办

- 真实 Harness 交互验证：审批弹窗、`.env` 拒绝、`skill_usage_report` 的真实统计。
- 给 GitHub 仓库加 topic `dsh-plugin`、配置 `NPM_TOKEN` secret，发布两个包到 npm，再向 `awesome-dsh-plugin` 提 PR、申请官方插件作者扶持。
- v2 候选：`knownSkills` 自动发现、检查项表单校验、自定义工具参数键名配置。

## [0.1.0] - 2026-11-11

### Added

- `dangerous-op-precheck`：`tools/pre-execute` 瀑布拦截，`ask` 编号检查清单 / `block` 直接拒绝，只收紧不放宽，加载期规则校验。
- `skill-usage-audit`：注册 `skill_usage_report`，跨会话统计调用/成功/失败/待定与最近调用时间，CJK 宽度对齐表格。
- 双数据源：`ctx.sessionQuery` 优先，jsonl 存档兜底（按后缀识别任意世代，兼容 `session.v3.jsonl.zstd` 与 zstd 解压）。
- **`dsh.bundle` 声明 + 包内 `cordis.patch.yml`**：`dsh plugin add` 后自动成为 profile layer，无需手写挂载配置；也是插件市场上架的必需声明。
- 工程化：`npm run check`（build + 87 单测 + 7 项端到端冒烟）、`npm run smoke:installed`（验证 dsh profile 安装产物，5 项）、CI、MIT LICENSE、`.npmrc`、发布 workflow。
- 文档：`docs/真机验证.md` 记录 dsh 0.2.2-rc.1 的安装门槛、配置与两轮实测。

### Fixed

- `dsh-tools` 从 `0.0.1-rc.1` 对齐到运行时的 `0.2.2-rc.1`，解决 `plugin add` 被兼容性检查拒绝。
- `cordis.example.yml` 改为顶层数组 `- insert:`，解决 dsh 报「must be a top-level YAML array」。
- jsonl 兜底路径兼容官方当前存档世代。
- 若干文档中的旧版 API / 命令口径（详见根 README「两份文档里被证伪的假设」）。

### 已知限制

- 真实交互验证尚未完成；两轮冒烟均使用构造数据。
- 代码需手动同步两个远程（`origin` / `github`）；Gitee 侧不触发 GitHub Actions，CI 状态以 GitHub 侧为准（已实测成功）。
- `npm audit --omit=dev` 报 8 个 high（`zod <4.6.6`，GHSA-mrhx-c7xc-m3w5），由 `@deepseek-ai/dsh-tools` 传递依赖引入，属 dsh 0.2.2-rc.1 上游问题；暂不修，避免 `audit fix --force` 破坏版本对齐。

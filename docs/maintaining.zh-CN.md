# 仓库维护手册

[English](maintaining.md) · **简体中文**

本文是 `pax-beehive/dsh-hub-cli` 的仓库运营规范。

## 每周轮值

### 周二：分类

1. 检查新的 Issue 和 Discussion。
2. 适用时分别添加一个 `type:*`、`area:*` 和 `status:*` 标签。
3. 未确认的缺陷要求提供最小复现，并添加 `status:needs-repro`。
4. 为范围明确且已接受的工作添加 `status:accepted`，记录成功标准。
5. 检查 Dependabot PR；必需检查和兼容性 Review 通过后才能合并。

### 周五：Review 与发布准备

1. 检查开放 PR，确认重要变更均关联已接受的 Issue。
2. 检查失败或不稳定的 Actions；可重复发生的问题应创建 Issue。
3. 检查连续 30 天没有更新的已接受 Issue，并补充状态说明。
4. 判断积累的用户可见变更是否达到发布候选标准。

维护者按周轮值。当前轮值维护者负责首次响应，第二位维护者负责必需 Review 和升级处理。

## 服务目标

- 新 Issue：两个工作日内首次分类。
- PR：三个工作日内首次 Review。
- 信息完整的漏洞报告：三个工作日内确认收到。
- 当前版本回归：拥有最高的非安全优先级。

## Issue 生命周期

`status:needs-triage` → `status:needs-repro` 或 `status:accepted` → 关联 PR → 合并后关闭。

- 重复 Issue 应链接到主 Issue 后关闭。
- 拒绝的建议应简要说明产品或兼容性原因。
- 启动期不使用自动 stale bot。
- 只有问题与期望结果明确后，才将 Discussion 转为 Issue。

## PR 管控

- PR 目标为 `main`；分支规则禁止直接 Push。
- 要求一位批准者、全部对话已解决、`CI / verify`、CodeQL、PR 标题检查、依赖审查和必需 Code Owner Review。
- 新提交会使旧审批失效。
- 使用 Squash merge，标题采用适合 CHANGELOG 的 Conventional Commit 风格。
- 合并后删除来源分支。
- 不得为了方便绕过检查。紧急安全工作通过私密公告处理，发布前仍需 Review。

## 标签模型

- `type:*` 表示工作原因：bug、feature、docs、security、breaking、question、release、showcase。
- `area:*` 表示负责领域：cli、agent、registry、schemas、docs、github。
- `status:*` 表示流程状态：needs-triage、needs-repro、accepted、blocked。
- `good first issue` 和 `help wanted` 表示对外贡献机会。
- `skip-changelog` 将仅内部变更排除在自动 Release Notes 之外。

## 发布管控

发布遵循 [releasing.md](releasing.md)，并满足：

1. 根目录和四个 package 使用统一精确版本。
2. 更新 `CHANGELOG.md`，同步面向用户的中英文文档。
3. Release Commit 的必需检查和 `pnpm check` 通过。
4. 使用不可移动、受保护的 `v<version>` Tag。
5. 验证 npm `latest`、provenance、仓库元数据和全新安装 Smoke Test。

固定窗口内没有足够变更时不发布空版本。安全修复在协调披露准备完成后立即发布。

## 月度复盘

每月发布一篇维护者 Discussion，总结：

- Stars、Forks、独立访客、Clone 和外部贡献者；
- Issue 响应时间、关闭数量和未分类积压；
- PR Review 和合并时间；
- CI、依赖、安全和发布失败；
- npm 下载趋势及 CLI 聚合成功/失败信号。

下个月行动项以 Issue 形式记录，并明确负责人和验收标准。

## 一次性仓库设置

GitHub 设置应与本文保持一致：

- Homepage 为 `https://dshpluginhub.ai`，设置准确的 Repository Topics；
- 启用 Issues 和 Discussions，关闭未使用的 Wiki 和 Projects；
- 启用 Squash merge 和合并后自动删除来源分支；
- 启用私密漏洞报告、Dependabot Alerts 与更新、Secret Scanning 和 Push Protection；
- 为 `main` 设置 Ruleset，要求 PR、一位批准者、Code Owner Review、解决对话、线性历史和必需 Actions 检查；
- 保护 `v*` Tag，仅允许维护者创建 Release。

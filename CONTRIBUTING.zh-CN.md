# 参与贡献

[English](CONTRIBUTING.md) · **简体中文**

感谢你参与 DSH Hub CLI。小型文档和明确的缺陷修复可以直接提交 PR；新增命令、公共 Schema、兼容性变更和较大的功能应先创建 Issue 或 Discussion。

## 开始之前

- 使用问题请前往 [Discussions Q&A](https://github.com/pax-beehive/dsh-hub-cli/discussions/categories/q-a)。
- 产品想法请先前往 [Discussions Ideas](https://github.com/pax-beehive/dsh-hub-cli/discussions/categories/ideas)。
- 可复现缺陷请使用结构化 [Bug Report](https://github.com/pax-beehive/dsh-hub-cli/issues/new?template=bug_report.yml)。
- 安全漏洞请遵循[安全政策](SECURITY.zh-CN.md)，不要创建公开 Issue。

## 开发环境

1. 安装 Node.js 22.13 或更高版本，并启用 Corepack。
2. 运行 `pnpm install --frozen-lockfile`。
3. 创建范围单一的分支和 PR。
4. 提交前运行 `pnpm check`。

## 变更边界

- 不要将托管服务密钥和内部实现细节放入此仓库。
- Schema 变更属于公共 API 变更，必须在同一个 PR 中更新解析器和 CLI 测试。
- 保留本地变更的 dry-run 和显式计划行为。
- 绝不记录登录 Token、环境变量值或 Profile 密钥值。
- 四个 package 必须使用相同版本；Release Tag 格式为 `v<version>`。
- 面向用户的行为应同步更新英文和中文文档。

## PR 要求

- 描述用户可见行为、安全与隐私影响以及验证方式。
- 重要变更关联一个标记为 `status:accepted` 的 Issue。
- 不要在同一个 PR 中混入无关重构。
- 根据改动补充回归测试、兼容性说明和 CHANGELOG。
- 使用 Squash merge；维护者合并后删除来源分支。

提交贡献代表你同意按本仓库的 MIT License 提供该贡献。

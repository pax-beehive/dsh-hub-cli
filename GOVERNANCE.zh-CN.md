# 治理规则

[English](GOVERNANCE.md) · **简体中文**

DSH Hub CLI 由 [CODEOWNERS](.github/CODEOWNERS) 中列出的仓库维护者公开维护。本文定义工作如何被接受、审核、发布和升级处理。

## 原则

- 优先保护用户。可复现性、本地变更可审阅、隐私和密钥处理均属于发布门槛。
- 保持公共契约一致。相互依赖的 Schema、解析器、CLI 和 Agent 工具变更应共同发布。
- 重要工作先讨论后实施。新增命令、公共 Schema、兼容性和大型依赖变更需要先获得 Issue 接受。
- 保持决策公开。产品和技术决策应记录在 Issue、Discussion、PR 或仓库文档中。
- 优先采用可撤销操作和小型、易审阅的 PR。

## 角色

### 维护者

维护者负责 Issue 分类、Discussion 管理、PR Review、安全报告、版本发布和仓库设置。必需检查与审批通过后，维护者可以合并 PR。

### 贡献者

任何人都可以报告问题、参与 Discussion、改进文档或提交已经确认范围的变更。持续提供建设性贡献的成员，经维护者一致同意后可获得更多分类或审核权限。

## 决策流程

1. 使用问题和早期想法从 Discussions 开始。
2. 可复现缺陷和范围明确的工作使用 Issue。
3. 维护者为接受的工作添加 `status:accepted`，并记录预期结果。
4. 实施通过关联的 PR 完成。
5. 涉及公共契约、安全、隐私或发布的变更，需要对应领域 Code Owner 审核。

维护者优先寻求共识。无法达成共识时，PR 保持开放或提案延期；仓库稳定性优先于进度。

## PR 规则

- PR 以 `main` 为目标分支；重要变更必须关联已接受的 Issue。
- 合并前必须通过 CI、CodeQL 和 Code Owner Review。
- 维护者使用 Squash merge，合并后删除来源分支。
- 禁止对 `main` force push、绕过必需检查或移动已经发布的 Release Tag。
- 维护者可以要求拆分无关变更，或补充兼容性、安全、文档和回归验证。

## 发布

四个 package 使用统一 SemVer 版本和一个 `v<version>` Tag。发布遵循 [docs/releasing.md](docs/releasing.md)。面向用户的变更应在同一个版本中更新 CHANGELOG 和中英文文档。安全版本可以采用加速的私密披露流程。

## 社区管理与利益冲突

维护者按照[行为准则](CODE_OF_CONDUCT.zh-CN.md)管理社区。涉及行为报告或存在重大利益冲突的维护者必须回避。行为问题发送至 [hello@dshpluginhub.ai](mailto:hello@dshpluginhub.ai)，漏洞通过私密安全公告流程报告。

## 治理规则变更

治理规则变更需要公开 PR，并获得至少两位当前 Code Owner 批准。PR 必须说明运营影响以及对进行中工作的迁移方式。

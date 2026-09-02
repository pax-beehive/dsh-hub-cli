# 安全政策

[English](SECURITY.md) · **简体中文**

## 支持版本

安全修复面向当前 npm `latest` 版本发布。请同时升级四个 `@dsh-plugin-hub/*` package，确保契约、解析器、CLI 和 Agent 适配器保持一致。

## 报告漏洞

请勿为疑似漏洞创建公开 Issue。请使用仓库 **Security → Report a vulnerability** 流程创建[私密安全公告](https://github.com/pax-beehive/dsh-hub-cli/security/advisories/new)。报告应包含受影响命令或 package、复现步骤、影响和建议缓解方式。

维护者会在三个工作日内确认收到信息完整的报告，协调修复与披露窗口，并在报告者愿意时公开致谢。

## 敏感本地数据

CLI 将 Hub Session 存储在 `$DSH_HOME/.hub/auth.json` 或 `~/.dsh/.hub/auth.json`，文件权限为 `0600`。请勿在 Issue、Discussion 或 PR 中附加该文件、Access Token、Refresh Token、`.env` 文件、Profile 密钥值或未脱敏的本地路径。

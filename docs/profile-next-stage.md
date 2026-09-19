# Profile follow-up work

The 0.5.0 scope covers local Profile management, saved inputs, customization-preserving upgrades, history, recovery and the native aggregate pnpm installer. It does not claim that every environment or artifact is attested.

- Bind installation inputs before any package-manager hook can run while configuration is read; account for custom environment-variable substitutions when reusing a lock; support pnpmfile arrays. Verify externally linked configuration targets and hook dependencies consistently.
- Add Runtime and GitHub prepared-artifact verification and an author-distributed dependency-lock contract. A local pnpm lock receipt is not a complete artifact attestation.
- Validate clean network installation, third-party tasks, and customized upgrade/recovery on every promised environment. Existing process fixtures and local loopback package tests do not substitute for this coverage.
- Exercise the author/account/browser flow through two real releases and the recipient installation, task, upgrade and recovery flow.
- Record voluntary trials by an independent author and first-time recipients. No real-user outcomes have been claimed.

## 下一阶段

0.5.0 已实现 Profile 本地管理、输入存储、保留个人定制的升级、历史恢复和原生 pnpm 聚合安装。后续补齐 hook 与配置绑定、Runtime/GitHub 制品验证、作者分发锁、支持环境的完整任务验收及真实用户试用。本地测试通过不计为上述真实用户结果。

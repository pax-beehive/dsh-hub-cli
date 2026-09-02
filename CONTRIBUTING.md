# Contributing

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for contributing to DSH Hub CLI. Small documentation changes and
well-scoped bug fixes may go directly to a pull request. New commands, public
schema changes, compatibility changes, and substantial features start with an
Issue or Discussion.

## Before you start

- Ask usage questions in [Discussions Q&A](https://github.com/pax-beehive/dsh-hub-cli/discussions/categories/q-a).
- Explore product ideas in [Discussions Ideas](https://github.com/pax-beehive/dsh-hub-cli/discussions/categories/ideas).
- Report reproducible bugs with the structured [bug form](https://github.com/pax-beehive/dsh-hub-cli/issues/new?template=bug_report.yml).
- Follow the [security policy](SECURITY.md) for vulnerabilities; never open a public Issue.

## Setup

1. Install Node.js 22.13 or later and enable Corepack.
2. Run `pnpm install --frozen-lockfile`.
3. Create a focused branch and pull request.
4. Run `pnpm check` before opening a pull request.

## Change boundaries

- Keep hosted-service secrets and implementation details out of this repository.
- Treat schema changes as public API changes and update resolver/CLI tests in the same pull request.
- Preserve dry-run and explicit-plan behavior for local mutations.
- Never log login tokens, environment-variable values, or Profile secret values.
- Keep all four package versions identical; releases are tagged `v<version>`.
- Update both English and Chinese documentation for user-visible behavior.

## Pull requests

- Describe user-visible behavior, security and privacy impact, and validation.
- Link significant work to an Issue labeled `status:accepted`.
- Keep unrelated refactors separate.
- Add regression tests, compatibility notes, and a changelog entry when relevant.
- Maintainers use squash merge and delete the source branch after merge.

By submitting a contribution, you agree that it is licensed under this
repository's MIT License.

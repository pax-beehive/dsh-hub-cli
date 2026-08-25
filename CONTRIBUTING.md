# Contributing

## Setup

1. Install Node.js 22.13 or later and enable Corepack.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm check` before opening a pull request.

## Change boundaries

- Keep hosted-service secrets and implementation details out of this repository.
- Treat schema changes as public API changes and update resolver/CLI tests in the same pull request.
- Preserve dry-run and explicit-plan behavior for local mutations.
- Never log login tokens, environment-variable values, or Profile secret values.
- Keep all four package versions identical; releases are tagged `v<version>`.

## Pull requests

Describe user-visible behavior, security impact, and tests. Keep unrelated
changes separate. Maintainers may request an issue before accepting large API
or command-surface changes.

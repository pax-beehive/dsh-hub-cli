# DSH Hub CLI

Open-source local tooling for [DSH Plugin Hub](https://dshpluginhub.ai). This
repository contains the complete client-side trust boundary: portable data
contracts, deterministic resolution, the `dsh-hub` CLI, and the DSH agent-tool
adapter that invokes it.

The hosted website, API, database, and deployment infrastructure live outside
this repository.

## Packages

| Package | Responsibility |
| --- | --- |
| [`@dsh-plugin-hub/schemas`](packages/schemas) | Runtime-validated Plugin, Profile, and Hub API contracts |
| [`@dsh-plugin-hub/registry`](packages/registry) | Deterministic Plugin and Profile version resolution |
| [`@dsh-plugin-hub/cli`](packages/cli) | Search, install, capture, share, apply, history, and rollback commands |
| [`@dsh-plugin-hub/dsh-plugin`](packages/dsh-plugin) | DSH agent tools backed by the same reviewed CLI operation plans |

## Install

Requires Node.js 22.13 or later.

```bash
npm install --global @dsh-plugin-hub/cli
dsh-hub --help
```

Or run a single command without a global installation:

```bash
npx @dsh-plugin-hub/cli search vision
```

To expose the plan/apply workflow as DSH agent tools:

```bash
dsh plugin --profile web add @dsh-plugin-hub/dsh-plugin
```

The repository also includes a reviewable
[`dsh-hub` agent Skill](skills/dsh-hub/SKILL.md) that requires an explicit,
expiring operation plan before an agent applies a Profile mutation.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` type-checks every TypeScript package, runs the complete test suite,
builds publishable artifacts, and audits the files that each npm package would
contain.

## Security model

The CLI can install packages, update local DSH Profiles, and store a Hub login
session. Mutating operations use explicit, expiring plans; Profile application
uses staging, validation, atomic replacement, and recoverable revisions.

Review [SECURITY.md](SECURITY.md) before reporting a vulnerability and
[docs/architecture.md](docs/architecture.md) for the package and trust
boundaries.

## Contributing

Bug reports and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

This is an independent community project and is not affiliated with or
endorsed by DeepSeek.

Licensed under the [MIT License](LICENSE).

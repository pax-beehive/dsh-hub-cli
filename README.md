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
| [`@dsh-plugin-hub/cli`](packages/cli) | Search, exact install plans, Profile diff, doctor, upgrade, share, apply, history, and rollback |
| [`@dsh-plugin-hub/dsh-plugin`](packages/dsh-plugin) | DSH agent tools backed by the same reviewed CLI operation plans |

## Version 0.2.0

The `0.2.0` packages add reviewable, expiring plans for Plugin installation and
Profile apply, upgrade, share, and rollback; Profile diff, doctor, and history;
recoverable local revisions; and privacy-preserving lifecycle telemetry. All
four public packages are released in lockstep under the same version.

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
expiring operation plan before an agent applies a Plugin or Profile mutation.

## Common workflows

```bash
# Discover and inspect an exact Plugin version
dsh-hub search memory
dsh-hub info dsh-context --version 1.2.3

# Review an expiring install plan before applying it
dsh-hub install dsh-context --version 1.2.3 --profile web --plan --json
dsh-hub operation apply <plan-id> --json

# Inspect local Profile health and drift
dsh-hub profile doctor --profile web
dsh-hub profile diff <profile-slug> --version <version> --profile web

# Preview or plan a recoverable upgrade
dsh-hub profile upgrade <profile-slug> --version <version> --profile web --dry-run
dsh-hub profile upgrade <profile-slug> --version <version> --profile web --plan --json
```

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

The CLI first prints a notice and sends no event during that run. It records an
enabled preference for later eligible commands, which users can disable before
the next run. Successful and failed install/Profile lifecycle commands then
send best-effort anonymous usage events to the Hub. The API stores 365 days of
daily aggregates for package or Profile slug, outcome, public version,
platform, architecture, CLI version, a stable error category, and duration.
Event payloads contain no account identity, machine identifier, IP-address
field, local path, Profile contents, configuration, environment value, or
secret. Normal delivery uses HTTPS in a detached process with a 1.5-second
timeout and never changes the command result. Use
`dsh-hub telemetry state|on|off` for the persistent setting;
`--no-telemetry`, `DSH_HUB_TELEMETRY=0`, or `DO_NOT_TRACK=1` disables one
invocation. `DSH_HUB_TELEMETRY_DEBUG=1` prints the complete next event and
suppresses delivery.

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

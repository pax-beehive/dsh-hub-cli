# @dsh-plugin-hub/dsh-plugin

Agent-facing DSH tools for planning, sharing, applying, and rolling back
reproducible [DSH Plugin Hub](https://dshpluginhub.ai) Presets.

- Website: [dshpluginhub.ai](https://dshpluginhub.ai)
- Browse plugins: [dshpluginhub.ai/plugins](https://dshpluginhub.ai/plugins)
- Explore Presets: [dshpluginhub.ai/profiles](https://dshpluginhub.ai/profiles)

Install into a Profile:

```sh
dsh plugin --profile web add @dsh-plugin-hub/dsh-plugin
```

The bundle exposes read-only discovery and diagnosis tools plus confirmed plan
application, all backed by the local `dsh-hub` CLI:

- `dsh_hub_search` searches the live catalog.
- `dsh_hub_plugin_info` reviews exact versions, compatibility and security.
- `dsh_hub_plugin_plan` creates an exact, preconditioned Plugin install plan.
- `dsh_hub_profile_plan` creates a read-only, expiring install plan.
- `dsh_hub_profile_diff` compares Plugin membership, order, versions, sources, and Release identity.
- `dsh_hub_profile_upgrade_plan` plans an upgrade and returns its full diff.
- `dsh_hub_profile_doctor` diagnoses local state and release drift.
- `dsh_hub_profile_share_plan` captures an exact, read-only publication plan.
- `dsh_hub_profile_rollback_plan` selects a complete recoverable revision.
- `dsh_hub_operation_apply` applies that plan after explicit confirmation.
- `dsh_hub_profile_history` lists recoverable local revisions.

Every machine-triggered mutation uses an expiring, single-use, preconditioned
plan and the same staging, validation, atomic switch and rollback implementation
as direct CLI use.

## Telemetry

This adapter does not add a separate telemetry client. Commands it invokes use
the installed `dsh-hub` CLI preference. On the CLI's first run a notice is
shown and that run sends no event; later eligible install and Preset lifecycle
operations report anonymous aggregates unless the user runs `dsh-hub telemetry
off` or uses one of the documented per-invocation opt-outs. See the
[`@dsh-plugin-hub/cli` README](https://github.com/pax-beehive/dsh-hub-cli/tree/main/packages/cli#anonymous-cli-telemetry) for the
exact fields, retention period, debug mode, and controls.

Requires Node.js 22.13 or later, `@deepseek-ai/cordis`, and
`@deepseek-ai/dsh-tools`.

This is an independent community project and is not affiliated with or endorsed
by DeepSeek.

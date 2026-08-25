# @dsh-plugin-hub/dsh-plugin

Agent-facing DSH tools for planning, sharing, applying, and rolling back
reproducible [DSH Plugin Hub](https://dshpluginhub.ai) Profiles.

- Website: [dshpluginhub.ai](https://dshpluginhub.ai)
- Browse plugins: [dshpluginhub.ai/plugins](https://dshpluginhub.ai/plugins)
- Explore Profiles: [dshpluginhub.ai/profiles](https://dshpluginhub.ai/profiles)

Install into a Profile:

```sh
dsh plugin --profile web add @dsh-plugin-hub/dsh-plugin
```

The bundle exposes five DSH tools backed by the local `dsh-hub` CLI:

- `dsh_hub_profile_plan` creates a read-only, expiring install plan.
- `dsh_hub_profile_share_plan` captures an exact, read-only publication plan.
- `dsh_hub_profile_rollback_plan` selects a complete recoverable revision.
- `dsh_hub_operation_apply` applies that plan after explicit confirmation.
- `dsh_hub_profile_history` lists recoverable local revisions.

Every machine-triggered mutation uses an expiring, single-use, preconditioned
plan and the same staging, validation, atomic switch and rollback implementation
as direct CLI use.

Requires Node.js 22.13 or later, `@deepseek-ai/cordis`, and
`@deepseek-ai/dsh-tools`.

This is an independent community project and is not affiliated with or endorsed
by DeepSeek.

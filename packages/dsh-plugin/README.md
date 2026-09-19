# @dsh-plugin-hub/dsh-plugin

Agent tools for reviewing and managing local DSH Profiles and public
[DSH Plugin Hub](https://dshpluginhub.ai) Presets through the installed `dsh-hub` CLI.

```sh
dsh plugin --profile web add @dsh-plugin-hub/dsh-plugin
```

## Choose the target and review a plan

Start with `dsh_hub_profile_list` and `dsh_hub_profile_status`. They identify each
Profile as `local`, `author`, or `unmanaged`, and show its recorded runtime,
readiness and local drift. Pass the selected `profile` explicitly to subsequent
tools; omitting it selects `web`. The CLI inherits the host's `DSH_HOME`.

`dsh_hub_plugin_plan` adds a selected Plugin. It accepts `runtimeVersion`,
`position`, and conflict `resolutions`. `dsh_hub_profile_edit_plan` supports:

| action | parameters |
| --- | --- |
| `add` | `packageName`, optional `version`, `position` |
| `remove`, `disable`, `enable` | `packageName` |
| `reorder` | `order`: every enabled package in desired order |
| `configure` | `patchFile`: an existing local file path |
| `input-declare` | `inputKey`, optional public `label`, `required`, `secret` |
| `input-remove` | `inputKey` |

Every edit also accepts `profile`, `runtimeVersion`, and `resolutions`. Local
creation and unmanaged adoption preserve existing configuration and files;
local Profiles have no invented author identity. Edits to author Profiles retain
the author baseline for future upgrades. Disable keeps the installed dependency
and records the disabled intent; remove records removal. Removing an input
**declaration** does not delete its saved local value. Required and secret
settings cannot weaken an author's requirements.

Planning may persist an expiring local plan. It does not install dependencies,
change the active Profile, prepare runtime caches, or publish a Release. Present
the exact plan ID, target, runtime, immutable package sources and versions, load
order, declarations, conflict decisions, and effects to the user. Configuration
bodies in doctor/history/publication results are replaced by byte counts and
hashes; ask the user to inspect those files locally before confirming. After the
user confirms that exact plan, call `dsh_hub_operation_apply` with its `planId`
and `confirmed: true`. Application uses the CLI's single-use plan checks, staged
installation, validation, atomic switch and rollback. A changed target or choice
requires a new plan and renewed review.

A blocked plan returns `status: "blocked"`, `exitCode: 2`, safe conflict metadata
and `contextHash`; it is not an executable plan. Present the offered choices,
then repeat the same planning tool with the user's choices:

```json
{
  "resolutions": {
    "contextHash": "sha256:<exact hash from the preview>",
    "choices": { "<conflict ID>": "local" }
  }
}
```

Each choice must be `local` or `upstream` and allowed by that conflict. The adapter
passes this structured object through a private temporary file and removes it
after the CLI exits, including failures and cancellation. The resulting plan
binds the choices and preview context; stale contexts are refused by the CLI.

## Runtime and secrets stay under local control

New and unrecorded Profiles need an exact `runtimeVersion`. Recorded Profiles
use their pinned runtime; publication never guesses from a global `dsh`.
Read-only planning needs an already prepared cache. For a cold cache,
`dsh_hub_runtime_prepare_guidance` returns this local command without running it:

```sh
dsh-hub runtime prepare --runtime-version 0.1.1-rc.2
```

The user reviews the exact version and runs it locally: runtime preparation can
download packages and execute installation scripts. No agent tool prepares a
runtime automatically. `dsh_hub_profile_run_preview` combines local readiness
with `profile run --dry-run`; it neither launches DSH nor installs anything. Its
local launch instruction can prepare the recorded cache when the user runs it.

`dsh_hub_profile_inputs` returns declaration/readiness metadata and precedence,
never saved or environment values. Input declarations also accept no values.
For input entry, give the user the local hidden-prompt command:

```sh
dsh-hub profile inputs set SERVICE_API_KEY --profile web
```

Never request secrets in chat, tool arguments, display labels, or plan choices.
Configuration edits take only a local path, never configuration text. Environment
values take precedence over stored values; `DSH_HOME` remains runtime-managed.
The adapter does not expose input-value writes or interactive execution tools.

When a Profile is launched through the current CLI, its runtime environment marks
which keys came from local saved inputs. Before every CLI subprocess, this adapter
removes those marked keys and the marker. The target Profile resolves its own
saved inputs for validation or launch; another Profile's saved values cannot
silently override them or reach package preparation through this adapter.
Explicit external environment values remain available and keep their precedence.
Invalid markers fail before a subprocess starts. Relaunch older hosts through the
current CLI to establish provenance; unmarked environments retain compatibility
and cannot be classified retrospectively. The marker contains key names only.

## Other tools

- `dsh_hub_search`, `dsh_hub_plugin_info`: live catalog and source/security review.
- `dsh_hub_profile_plan`: plan installing a Hub Release into the selected Profile.
- `dsh_hub_profile_diff`: preview author upgrades and local merge conflicts.
- `dsh_hub_profile_upgrade_plan`: plan a selected author Release upgrade.
- `dsh_hub_profile_doctor`: diagnose local state and optionally remote drift;
  use `dsh_hub_profile_status` for a local-only check.
- `dsh_hub_profile_share_plan`: plan an immutable publication; review captured
  enabled bundles and fixed sources, runtime, patch, and input declarations.
  Review configuration locally before sharing. Extra files, ordinary/disabled
  dependencies, manifest overrides, and stored input values are excluded.
- `dsh_hub_profile_history`, `dsh_hub_profile_rollback_plan`: inspect and restore
  complete revisions, including the unmanaged state before first adoption.

Malformed or oversized subprocess output fails explicitly. Raw CLI stderr and
configuration values are not included in tool errors; inspect a failing command
locally when more detail is needed.

## Telemetry

This adapter has no separate telemetry client. Commands use the installed CLI's
preference: its first-run notice sends no event; later eligible installation and
lifecycle operations report anonymous aggregates unless opted out with
`dsh-hub telemetry off` or a documented invocation opt-out. See the
[CLI README](https://github.com/pax-beehive/dsh-hub-cli/tree/main/packages/cli#anonymous-cli-telemetry).

Requires Node.js 22.13 or later, `@deepseek-ai/cordis`, and
`@deepseek-ai/dsh-tools`. This independent community project is not affiliated
with or endorsed by DeepSeek.

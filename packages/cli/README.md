# @dsh-plugin-hub/cli

The `dsh-hub` command-line client for discovering DSH plugins, sharing complete
version-locked Presets, applying them safely, and rolling back local revisions.

Version `0.2.0` adds reviewable lifecycle plans, Preset diff/doctor/upgrade,
recoverable history and rollback, and the telemetry controls documented below.

- Website: [dshpluginhub.ai](https://dshpluginhub.ai)
- Browse plugins: [dshpluginhub.ai/plugins](https://dshpluginhub.ai/plugins)
- Explore Presets: [dshpluginhub.ai/profiles](https://dshpluginhub.ai/profiles)

## Install

Requires Node.js 22.13 or later and `pnpm` on `PATH`.

```bash
npm install --global @dsh-plugin-hub/cli
dsh-hub --help
```

You can also run it without a global install:

```bash
npx @dsh-plugin-hub/cli --help
```

## Quick start

```bash
dsh-hub search vision
dsh-hub info <package> --version latest
dsh-hub sync <package>
dsh-hub install <package> --profile web --dry-run

dsh-hub profile search team
dsh-hub profile capture my-profile --profile web
dsh-hub profile share my-profile --version 1.0.0 --profile web
dsh-hub profile apply <profile-slug> --profile web --dry-run
dsh-hub profile history --profile web
dsh-hub profile rollback --profile web
```

A Preset Release locks the DSH runtime, Plugin versions, sources, integrity,
and user-confirmed sequence. Apply uses a staging Profile, validation, atomic
switch, recoverable local revisions, and an auditable build-script allowlist
derived from each pinned GitHub source.

## Anonymous CLI telemetry

On first run the CLI prints a notice, saves an enabled preference for later
eligible commands, and sends no event. You can turn telemetry off before the
next run. Successful and failed Plugin install and Preset apply, upgrade,
rollback, share, and doctor operations then send aggregate usage data to the
Hub. Payloads contain the public package or Preset identifier and version,
command outcome, a stable error category, duration, platform, architecture,
and CLI version. They contain no account, machine ID, IP-address field, local
path, Profile contents, configuration value, environment value, or secret. The
API immediately folds events into daily aggregates and retains them for 365
days. Hosting and security providers still process source IPs to deliver and
protect HTTP requests; the API keeps only hour-rotating rate-limit HMAC keys for
the current and previous hour.

Control the persistent setting with:

```bash
dsh-hub telemetry state
dsh-hub telemetry off
dsh-hub telemetry on
```

`--no-telemetry`, `DSH_HUB_TELEMETRY=0`, and `DO_NOT_TRACK=1` disable one
invocation without changing the saved preference. To inspect the complete next
event without sending it, run the command with `DSH_HUB_TELEMETRY_DEBUG=1`.
Normal delivery uses HTTPS in a detached process with a 1.5-second timeout and
never changes the requested command's result. See the hosted
[privacy notice](https://dshpluginhub.ai/privacy) for the complete disclosure.

This is an independent community project and is not affiliated with or endorsed
by DeepSeek.

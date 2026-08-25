# @dsh-plugin-hub/cli

The `dsh-hub` command-line client for discovering DSH plugins, sharing complete
version-locked Profiles, applying them safely, and rolling back local revisions.

- Website: [dshpluginhub.ai](https://dshpluginhub.ai)
- Browse plugins: [dshpluginhub.ai/plugins](https://dshpluginhub.ai/plugins)
- Explore Profiles: [dshpluginhub.ai/profiles](https://dshpluginhub.ai/profiles)

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
dsh-hub install <package> --profile web --dry-run

dsh-hub profile search team
dsh-hub profile capture my-profile --profile web
dsh-hub profile share my-profile --version 1.0.0 --profile web
dsh-hub profile apply <profile-slug> --profile web --dry-run
dsh-hub profile history --profile web
dsh-hub profile rollback --profile web
```

A Profile Release locks the DSH runtime, Plugin versions, sources, integrity,
and user-confirmed sequence. Apply uses a staging Profile, validation, atomic
switch, recoverable local revisions, and an auditable build-script allowlist
derived from each pinned GitHub source.

This is an independent community project and is not affiliated with or endorsed
by DeepSeek.

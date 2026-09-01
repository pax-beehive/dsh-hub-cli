# @dsh-plugin-hub/schemas

Shared schemas for DSH plugins, version-locked Profiles, Profile Releases, and
DSH Plugin Hub API payloads.

- Website: [dshpluginhub.ai](https://dshpluginhub.ai)
- Browse plugins: [dshpluginhub.ai/plugins](https://dshpluginhub.ai/plugins)
- Explore Profiles: [dshpluginhub.ai/profiles](https://dshpluginhub.ai/profiles)

## Install

```bash
npm install @dsh-plugin-hub/schemas
```

## Usage

```ts
import {
  dshPackageManifestSchema,
  dshProfileManifestSchema,
} from "@dsh-plugin-hub/schemas";

const plugin = dshPackageManifestSchema.parse(packageJson);
const profile = dshProfileManifestSchema.parse(profilePackageJson);
```

The package exports Zod schemas and inferred TypeScript types for portable DSH
bundle manifests, Plugin Hub records, Profile drafts and immutable releases.
Use it when building a DSH plugin, integration, validator, or custom Hub client.

Version `0.2.0` is released in lockstep with the CLI, registry, and DSH adapter.
This package performs local validation only: it makes no network request and
collects no telemetry. Anonymous lifecycle telemetry belongs exclusively to the
`@dsh-plugin-hub/cli` runtime and follows that package's documented controls.

This is an independent community project and is not affiliated with or endorsed
by DeepSeek.

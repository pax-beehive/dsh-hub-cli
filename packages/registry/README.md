# @dsh-plugin-hub/registry

Deterministic version resolution and Profile planning for
[DSH Plugin Hub](https://dshpluginhub.ai).

## Install

```bash
npm install @dsh-plugin-hub/registry
```

## What it does

- Resolves exact Plugin versions from semver selectors and dist-tags
- Excludes withdrawn versions
- Preserves an author-confirmed Profile sequence
- Validates `before` and `after` ordering constraints
- Detects duplicate bundles, ordering cycles, and entry ID conflicts
- Produces exact install specs and integrity metadata

```ts
import {
  resolvePluginVersion,
  resolveProfile,
  validateProfileBundleOrder,
} from "@dsh-plugin-hub/registry";
```

This package performs local deterministic computation. It does not host npm
packages or make Registry network requests. The shared data contracts live in
[`@dsh-plugin-hub/schemas`](https://www.npmjs.com/package/@dsh-plugin-hub/schemas).

Browse public DSH plugins and Profiles at
[dshpluginhub.ai](https://dshpluginhub.ai).

This is an independent community project and is not affiliated with or endorsed
by DeepSeek.

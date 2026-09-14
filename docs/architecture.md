# Architecture and trust boundaries

The repository contains the client-side code that users install and execute.

```text
schemas → registry → cli → dsh-plugin
                    ↘ Hub HTTPS API
```

- `schemas` validates untrusted manifests and API responses at runtime.
- `registry` resolves selectors into deterministic install and Preset plans.
- `cli` owns authentication, local filesystem changes, command execution,
  staging, validation, revision history, and rollback.
- `dsh-plugin` exposes agent-facing tools and delegates every mutation to an
  explicit CLI operation plan.
- `skills/dsh-hub` documents the confirmation, secret-handling and recovery
  rules an agent must follow when it invokes those operations.

The hosted Hub remains a separate trust boundary. The client never imports
hosted-service source code and communicates through the documented HTTPS API.
The WorkOS device-flow client identifier embedded in the CLI is a public OAuth
identifier; access and refresh tokens remain local to the user.

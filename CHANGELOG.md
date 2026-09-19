# Changelog

All four `@dsh-plugin-hub/*` packages are released together under one version.

## 0.5.0 — 2026-09-18

- Add local Profile inventory, status, fixed-runtime launch and explicit isolated runtime preparation.
- Support new, unmanaged and author-backed Profiles through one staged edit transaction: install/remove, enable/disable, reorder, configure and input declarations, with history and rollback.
- Keep author baselines separate from personal configuration. Preview and resolve upgrade conflicts, retain local files and dependencies, and preserve explicit disable/remove choices across author releases.
- Store Profile input values separately with hidden terminal entry, environment overrides and shared apply/doctor/run readiness checks. Saved values are excluded from runtime package preparation and operation plans.
- Track saved-input provenance across host tools and nested CLI calls; reload the target Profile's store and keep inherited saved values out of package preparation. Validate explicit library environments and handle Windows input-name aliases.
- Bind edit and upgrade plans to local file state, resolved sources and explicit choices; reject changed plans before switching active files.
- Add host tools for local inventory, status, input readiness, run previews and reviewed edits; preserve structured conflicts and protect configuration in tool output.
- Capture and share the recorded runtime, actual builtin versions and declared input metadata. Bind publication plans to the source files and runtime, reject unsupported dependency sources, and recheck before publication.
- Derive reported CLI version from the installed package manifest and check that runtime and Profile modules are included in release packages.
- Resolve the full effective Profile dependency graph with a selected exact pnpm version, validate the native lock and declared npm integrity, then install with a frozen lock. Reuse intact locks for compatible local edits and retain the lock receipt through history and rollback.
- Check recorded native locks and installation inputs during doctor/status/run. Existing installations without a receipt remain usable with an explicit verification warning.

Runtime and GitHub build artifact attestation, author-distributed locks, complete hook/configuration coverage, supported-environment task validation and real-user trials remain follow-up work. See [next-stage work](docs/profile-next-stage.md).

## 0.4.0

- `DSH_HUB_TOKEN` publishes from CI without an interactive `dsh-hub login`.

## 0.3.0

- Add `dsh-hub sync <package>` for an immediate npm sync, so a version published seconds ago is indexed without waiting for the schedule.
- Add bilingual repository governance, support, security, contribution, and maintenance guidance.
- Add structured Issue and Discussion forms, a pull request template, CODEOWNERS, automatic area labels, pull request policy checks, dependency review, and categorized GitHub Release Notes.
- Validate required repository-governance files as part of `pnpm check`.

## 0.2.0

- Reviewable, expiring operation plans for Plugin install and Profile apply,
  upgrade, share, and rollback, applied through `dsh-hub operation apply`.
- `profile diff`, `profile doctor`, and `profile history` for inspecting local
  state and drift against a Hub Release.
- Recoverable local revisions: apply and upgrade keep the previous Profile
  directory and lockfile intact for `profile rollback`.
- Privacy-preserving lifecycle telemetry with a first-run notice and
  `dsh-hub telemetry state|on|off` controls.
- DSH agent tools in `@dsh-plugin-hub/dsh-plugin` for planning, diffing,
  diagnosing, and confirmed application.

## 0.1.4

- Initial open-source release of the schemas, registry resolver, `dsh-hub`
  CLI, and DSH agent-tool adapter.

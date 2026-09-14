# Changelog

All four `@dsh-plugin-hub/*` packages are released together under one version.

## Unreleased

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

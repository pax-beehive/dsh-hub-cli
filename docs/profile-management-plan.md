# Local Profile management implementation plan

## Current implementation update — 2026-09-17

The customization-preserving upgrade is now integrated. Managed apply, upgrade and import keep the pure author baseline separate, prepare the effective dependency set and ordered bundle list, preserve personal files and configuration, and require context-bound choices for conflicts. Package-manager configuration participates before installation. Staging validates installed package identities and composition before the existing history/swap transaction runs. Rollback restores both files and author state.

The completed B05 check passed 137 tests. The subsequent integrated B04/B05 check passed build, types, all **171 tests**, package-content checks and governance. Managed local add/remove/enable/disable/reorder/configure and local input declarations now use this same transaction. Exact-version local compatibility/order rules and explicit disable/remove choices are recorded independently of author content; author removal and later reintroduction cannot silently undo those choices. Configure and remove can repair their corresponding broken local candidates before validation without writing active files.

The next local-source slice passed the complete build/type/package/governance checks and **200 tests**. New, unmanaged and existing local Profiles now use the same edit transaction. Exact cached runtime templates determine initial bundles by the final target name; actual builtin metadata supplies versions. Local state does not fabricate an author baseline. Adopting existing files, rolling back to unmanaged state and later attaching an author Release preserve personal content through explicit conflicts. Cold-cache previews return an exact preparation command without installing anything; runtime selection and descriptor evidence bind the resulting plan.

The subsequent host/export slice passed **244 tests**, builds/types, package-content checks and governance. Seventeen host tools use the same CLI for inventory, status, readiness, run previews and reviewed edits. Structured conflict choices survive the subprocess boundary; configuration bodies are redacted. Capture/share preserve exact runtime identity, actual builtin versions and declared input metadata, reject unsupported sources, and bind publication to source files and runtime. Extra runtime builtins remain personal content when absent from the author Release.

Separate real cached official runtime smoke checks confirmed new web/headless/custom targets, unmanaged adoption, rollback, local-to-author attachment and subsequent author upgrade, alongside the earlier customization and persistent disable/remove cases. The host adapter also invoked actual CLI subprocesses and official-runtime composition within an isolated test Profile. No release, fresh network installation, third-party task, real agent-model session or real user outcome is implied. Nonstandard dependency groups, full artifact integrity and transitive-lock replay remain open.

The saved-input inheritance follow-up passed the full build/type/package/governance check and **269 tests**. A private names-only provenance marker follows stored inputs into the host. The adapter clears marked inputs before each CLI spawn, and a directly nested CLI clears them at startup. Runtime preparation, package commands and installation library entry points validate this boundary; the target Profile reloads its own store for validation/run. Explicit external values retain precedence. Real subprocess chains cover both entry paths, cold runtime preparation, package installation, explicit library environments and malformed-marker rejection. Windows alias selection is tested through a platform seam; native Windows execution remains unverified. Older unmarked hosts retain their inherited semantics and need relaunching to establish provenance. Arbitrary application subprocesses are outside this management boundary.

The sections below record earlier implementation stages; their replacement-only boundary describes the initial lifecycle implementation and has been superseded by the integrated upgrade above.

## Outcome

Make the installed side of Profile publishing usable every day: enumerate local Profiles, inspect release/runtime/drift/history, start a managed Profile with the runtime that its author published, and refuse a stale operation before it replaces local work.

## Implementation order

1. Add deterministic local snapshots of Profile files and Hub state. Include package manifests, patch, lockfiles and custom files; hash symlink targets without following them. Exclude dependency trees and VCS internals. File contents, environment values and credentials stay local.
2. Bind apply/upgrade/rollback plans to snapshots, including the rollback revision. Reject legacy plans without disk preconditions and recheck the active Profile after staging, before switching directories. Serialize Profile replacement and rollback on a local mutation lock.
3. Persist release runtime and input declarations in the local Hub state, plus the installed filesystem baseline. Add `profile list`, `profile status`, and `profile run` with exact runtime selection and a dry-run preview. Preserve inherited local environment; do not record input values.
4. Make rollback recover the displaced Profile if the state write fails, and include unmanaged original Profiles in history so their files can be recovered.
5. Add regression coverage for hand edits, custom files, modified rollback revisions, races during staging, local status, runtime pinning and failed rollback. Build before testing compiled modules, then run the repository checks.

## Product boundaries

- Applying a Release replaces the selected Profile. Existing files stay in a local revision; there is no automatic three-way merge or promise to preserve customizations in the new Profile.
- Snapshot checks cover authored Profile files, not all installed dependency bytes. This does not claim reproducible transitive dependencies or execution attestation.
- Legacy installations without a recorded runtime must be reapplied or supply an explicit exact runtime for `run`; a global runtime is never silently substituted.
- The new local commands do not contact the Hub or transmit Profile inventory/configuration. Launch still lets the DSH runtime access the network according to its own behavior.
- No publish, deployment or version bump in this change.

## Acceptance evidence

Behavior tests must prove that stale plans cannot execute, edits made while staging survive, rollback failures restore both directory and Hub state, unmanaged Profiles remain recoverable, and a Profile runs with its recorded runtime. CLI smoke tests use an isolated `DSH_HOME` and demonstrate list/status/run dry-run without network.

## Verification completed — 2026-09-17

- `pnpm check`: build, package typechecks, 68 tests, package-content check and repository-governance check passed.
- Bundled Node 24.19.0: all 19 Profile management behavior tests passed against freshly built output.
- CLI process tests verified list/status/run previews against an unreachable API URL. A local fake `npx` executable verified the actual launch arguments, inherited input and `DSH_HOME`; this is process integration coverage, not a real DSH host validation.
- `git diff --check` passed. No version bump, publication, deployment, or commit was performed.
- Subsequent real-host smoke on macOS used the pre-existing official `@deepseek-ai/dsh@0.1.1-rc.2` cache: real version/config composition, installed status, pinned-run preview, history and rollback passed. It exposed DSH's shared `profiles/node_modules` directory; the list now excludes it and target validation rejects that reserved name case-insensitively. The final repository check passed 69 tests.
- Remaining release validation: fresh network installation, full third-party template installation, real task activation on supported operating systems, and npm distribution of the next CLI version. Full dependency locking and customization merging remain future product work.

## Next baseline slice: persistent local inputs

Implement `profile inputs list`, `profile inputs set KEY [--stdin]`, and `profile inputs unset KEY`, each scoped by `--profile`. Configuration works before a Profile is installed; existing apply/run syntax remains valid. Interactive entry never echoes values; automation supplies values through stdin, never command arguments. Stdin strips one terminal newline (including CRLF) and otherwise preserves the value, including embedded newlines.

Store values only in `DSH_HOME/.hub/inputs/<profile>.json`, outside the shareable Profile and installation revisions. The storage directory is 0700; files and atomic temporary writes are 0600. Reject symlink paths and control-environment keys such as PATH, NODE_OPTIONS, DSH_HOME, loader and package-manager controls. This is local file-permission protection, not encryption. Do not read existing real user credentials during implementation or testing.

Input precedence is explicit inherited environment first, saved Profile value second. An explicitly present empty environment value wins and counts as missing for a required declaration. Only keys declared by the selected Release or installed Hub state are loaded from storage into child processes; orphaned saved keys stay local and are visible by name for cleanup. Built-in process controls are never loaded from storage, even if a malicious Release declares them. Status output exposes only key, configured boolean, required/secret metadata, and source; no values or hashes of values.

Apply, plan apply, doctor/status and run share this resolver. Required-value errors include a directly usable `profile inputs set KEY --profile NAME` command. Apply uses the target Profile's saved inputs while staging under a temporary name. Capture/export/share read the shareable configuration and declarations only. Add filesystem and real child-process tests for scope isolation, precedence, empty/multiline values, unset, pre-install configuration, blocked keys, symlink/permissions, and absence from plans, dry-run and status output. No local-overlay refactor or publication in this slice.

## Persistent-input execution details and acceptance

- `DSH_HOME` is derived from the invocation's effective home and appears as runtime-managed metadata, never as an impossible user-configured requirement. Other reserved process declarations use the inherited environment only. `DSH_AGENTS_HOME` remains a configurable declared input; there is no universal plugin-independent default.
- Plans pin the input declarations while values are resolved at execution time. Credential rotation does not invalidate a plan, and values are never fingerprinted. Execution rechecks required readiness before installing, and an already running process keeps its original environment snapshot.
- Staged config validation discards both output streams. Composition failures say that the new Release failed and the existing Profile was not switched. Runtime preparation errors retain a separate controlled phase and exit status; detailed composition diagnostics remain open work.
- An independent review identified npm exec cache misses as an input leak path. The completed implementation prepares an exact package in a private staged npm prefix with `--global=false`, using inherited environment only. It validates the package name/version and a regular executable resolving inside the package, atomically saves the runtime cache, and launches through `process.execPath`. Saved values are added only for that final executable. There is no npm/npx subprocess in the second phase and no cwd/global-package fallback.
- Runtime preparation failures and concurrent preparation cannot overwrite a usable version. Invalid/symlink caches fail closed. Profile dry-run preserves the logical pinned command for compatibility and separately reports its actual preparation/direct-launch strategy.
- Actual PTY evidence confirms no input echo and a 0600 saved file. Isolated child-process tests cover first preparation without stored values, declared values in the final runtime, undeclared values absent, cache hits skipping npm, hidden config output on success/failure, and existing Profile preservation. Evidence and repeatable commands live in `research/profile-product/input-smoke/` in the parent workspace.
- Complete author dependency locks, runtime/plugin artifact attestation, fresh network installation and richer diagnostics are not claimed by this slice. Normal interactive applications retain their own output and can print values they receive.
- Final verification: `pnpm check` passed build/typechecks, all **99 tests**, package contents and repository governance. Bundled Node 24.19 directly passed all **14 inputs/runtime tests** against that build. `git diff --check` passed. These totals include the separate merge helper tests already present in the shared workspace. No publication, commit, deployment, network approval or real credential access occurred.

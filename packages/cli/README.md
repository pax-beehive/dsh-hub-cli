# @dsh-plugin-hub/cli

The `dsh-hub` command-line client for discovering DSH plugins, sharing complete
version-locked Presets, applying them safely, and rolling back local revisions.

Version `0.5.0` adds local Profile management, saved inputs, customization-preserving
upgrades, fixed Runtime launch and native pnpm lock receipts. Runtime/GitHub artifact
attestation and complete hook/environment verification remain follow-up work.

Version `0.4.0` added `DSH_HUB_TOKEN` so a pipeline can publish without an
interactive login. Version `0.3.0` added `dsh-hub sync <package>` for an
immediate npm sync; the reviewable lifecycle plans, Preset diff/doctor/upgrade,
recoverable history and rollback, and the telemetry controls documented below
arrive with `0.2.0`.

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

## Manage installed Profiles (next release)

```bash
dsh-hub profile list
dsh-hub profile status --profile research --json
dsh-hub profile run --profile research --dry-run
dsh-hub profile run --profile research
dsh-hub profile upgrade --profile research --plan --json
dsh-hub operation apply <plan-id>
dsh-hub profile rollback --profile research --plan --json
```

`list` and `status` inspect local Profiles without contacting the Hub. They show
the installed Release, its runtime, local file drift, required input readiness,
and recoverable revision count. Neither command returns environment values or
configuration contents. `run` invokes the exact DSH runtime recorded during
installation and inherits your local environment. Older installations need a
fresh apply or an explicit `--runtime-version <exact-semver>`; an unrecorded
global runtime is never silently selected.

Execution prepares that exact package under `$DSH_HOME/.hub/runtimes/<version>`
using an isolated npm installation, then runs its verified package bin directly
with the current Node executable. A usable cache skips npm entirely. `run`
dry-run keeps `command` as the compatible logical runtime request and reports
the actual two-step strategy in `execution`; it does not prepare or launch
anything. Invoke `profile run` to use saved inputs and this preparation boundary.

Managed Profile updates compare the previous author Release, current local
files, and the new Release. Independent manifest edits, fixed local dependencies
and extra files are retained. The author baseline stays separate from the
effective installation so later upgrades continue to distinguish personal work.
`apply` and archive `import` use this preservation path for managed targets too.
An imported archive has no authenticated Hub slug and clears the old Hub source
identity. The previous directory and its full state remain recoverable revisions.

Preview before upgrading:

```bash
dsh-hub profile diff --profile research --json
dsh-hub profile upgrade --profile research --resolutions choices.json --plan --json
dsh-hub operation apply <plan-id>
```

Conflicts expose paths, IDs and permitted choices, without printing local
configuration values. A resolutions file contains only the preview's
`contextHash` and a `choices` object mapping conflict IDs to `local` or
`upstream`, according to each conflict's allowed choices. YAML patch text and
plugin order arrays are handled atomically; competing changes require a choice.
Some generated files can only be rebuilt from upstream. Unsupported sources
and missing trustworthy baselines stop the update with an explanation.
Install to another `--profile` to keep an independent setup.

`diff` is a read command. Direct updates, dry-run and plan creation return exit
code 2 when preparation is blocked; no executable plan or installation is
created. Legacy installations can migrate using their original exact Hub
Release with a matching recorded content hash. A missing or unverifiable
baseline never silently becomes an overwrite operation.

Plans bind to the current local files and Hub state. Changes to a patch,
manifest, lockfile, custom file, or rollback revision invalidate the plan. The
installer checks again after staging; intervening edits abort the switch and
remain intact. Dependency trees and Git internals are excluded from this file
snapshot, so a clean status does not attest to all dependency bytes or task
success. Upgrade preparation also binds its extra-file inventory and merge
result. Plans save target author data, conflict choices and hashes; local
merged manifests, patches and raw conflict values are not stored in the plan.
Execution recalculates the same preparation under the installation lock.
Existing replacement upgrade plans must be recreated.

Profile replacement and rollback use a local exclusive lock. If a process was
forcibly terminated, inspect the Profile and confirm no Hub operation is still
running before removing its `.hub/installations/<profile>/mutation.lock`.

## Create and edit local Profiles (next release)

```bash
dsh-hub install <package> --version <selector> --profile research --position 1 --plan --json
dsh-hub profile plugin disable <package> --profile research --dry-run
dsh-hub profile plugin enable <package> --profile research --plan --json
dsh-hub profile plugin remove <package> --profile research --plan --json
dsh-hub profile plugin reorder <first-package> <second-package> --profile research --plan --json
dsh-hub profile configure --file ./my.patch.yml --profile research --plan --json
dsh-hub operation apply <plan-id>
```

A new or previously unmanaged Profile needs an explicit exact runtime. A direct
edit prepares that version's isolated cache and initializes the Profile in the
same transaction:

```bash
dsh-hub install <package> --profile research --runtime-version <exact-version>
# Or start from your own configuration file:
dsh-hub profile configure --file ./my.patch.yml --profile research --runtime-version <exact-version>
```

To review first, prepare the cache explicitly, then create a read-only preview
or a plan:

```bash
dsh-hub runtime prepare --runtime-version <exact-version>
dsh-hub profile configure --file ./my.patch.yml --profile research --runtime-version <exact-version> --plan --json
dsh-hub operation apply <plan-id>
dsh-hub profile status --profile research --json
dsh-hub profile run --profile research
```

`runtime prepare` writes only the exact-version runtime cache and never loads
saved Profile inputs. Dry-run and plan preparation do not download runtimes;
a cold cache gives this explicit preparation command. New Profiles use the
verified host's template for their target name: `web` and `headless` get their
shipped app bundles, and other names get the host's default base bundle. The
manifest, user patch and pnpm workspace are initialized before validation.
Previously unmanaged Profiles retain their local files and configuration;
the previous directory remains recoverable through history and rollback.

`status` distinguishes `author`, `local`, and `unmanaged` sources. Local edits
record the effective runtime, bundles and inputs without creating an author
baseline from personal configuration. Further edits default to the recorded
runtime. A local Profile can select a different exact version explicitly; its
builtin pins and compatibility are checked again. An author Profile changes
runtime through its Release upgrade; a conflicting local runtime override fails.

For a legacy Hub installation missing its author baseline, preview its original
Release with `profile diff <slug> --version <installed-release> --profile research`,
then apply that Release to migrate a verified matching baseline. If the original
Release is unavailable, apply a Release under a new Profile name. A legacy Hub
record never silently becomes a standalone local Profile.

`install` resolves a selector to an exact source and adds it to the effective
Profile; `--position` is a zero-based load-order index. Its published ordering
and compatibility rules remain local metadata for later edits and upgrades.
`disable` retains the dependency while taking it out of the load order;
`enable` checks the installed bundle before loading it again. `remove` drops the
dependency and load-order entry. Reorder lists every enabled bundle exactly once.
Removal retains the local patch and validates the resulting composition.
`configure` replaces the Profile patch with a local UTF-8 file. Preview and plan
output include safe actions and hashes, without the patch's contents.

All edit commands accept `--runtime-version <exact>`, `--dry-run`, `--plan` and context-bound `--resolutions`.
A dry-run prepares a preview without changing the Profile or installing packages.
A plan stores the exact selected runtime and edit intent; configuration edits
store only the file path and binding hashes. Changing the file, intent or local Profile invalidates the plan.
Execution stages the result, uses the recorded runtime, validates it, and saves a
recoverable revision before switching when a previous Profile exists. An existing
author baseline remains unchanged; standalone local Profiles have no author baseline.
Older `plugin.install` plans must be recreated with `install --plan`.

To make a local plugin's input available to validation and launch, declare the
key as well as storing its value:

```bash
dsh-hub profile inputs set MY_PLUGIN_KEY --profile research
dsh-hub profile inputs declare MY_PLUGIN_KEY --label 'Plugin key' --profile research --plan --json
dsh-hub operation apply <plan-id>
dsh-hub profile inputs undeclare MY_PLUGIN_KEY --profile research --plan --json
```

Declarations default to required and secret. Use `--optional` or `--public-input`
only for keys with that policy. A local declaration cannot weaken an author's
required or secret policy. `undeclare` removes only the local declaration and
keeps the stored value; `inputs unset` deletes a stored value. Local declarations
survive upgrades and participate in doctor and run. Values stay in the separate
private input store and never become part of these operation plans or revisions.

## Local Profile inputs (next release)

Configure an input before installation or change it later:

```bash
dsh-hub profile inputs set DEEPSEEK_API_KEY --profile research
dsh-hub profile inputs list --profile research --json
dsh-hub profile inputs unset DEEPSEEK_API_KEY --profile research
```

The `set` command prompts without echoing your value. Automation can supply a
value through a pipe with `--stdin`; values are never accepted as command
arguments. Stdin removes one final newline (including CRLF), preserves embedded
newlines, and rejects NUL bytes and values over 64 KiB.

Values are stored in `$DSH_HOME/.hub/inputs/<profile>.json`, separate from the
shareable Profile and its revision history. Files use owner-only permissions
and atomic writes. This is local filesystem protection, not encryption.
`list` returns names, readiness and source only. Capture/share, operation plans,
status and dry-run output contain no saved values.

Configuration validation suppresses child stdout and stderr because a composed
config can contain substituted values. A failed staged composition check leaves
the current Profile unchanged. Runtime preparation failures identify that phase
and its exit status separately; detailed sanitized composition diagnostics are
not yet implemented. Preparation removes inputs marked as coming from a parent
Profile's store; target saved inputs are added when launching the verified DSH bin
directly. They are not passed through npm/npx or to package-install processes.
Normal `profile run` keeps the application's
interactive output; Hub cannot prevent an arbitrary plugin from printing values
that the running application receives.

The current CLI carries a private marker containing only the names of inputs
loaded from its target store. The host adapter clears these marked inputs before
each CLI subprocess; a directly nested CLI does the same at startup. The target
Profile then resolves its own saved values. Invalid markers fail before Hub
installation or runtime preparation starts. Explicit external values retain
precedence, including an explicitly empty value. Windows input resolution handles
case aliases consistently; POSIX preserves case-sensitive input names.

Relaunch older hosts through the current `profile run` to establish provenance.
An unmarked inherited value keeps its legacy behavior because its source cannot
be inferred. This boundary covers Hub's management commands and does not sandbox
arbitrary child processes started by application plugins.

The exact runtime package check does not verify every dependency byte or lock
the author's complete transitive dependency graph. Fresh network installation
and cross-platform execution still require release acceptance tests.

Apply, doctor and run load only saved keys declared by the selected Release or
installed Profile. Explicit environment variables take precedence; an explicitly
empty environment variable stays empty and does not fall back to a saved value.
Unreferenced saved keys are retained for later use and can be removed with
`unset`. They are never automatically added to the child environment.

`DSH_HOME` is managed by the runtime: it is derived from the effective home for
this invocation and appears as `source: runtime, configurable: false` when a
Profile declares it. PATH, NODE_OPTIONS and other process controls cannot be
saved as Profile inputs. Other process-controlled declarations must come from
your trusted launch environment. `DSH_AGENTS_HOME`, when declared, can be set
locally to the desired agents directory; Hub does not assume every plugin uses
the same default.

Saved input values are resolved when an operation is applied. Rotating a local
credential does not invalidate a plan or embed the value in its fingerprint;
the Release's input declarations remain part of the reviewed plan. Missing
required values still stop execution before installation starts. A rotation
while a command is already running takes effect on its next invocation.

## Capture and share a Profile (next release)

`profile capture` and `profile share` use the Profile's recorded exact Runtime.
An explicit `--runtime-version` must match that pin. A Profile without a recorded
Runtime requires `--runtime-version <exact>`; neither command probes a global
`dsh` installation. To change an existing local Profile's Runtime, use
`profile configure --file <patch.yml> --runtime-version <exact>` first. `profile run`
also rejects an override that conflicts with its recorded Runtime.

Capture preserves bundle order, actual builtin package versions, installed exact
npm/GitHub versions, and declared input labels and required/secret policies.
Builtin versions come from the selected private Runtime's descriptor or recorded
effective builtin pins; they do not inherit the Runtime package's version. When
unrecorded builtins need a descriptor, run `runtime prepare --runtime-version
<exact>` first. Input values stay in the separate local store.

Capture, `share --dry-run`, and `share --plan` read local evidence without downloading
or claiming that composition has been tested. Sharing validates with the selected
exact Runtime before publication. A share plan binds the Runtime source,
Profile configuration and recorded state, captured draft and publication intent. Apply checks
these again after validation and immediately before publishing the immutable
Release. Changed Profiles and older share plans require a new preview. If local
files change while a remote draft is being saved, that draft can remain saved,
while Release publication stops.

## Publishing from CI

`dsh-hub login` is an interactive WorkOS device flow, so unattended pipelines
use a publish-scoped Hub token instead. Create one in the Dashboard
(**访问令牌 / Access tokens**) and expose it as `DSH_HUB_TOKEN`:

```bash
DSH_HUB_TOKEN=dshhub_... dsh-hub sync my-plugin
DSH_HUB_TOKEN=dshhub_... dsh-hub profile share my-stack --version 1.0.0 --profile web
```

The variable is trimmed, takes precedence over the session saved in
`~/.dsh/.hub/auth.json`, and needs no login or token refresh. A token may call
only:

```text
POST /manage/sync/npm
POST /manage/publish/npm
PUT  /manage/profiles/{slug}/draft
POST /manage/profiles/{slug}/releases
```

Every other `/manage` route requires a browser session, so a leaked token cannot
edit listings, change GitHub connections or mint another token. Revoke it from
the Dashboard; revocation applies to the next request.

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

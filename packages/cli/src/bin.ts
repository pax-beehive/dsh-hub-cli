#!/usr/bin/env node
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { resolveProfile, resolvePluginVersion } from "@dsh-plugin-hub/registry";
import { HubApiClient } from "./api-client.js";
import { exactSemverSchema } from "@dsh-plugin-hub/schemas";
import { getAccessToken, login, logout } from "./auth.js";
import {
  applyOperationPlan,
  createProfileEditPlan,
  createProfileApplyPlan,
  createProfileRollbackPlan,
  createProfileSharePlan,
  readUpgradeResolutions,
} from "./operations.js";
import {
  diffResolvedProfile,
  doctorProfile,
  listLocalProfiles,
  profileStatus,
  readProfileState,
  resolveProfileExportRuntime,
  runLocalProfile,
} from "./profile-lifecycle.js";
import {
  buildCliUsagePayload,
  CLI_VERSION,
  cliErrorCode,
  initializeTelemetry,
  readTelemetryStatus,
  sendCliUsage,
  setTelemetryPreference,
  TELEMETRY_RETENTION_DAYS,
  telemetryEndpoint,
  type CliUsageInput,
} from "./telemetry.js";
import { readProfileArchive, verifyProfileRelease } from "./profile-archive.js";
import {
  assertProfileApplyPrerequisites,
  applyProfileEdit,
  prepareLocalProfileRuntime,
  profileNeedsPreservation,
  dshHomePath,
  captureProfile,
  installResolvedProfile,
  listProfileRevisions,
  ProfileUpgradeBlockedError,
  rollbackProfile,
} from "./index.js";
import { createPluginStarter } from "./scaffold.js";
import { validatePackageDirectory } from "./package-validation.js";
import { assertProfileInputKey, listProfileInputs, setProfileInput, stripStoredInputEnvironment, unsetProfileInput } from "./profile-inputs.js";
import { readProfileInputValue } from "./input-prompt.js";
import { preparePinnedRuntime } from "./runtime-launch.js";
import { prepareProfileUpgrade } from "./profile-upgrade.js";
import { prepareProfileEdit, type ProfileEditIntent } from "./profile-edit.js";
import type { PluginRecord } from "@dsh-plugin-hub/schemas";

const usage = `dsh-hub — DeepSeek Harness plugin and preset client

Usage:
  dsh-hub --version
  dsh-hub init [directory] --repository <owner/repository> [--name <npm-package>]
  dsh-hub validate [directory] [--json]
  dsh-hub search <query> [--json]
  dsh-hub info <package> [--version <selector>] [--json]
  dsh-hub sync <package> [--json]
  dsh-hub install <package> [--version <selector>] [--profile web] [--runtime-version <exact>] [--dry-run|--plan --json]
  dsh-hub runtime prepare --runtime-version <exact> [--json]
  dsh-hub login
  dsh-hub logout
  dsh-hub telemetry [state|on|off|debug]
  dsh-hub profile search <query> [--json]
  dsh-hub profile list [--json]
  dsh-hub profile status [--profile web] [--json]
  dsh-hub profile run [--profile web] [--runtime-version <exact-version>] [--dry-run] [--json]
  dsh-hub profile inputs list [--profile web] [--json]
  dsh-hub profile inputs set <KEY> [--profile web] [--stdin] [--json]
  dsh-hub profile inputs unset <KEY> [--profile web] [--json]
  dsh-hub profile inputs declare <KEY> [--label <label>] [--optional] [--public-input] [--dry-run|--plan]
  dsh-hub profile inputs undeclare <KEY> [--profile web] [--dry-run|--plan]
  dsh-hub profile plugin remove|enable|disable <package> [--profile web] [--dry-run|--plan]
  dsh-hub profile plugin reorder <package...> [--profile web] [--dry-run|--plan]
  dsh-hub profile configure --file <patch.yml> [--profile web] [--dry-run|--plan]
  dsh-hub profile apply <slug> [--version <version>] [--profile web] [--resolutions <file>] [--dry-run]
  dsh-hub profile apply <slug> [--version <version>] [--profile web] --plan --json
  dsh-hub profile diff [slug] [--version <version>] [--profile web] [--resolutions <file>] [--json]
  dsh-hub profile upgrade [slug] [--version <version>] [--profile web] [--resolutions <file>] [--dry-run|--plan --json]
  dsh-hub profile doctor [slug] [--version <version>] [--profile web] [--json]
  dsh-hub profile capture <slug> [--profile web] [--runtime-version <exact>] [--name <display-name>] [--json]
  dsh-hub profile import <file.dshprofile> [--profile web] [--resolutions <file>] [--dry-run]
  dsh-hub profile share <slug> --version <version> [--profile web] [--runtime-version <exact>] [--display-name <name>] [--plan --json]
  dsh-hub profile history [--profile web] [--json]
  dsh-hub profile rollback [revision] [--profile web] [--plan --json]
  dsh-hub operation apply <plan-id> [--json]

Options:
  --api <url>       Hub API base URL
  --name <package>  npm package name for a generated starter
  --repository <r>  Public GitHub owner/repository for a generated starter
  --display-name <n> Human-readable name for a generated starter
  --description <d> Preset description when sharing
  --runtime-version <v> Exact DSH version for local creation/editing, run, or sharing
  --profile <name>  Target DSH profile (default: web)
  --version <value> Exact version, dist-tag, or semver range
  --dry-run         Preview resolved changes without changing the profile
  --plan            Persist a preconditioned operation plan without applying it
  --json            Print machine-readable output
  --no-telemetry    Disable anonymous aggregate CLI usage reporting
  --stdin           Read a local input value from stdin instead of a hidden prompt
  --resolutions <f>  JSON contextHash and local/upstream conflict choices from a preview
  --position <n>     Zero-based enabled bundle position when installing
  --file <path>      Local configuration patch file; content stays out of operation plans
  --label <text>     Display label for a local input declaration
  --optional        Declare the local input as optional (default: required)
  --public-input    Declare the local input as non-secret (default: secret)

Environment:
  DSH_HUB_TOKEN     Publish-scoped Hub token for CI, used instead of dsh-hub login
`;

function print(value: unknown, json: boolean) {
  if (json) console.log(JSON.stringify(value));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function resolveProfileTarget(client: HubApiClient, slug: string, version: string) {
  const profile = await client.profile(slug);
  const selected = version === "latest"
    ? profile.versions.find((candidate) => candidate.version === profile.latestVersion)
    : profile.versions.find((candidate) => candidate.version === version);
  if (!selected) throw new Error(`Preset ${slug} has no version ${version}`);
  verifyProfileRelease(selected);
  const records = await Promise.all(selected.bundles
    .filter((bundle) => bundle.sourceKind !== "builtin")
    .map((bundle) => client.package(bundle.packageName)));
  const resolved = resolveProfile(selected, new Map(records.map((record) => [record.packageName, record])));
  return { profile, selected, resolved };
}

async function legacyUpgradeBaseline(client: HubApiClient, current: Awaited<ReturnType<typeof readProfileState>>) {
  if (current?.authorBaseline || !current?.hubProfile || !current.contentHash) return {};
  try {
    const old = await resolveProfileTarget(client, current.hubProfile.slug, current.hubProfile.version);
    if (old.selected.contentHash !== current.contentHash) return {};
    return { baselineRelease: old.selected, baselineResolved: old.resolved };
  } catch { return {}; } // The preparer reports baseline_required without exposing API/config details.
}

function upgradePreview(prepared: Awaited<ReturnType<typeof prepareProfileUpgrade>>, profile: string) {
  return { status: prepared.status, contextHash: prepared.contextHash,
    resultHash: prepared.status === "ready" ? prepared.resultHash : undefined,
    summary: prepared.summary,
    reason: prepared.status === "baseline_required" ? prepared.reason : undefined,
    nextStep: prepared.status === "conflicted"
      ? `Save {"contextHash":"${prepared.contextHash}","choices":{}}; map every conflict ID to one of its listed choices and rerun with --resolutions <file>`
      : prepared.status === "baseline_required"
        ? `Make the original exact Hub Release available, or apply to a new Profile with --profile ${profile}-new`
        : undefined };
}

async function measured<T>(
  client: HubApiClient,
  input: Omit<CliUsageInput, "outcome" | "durationMs" | "errorCode">,
  action: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await action();
    await sendCliUsage(client.baseUrl, { ...input, outcome: "succeeded", durationMs: Date.now() - started });
    return result;
  } catch (error) {
    await sendCliUsage(client.baseUrl, {
      ...input,
      outcome: "failed",
      errorCode: cliErrorCode(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

async function main() {
  // Covers direct CLI invocations from a Hub-launched host as well as the agent
  // adapter. Validate before telemetry, API requests, filesystem writes or spawn.
  const environment = stripStoredInputEnvironment(process.env);
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(environment, key)) delete process.env[key];
  if (process.argv.length === 3 && ["--version", "-v"].includes(process.argv[2]!)) {
    console.log(CLI_VERSION);
    return;
  }
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      api: { type: "string" },
      name: { type: "string" },
      repository: { type: "string" },
      "display-name": { type: "string" },
      description: { type: "string" },
      "runtime-version": { type: "string" },
      profile: { type: "string", default: "web" },
      version: { type: "string", default: "latest" },
      "dry-run": { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "no-telemetry": { type: "boolean", default: false },
      stdin: { type: "boolean", default: false },
      resolutions: { type: "string" },
      position: { type: "string" },
      file: { type: "string" },
      label: { type: "string" },
      optional: { type: "boolean", default: false },
      "public-input": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, subject, value] = parsed.positionals;
  const json = parsed.values.json ?? false;
  if (parsed.values["no-telemetry"]) process.env.DSH_HUB_TELEMETRY = "0";
  if (json) process.env.DSH_HUB_MACHINE = "1";
  if (command === "telemetry") {
    const action = subject ?? "state";
    if (action === "on" || action === "off") {
      const status = await setTelemetryPreference(action === "on");
      print({
        enabled: status.enabled,
        message: `Anonymous CLI telemetry is ${status.enabled ? "on" : "off"}.`,
        configPath: status.configPath,
      }, json);
      return;
    }
    if (action === "state" || action === "status") {
      print(await readTelemetryStatus(), json);
      return;
    }
    if (action === "debug") {
      const client = new HubApiClient(parsed.values.api ?? process.env.DSH_HUB_API_URL, getAccessToken);
      const status = await readTelemetryStatus();
      print({
        ...status,
        endpoint: telemetryEndpoint(client.baseUrl),
        retentionDays: TELEMETRY_RETENTION_DAYS,
        transport: "detached background process with a 1.5 second timeout",
        inspectNextEvent: "DSH_HUB_TELEMETRY_DEBUG=1 dsh-hub <command>",
        debugBehavior: "prints the complete event to stderr and suppresses network delivery",
        samplePayload: buildCliUsagePayload({
          event: "plugin.install",
          outcome: "succeeded",
          packageName: "public-package-name",
          version: "1.0.0",
          durationMs: 100,
        }),
      }, json);
      return;
    }
    throw new Error("telemetry expects state, on, off, or debug");
  }
  if (command) {
    await initializeTelemetry({
      onNotice: (message) => console.error(message),
      onWarning: (message) => console.error(message),
    });
  }
  if (parsed.values.help || !command) {
    console.log(usage);
    return;
  }
  const localEdit = command === "install" || (command === "profile" &&
    (["plugin", "configure"].includes(subject ?? "") || subject === "inputs" && ["declare", "undeclare"].includes(value ?? "")));
  if (localEdit && parsed.values["runtime-version"] && !exactSemverSchema.safeParse(parsed.values["runtime-version"]).success) {
    throw new Error("--runtime-version requires an exact semantic version");
  }
  if (localEdit && parsed.values["dry-run"] && parsed.values.plan) throw new Error("Choose --dry-run or --plan for a local edit");
  if (parsed.values.resolutions && !localEdit && (command !== "profile" || !["apply", "upgrade", "diff", "import"].includes(subject ?? ""))) {
    throw new Error("--resolutions is supported by Profile previews and edits; saved operation plans already bind their choices");
  }
  const resolutions = parsed.values.resolutions ? await readUpgradeResolutions(resolve(parsed.values.resolutions)) : undefined;
  if (command === "profile" && subject === "import" && parsed.values.plan) {
    throw new Error("Profile import does not support --plan; use --dry-run to review it without changing the Profile");
  }

  async function executeLocalEdit(intent: ProfileEditIntent, security?: PluginRecord["security"]) {
    const options = { profile: parsed.values.profile, intent, resolutions, runtimeVersion: parsed.values["runtime-version"] };
    if (parsed.values.plan) {
      print(await createProfileEditPlan({ ...options, security }), true);
      return;
    }
    if (!parsed.values["dry-run"]) await prepareLocalProfileRuntime(options);
    const prepared = await prepareProfileEdit(options);
    if (parsed.values["dry-run"]) {
      print({ status: "ready", source: prepared.source, contextHash: prepared.contextHash, resultHash: prepared.resultHash, edit: prepared.summary }, json);
      return;
    }
    await assertProfileApplyPrerequisites();
    const result = await applyProfileEdit({ ...options, expectedContextHash: prepared.contextHash, expectedResultHash: prepared.resultHash });
    print({ profile: parsed.values.profile, source: result.lockfile.source, revision: result.revision, edit: result.edit }, json);
  }

  if (command === "runtime") {
    if (subject !== "prepare" || parsed.positionals.length !== 2 || !parsed.values["runtime-version"] ||
        !exactSemverSchema.safeParse(parsed.values["runtime-version"]).success) {
      throw new Error("Use runtime prepare --runtime-version <exact-semver>");
    }
    if (parsed.values["dry-run"] || parsed.values.plan) throw new Error("runtime prepare writes only the exact-version cache; omit --dry-run and --plan");
    await preparePinnedRuntime(parsed.values["runtime-version"], dshHomePath());
    print({ status: "ready", runtimeVersion: parsed.values["runtime-version"] }, json);
    return;
  }

  if (command === "login") {
    const user = await login({ onCode: ({ code, url }) => {
      console.log(`Open ${url}`);
      console.log(`Confirm code: ${code}`);
    }});
    console.log(`Signed in as ${user.email}`);
    return;
  }
  if (command === "logout") {
    await logout();
    console.log("Signed out");
    return;
  }

  if (command === "profile" && subject === "inputs") {
    const key = parsed.positionals[3];
    if ((value === "declare" || value === "undeclare") && key && parsed.positionals.length === 4) {
      assertProfileInputKey(key);
      await executeLocalEdit(value === "declare"
        ? { kind: "input-declare", declaration: { key, label: parsed.values.label ?? key,
          required: !parsed.values.optional, secret: !parsed.values["public-input"] } }
        : { kind: "input-remove", key });
      return;
    }
    if (parsed.values["dry-run"] || parsed.values.plan) throw new Error("Input value commands do not accept --dry-run or --plan; use inputs list to inspect configured keys");
    if (value === "list" && parsed.positionals.length === 3) {
      const current = await readProfileState(parsed.values.profile);
      const inputs = await listProfileInputs({ profile: parsed.values.profile, declarations: current?.inputs });
      print({ profile: parsed.values.profile, inputs, precedence: "environment > stored; DSH_HOME is runtime-managed" }, json);
      return;
    }
    if ((value === "set" || value === "unset") && key && parsed.positionals.length === 4) {
      assertProfileInputKey(key);
      if (value === "set") await setProfileInput(parsed.values.profile, key, await readProfileInputValue(parsed.values.stdin, key));
      else await unsetProfileInput(parsed.values.profile, key);
      print({ profile: parsed.values.profile, key, action: value === "set" ? "saved" : "removed",
        storage: "local file protected by filesystem permissions; values are not encrypted" }, json);
      return;
    }
    throw new Error("Use profile inputs list, set KEY [--stdin], unset KEY, declare KEY, or undeclare KEY; never pass a value as an argument");
  }

  if (command === "profile" && subject === "plugin") {
    const packageName = parsed.positionals[3];
    if ((value === "remove" || value === "enable" || value === "disable") && packageName && parsed.positionals.length === 4) {
      await executeLocalEdit({ kind: value, packageName });
      return;
    }
    if (value === "reorder" && parsed.positionals.length > 3) {
      await executeLocalEdit({ kind: "reorder", order: parsed.positionals.slice(3) });
      return;
    }
    throw new Error("Use profile plugin remove, enable, disable <package>, or reorder <every enabled package in order>");
  }
  if (command === "profile" && subject === "configure") {
    if (!parsed.values.file || parsed.positionals.length !== 2) throw new Error("Use profile configure --file <local patch.yml>; configuration values must stay in the file");
    await executeLocalEdit({ kind: "configure", patchFile: resolve(parsed.values.file) });
    return;
  }

  if (command === "profile" && subject === "list") {
    const profiles = await listLocalProfiles();
    if (json) print(profiles, true);
    else if (!profiles.length) console.log("No local Profiles. Apply a Hub Release to get started.");
    else for (const item of profiles) console.log([
      item.profile,
      item.release ? `${item.release.slug}@${item.release.version}` : item.source,
      `${item.bundleCount} bundles`,
      `runtime ${item.runtimeVersion ?? "unrecorded"}`,
      item.drift,
      item.healthy ? "ready" : "needs attention",
    ].join("  ·  "));
    return;
  }
  if (command === "profile" && subject === "status") {
    print(await profileStatus(parsed.values.profile), json);
    return;
  }
  if (command === "profile" && subject === "run") {
    const result = await runLocalProfile({ profile: parsed.values.profile,
      runtimeVersion: parsed.values["runtime-version"], dryRun: parsed.values["dry-run"] });
    if (json || parsed.values["dry-run"]) print(result, json);
    return;
  }

  const client = new HubApiClient(parsed.values.api ?? process.env.DSH_HUB_API_URL, getAccessToken);
  if (command === "init") {
    const directory = subject ?? ".";
    if (!parsed.values.repository) {
      throw new Error("init requires --repository <owner/repository>");
    }
    const packageName = parsed.values.name ?? basename(resolve(directory));
    const result = await createPluginStarter({
      directory,
      packageName,
      repository: parsed.values.repository,
      displayName: parsed.values["display-name"],
    });
    if (json) print(result, true);
    else {
      console.log(`Created ${result.packageName} in ${result.directory}`);
      for (const file of result.files) console.log(`  ${file}`);
      console.log("\nNext:");
      for (const nextCommand of result.nextCommands) console.log(`  ${nextCommand}`);
    }
    return;
  }

  if (command === "validate") {
    const result = await validatePackageDirectory(subject ?? ".");
    if (json) print(result, true);
    else {
      console.log(`Valid ${result.kind}: ${result.name}@${result.version}`);
      if (result.patch) console.log(`  patch: ${result.patch}`);
      if (result.bundleCount !== undefined) console.log(`  bundles: ${result.bundleCount}`);
      for (const warning of result.warnings) console.log(`  warning: ${warning}`);
    }
    return;
  }

  if (command === "search") {
    const result = await client.search(parsed.positionals.slice(1).join(" "));
    if (json) print(result, true);
    else for (const item of result.items) console.log(`${item.packageName}\t${item.latestVersion}\t${item.summary}`);
    return;
  }

  if (command === "info" && subject) {
    const plugin = await client.package(subject);
    const selected = resolvePluginVersion(plugin, parsed.values.version);
    print({ ...plugin, selectedVersion: selected }, json);
    return;
  }

  if (command === "sync" && subject) {
    const result = await client.syncPackage(subject);
    if (result.status !== "accepted") {
      throw new Error(`Hub rejected ${result.packageName}: ${result.reason ?? "unknown reason"}`);
    }
    if (json) print(result, true);
    else {
      console.log(`Synced ${result.kind === "profile" ? "preset" : "plugin"}: ${result.slug}@${result.latestVersion}`);
      console.log(`  versions: ${result.versionsAdded ?? 0} added, ${result.versionsSeen ?? 0} seen`);
    }
    return;
  }

  if (command === "install" && subject) {
    if (parsed.positionals.length !== 2) throw new Error("Use install <package> with --version and --profile options");
    const plugin = await client.package(subject);
    const selected = resolvePluginVersion(plugin, parsed.values.version);
    const position = parsed.values.position === undefined ? undefined : Number(parsed.values.position);
    if (position !== undefined && (!/^(0|[1-9][0-9]*)$/.test(parsed.values.position!) || !Number.isSafeInteger(position))) {
      throw new Error("--position requires a non-negative integer");
    }
    const intent: ProfileEditIntent = { kind: "add", position,
      rule: { packageName: plugin.packageName, version: selected.version, before: selected.before, after: selected.after, compatibility: selected.compatibility }, bundle: {
      packageName: plugin.packageName, selector: selected.version, version: selected.version,
      installSpec: selected.source.installSpec, sourceKind: selected.source.kind,
      integrity: selected.source.kind === "npm" ? selected.source.integrity : undefined,
    } };
    const install = () => executeLocalEdit(intent, plugin.security?.version === selected.version ? plugin.security : undefined);
    if (parsed.values.plan || parsed.values["dry-run"]) await install();
    else await measured(client, { event: "plugin.install", packageName: plugin.packageName, version: selected.version }, install);
    return;
  }

  if (command === "profile" && subject === "apply" && value) {
    const { profile, selected, resolved } = await resolveProfileTarget(client, value, parsed.values.version);
    const current = await readProfileState(parsed.values.profile);
    const baseline = await legacyUpgradeBaseline(client, current);
    const preserve = await profileNeedsPreservation(parsed.values.profile);
    const prepared = preserve ? await prepareProfileUpgrade({ profile: parsed.values.profile, slug: profile.slug,
      release: selected, resolved, resolutions, ...baseline }) : undefined;
    if (prepared && prepared.status !== "ready") {
      print({ profile: parsed.values.profile, upgrade: upgradePreview(prepared, parsed.values.profile) }, json || parsed.values.plan);
      process.exitCode = 2;
      return;
    }
    if (resolutions && !preserve) throw new Error("This new Profile has no upgrade conflicts; omit --resolutions");
    if (parsed.values.plan) {
      print(await createProfileApplyPlan({
        profile: parsed.values.profile,
        slug: profile.slug,
        release: selected,
        resolved,
        resolutions, ...baseline,
      }), true);
      return;
    }
    if (!parsed.values["dry-run"]) await assertProfileApplyPrerequisites();
    const install = () => installResolvedProfile({
        profile: parsed.values.profile,
        resolved,
        release: selected,
        hubProfileSlug: profile.slug,
        dryRun: parsed.values["dry-run"],
        mode: preserve ? "upgrade" : "apply", resolutions, ...baseline,
        expectedFingerprint: prepared?.expectedFingerprint,
        expectedUpgradeHash: prepared?.status === "ready" ? prepared.resultHash : undefined,
      });
    const result = parsed.values["dry-run"]
      ? await install()
      : await measured(client, { event: "profile.apply", profileSlug: profile.slug, version: selected.version }, install);
    if (parsed.values["dry-run"] || json) {
      print({
        profile: profile.slug,
        version: selected.version,
        commands: result.commands.map((item) => [item.command, ...item.args]),
        lockfile: result.lockfile,
        upgrade: prepared ? upgradePreview(prepared, parsed.values.profile) : result.upgrade,
      }, json);
    } else {
      console.log(`Applied ${profile.slug}@${selected.version} to ${parsed.values.profile}. Run: dsh-hub profile run --profile ${parsed.values.profile}`);
    }
    return;
  }

  if (command === "profile" && subject === "diff") {
    const current = await readProfileState(parsed.values.profile);
    const slug = value ?? current?.hubProfile?.slug;
    if (!slug) throw new Error("Preset diff requires a Hub Preset slug or an installed Hub Preset");
    const { profile, selected, resolved } = await resolveProfileTarget(client, slug, parsed.values.version);
    const baseline = await legacyUpgradeBaseline(client, current);
    const prepared = await prepareProfileUpgrade({ profile: parsed.values.profile, slug: profile.slug,
      release: selected, resolved, resolutions, ...baseline });
    print({ ...diffResolvedProfile({
      profile: parsed.values.profile,
      slug: profile.slug,
      release: selected,
      resolved,
      current,
    }), upgrade: upgradePreview(prepared, parsed.values.profile) }, json);
    return;
  }

  if (command === "profile" && subject === "upgrade") {
    if (!await profileNeedsPreservation(parsed.values.profile)) throw new Error("Profile upgrade requires an existing Profile; use profile apply <slug> --profile <name> to create one");
    const current = await readProfileState(parsed.values.profile);
    const slug = value ?? current?.hubProfile?.slug;
    if (!slug) throw new Error("Preset upgrade requires a Hub Preset slug or an installed Hub Preset");
    const { profile, selected, resolved } = await resolveProfileTarget(client, slug, parsed.values.version);
    const diff = diffResolvedProfile({ profile: parsed.values.profile, slug: profile.slug, release: selected, resolved, current });
    const baseline = await legacyUpgradeBaseline(client, current);
    const prepared = await prepareProfileUpgrade({ profile: parsed.values.profile, slug: profile.slug,
      release: selected, resolved, resolutions, ...baseline });
    const upgrade = upgradePreview(prepared, parsed.values.profile);
    if (prepared.status !== "ready") {
      print({ upToDate: false, diff, upgrade }, json || parsed.values.plan);
      process.exitCode = 2;
      return;
    }
    if (!diff.changed && current?.authorBaseline && current.hubProfile?.slug === profile.slug && !resolutions) {
      const local = await profileStatus(parsed.values.profile);
      if (local.drift === "clean" && local.healthy) {
        print({ upToDate: true, diff, upgrade, local }, json || parsed.values.plan);
        return;
      }
    }
    if (parsed.values.plan) {
      const plan = await createProfileApplyPlan({
        profile: parsed.values.profile, slug: profile.slug, release: selected, resolved, kind: "profile.upgrade",
        resolutions, ...baseline,
      });
      print({ ...plan, diff, upgrade }, true);
      return;
    }
    if (!parsed.values["dry-run"]) await assertProfileApplyPrerequisites();
    const install = () => installResolvedProfile({
      profile: parsed.values.profile,
      resolved,
      release: selected,
      hubProfileSlug: profile.slug,
      dryRun: parsed.values["dry-run"],
      mode: "upgrade", resolutions, ...baseline,
      expectedFingerprint: prepared.expectedFingerprint, expectedUpgradeHash: prepared.resultHash,
    });
    const result = parsed.values["dry-run"] ? await install() : await measured(client, {
      event: "profile.upgrade", profileSlug: profile.slug, version: selected.version,
    }, install);
    print({ upToDate: !diff.changed, diff, upgrade, commands: result.commands, lockfile: result.lockfile, revision: result.revision }, json);
    return;
  }

  if (command === "profile" && subject === "doctor") {
    const current = await readProfileState(parsed.values.profile);
    const slug = value ?? current?.hubProfile?.slug;
    let remote: Awaited<ReturnType<typeof resolveProfileTarget>> | undefined;
    if (slug) remote = await resolveProfileTarget(client, slug, parsed.values.version);
    const started = Date.now();
    const result = await doctorProfile({
      profile: parsed.values.profile,
      slug: remote?.profile.slug,
      release: remote?.selected,
      resolved: remote?.resolved,
    });
    if (slug) {
      await sendCliUsage(client.baseUrl, {
        event: "profile.doctor",
        outcome: result.healthy ? "succeeded" : "failed",
        profileSlug: slug,
        version: remote?.selected.version ?? current?.hubProfile?.version,
        errorCode: result.healthy ? undefined : "doctor_unhealthy",
        durationMs: Date.now() - started,
      });
    }
    print(result, json);
    return;
  }

  if (command === "profile" && subject === "capture" && value) {
    const runtime = await resolveProfileExportRuntime({ profile: parsed.values.profile, runtimeVersion: parsed.values["runtime-version"] });
    const draft = await captureProfile({ profile: parsed.values.profile, slug: value, name: parsed.values.name, runtimeVersion: runtime.version });
    draft.runtime = { range: draft.dsh, version: runtime.version };
    print(draft, json);
    return;
  }

  if (command === "profile" && subject === "import" && value) {
    const selected = await readProfileArchive(resolve(value));
    const records = await Promise.all(selected.bundles
      .filter((bundle) => bundle.sourceKind !== "builtin")
      .map((bundle) => client.package(bundle.packageName)));
    const resolved = resolveProfile(selected, new Map(records.map((record) => [record.packageName, record])));
    const current = await readProfileState(parsed.values.profile);
    const preserve = await profileNeedsPreservation(parsed.values.profile);
    const baseline = await legacyUpgradeBaseline(client, current);
    // Archives carry no authenticated Hub slug. Preserve local changes but clear that identity.
    const prepared = preserve ? await prepareProfileUpgrade({ profile: parsed.values.profile, release: selected,
      resolved, resolutions, ...baseline }) : undefined;
    if (prepared && prepared.status !== "ready") {
      print({ profile: parsed.values.profile, upgrade: upgradePreview(prepared, parsed.values.profile) }, json);
      process.exitCode = 2;
      return;
    }
    if (resolutions && !preserve) throw new Error("This new Profile has no upgrade conflicts; omit --resolutions");
    if (!parsed.values["dry-run"]) await assertProfileApplyPrerequisites();
    const result = await installResolvedProfile({
      profile: parsed.values.profile,
      resolved,
      release: selected,
      dryRun: parsed.values["dry-run"],
      mode: preserve ? "upgrade" : "apply", resolutions, ...baseline,
      expectedFingerprint: prepared?.expectedFingerprint,
      expectedUpgradeHash: prepared?.status === "ready" ? prepared.resultHash : undefined,
    });
    if (parsed.values["dry-run"] || json) print({ version: selected.version, commands: result.commands, lockfile: result.lockfile,
      upgrade: prepared ? upgradePreview(prepared, parsed.values.profile) : result.upgrade }, json);
    return;
  }

  if (command === "profile" && subject === "share" && value) {
    const version = exactSemverSchema.parse(parsed.values.version);
    const runtime = await resolveProfileExportRuntime({ profile: parsed.values.profile, runtimeVersion: parsed.values["runtime-version"] });
    const draft = await captureProfile({
      profile: parsed.values.profile,
      slug: value,
      name: parsed.values["display-name"] ?? parsed.values.name,
      description: parsed.values.description,
      runtimeVersion: runtime.version,
    });
    draft.runtime = { range: draft.dsh, version: runtime.version };
    if (parsed.values.plan) {
      print(await createProfileSharePlan({
        profile: parsed.values.profile,
        slug: value,
        version,
        apiBase: client.baseUrl,
        draft,
      }), true);
      return;
    }
    if (parsed.values["dry-run"]) {
      print({ draft, version }, json);
      return;
    }
    const publication = await measured(client, {
      event: "profile.share", profileSlug: value, version,
    }, async () => {
      const plan = await createProfileSharePlan({ profile: parsed.values.profile, slug: value, version, apiBase: client.baseUrl, draft });
      return (await applyOperationPlan({ id: plan.id })).publication;
    });
    print(publication, json);
    return;
  }

  if (command === "profile" && subject === "history") {
    print(await listProfileRevisions(parsed.values.profile), json);
    return;
  }

  if (command === "profile" && subject === "rollback") {
    if (parsed.values.plan) {
      print(await createProfileRollbackPlan({ profile: parsed.values.profile, revision: value }), true);
      return;
    }
    const current = await readProfileState(parsed.values.profile);
    const slug = current?.hubProfile?.slug;
    const action = () => rollbackProfile({ profile: parsed.values.profile, revision: value });
    const result = slug
      ? await measured(client, {
          event: "profile.rollback", profileSlug: slug, version: current?.hubProfile?.version,
        }, action)
      : await action();
    print(result, json);
    return;
  }

  if (command === "profile" && subject === "search") {
    const result = await client.profiles(parsed.positionals.slice(2).join(" "));
    if (json) print(result, true);
    else for (const item of result.items) console.log(`${item.slug}\t${item.latestVersion}\t${item.name}`);
    return;
  }

  if (command === "operation" && subject === "apply" && value) {
    let usage: Omit<CliUsageInput, "outcome" | "durationMs" | "errorCode"> | undefined;
    const started = Date.now();
    let result: Awaited<ReturnType<typeof applyOperationPlan>>;
    try {
      result = await applyOperationPlan({
        id: value,
        progress: (event) => {
          if (event.type === "operation.started") {
            const operation = String(event.operation);
            usage = operation === "profile.edit" && event.action !== "add" ? undefined : {
              event: operation === "plugin.install" || operation === "profile.edit" ? "plugin.install" :
                operation === "profile.upgrade" ? "profile.upgrade" :
                  operation === "profile.rollback" ? "profile.rollback" :
                    operation === "profile.share" ? "profile.share" : "profile.apply",
              packageName: typeof event.packageName === "string" ? event.packageName : undefined,
              profileSlug: typeof event.profileSlug === "string" ? event.profileSlug : undefined,
              version: typeof event.version === "string" ? event.version : undefined,
            };
          }
          if (json) console.log(JSON.stringify(event));
          else console.log(`${String(event.type)} ${String(event.planId)}`);
        },
      });
    } catch (error) {
      if (usage) await sendCliUsage(client.baseUrl, {
        ...usage, outcome: "failed", errorCode: cliErrorCode(error), durationMs: Date.now() - started,
      });
      throw error;
    }
    if (usage) await sendCliUsage(client.baseUrl, { ...usage, outcome: "succeeded", durationMs: Date.now() - started });
    if (!json) print({ planId: result.plan.id, status: result.plan.status, revision: result.revision, edit: result.edit }, false);
    return;
  }

  throw new Error(`Unknown or incomplete command\n\n${usage}`);
}

main().catch((error: unknown) => {
  if (error instanceof ProfileUpgradeBlockedError) {
    print({ error: error.code, message: error.message, contextHash: error.contextHash, summary: error.summary }, process.argv.includes("--json"));
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

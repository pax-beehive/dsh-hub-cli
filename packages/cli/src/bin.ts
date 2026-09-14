#!/usr/bin/env node
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { resolveProfile, resolvePluginVersion } from "@dsh-plugin-hub/registry";
import { HubApiClient } from "./api-client.js";
import { exactSemverSchema } from "@dsh-plugin-hub/schemas";
import { getAccessToken, login, logout } from "./auth.js";
import {
  applyOperationPlan,
  createPluginInstallPlan,
  createProfileApplyPlan,
  createProfileRollbackPlan,
  createProfileSharePlan,
} from "./operations.js";
import {
  diffResolvedProfile,
  doctorProfile,
  readProfileState,
} from "./profile-lifecycle.js";
import {
  buildCliUsagePayload,
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
  buildDshInstallCommand,
  captureProfile,
  detectDshVersion,
  executeDshCommand,
  installResolvedProfile,
  listProfileRevisions,
  rollbackProfile,
  validateCurrentProfile,
} from "./index.js";
import { createPluginStarter } from "./scaffold.js";
import { validatePackageDirectory } from "./package-validation.js";

const usage = `dsh-hub — DeepSeek Harness plugin and preset client

Usage:
  dsh-hub init [directory] --repository <owner/repository> [--name <npm-package>]
  dsh-hub validate [directory] [--json]
  dsh-hub search <query> [--json]
  dsh-hub info <package> [--version <selector>] [--json]
  dsh-hub sync <package> [--json]
  dsh-hub install <package> [--version <selector>] [--profile web] [--dry-run|--plan --json]
  dsh-hub login
  dsh-hub logout
  dsh-hub telemetry [state|on|off|debug]
  dsh-hub profile search <query> [--json]
  dsh-hub profile apply <slug> [--version <version>] [--profile web] [--dry-run]
  dsh-hub profile apply <slug> [--version <version>] [--profile web] --plan --json
  dsh-hub profile diff [slug] [--version <version>] [--profile web] [--json]
  dsh-hub profile upgrade [slug] [--version <version>] [--profile web] [--dry-run|--plan --json]
  dsh-hub profile doctor [slug] [--version <version>] [--profile web] [--json]
  dsh-hub profile capture <slug> [--profile web] [--name <display-name>] [--json]
  dsh-hub profile import <file.dshprofile> [--profile web] [--dry-run]
  dsh-hub profile share <slug> --version <version> [--profile web] [--display-name <name>] [--plan --json]
  dsh-hub profile history [--profile web] [--json]
  dsh-hub profile rollback [revision] [--profile web] [--plan --json]
  dsh-hub operation apply <plan-id> [--json]

Options:
  --api <url>       Hub API base URL
  --name <package>  npm package name for a generated starter
  --repository <r>  Public GitHub owner/repository for a generated starter
  --display-name <n> Human-readable name for a generated starter
  --description <d> Preset description when sharing
  --runtime-version <v> Exact local DSH runtime version for a Preset Release
  --profile <name>  Target DSH profile (default: web)
  --version <value> Exact version, dist-tag, or semver range
  --dry-run         Print the resolved commands without changing the profile
  --plan            Persist a preconditioned operation plan without applying it
  --json            Print machine-readable output
  --no-telemetry    Disable anonymous aggregate CLI usage reporting
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
    const plugin = await client.package(subject);
    const selected = resolvePluginVersion(plugin, parsed.values.version);
    const install = buildDshInstallCommand(parsed.values.profile, selected.source.installSpec);
    if (parsed.values.plan) {
      print(await createPluginInstallPlan({
        profile: parsed.values.profile,
        plugin,
        version: selected.version,
        installSpec: selected.source.installSpec,
      }), true);
      return;
    }
    if (parsed.values["dry-run"]) {
      print({ plugin: plugin.packageName, version: selected.version, command: [install.command, ...install.args] }, json);
      return;
    }
    await measured(client, {
      event: "plugin.install",
      packageName: plugin.packageName,
      version: selected.version,
    }, async () => {
      await executeDshCommand(install);
      await validateCurrentProfile(parsed.values.profile);
    });
    return;
  }

  if (command === "profile" && subject === "apply" && value) {
    if (!parsed.values["dry-run"] && !parsed.values.plan) await assertProfileApplyPrerequisites();
    const { profile, selected, resolved } = await resolveProfileTarget(client, value, parsed.values.version);
    if (parsed.values.plan) {
      print(await createProfileApplyPlan({
        profile: parsed.values.profile,
        slug: profile.slug,
        release: selected,
        resolved,
      }), true);
      return;
    }
    const install = () => installResolvedProfile({
        profile: parsed.values.profile,
        resolved,
        release: selected,
        hubProfileSlug: profile.slug,
        dryRun: parsed.values["dry-run"],
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
      }, json);
    }
    return;
  }

  if (command === "profile" && subject === "diff") {
    const current = await readProfileState(parsed.values.profile);
    const slug = value ?? current?.hubProfile?.slug;
    if (!slug) throw new Error("Preset diff requires a Hub Preset slug or an installed Hub Preset");
    const { profile, selected, resolved } = await resolveProfileTarget(client, slug, parsed.values.version);
    print(diffResolvedProfile({
      profile: parsed.values.profile,
      slug: profile.slug,
      release: selected,
      resolved,
      current,
    }), json);
    return;
  }

  if (command === "profile" && subject === "upgrade") {
    if (!parsed.values["dry-run"] && !parsed.values.plan) await assertProfileApplyPrerequisites();
    const current = await readProfileState(parsed.values.profile);
    const slug = value ?? current?.hubProfile?.slug;
    if (!slug) throw new Error("Preset upgrade requires a Hub Preset slug or an installed Hub Preset");
    const { profile, selected, resolved } = await resolveProfileTarget(client, slug, parsed.values.version);
    const diff = diffResolvedProfile({ profile: parsed.values.profile, slug: profile.slug, release: selected, resolved, current });
    if (!diff.changed) {
      print({ upToDate: true, diff }, json || parsed.values.plan);
      return;
    }
    if (parsed.values.plan) {
      const plan = await createProfileApplyPlan({
        profile: parsed.values.profile, slug: profile.slug, release: selected, resolved, kind: "profile.upgrade",
      });
      print({ ...plan, diff }, true);
      return;
    }
    const install = () => installResolvedProfile({
      profile: parsed.values.profile,
      resolved,
      release: selected,
      hubProfileSlug: profile.slug,
      dryRun: parsed.values["dry-run"],
    });
    const result = parsed.values["dry-run"] ? await install() : await measured(client, {
      event: "profile.upgrade", profileSlug: profile.slug, version: selected.version,
    }, install);
    print({ upToDate: false, diff, commands: result.commands, lockfile: result.lockfile, revision: result.revision }, json);
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
    print(await captureProfile({
      profile: parsed.values.profile,
      slug: value,
      name: parsed.values.name,
    }), json);
    return;
  }

  if (command === "profile" && subject === "import" && value) {
    if (!parsed.values["dry-run"]) await assertProfileApplyPrerequisites();
    const selected = await readProfileArchive(resolve(value));
    const records = await Promise.all(selected.bundles
      .filter((bundle) => bundle.sourceKind !== "builtin")
      .map((bundle) => client.package(bundle.packageName)));
    const resolved = resolveProfile(selected, new Map(records.map((record) => [record.packageName, record])));
    const result = await installResolvedProfile({
      profile: parsed.values.profile,
      resolved,
      release: selected,
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values["dry-run"] || json) print({ version: selected.version, commands: result.commands, lockfile: result.lockfile }, json);
    return;
  }

  if (command === "profile" && subject === "share" && value) {
    const version = exactSemverSchema.parse(parsed.values.version);
    const draft = await captureProfile({
      profile: parsed.values.profile,
      slug: value,
      name: parsed.values["display-name"] ?? parsed.values.name,
      description: parsed.values.description,
    });
    const runtimeVersion = exactSemverSchema.parse(parsed.values["runtime-version"] ?? await detectDshVersion());
    draft.runtime = { range: draft.dsh, version: runtimeVersion };
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
      await validateCurrentProfile(parsed.values.profile, runtimeVersion);
      await client.saveProfileDraft(draft);
      return client.publishProfile(value, version, true);
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
            usage = {
              event: operation === "plugin.install" ? "plugin.install" :
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
    if (!json) print({ planId: result.plan.id, status: result.plan.status, revision: result.revision }, false);
    return;
  }

  throw new Error(`Unknown or incomplete command\n\n${usage}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

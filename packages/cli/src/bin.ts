#!/usr/bin/env node
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { resolveProfile, resolvePluginVersion } from "@dsh-plugin-hub/registry";
import { HubApiClient } from "./api-client.js";
import { exactSemverSchema } from "@dsh-plugin-hub/schemas";
import { getAccessToken, login, logout } from "./auth.js";
import {
  applyOperationPlan,
  createProfileApplyPlan,
  createProfileRollbackPlan,
  createProfileSharePlan,
} from "./operations.js";
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

const usage = `dsh-hub — DeepSeek Harness plugin and profile client

Usage:
  dsh-hub init [directory] --repository <owner/repository> [--name <npm-package>]
  dsh-hub validate [directory] [--json]
  dsh-hub search <query> [--json]
  dsh-hub info <package> [--version <selector>] [--json]
  dsh-hub install <package> [--version <selector>] [--profile web] [--dry-run]
  dsh-hub login
  dsh-hub logout
  dsh-hub profile search <query> [--json]
  dsh-hub profile apply <slug> [--version <version>] [--profile web] [--dry-run]
  dsh-hub profile apply <slug> [--version <version>] [--profile web] --plan --json
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
  --description <d> Profile description when sharing
  --runtime-version <v> Exact local DSH runtime version for a Profile Release
  --profile <name>  Target DSH profile (default: web)
  --version <value> Exact version, dist-tag, or semver range
  --dry-run         Print the resolved commands without changing the profile
  --plan            Persist a preconditioned operation plan without applying it
  --json            Print machine-readable output
`;

function print(value: unknown, json: boolean) {
  if (json) console.log(JSON.stringify(value));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, subject, value] = parsed.positionals;
  const json = parsed.values.json ?? false;
  if (json) process.env.DSH_HUB_MACHINE = "1";
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

  if (command === "install" && subject) {
    const plugin = await client.package(subject);
    const selected = resolvePluginVersion(plugin, parsed.values.version);
    const install = buildDshInstallCommand(parsed.values.profile, selected.source.installSpec);
    if (parsed.values["dry-run"]) {
      print({ plugin: plugin.packageName, version: selected.version, command: [install.command, ...install.args] }, json);
      return;
    }
    await executeDshCommand(install);
    return;
  }

  if (command === "profile" && subject === "apply" && value) {
    if (!parsed.values["dry-run"] && !parsed.values.plan) await assertProfileApplyPrerequisites();
    const profile = await client.profile(value);
    const selected = parsed.values.version === "latest"
      ? profile.versions.find((candidate) => candidate.version === profile.latestVersion)
      : profile.versions.find((candidate) => candidate.version === parsed.values.version);
    if (!selected) throw new Error(`Profile ${value} has no version ${parsed.values.version}`);
    verifyProfileRelease(selected);
    const records = await Promise.all(selected.bundles
      .filter((bundle) => bundle.sourceKind !== "builtin")
      .map((bundle) => client.package(bundle.packageName)));
    const resolved = resolveProfile(selected, new Map(records.map((record) => [record.packageName, record])));
    if (parsed.values.plan) {
      print(await createProfileApplyPlan({
        profile: parsed.values.profile,
        slug: profile.slug,
        release: selected,
        resolved,
      }), true);
      return;
    }
    const result = await installResolvedProfile({
      profile: parsed.values.profile,
      resolved,
      release: selected,
      hubProfileSlug: profile.slug,
      dryRun: parsed.values["dry-run"],
    });
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
    await validateCurrentProfile(parsed.values.profile, runtimeVersion);
    await client.saveProfileDraft(draft);
    print(await client.publishProfile(value, version, true), json);
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
    print(await rollbackProfile({ profile: parsed.values.profile, revision: value }), json);
    return;
  }

  if (command === "profile" && subject === "search") {
    const result = await client.profiles(parsed.positionals.slice(2).join(" "));
    if (json) print(result, true);
    else for (const item of result.items) console.log(`${item.slug}\t${item.latestVersion}\t${item.name}`);
    return;
  }

  if (command === "operation" && subject === "apply" && value) {
    const result = await applyOperationPlan({
      id: value,
      progress: (event) => {
        if (json) console.log(JSON.stringify(event));
        else console.log(`${String(event.type)} ${String(event.planId)}`);
      },
    });
    if (!json) print({ planId: result.plan.id, status: result.plan.status, revision: result.revision }, false);
    return;
  }

  throw new Error(`Unknown or incomplete command\n\n${usage}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

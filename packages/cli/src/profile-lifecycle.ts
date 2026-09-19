import { mergeProfileInputDeclarations } from "./profile-edit.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedProfile } from "@dsh-plugin-hub/registry";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import { exactSemverSchema } from "@dsh-plugin-hub/schemas";
import {
  dshHomePath,
  executeDshCommand,
  listProfileRevisions,
  profileDirectory,
  profileLockPath,
  type DshInstallCommand,
  type HubLockfile,
} from "./index.js";
import { directoryFingerprint } from "./profile-files.js";
import { assertEffectiveProfileDependencyLock, verifyEffectiveProfileDependencyLock } from "./profile-dependency-install.js";
import { missingProfileInputMessage, resolveProfileInputs, type ProfileInputStatus } from "./profile-inputs.js";

export interface ProfileBundleChange {
  packageName: string;
  change: "added" | "removed" | "updated" | "source-changed" | "unchanged";
  fromVersion?: string;
  toVersion?: string;
  fromSource?: string;
  toSource?: string;
}

export interface ProfileDiff {
  profile: string;
  current?: { slug?: string; version?: string; contentHash?: string };
  target: { slug: string; version: string; contentHash?: string };
  order: { changed: boolean; current: string[]; target: string[] };
  changes: ProfileBundleChange[];
  summary: { added: number; removed: number; updated: number; sourceChanged: number; unchanged: number };
  changed: boolean;
}

export interface ProfileDoctorCheck {
  id: string;
  status: "passed" | "warning" | "failed";
  message: string;
  packageName?: string;
}

export interface ProfileDoctorResult {
  profile: string;
  healthy: boolean;
  checks: ProfileDoctorCheck[];
  current?: HubLockfile;
  remoteDiff?: ProfileDiff;
  inputs?: ProfileInputStatus[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readProfileState(profile: string, dshHome?: string): Promise<HubLockfile | undefined> {
  try {
    const current = JSON.parse(await readFile(profileLockPath(profile, dshHome), "utf8")) as HubLockfile;
    if (!current || typeof current !== "object" || Array.isArray(current) || current.schemaVersion !== 2 ||
        current.profile !== profile || !Array.isArray(current.bundles) ||
        (current.source !== undefined && current.source !== "author" && current.source !== "local")) {
      throw new Error("Local Profile state has an unsupported format; repair it before using this Profile");
    }
    if (current.authorBaseline && (current.authorBaseline.schemaVersion !== 1 ||
        !current.authorBaseline.release || !Array.isArray(current.authorBaseline.resolved?.bundles))) {
      throw new Error("Local Profile author baseline has an unsupported format");
    }
    if (current.dependencies !== undefined && !Array.isArray(current.dependencies)) {
      throw new Error("Local Profile effective dependencies have an unsupported format");
    }
    if (current.effectiveLock !== undefined) assertEffectiveProfileDependencyLock(current.effectiveLock);
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("Local Profile state is invalid JSON");
    throw error;
  }
}

/** Select export metadata from the recorded pin or an explicit legacy choice; never probe a global executable. */
export async function resolveProfileExportRuntime(options: { profile: string; runtimeVersion?: string; dshHome?: string }): Promise<{
  version: string; source: "recorded" | "explicit";
}> {
  const current = await readProfileState(options.profile, options.dshHome);
  const recorded = current && !current.unmanaged ? current.runtime?.version ?? current.authorBaseline?.release.runtime?.version : undefined;
  if (recorded !== undefined && !exactSemverSchema.safeParse(recorded).success) {
    throw new Error("The Profile's recorded runtime is invalid; repair its local state before sharing or capturing");
  }
  if (options.runtimeVersion !== undefined && !exactSemverSchema.safeParse(options.runtimeVersion).success) {
    throw new Error("Sharing and capture require --runtime-version <exact-semver>");
  }
  if (recorded && options.runtimeVersion !== undefined && options.runtimeVersion !== recorded) {
    throw new Error(`The Profile's recorded runtime is ${recorded}; omit --runtime-version or pass that same exact version when sharing or capturing`);
  }
  const version = recorded ?? options.runtimeVersion;
  if (!version) throw new Error("This Profile has no recorded exact runtime; pass --runtime-version <exact-semver> when sharing or capturing");
  return { version, source: recorded ? "recorded" : "explicit" };
}

export function diffResolvedProfile(input: {
  profile: string;
  slug: string;
  release: HubProfileVersion;
  resolved: ResolvedProfile;
  current?: HubLockfile;
}): ProfileDiff {
  const authorBundles = input.current?.authorBaseline?.resolved.bundles ?? input.current?.bundles ?? [];
  const currentByName = new Map(authorBundles.map((bundle) => [bundle.packageName, bundle]));
  const targetByName = new Map(input.resolved.bundles.map((bundle) => [bundle.packageName, bundle]));
  const currentOrder = authorBundles.map((bundle) => bundle.packageName);
  const targetOrder = input.resolved.bundles.map((bundle) => bundle.packageName);
  const orderChanged = JSON.stringify(currentOrder) !== JSON.stringify(targetOrder);
  const names = [...new Set([...currentByName.keys(), ...targetByName.keys()])].sort();
  const changes: ProfileBundleChange[] = names.map((packageName) => {
    const from = currentByName.get(packageName);
    const to = targetByName.get(packageName);
    if (!from && to) return { packageName, change: "added", toVersion: to.version, toSource: to.installSpec };
    if (from && !to) return { packageName, change: "removed", fromVersion: from.version, fromSource: from.installSpec };
    if (from!.version !== to!.version) {
      return { packageName, change: "updated", fromVersion: from!.version, toVersion: to!.version };
    }
    if (from!.sourceKind !== to!.sourceKind || from!.installSpec !== to!.installSpec) {
      return {
        packageName, change: "source-changed", fromVersion: from!.version, toVersion: to!.version,
        fromSource: from!.installSpec, toSource: to!.installSpec,
      };
    }
    return { packageName, change: "unchanged", fromVersion: from!.version, toVersion: to!.version };
  });
  const summary = {
    added: changes.filter((item) => item.change === "added").length,
    removed: changes.filter((item) => item.change === "removed").length,
    updated: changes.filter((item) => item.change === "updated").length,
    sourceChanged: changes.filter((item) => item.change === "source-changed").length,
    unchanged: changes.filter((item) => item.change === "unchanged").length,
  };
  return {
    profile: input.profile,
    current: input.current ? {
      slug: input.current.authorBaseline?.slug ?? input.current.hubProfile?.slug,
      version: input.current.authorBaseline?.release.version ?? input.current.hubProfile?.version,
      contentHash: input.current.authorBaseline?.release.contentHash ?? input.current.contentHash,
    } : undefined,
    target: { slug: input.slug, version: input.release.version, contentHash: input.release.contentHash },
    order: { changed: orderChanged, current: currentOrder, target: targetOrder },
    changes,
    summary,
    changed: orderChanged || summary.added + summary.removed + summary.updated + summary.sourceChanged > 0 ||
      input.current?.contentHash !== input.release.contentHash,
  };
}

export async function doctorProfile(input: {
  profile: string;
  dshHome?: string;
  release?: HubProfileVersion;
  resolved?: ResolvedProfile;
  slug?: string;
}): Promise<ProfileDoctorResult> {
  const checks: ProfileDoctorCheck[] = [];
  const directory = profileDirectory(input.profile, input.dshHome);
  const current = await readProfileState(input.profile, input.dshHome);
  if (!await exists(directory)) {
    checks.push({ id: "profile-directory", status: "failed", message: "Profile directory is missing" });
    return { profile: input.profile, healthy: false, checks, current };
  }
  checks.push({ id: "profile-directory", status: "passed", message: "Profile directory exists" });
  if (await exists(join(directory, "cordis.patch.yml"))) {
    checks.push({ id: "profile-patch", status: "passed", message: "Profile cordis.patch.yml is present" });
  } else {
    checks.push({ id: "profile-patch", status: "failed", message: "Profile cordis.patch.yml is missing" });
  }
  if (!current) {
    checks.push({ id: "hub-lock", status: "warning", message: "No Hub lockfile; exact Hub state is unknown" });
  } else {
    checks.push({ id: "hub-lock", status: "passed", message: "Hub lockfile is present" });
  }
  if (current?.effectiveLock) {
    try {
      await verifyEffectiveProfileDependencyLock(directory, current.effectiveLock);
      checks.push({ id: "dependency-lock", status: "passed", message: "The recorded native dependency lock and installation inputs match" });
    } catch (error) {
      checks.push({ id: "dependency-lock", status: "failed", message: error instanceof Error ? error.message
        : "The recorded dependency lock could not be verified; repair the Profile before running" });
    }
  } else {
    checks.push({ id: "dependency-lock", status: "warning", message: "No verified native dependency lock receipt; the existing Profile remains usable with its recorded direct versions" });
  }
  if (current?.localFilesHash) {
    const changed = current.localFilesHash !== await directoryFingerprint(directory);
    checks.push({ id: "local-files", status: changed ? "warning" : "passed",
      message: changed ? "Local Profile files changed since installation; preview the next upgrade to review retained changes and conflicts"
        : "Local Profile files match the recorded installation" });
  }

  let manifest: { dsh?: { profile?: { bundles?: unknown } }; dependencies?: Record<string, string> } | undefined;
  try {
    manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as typeof manifest;
    checks.push({ id: "manifest", status: "passed", message: "Profile package.json is readable" });
  } catch {
    checks.push({ id: "manifest", status: "failed", message: "Profile package.json is missing or invalid" });
  }
  const declared = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(declared) || declared.some((item) => typeof item !== "string")) {
    checks.push({ id: "bundle-sequence", status: "failed", message: "Profile has no valid ordered bundle sequence" });
  } else if (current && JSON.stringify(declared) !== JSON.stringify(current.bundles.map((item) => item.packageName))) {
    checks.push({ id: "bundle-sequence", status: "failed", message: "Profile bundle order differs from the Hub lockfile" });
  } else {
    checks.push({ id: "bundle-sequence", status: "passed", message: "Profile bundle order is consistent" });
  }

  const loaded = new Set(current?.bundles.map((item) => item.packageName) ?? []);
  for (const bundle of current?.dependencies ?? current?.bundles ?? []) {
    if (bundle.sourceKind === "builtin") continue;
    const id = loaded.has(bundle.packageName) ? "bundle-version" : "dependency-version";
    const packageManifest = join(directory, "node_modules", ...bundle.packageName.split("/"), "package.json");
    try {
      const installed = JSON.parse(await readFile(packageManifest, "utf8")) as { name?: string; version?: string };
      if (installed.name !== bundle.packageName || installed.version !== bundle.version) {
        checks.push({
          id, status: "failed", packageName: bundle.packageName,
          message: `Installed package identity or version differs from ${bundle.packageName}@${bundle.version}`,
        });
      } else {
        checks.push({ id, status: "passed", packageName: bundle.packageName, message: `Installed ${bundle.version}` });
      }
    } catch {
      checks.push({ id, status: "failed", packageName: bundle.packageName, message: "Installed package is missing" });
    }
  }

  const inputs = await resolveProfileInputs({ profile: input.profile, declarations: input.release ? mergeProfileInputDeclarations(input.release.inputs, current?.localInputs ?? []) : current?.inputs ?? [], dshHome: input.dshHome });
  for (const required of inputs.statuses.filter((item) => item.required)) {
    checks.push(required.configured
      ? { id: "required-input", status: "passed", message: `${required.key} is available (${required.source})` }
      : { id: "required-input", status: "failed", message: `${required.key} is missing. ${missingProfileInputMessage(input.profile, [required.key])}` });
  }

  const remoteDiff = input.release && input.resolved && input.slug
    ? diffResolvedProfile({ profile: input.profile, slug: input.slug, release: input.release, resolved: input.resolved, current })
    : undefined;
  if (remoteDiff?.changed) {
    checks.push({ id: "latest-release", status: "warning", message: `A different Hub Release is available: ${remoteDiff.target.version}` });
  } else if (remoteDiff) {
    checks.push({ id: "latest-release", status: "passed", message: "Installed Profile matches the selected Hub Release" });
  }
  return {
    profile: input.profile,
    healthy: checks.every((check) => check.status !== "failed"),
    checks,
    current,
    remoteDiff,
    inputs: inputs.statuses,
  };
}

export interface LocalProfileStatus {
  profile: string;
  directory: string;
  exists: boolean;
  managed: boolean;
  source: "author" | "local" | "unmanaged";
  release?: { slug: string; version: string };
  runtimeVersion?: string;
  drift: "clean" | "modified" | "unknown";
  bundleCount: number;
  revisionCount: number;
  healthy: boolean;
  checks: ProfileDoctorCheck[];
  nextSteps: string[];
  inputs?: ProfileInputStatus[];
}

/** Reads only local state, and deliberately returns no configuration/input values. */
export async function profileStatus(profile: string, dshHome?: string): Promise<LocalProfileStatus> {
  const directory = profileDirectory(profile, dshHome);
  const result = await doctorProfile({ profile, dshHome });
  const current = result.current;
  const present = await exists(directory);
  const drift = !current?.localFilesHash ? "unknown" :
    current.localFilesHash === await directoryFingerprint(directory) ? "clean" : "modified";
  let bundleCount = current?.bundles.length ?? 0;
  try {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (Array.isArray(manifest.dsh?.profile?.bundles)) bundleCount = manifest.dsh.profile.bundles.length;
  } catch { /* doctor already reports an invalid or missing manifest */ }
  const nextSteps: string[] = [];
  if (current?.source === "local") nextSteps.push(`dsh-hub profile configure --file <patch.yml> --profile ${profile} --plan --json`);
  if (current?.runtime) nextSteps.push(`dsh-hub profile run --profile ${profile}`);
  if (current?.hubProfile) nextSteps.push(`dsh-hub profile upgrade --profile ${profile} --plan --json`);
  else if (present) nextSteps.push(`dsh-hub profile capture my-${profile} --profile ${profile} --json`);
  const revisions = await listProfileRevisions(profile, dshHome);
  if (revisions.length) nextSteps.push(`dsh-hub profile history --profile ${profile}`);
  return {
    profile, directory, exists: present, managed: Boolean(current && !current.unmanaged),
    source: current?.source ?? (current?.authorBaseline || current?.hubProfile || current?.contentHash ? "author" : current && !current.unmanaged ? "local" : "unmanaged"), release: current?.hubProfile,
    runtimeVersion: current?.runtime?.version, drift, bundleCount, revisionCount: revisions.length,
    healthy: result.healthy, checks: result.checks, nextSteps, inputs: result.inputs,
  };
}

export async function listLocalProfiles(dshHome?: string): Promise<LocalProfileStatus[]> {
  const home = dshHomePath(dshHome);
  const names = new Set<string>();
  for (const directory of [join(home, "profiles"), join(home, ".hub", "installations")]) {
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase() !== "node_modules" && entry.name !== ".git" &&
            !entry.name.startsWith(".hub-") && /^[A-Za-z0-9._-]+$/.test(entry.name)) names.add(entry.name);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const result: LocalProfileStatus[] = [];
  for (const name of [...names].sort()) {
    try { result.push(await profileStatus(name, home)); }
    catch {
      result.push({ profile: name, directory: profileDirectory(name, home), exists: await exists(profileDirectory(name, home)),
        managed: false, source: "unmanaged", drift: "unknown", bundleCount: 0, revisionCount: 0, healthy: false,
        checks: [{ id: "local-state", status: "failed", message: "Local Profile state is unreadable; inspect its files before modifying it" }],
        nextSteps: [`dsh-hub profile status --profile ${name}`] });
    }
  }
  return result;
}

export async function runLocalProfile(options: {
  profile: string;
  dshHome?: string;
  runtimeVersion?: string;
  dryRun?: boolean;
  execute?: (command: DshInstallCommand, env?: NodeJS.ProcessEnv) => Promise<void>;
}): Promise<{ profile: string; runtimeVersion: string; command: DshInstallCommand; drift: LocalProfileStatus["drift"];
  execution: { preparation: "isolated-npm-install-without-stored-inputs"; launch: "verified-package-bin-via-node" } }> {
  const status = await profileStatus(options.profile, options.dshHome);
  if (!status.exists) throw new Error(`Profile ${options.profile} does not exist`);
  if (status.runtimeVersion && options.runtimeVersion && options.runtimeVersion !== status.runtimeVersion) {
    throw new Error(`This Profile is pinned to runtime ${status.runtimeVersion}; change a local Profile with profile configure --file <patch.yml> --runtime-version <exact>, or apply a Release with the desired runtime, before running it`);
  }
  const runtime = status.runtimeVersion ?? options.runtimeVersion;
  if (!runtime) throw new Error("No recorded runtime; reapply a Hub Release or pass --runtime-version <exact-semver>");
  const runtimeVersion = exactSemverSchema.parse(runtime);
  const command: DshInstallCommand = { command: "npx", args: ["-y", `@deepseek-ai/dsh@${runtimeVersion}`, "--profile", options.profile] };
  if (!options.dryRun) {
    const failed = status.checks.filter((check) => check.status === "failed");
    if (failed.length) throw new Error(`Profile is not ready: ${failed.map((check) => check.message).join("; ")}`);
    const current = await readProfileState(options.profile, options.dshHome);
    const inputs = await resolveProfileInputs({ profile: options.profile, declarations: current?.inputs ?? [], dshHome: options.dshHome });
    if (inputs.missing.length) throw new Error(missingProfileInputMessage(options.profile, inputs.missing));
    await (options.execute ?? ((command, env) => executeDshCommand(command, options.dshHome, env)))(command, inputs.env);
  }
  return { profile: options.profile, runtimeVersion, command, drift: status.drift,
    execution: { preparation: "isolated-npm-install-without-stored-inputs", launch: "verified-package-bin-via-node" } };
}

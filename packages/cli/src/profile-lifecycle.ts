import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedProfile } from "@dsh-plugin-hub/registry";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import {
  profileDirectory,
  profileLockPath,
  type HubLockfile,
} from "./index.js";

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
    return JSON.parse(await readFile(profileLockPath(profile, dshHome), "utf8")) as HubLockfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function diffResolvedProfile(input: {
  profile: string;
  slug: string;
  release: HubProfileVersion;
  resolved: ResolvedProfile;
  current?: HubLockfile;
}): ProfileDiff {
  const currentByName = new Map((input.current?.bundles ?? []).map((bundle) => [bundle.packageName, bundle]));
  const targetByName = new Map(input.resolved.bundles.map((bundle) => [bundle.packageName, bundle]));
  const currentOrder = (input.current?.bundles ?? []).map((bundle) => bundle.packageName);
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
      slug: input.current.hubProfile?.slug,
      version: input.current.hubProfile?.version,
      contentHash: input.current.contentHash,
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

  for (const bundle of current?.bundles ?? []) {
    if (bundle.sourceKind === "builtin") continue;
    const packageManifest = join(directory, "node_modules", ...bundle.packageName.split("/"), "package.json");
    try {
      const installed = JSON.parse(await readFile(packageManifest, "utf8")) as { version?: string };
      if (installed.version !== bundle.version) {
        checks.push({
          id: "bundle-version", status: "failed", packageName: bundle.packageName,
          message: `Installed ${installed.version ?? "unknown"}; lockfile requires ${bundle.version}`,
        });
      } else {
        checks.push({ id: "bundle-version", status: "passed", packageName: bundle.packageName, message: `Installed ${bundle.version}` });
      }
    } catch {
      checks.push({ id: "bundle-version", status: "failed", packageName: bundle.packageName, message: "Installed package is missing" });
    }
  }

  for (const required of input.release?.inputs.filter((item) => item.required) ?? []) {
    checks.push(process.env[required.key]
      ? { id: "required-input", status: "passed", message: `${required.key} is available` }
      : { id: "required-input", status: "failed", message: `${required.key} is missing` });
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
  };
}

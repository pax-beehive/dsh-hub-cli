import type {
  HubProfileVersion,
  PluginRecord,
  PluginVersion,
  ProfileBundle,
} from "@dsh-plugin-hub/schemas";
import { gt, maxSatisfying, rcompare, valid } from "semver";

export class RegistryResolutionError extends Error {
  readonly code:
    | "PACKAGE_NOT_FOUND"
    | "VERSION_NOT_FOUND"
    | "DUPLICATE_BUNDLE"
    | "ORDER_CYCLE"
    | "ORDER_CONSTRAINT";

  constructor(
    code: RegistryResolutionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RegistryResolutionError";
    this.code = code;
  }
}

export function resolvePluginVersion(
  plugin: PluginRecord,
  selector = "latest",
): PluginVersion {
  const available = plugin.versions.filter((version) => !version.yanked);
  const tagged = plugin.distTags[selector];
  const requested = tagged ?? selector;

  if (valid(requested)) {
    const exact = available.find((version) => version.version === requested);
    if (exact) return exact;
  }

  const resolved = maxSatisfying(
    available.map((version) => version.version),
    requested === "latest" ? "*" : requested,
  );
  if (resolved) {
    return available.find((version) => version.version === resolved)!;
  }

  throw new RegistryResolutionError(
    "VERSION_NOT_FOUND",
    `${plugin.packageName} has no non-yanked version matching ${selector}`,
  );
}

export function sortedVersions(plugin: PluginRecord): PluginVersion[] {
  return [...plugin.versions].sort((left, right) =>
    rcompare(left.version, right.version),
  );
}

export function isGreaterVersion(left: string, right: string): boolean {
  return gt(left, right);
}

export function orderProfileBundles(
  bundles: readonly ProfileBundle[],
): ProfileBundle[] {
  const byName = new Map<string, ProfileBundle>();
  const inputOrder = new Map<string, number>();
  for (const [index, bundle] of bundles.entries()) {
    if (byName.has(bundle.packageName)) {
      throw new RegistryResolutionError(
        "DUPLICATE_BUNDLE",
        `Profile contains ${bundle.packageName} more than once`,
      );
    }
    byName.set(bundle.packageName, bundle);
    inputOrder.set(bundle.packageName, index);
  }

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const name of byName.keys()) {
    outgoing.set(name, new Set());
    indegree.set(name, 0);
  }

  const addEdge = (from: string, to: string) => {
    if (!byName.has(from) || !byName.has(to) || from === to) return;
    const targets = outgoing.get(from)!;
    if (targets.has(to)) return;
    targets.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  };

  for (const bundle of bundles) {
    for (const target of bundle.before) addEdge(bundle.packageName, target);
    for (const target of bundle.after) addEdge(target, bundle.packageName);
  }

  const ready = [...byName.keys()]
    .filter((name) => indegree.get(name) === 0)
    .sort((left, right) => inputOrder.get(left)! - inputOrder.get(right)!);
  const ordered: ProfileBundle[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(byName.get(current)!);
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort((left, right) => inputOrder.get(left)! - inputOrder.get(right)!);
      }
    }
  }

  if (ordered.length !== bundles.length) {
    const cycle = [...byName.keys()].filter((name) => (indegree.get(name) ?? 0) > 0);
    throw new RegistryResolutionError(
      "ORDER_CYCLE",
      `Profile bundle order contains a cycle: ${cycle.join(", ")}`,
    );
  }

  return ordered;
}

/** Validate an author-confirmed Profile sequence without changing it. */
export function validateProfileBundleOrder(
  bundles: readonly ProfileBundle[],
): ProfileBundle[] {
  const positions = new Map<string, number>();
  for (const [index, bundle] of bundles.entries()) {
    if (positions.has(bundle.packageName)) {
      throw new RegistryResolutionError("DUPLICATE_BUNDLE", `Profile contains ${bundle.packageName} more than once`);
    }
    positions.set(bundle.packageName, index);
  }
  for (const [index, bundle] of bundles.entries()) {
    for (const target of bundle.before) {
      const targetIndex = positions.get(target);
      if (targetIndex === undefined || index >= targetIndex) {
        throw new RegistryResolutionError("ORDER_CONSTRAINT", `${bundle.packageName} must appear before ${target}`);
      }
    }
    for (const target of bundle.after) {
      const targetIndex = positions.get(target);
      if (targetIndex === undefined || index <= targetIndex) {
        throw new RegistryResolutionError("ORDER_CONSTRAINT", `${bundle.packageName} must appear after ${target}`);
      }
    }
  }
  return [...bundles];
}

export interface ResolvedProfileBundle {
  packageName: string;
  selector: string;
  version: string;
  installSpec: string;
  integrity?: string;
  sourceKind: PluginVersion["source"]["kind"] | "builtin";
}

export interface ResolvedProfile {
  profileVersion: string;
  bundles: ResolvedProfileBundle[];
}

export function resolveProfile(
  profile: HubProfileVersion,
  plugins: ReadonlyMap<string, PluginRecord>,
): ResolvedProfile {
  const ordered = validateProfileBundleOrder(profile.bundles);
  const bundles = ordered.map((reference) => {
    if (reference.sourceKind === "builtin" && reference.version) {
      return {
        packageName: reference.packageName,
        selector: reference.selector,
        version: reference.version,
        installSpec: reference.installSpec ?? `builtin:${reference.packageName}@${reference.version}`,
        integrity: reference.integrity,
        sourceKind: "builtin" as const,
      };
    }
    const plugin = plugins.get(reference.packageName);
    if (!plugin) {
      throw new RegistryResolutionError(
        "PACKAGE_NOT_FOUND",
        `Profile references unknown package ${reference.packageName}`,
      );
    }
    const version = reference.version
      ? plugin.versions.find((candidate) =>
          candidate.version === reference.version && !candidate.yanked,
        )
      : resolvePluginVersion(plugin, reference.selector);
    if (!version) {
      throw new RegistryResolutionError(
        "VERSION_NOT_FOUND",
        `${reference.packageName} has no non-yanked version ${reference.version}`,
      );
    }
    return {
      packageName: reference.packageName,
      selector: reference.selector,
      version: version.version,
      installSpec: reference.installSpec ?? version.source.installSpec,
      integrity: reference.integrity ??
        (version.source.kind === "github" ? undefined : version.source.integrity),
      sourceKind: reference.sourceKind ?? version.source.kind,
    };
  });

  return { profileVersion: profile.version, bundles };
}

export interface EntryIdConflict {
  entryId: string;
  packages: string[];
}

export function detectEntryIdConflicts(
  versions: readonly { packageName: string; version: PluginVersion }[],
): EntryIdConflict[] {
  const owners = new Map<string, string[]>();
  for (const { packageName, version } of versions) {
    for (const entryId of new Set(version.entryIds)) {
      const packages = owners.get(entryId) ?? [];
      packages.push(packageName);
      owners.set(entryId, packages);
    }
  }
  return [...owners.entries()]
    .filter(([, packages]) => packages.length > 1)
    .map(([entryId, packages]) => ({ entryId, packages }));
}

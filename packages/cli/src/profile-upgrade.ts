import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { satisfies, valid, validRange } from "semver";
import { exactSemverSchema, type HubProfileVersion } from "@dsh-plugin-hub/schemas";
import type { ResolvedProfile, ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { validateProfileBundleOrder } from "@dsh-plugin-hub/registry";
import { profileDirectory, profileLockPath, type HubLockfile } from "./index.js";
import { installationFingerprint } from "./profile-files.js";
import { mergeProfileJson, type ProfileJsonObject, type ProfileJsonValue, type ProfileMergeConflict, type ProfileMergeEntry } from "./profile-merge.js";
import { scanProfileFiles, type ProfileFileEntry } from "./profile-upgrade-files.js";
import { inspectLocalRuntimeDefaults, type LocalRuntimeDefaults } from "./profile-runtime.js";

export { scanProfileFiles, copyProfileFiles, type ProfileFileEntry } from "./profile-upgrade-files.js";

export interface AuthorBaseline {
  schemaVersion: 1;
  profile: string;
  slug?: string;
  release: HubProfileVersion;
  resolved: ResolvedProfile;
  manifest: ProfileJsonObject;
  patch: string;
}
export interface ProfileUpgradeResolutions { contextHash: string; choices: Record<string, "local" | "upstream"> }
export interface ProfileUpgradeConflict {
  id: string;
  path: string;
  kind: "manifest" | "patch" | "generated_file" | "dependency" | "layout" | "resolutions";
  choices: Array<"local" | "upstream">;
  reason?: string;
}
export interface ProfileUpgradeSummary {
  status: "ready" | "conflicted" | "baseline_required";
  baseline: { slug?: string; version?: string };
  target: { slug?: string; version: string; source?: "hub" | "local_import" | "local" };
  changes: Array<{ path: string; action: string }>;
  conflicts: ProfileUpgradeConflict[];
  decisions: Array<{ id: string; choice: "local" | "upstream" }>;
}
export interface ProfileUpgradeDependency extends ResolvedProfileBundle { origin: "author" | "local" }
export interface LocalBundleOverrides { disabled: string[]; removed: string[] }
interface UpgradeContext { contextHash: string; expectedFingerprint: string; summary: ProfileUpgradeSummary }
interface PreparedProfileContent extends UpgradeContext { status: "ready"; authorBaseline?: AuthorBaseline; manifest: ProfileJsonObject; patch: string;
      effectiveBundles: ResolvedProfileBundle[]; dependencies: ProfileUpgradeDependency[]; preservedFiles: ProfileFileEntry[]; removedFiles: string[];
      localBundleOverrides: LocalBundleOverrides; resultHash: string }
type BlockedProfileContent =
  | (UpgradeContext & { status: "conflicted"; conflicts: ProfileUpgradeConflict[] })
  | (UpgradeContext & { status: "baseline_required"; reason: string });
export type ProfileUpgradePreparation = (PreparedProfileContent & { authorBaseline: AuthorBaseline }) | BlockedProfileContent;
export type LocalProfilePreparation = (PreparedProfileContent & { authorBaseline?: undefined }) | BlockedProfileContent;
export interface BuildAuthorBaselineOptions { profile: string; slug?: string; release: HubProfileVersion; resolved: ResolvedProfile }
export interface PrepareProfileUpgradeOptions extends BuildAuthorBaselineOptions {
  dshHome?: string;
  resolutions?: ProfileUpgradeResolutions;
  baselineRelease?: HubProfileVersion;
  baselineResolved?: ResolvedProfile;
  /** Internal edit candidate. Runs in memory before merge validation; never writes the active Profile. */
  localEdit?: {
    transform(local: { manifest: ProfileJsonValue | undefined; patch: string | undefined }): { manifest: ProfileJsonValue | undefined; patch: string | undefined };
    dependencies?: ResolvedProfileBundle[];
    bundleOverrides?: LocalBundleOverrides;
  };
}
export interface PrepareLocalProfileOptions {
  profile: string;
  dshHome?: string;
  runtimeVersion: string;
  descriptorHash: string;
  builtinBundles: ResolvedProfileBundle[];
  initialManifest: ProfileJsonObject;
  initialPatch: string;
  resolutions?: ProfileUpgradeResolutions;
  localEdit?: PrepareProfileUpgradeOptions["localEdit"];
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function hash(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function put(object: ProfileJsonObject, key: string, value: ProfileJsonValue): void {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}
function object(value: unknown): value is ProfileJsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function pointer(key: string): string { return key.replaceAll("~", "~0").replaceAll("/", "~1"); }
function spec(bundle: ResolvedProfileBundle): string { return bundle.sourceKind === "npm" ? bundle.version : bundle.installSpec; }

/** Pure author template. Never include merged local values in this sidecar. */
export function buildAuthorBaseline(options: BuildAuthorBaselineOptions): AuthorBaseline {
  // Reuse the same validation as installation paths without accessing the disk.
  profileDirectory(options.profile);
  if (options.release.version !== options.resolved.profileVersion || options.release.bundles.length !== options.resolved.bundles.length
    || options.release.bundles.some((bundle, index) => bundle.packageName !== options.resolved.bundles[index]?.packageName)) {
    throw new Error("The author Release and resolved Profile version or bundle order do not match");
  }
  const dependencies: ProfileJsonObject = {};
  for (const bundle of options.resolved.bundles) if (bundle.sourceKind !== "builtin") put(dependencies, bundle.packageName, spec(bundle));
  return clone({ schemaVersion: 1, profile: options.profile, ...(options.slug === undefined ? {} : { slug: options.slug }),
    release: options.release, resolved: options.resolved,
    manifest: { name: `dsh-hub-${options.profile.toLowerCase()}`, private: true, dependencies,
      dsh: { profile: { bundles: options.resolved.bundles.map(bundle => bundle.packageName) } } },
    patch: options.release.patchYaml ?? `${JSON.stringify(options.release.patch ?? [], null, 2)}\n`,
  });
}

function storedBaseline(current: HubLockfile | undefined, profile: string): AuthorBaseline | undefined {
  const baseline = current?.authorBaseline;
  if (!baseline || current?.profile !== profile) return undefined;
  try {
    if (baseline.schemaVersion !== 1 || baseline.profile !== profile || baseline.release.contentHash !== current.contentHash
      || baseline.slug !== current.hubProfile?.slug || current.hubProfile && baseline.release.version !== current.hubProfile.version) return undefined;
    const normalized = buildAuthorBaseline({ profile, slug: baseline.slug, release: baseline.release, resolved: baseline.resolved });
    // A merged local manifest/patch must never become the next author baseline.
    if (canonical(normalized) !== canonical(baseline)) return undefined;
    return normalized;
  } catch { return undefined; }
}

function conflict(path: string, kind: ProfileUpgradeConflict["kind"], choices: ProfileUpgradeConflict["choices"], reason?: string): ProfileUpgradeConflict {
  return { id: hash([kind, path]).slice(7, 31), path, kind, choices, ...(reason ? { reason } : {}) };
}
function setEntry(root: ProfileJsonValue | undefined, path: string, entry: ProfileMergeEntry): ProfileJsonValue | undefined {
  if (!path) return entry.present ? clone(entry.value) : undefined;
  const parts = path.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (!object(cursor) || !Object.hasOwn(cursor, part)) throw new Error("Cannot resolve an invalid Profile merge path");
    cursor = cursor[part];
  }
  if (!object(cursor)) throw new Error("Cannot resolve an invalid Profile merge path");
  const key = parts.at(-1)!;
  if (entry.present) put(cursor, key, clone(entry.value)); else delete cursor[key];
  return root;
}

function resolvedMerge(base: ProfileJsonValue | undefined, local: ProfileJsonValue | undefined, upstream: ProfileJsonValue | undefined,
  raw: ProfileMergeConflict[], prefix: string, kind: "manifest" | "patch", choose: (item: ProfileUpgradeConflict) => "local" | "upstream" | undefined) {
  let left = local === undefined ? undefined : clone(local), right = upstream === undefined ? undefined : clone(upstream);
  for (const item of raw) {
    const selected = choose(conflict(`${prefix}${item.path}`, kind, ["local", "upstream"]));
    if (selected) { left = setEntry(left, item.path, item[selected]); right = setEntry(right, item.path, item[selected]); }
  }
  return mergeProfileJson(base, left, right);
}

const generatedNames = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]);
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const githubSpec = /^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)#([0-9a-f]{40})$/i;

export function normalizeLocalBundleOverrides(value?: LocalBundleOverrides): LocalBundleOverrides {
  if (value === undefined) return { disabled: [], removed: [] };
  if (!Array.isArray(value.disabled) || !Array.isArray(value.removed) || [...value.disabled, ...value.removed].some(name => typeof name !== "string" || !packageNamePattern.test(name))) {
    throw new Error("The local bundle action history is invalid; recover the Profile state before continuing");
  }
  const removed = [...new Set(value.removed)].sort();
  return { disabled: [...new Set(value.disabled)].filter(name => !removed.includes(name)).sort(), removed };
}

function applyBundleOverrides(value: ProfileJsonValue | undefined, overrides: LocalBundleOverrides): ProfileJsonValue | undefined {
  if (value === undefined) return undefined;
  const result = clone(value);
  if (!object(result)) return result;
  if (object(result.dependencies)) for (const name of overrides.removed) delete result.dependencies[name];
  if (object(result.dsh) && object(result.dsh.profile) && Array.isArray(result.dsh.profile.bundles)) {
    const suppressed = new Set([...overrides.disabled, ...overrides.removed]);
    put(result.dsh.profile, "bundles", result.dsh.profile.bundles.filter(name => typeof name !== "string" || !suppressed.has(name)));
  }
  return result;
}

async function readRegular(path: string): Promise<string | undefined> {
  try { if (!(await lstat(path)).isFile()) throw new Error("Profile configuration must be a regular file"); return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Cannot read local Profile configuration safely"); }
}

/** Read-only: previews contain safe paths and decisions, never local configuration values. */
export async function prepareProfileUpgrade(options: PrepareProfileUpgradeOptions): Promise<ProfileUpgradePreparation> {
  const prepared = await prepareProfileContent({ ...options, mode: "author" });
  if (prepared.status !== "ready") return prepared;
  if (!prepared.authorBaseline) throw new Error("Author preparation did not produce an author baseline");
  return { ...prepared, authorBaseline: prepared.authorBaseline };
}

/** Local preparation has no Release and never constructs an author baseline from personal configuration. */
export async function prepareLocalProfile(options: PrepareLocalProfileOptions): Promise<LocalProfilePreparation> {
  const prepared = await prepareProfileContent({ ...options, mode: "local" });
  if (prepared.status !== "ready") return prepared;
  return { ...prepared, authorBaseline: undefined };
}

async function prepareProfileContent(options: (PrepareProfileUpgradeOptions & { mode: "author" }) | (PrepareLocalProfileOptions & { mode: "local" })): Promise<PreparedProfileContent | BlockedProfileContent> {
  const author = options.mode === "author" ? options : undefined;
  const local = options.mode === "local" ? options : undefined;
  const targetResolution: ResolvedProfile = author?.resolved ?? { profileVersion: "local", bundles: local!.builtinBundles };
  const directory = profileDirectory(options.profile, options.dshHome), statePath = profileLockPath(options.profile, options.dshHome);
  const expectedFingerprint = await installationFingerprint(directory, statePath);
  const files = await scanProfileFiles(directory);
  let current: (HubLockfile & { authorBaseline?: AuthorBaseline; dependencies?: ResolvedProfileBundle[]; generatedFiles?: ProfileFileEntry[] }) | undefined;
  try {
    const contents = await readRegular(statePath);
    if (contents !== undefined) {
      const parsed: unknown = JSON.parse(contents);
      if (!object(parsed) || parsed.schemaVersion !== 2 || parsed.profile !== options.profile || !Array.isArray(parsed.bundles)) throw new Error();
      current = parsed as unknown as HubLockfile;
    }
  }
  catch { throw new Error("Cannot read the managed Profile state; inspect or restore its history before upgrading"); }
  const authorBaseline = author ? buildAuthorBaseline(author) : undefined;
  const localBundleOverrides = normalizeLocalBundleOverrides(options.localEdit?.bundleOverrides ?? current?.localBundleOverrides);
  let baseline = storedBaseline(current, options.profile);
  if (!baseline && current?.profile === options.profile && !current.unmanaged && author?.baselineRelease && author.baselineResolved
    && current.hubProfile && author.baselineRelease.version === current.hubProfile.version && author.baselineResolved.profileVersion === current.hubProfile.version
    && current.contentHash && author.baselineRelease.contentHash === current.contentHash
    && canonical(author.baselineResolved.bundles) === canonical(current.bundles)) {
    baseline = buildAuthorBaseline({ profile: options.profile, slug: current.hubProfile.slug, release: author.baselineRelease, resolved: author.baselineResolved });
  }
  let manifest: ProfileJsonValue | undefined, patch: string | undefined;
  try {
    const contents = await readRegular(join(directory, "package.json"));
    manifest = contents === undefined ? undefined : JSON.parse(contents) as ProfileJsonValue;
    patch = await readRegular(join(directory, "cordis.patch.yml"));
  } catch { throw new Error("Cannot read local Profile configuration; fix its file format before upgrading"); }
  if (local && (!current || current.unmanaged)) {
    manifest ??= clone(local.initialManifest);
    patch ??= local.initialPatch;
    // Older hand-created Profiles may omit optional manifest containers. Fill
    // only absent fields; malformed or explicitly null data still needs repair.
    if (object(manifest)) {
      if (!Object.hasOwn(manifest, "dependencies")) put(manifest, "dependencies", {});
      if (!Object.hasOwn(manifest, "dsh")) put(manifest, "dsh", clone(local.initialManifest.dsh!));
      else if (object(manifest.dsh)) {
        if (!Object.hasOwn(manifest.dsh, "profile")) put(manifest.dsh, "profile", clone((local.initialManifest.dsh as ProfileJsonObject).profile!));
        else if (object(manifest.dsh.profile) && !Object.hasOwn(manifest.dsh.profile, "bundles")) {
          put(manifest.dsh.profile, "bundles", clone(((local.initialManifest.dsh as ProfileJsonObject).profile as ProfileJsonObject).bundles!));
        }
      }
    }
  }
  if (options.localEdit) {
    const candidate = options.localEdit.transform({ manifest: manifest === undefined ? undefined : clone(manifest), patch });
    manifest = candidate.manifest; patch = candidate.patch;
  }
  const knownAuthor = Boolean(current?.hubProfile || current?.contentHash || current?.authorBaseline || current?.source === "author");
  // Derive potential retained content before inspecting optional runtime packages.
  // An unchanged author removal is already resolved and needs no extra cache.
  // For a conflict, bind read-only runtime evidence for the local branch before
  // accepting a choice. An unavailable cache blocks only an eventual retention.
  const baseManifest = applyBundleOverrides(local ? undefined : baseline?.manifest, localBundleOverrides);
  const localManifest = applyBundleOverrides(manifest, localBundleOverrides);
  const targetManifest = applyBundleOverrides(authorBaseline?.manifest, localBundleOverrides);
  const merge = mergeProfileJson(baseManifest, localManifest, targetManifest);
  const candidateMerge = merge.status === "conflicted" ? resolvedMerge(baseManifest, localManifest, targetManifest, merge.conflicts,
    "package.json#", "manifest", () => "local") : merge;
  const candidate = candidateMerge.status === "resolved" ? candidateMerge.value : undefined;
  const extraBuiltinNames = author && (!knownAuthor || baseline) && object(candidate) && object(candidate.dependencies)
    && object(candidate.dsh) && object(candidate.dsh.profile) && Array.isArray(candidate.dsh.profile.bundles)
    ? [...new Set(candidate.dsh.profile.bundles.filter((name): name is string => typeof name === "string" && packageNamePattern.test(name)
      && !Object.hasOwn(candidate.dependencies as ProfileJsonObject, name)
      && !targetResolution.bundles.some(bundle => bundle.packageName === name)))].sort() : [];
  let extraRuntime: LocalRuntimeDefaults | undefined;
  let extraRuntimeError: Error | undefined;
  if (extraBuiltinNames.length) {
    const runtimeVersion = author!.release.runtime?.version;
    if (exactSemverSchema.safeParse(runtimeVersion).success) {
      try {
        extraRuntime = await inspectLocalRuntimeDefaults({ profile: options.profile, runtimeVersion: runtimeVersion!, dshHome: options.dshHome, bundleNames: extraBuiltinNames });
      } catch (error) { extraRuntimeError = error as Error; }
    }
  }
  // Installed versions pin floating local semver ranges. Include this read-only
  // evidence in the context because node_modules is intentionally not copied.
  const installed: Record<string, { version?: string; name?: string }> = Object.create(null) as Record<string, { version?: string; name?: string }>;
  if (object(manifest) && object(manifest.dependencies)) for (const name of Object.keys(manifest.dependencies).sort()) {
    if (!packageNamePattern.test(name)) continue;
    try {
      const metadata = JSON.parse(await readFile(join(directory, "node_modules", ...name.split("/"), "package.json"), "utf8")) as Record<string, unknown>;
      installed[name] = { ...(typeof metadata.version === "string" ? { version: metadata.version } : {}), ...(typeof metadata.name === "string" ? { name: metadata.name } : {}) };
    } catch { installed[name] = {}; }
  }
  const contextHash = hash({ profile: options.profile, target: authorBaseline, baseline, expectedFingerprint, files, installed,
    localRuntime: local ? { version: local.runtimeVersion, descriptorHash: local.descriptorHash, bundles: local.builtinBundles } : undefined,
    extraRuntime: extraBuiltinNames.length ? { version: author?.release.runtime?.version, descriptorHash: extraRuntime?.fingerprint ?? "unavailable", names: extraBuiltinNames } : undefined,
    localEditHash: options.localEdit ? hash({ manifest, patch, dependencies: options.localEdit.dependencies, localBundleOverrides }) : undefined });
  const summary: ProfileUpgradeSummary = { status: "ready", baseline: { ...(baseline?.slug ? { slug: baseline.slug } : {}), ...(baseline ? { version: baseline.release.version } : {}) },
    target: { ...(author?.slug ? { slug: author.slug } : {}), version: author?.release.version ?? "local", source: local ? "local" : author?.slug ? "hub" : "local_import" }, changes: [], conflicts: [], decisions: [] };
  const context = { contextHash, expectedFingerprint, summary };
  if (current && current.profile !== options.profile || local && knownAuthor || author && !baseline && knownAuthor) {
    summary.status = "baseline_required";
    return { ...context, status: "baseline_required", reason: "The previous author baseline is unavailable. Supply the matching published release and resolved sources; local configuration cannot serve as the author baseline." };
  }
  const unresolved: ProfileUpgradeConflict[] = [], seen = new Set<string>();
  const resolutionContextValid = !options.resolutions || options.resolutions.contextHash === contextHash;
  function choose(item: ProfileUpgradeConflict): "local" | "upstream" | undefined {
    seen.add(item.id);
    const selected = resolutionContextValid && options.resolutions && Object.hasOwn(options.resolutions.choices, item.id) ? options.resolutions.choices[item.id] : undefined;
    if (selected && item.choices.includes(selected)) { summary.decisions.push({ id: item.id, choice: selected }); return selected; }
    unresolved.push(item); return undefined;
  }
  // Explicit package actions are persistent decisions. Project them onto all
  // merge operands so an author reintroduction does not recreate a conflict or
  // silently undo the decision. The stored author baseline remains untouched.
  const merged = merge.status === "conflicted" ? resolvedMerge(baseManifest, localManifest, targetManifest, merge.conflicts, "package.json#", "manifest", choose) : merge;
  if (merged.status === "resolved" && object(merged.value)) {
    if (object(merged.value.dependencies)) for (const name of localBundleOverrides.removed) delete merged.value.dependencies[name];
    if (object(merged.value.dsh) && object(merged.value.dsh.profile) && Array.isArray(merged.value.dsh.profile.bundles)) {
      const suppressed = new Set([...localBundleOverrides.disabled, ...localBundleOverrides.removed]);
      put(merged.value.dsh.profile, "bundles", merged.value.dsh.profile.bundles.filter(name => typeof name !== "string" || !suppressed.has(name)));
    }
    summary.changes.push(...localBundleOverrides.disabled.map(name => ({ path: `package.json#/dsh/profile/bundles/${pointer(name)}`, action: "preserve_disabled" })),
      ...localBundleOverrides.removed.map(name => ({ path: `package.json#/dependencies/${pointer(name)}`, action: "preserve_removed" })));
  }
  // YAML/Cordis is one atomic string: never parse nodes, infer IDs or reorder arrays.
  const basePatch = local ? undefined : baseline?.patch;
  const patchMerge = mergeProfileJson(basePatch, patch, authorBaseline?.patch);
  const mergedPatch = patchMerge.status === "conflicted" ? resolvedMerge(basePatch, patch, authorBaseline?.patch, patchMerge.conflicts, "cordis.patch.yml", "patch", choose) : patchMerge;
  const preservedFiles = files.filter(entry => entry.relativePath !== "package.json" && entry.relativePath !== "cordis.patch.yml" && !generatedNames.has(entry.relativePath.split("/")[0]!));
  const removedFiles: string[] = [];
  for (const name of [...generatedNames].sort()) {
    const entry = files.find(item => item.relativePath === name);
    const old = current?.generatedFiles?.find(item => item.relativePath === name);
    if (!entry && !old) continue;
    if (old && entry && canonical(old) === canonical(entry)) { summary.changes.push({ path: name, action: "regenerate" }); continue; }
    const workspace = name === "pnpm-workspace.yaml";
    if (local && workspace && entry?.kind === "file") {
      preservedFiles.push(entry); summary.changes.push({ path: name, action: "preserve_local_workspace" }); continue;
    }
    const selected = choose(conflict(name, "generated_file", workspace && (!entry || entry.kind === "file") ? ["local", "upstream"] : ["upstream"],
      workspace ? "The workspace configuration differs from its generated baseline, was deleted, or has no baseline. This installation uses the selected workspace configuration; keeping a local deletion leaves it absent."
        : "The dependency lock differs from its generated baseline or has no baseline. Rebuild it for the effective dependencies; the previous file remains in history."));
    if (selected === "local") { if (entry) preservedFiles.push(entry); else removedFiles.push(name); }
    if (selected) summary.changes.push({ path: name, action: selected === "local" ? entry ? "preserve_after_install" : "retain_deletion" : "regenerate" });
  }
  const dependencies: ProfileUpgradeDependency[] = [], effectiveBundles: ResolvedProfileBundle[] = [];
  if (merged.status === "resolved") {
    if (!object(merged.value) || !object(merged.value.dependencies) || !object(merged.value.dsh) || !object(merged.value.dsh.profile)
      || !Array.isArray(merged.value.dsh.profile.bundles) || merged.value.dsh.profile.bundles.some(item => typeof item !== "string")) {
      choose(conflict("package.json", "layout", [], "The effective manifest must contain dependencies and an ordered dsh.profile.bundles list. Repair the local manifest and prepare again."));
    } else {
      const names = merged.value.dsh.profile.bundles as string[];
      if (new Set(names).size !== names.length) choose(conflict("package.json#/dsh/profile/bundles", "layout", [], "The effective bundle list contains duplicate entries; repair it before preparing again."));
      try {
        validateProfileBundleOrder(names.map(name => {
          const reference = author?.release.bundles.find(item => item.packageName === name);
          return { packageName: name, selector: reference?.selector ?? "local", before: reference?.before ?? [], after: reference?.after ?? [] };
        }));
      } catch { choose(conflict("package.json#/dsh/profile/bundles", "layout", [], "The effective bundle order violates the target author's before/after constraints; repair the local order and prepare again.")); }
      for (const section of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
        const value = merged.value[section];
        if (value !== undefined && (!object(value) || Object.keys(value).length)) choose(conflict(`package.json#/${section}`, "dependency", [],
          "This dependency section cannot yet be installed and verified by Profile upgrades. Move required packages into dependencies before preparing again."));
      }
      for (const name of Object.keys(merged.value.dependencies).sort()) {
        const selector = merged.value.dependencies[name];
        let dependency: ProfileUpgradeDependency | undefined;
        if (packageNamePattern.test(name) && typeof selector === "string") {
          const target = targetResolution.bundles.find(bundle => bundle.packageName === name && bundle.sourceKind !== "builtin" && spec(bundle) === selector);
          const previous = [...(current?.dependencies ?? []), ...(current?.bundles ?? [])].find(bundle => bundle.packageName === name && bundle.sourceKind !== "builtin" && spec(bundle) === selector);
          const edited = options.localEdit?.dependencies?.find(bundle => bundle.packageName === name && spec(bundle) === selector && valid(bundle.version) === bundle.version
            && (bundle.sourceKind === "npm" && bundle.installSpec === `${name}@${bundle.version}` || bundle.sourceKind === "github" && githubSpec.test(bundle.installSpec)));
          if (edited) dependency = { ...clone(edited), origin: "local" };
          else if (target) dependency = { ...clone(target), origin: "author" };
          else if (previous) dependency = { ...clone(previous), selector, origin: "local" };
          else if (valid(selector)) dependency = { packageName: name, selector, version: valid(selector)!, installSpec: `${name}@${valid(selector)!}`, sourceKind: "npm", origin: "local" };
          else if (validRange(selector) && installed[name]?.version && valid(installed[name]!.version)
            && installed[name]?.name === name && satisfies(installed[name]!.version!, selector)) {
            dependency = { packageName: name, selector, version: installed[name]!.version!, installSpec: `${name}@${installed[name]!.version!}`, sourceKind: "npm", origin: "local" };
          } else if (githubSpec.test(selector) && installed[name]?.name === name && installed[name]?.version && valid(installed[name]!.version)) {
            dependency = { packageName: name, selector, version: installed[name]!.version!, installSpec: selector, sourceKind: "github", origin: "local" };
          }
        }
        if (dependency) { dependencies.push(dependency); put(merged.value.dependencies, name, spec(dependency)); }
        else choose(conflict(`package.json#/dependencies/${pointer(name)}`, "dependency", [], "The local dependency has no verifiable fixed source. Pin an npm version, install a version satisfying its semver range, or use a full GitHub commit; prepare again."));
      }
      for (const name of names) {
        const dependency = dependencies.find(item => item.packageName === name);
        if (!dependency && extraBuiltinNames.includes(name) && extraRuntimeError) throw extraRuntimeError;
        const builtin = targetResolution.bundles.find(item => item.packageName === name && item.sourceKind === "builtin")
          ?? (extraBuiltinNames.includes(name) ? extraRuntime?.builtins.find(item => item.packageName === name) : undefined);
        if (dependency) { const { origin: _, ...bundle } = dependency; effectiveBundles.push(bundle); }
        else if (builtin) {
          effectiveBundles.push(clone(builtin));
          if (extraBuiltinNames.includes(name)) summary.changes.push({ path: `package.json#/dsh/profile/bundles/${pointer(name)}`, action: "retain_target_runtime_builtin" });
        }
        else if (extraBuiltinNames.includes(name)) choose(conflict(`package.json#/dsh/profile/bundles/${pointer(name)}`, "layout", [],
          `This additional builtin cannot be verified in the target runtime. Disable it with dsh-hub profile plugin disable ${name} --profile ${options.profile}, or choose a Release with an exact runtime that includes it; prepare again.`));
        else choose(conflict("package.json#/dsh/profile/bundles", "layout", [], "An enabled bundle has no matching fixed dependency or target runtime builtin. Repair the local bundle list or dependency before preparing again."));
      }
    }
  }
  if (mergedPatch.status === "resolved" && typeof mergedPatch.value !== "string") choose(conflict("cordis.patch.yml", "layout", [], "The effective Profile needs a patch file; restore it before preparing again."));
  if (!resolutionContextValid) unresolved.push(conflict("resolutions", "resolutions", [], "The conflict choices belong to another target, local snapshot or runtime descriptor. Use this preview context to review and prepare fresh choices."));
  if (options.resolutions && Object.keys(options.resolutions.choices).some(id => !seen.has(id))) unresolved.push(conflict("resolutions", "resolutions", [], "The choices contain an unknown conflict identifier; prepare fresh choices."));
  if (expectedFingerprint !== await installationFingerprint(directory, statePath) || canonical(files) !== canonical(await scanProfileFiles(directory))) {
    unresolved.push(conflict("profile", "resolutions", [], "The local Profile changed while preparing; retry against its current contents."));
  }
  if (unresolved.length || merged.status !== "resolved" || mergedPatch.status !== "resolved") {
    summary.status = "conflicted";
    summary.conflicts = [...new Map(unresolved.map(item => [item.id, item])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
    return { ...context, status: "conflicted", conflicts: summary.conflicts };
  }
  const finalManifest = merged.value as ProfileJsonObject, finalPatch = mergedPatch.value as string;
  summary.changes.push({ path: "package.json", action: canonical(manifest) === canonical(finalManifest) ? "retain" : "merge" },
    { path: "cordis.patch.yml", action: patch === finalPatch ? "retain" : "replace" },
    ...preservedFiles.filter(entry => entry.relativePath).map(entry => ({ path: entry.relativePath, action: "preserve" })));
  summary.changes.sort((a, b) => a.path.localeCompare(b.path));
  const resultHash = hash({ authorBaseline, manifest: finalManifest, patch: finalPatch, effectiveBundles, dependencies, preservedFiles, removedFiles, localBundleOverrides });
  return { ...context, status: "ready", authorBaseline, manifest: finalManifest, patch: finalPatch, effectiveBundles, dependencies, preservedFiles, removedFiles, localBundleOverrides, resultHash };
}

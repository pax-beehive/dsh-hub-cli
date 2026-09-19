import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { satisfies, valid, validRange } from "semver";
import { compatibilitySchema, exactSemverSchema, profileInputSchema, type HubProfileVersion, type PluginVersion } from "@dsh-plugin-hub/schemas";
import { validateProfileBundleOrder, type ResolvedProfile, type ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { ProfileUpgradeBlockedError, profileDirectory, profileLockPath, type HubLockfile } from "./index.js";
import { installationFingerprint } from "./profile-files.js";
import { assertProfileInputKey } from "./profile-inputs.js";
import { normalizeLocalBundleOverrides, prepareLocalProfile, prepareProfileUpgrade, type AuthorBaseline, type LocalProfilePreparation, type ProfileUpgradePreparation, type ProfileUpgradeResolutions } from "./profile-upgrade.js";
import type { ProfileJsonObject, ProfileJsonValue } from "./profile-merge.js";
import { inspectLocalRuntimeDefaults, type LocalRuntimeDefaults } from "./profile-runtime.js";
export { inspectLocalRuntimeDefaults, type LocalRuntimeDefaults } from "./profile-runtime.js";

export interface LocalBundleRule {
  packageName: string;
  version: string;
  before: string[];
  after: string[];
  compatibility?: PluginVersion["compatibility"];
}

export type ProfileEditIntent =
  | { kind: "add"; bundle: ResolvedProfileBundle; position?: number; rule?: LocalBundleRule }
  | { kind: "remove" | "enable" | "disable"; packageName: string }
  | { kind: "reorder"; order: string[] }
  | { kind: "configure"; patchFile: string }
  | { kind: "input-declare"; declaration: HubProfileVersion["inputs"][number] }
  | { kind: "input-remove"; key: string };

export interface ProfileEditSummary {
  profile: string;
  action: ProfileEditIntent["kind"];
  packageName?: string;
  order?: string[];
  runtimeVersion?: string;
  source?: "author" | "local";
  changes: Array<{ path: string; action: string }>;
}
type ReadyUpgrade = Extract<ProfileUpgradePreparation, { status: "ready" }>;
export type ProfileEditPreparation = Omit<ReadyUpgrade, "summary" | "authorBaseline"> & {
  authorBaseline?: AuthorBaseline;
  current?: HubLockfile;
  source: "author" | "local";
  resolved: ResolvedProfile;
  runtime: HubProfileVersion["runtime"];
  inputs: HubProfileVersion["inputs"];
  localInputs: HubProfileVersion["inputs"];
  localBundleRules: LocalBundleRule[];
  summary: ProfileEditSummary;
  upgradeSummary: ReadyUpgrade["summary"];
};

export interface PrepareProfileEditOptions {
  profile: string;
  dshHome?: string;
  intent: ProfileEditIntent;
  runtimeVersion?: string;
  resolutions?: ProfileUpgradeResolutions;
}

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const pinnedGitHub = /^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)#([0-9a-f]{40})$/i;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function hash(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function put(target: ProfileJsonObject, key: string, value: ProfileJsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
function object(value: unknown): value is ProfileJsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assertName(name: string): void { if (!packageNamePattern.test(name)) throw new Error("A valid package name is required for this Profile edit"); }
function inputDeclaration(value: unknown, local: boolean): HubProfileVersion["inputs"][number] {
  const parsed = profileInputSchema.safeParse(value);
  if (!parsed.success) throw new Error("The input declaration must contain a valid key, label, required and secret policy");
  if (local) assertProfileInputKey(parsed.data.key);
  return parsed.data;
}

/** Effective declarations retain the author's required/secret floor across upgrades. No input values are read. */
export function mergeProfileInputDeclarations(author: HubProfileVersion["inputs"], local: HubProfileVersion["inputs"]): HubProfileVersion["inputs"] {
  const declarations = new Map<string, HubProfileVersion["inputs"][number]>();
  for (const item of author) {
    const declaration = inputDeclaration(item, false);
    if (declarations.has(declaration.key)) throw new Error("The author input declarations contain duplicate keys");
    declarations.set(declaration.key, declaration);
  }
  const seen = new Set<string>();
  for (const item of local) {
    const declaration = inputDeclaration(item, true), original = declarations.get(declaration.key);
    if (seen.has(declaration.key)) throw new Error("The local input declarations contain duplicate keys");
    seen.add(declaration.key);
    declarations.set(declaration.key, { ...declaration, required: Boolean(original?.required || declaration.required), secret: Boolean(original?.secret || declaration.secret) });
  }
  return clone([...declarations.values()]);
}

/** Retain installed exact-version metadata and check it before changing load order or runtime. */
export function validateLocalBundleRules(options: {
  bundles: ResolvedProfileBundle[];
  dependencies: ResolvedProfileBundle[];
  rules: LocalBundleRule[];
  runtimeVersion: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}): LocalBundleRule[] {
  const installed = [...options.dependencies, ...options.bundles.filter(item => item.sourceKind === "builtin")];
  const retained: LocalBundleRule[] = [], names = new Set<string>();
  for (const rule of options.rules) {
    if (!rule || !installed.some(item => item.packageName === rule.packageName && item.version === rule.version)) continue;
    assertName(rule.packageName);
    if (!exactSemverSchema.safeParse(rule.version).success || !Array.isArray(rule.before) || !Array.isArray(rule.after)
      || [...rule.before, ...rule.after].some(name => typeof name !== "string" || !packageNamePattern.test(name)) || names.has(rule.packageName)) {
      throw new Error("Local bundle ordering metadata is invalid or duplicated; resolve its declarations before editing");
    }
    names.add(rule.packageName);
    if (rule.compatibility) {
      const parsed = compatibilitySchema.safeParse(rule.compatibility);
      if (!parsed.success) throw new Error("Local bundle compatibility metadata is invalid");
      const compatibility = parsed.data;
      if (!exactSemverSchema.safeParse(options.runtimeVersion).success || !validRange(compatibility.dsh)
        || !satisfies(options.runtimeVersion, compatibility.dsh, { includePrerelease: true })) throw new Error("An installed local bundle is incompatible with the selected exact DSH runtime");
      if (compatibility.node && (!validRange(compatibility.node) || !satisfies(options.nodeVersion ?? process.versions.node, compatibility.node, { includePrerelease: true }))) {
        throw new Error("An installed local bundle is incompatible with this Node.js version");
      }
      if (compatibility.platforms.length && !compatibility.platforms.includes((options.platform ?? process.platform) as "darwin" | "linux" | "win32")) {
        throw new Error("An installed local bundle does not support this operating system");
      }
    }
    retained.push(clone(rule));
  }
  try {
    validateProfileBundleOrder(options.bundles.map(bundle => {
      const rule = retained.find(item => item.packageName === bundle.packageName);
      return { packageName: bundle.packageName, selector: bundle.selector, before: rule?.before ?? [], after: rule?.after ?? [] };
    }));
  } catch { throw new Error("The effective bundle order violates installed local bundle before/after constraints"); }
  return retained;
}

async function regularText(path: string, message: string, maximumBytes = 2_000_000): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error(message);
    const bytes = await handle.readFile(), text = bytes.toString("utf8");
    if (bytes.length > maximumBytes || !Buffer.from(text, "utf8").equals(bytes)) throw new Error(message);
    return text;
  } catch { throw new Error(message); }
  finally { await handle?.close(); }
}

async function installedBundleEvidence(directory: string, packageName: string, expectedVersion?: string): Promise<string> {
  try {
    const packageDirectory = await realpath(join(directory, "node_modules", ...packageName.split("/")));
    const metadataText = await readFile(join(packageDirectory, "package.json"), "utf8");
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    if (metadata.name !== packageName || typeof metadata.version !== "string" || !valid(metadata.version)
      || expectedVersion !== undefined && metadata.version !== expectedVersion || !object(metadata.dsh)
      || !object(metadata.dsh.bundle) || typeof metadata.dsh.bundle.patch !== "string" || !metadata.dsh.bundle.patch) throw new Error();
    const patch = await realpath(resolve(packageDirectory, metadata.dsh.bundle.patch));
    const within = relative(packageDirectory, patch);
    if (isAbsolute(within) || within === ".." || within.startsWith("../") || within.startsWith("..\\") || !(await stat(patch)).isFile()) throw new Error();
    return hash([metadataText, await readFile(patch)]);
  } catch { throw new Error("The installed dependency is not a verified DSH bundle with a readable package-local patch; install a valid bundle before enabling it"); }
}

function fixedBundle(bundle: ResolvedProfileBundle): ResolvedProfileBundle {
  assertName(bundle.packageName);
  if (valid(bundle.version) !== bundle.version || !bundle.selector) throw new Error("Adding a bundle requires an exact resolved version and source");
  if (bundle.sourceKind === "npm" && bundle.installSpec === `${bundle.packageName}@${bundle.version}`) return clone(bundle);
  if (bundle.sourceKind === "github" && pinnedGitHub.test(bundle.installSpec)) return clone(bundle);
  if (bundle.sourceKind === "builtin" && bundle.installSpec === `builtin:${bundle.packageName}@${bundle.version}`) return clone(bundle);
  throw new Error("Adding a bundle requires an exact npm source, a complete GitHub commit, or a known runtime builtin");
}

/** Read-only edit preparation. Configuration bytes stay in memory; previews contain only safe actions and paths. */
export async function prepareProfileEdit(options: PrepareProfileEditOptions): Promise<ProfileEditPreparation> {
  const directory = profileDirectory(options.profile, options.dshHome), statePath = profileLockPath(options.profile, options.dshHome);
  const firstFingerprint = await installationFingerprint(directory, statePath);
  let current: HubLockfile | undefined;
  try {
    await lstat(statePath);
    const parsed: unknown = JSON.parse(await regularText(statePath, "Cannot read the Profile state for editing"));
    if (!object(parsed) || parsed.schemaVersion !== 2 || parsed.profile !== options.profile || !Array.isArray(parsed.bundles)) throw new Error();
    current = parsed as unknown as HubLockfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The Profile state is unreadable or inconsistent; recover its saved state before editing");
  }
  const baseline = current?.authorBaseline;
  const knownAuthor = Boolean(baseline || current?.hubProfile || current?.contentHash || current?.source === "author");
  if (knownAuthor && (!baseline || current?.unmanaged)) throw new Error("A verified author baseline is required for this author Profile; recover its original Release before editing");
  const source = knownAuthor ? "author" as const : "local" as const;
  const recordedRuntime = current?.runtime?.version ?? baseline?.release.runtime?.version;
  if (source === "author" && options.runtimeVersion !== undefined && options.runtimeVersion !== recordedRuntime) throw new Error("An author Profile's runtime is pinned by its Release; apply the desired author Release instead");
  const selectedRuntime = options.runtimeVersion ?? recordedRuntime;
  if (!exactSemverSchema.safeParse(selectedRuntime).success) throw new Error(source === "author"
    ? "Editing requires the Profile's exact recorded runtime. Recover its original Release or install into a new Profile before editing"
    : "No exact runtime is recorded for this local Profile; pass --runtime-version <exact-semver>");
  const runtime = source === "author" ? clone(current?.runtime ?? baseline!.release.runtime!) : { range: selectedRuntime!, version: selectedRuntime! };
  let descriptor: LocalRuntimeDefaults | undefined;
  if (source === "local") {
    let enabled: string[] = [];
    try {
      const raw = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as ProfileJsonObject;
      if (object(raw.dsh) && object(raw.dsh.profile) && Array.isArray(raw.dsh.profile.bundles)) enabled = raw.dsh.profile.bundles.filter((item): item is string => typeof item === "string");
    } catch { /* The shared preparation reports malformed local files without values. */ }
    if (options.intent.kind === "add" && options.intent.bundle.sourceKind === "builtin") enabled.push(options.intent.bundle.packageName);
    if (options.intent.kind === "enable") enabled.push(options.intent.packageName);
    descriptor = await inspectLocalRuntimeDefaults({ profile: options.profile, dshHome: options.dshHome, runtimeVersion: selectedRuntime!, bundleNames: enabled });
  } else {
    // An extra builtin remains a local choice after joining an author Release.
    // Re-enabling it must inspect the selected runtime instead of looking for an
    // npm dependency or pretending the author declared it.
    const name = options.intent.kind === "add" && options.intent.bundle.sourceKind === "builtin" ? options.intent.bundle.packageName
      : options.intent.kind === "enable" ? options.intent.packageName : undefined;
    if (name !== undefined && !baseline!.resolved.bundles.some(bundle => bundle.packageName === name && bundle.sourceKind === "builtin")) {
      assertName(name);
      let localDependency = false;
      try {
        const raw: unknown = JSON.parse(await regularText(join(directory, "package.json"), "Cannot inspect the local manifest for this edit"));
        localDependency = object(raw) && object(raw.dependencies) && Object.hasOwn(raw.dependencies, name);
      } catch { /* The shared preparation reports invalid local configuration. */ }
      if (options.intent.kind === "add" || !localDependency) {
        descriptor = await inspectLocalRuntimeDefaults({ profile: options.profile, dshHome: options.dshHome, runtimeVersion: selectedRuntime!, bundleNames: [name] });
      }
    }
  }
  const knownBuiltins = source === "local" ? descriptor!.builtins : [...baseline!.resolved.bundles.filter(item => item.sourceKind === "builtin"),
    ...(descriptor?.builtins.filter(item => !baseline!.resolved.bundles.some(bundle => bundle.packageName === item.packageName)) ?? [])];
  const intent = clone(options.intent);
  const localBundleOverrides = normalizeLocalBundleOverrides(current?.localBundleOverrides);
  const editedName = intent.kind === "add" ? intent.bundle.packageName : "packageName" in intent ? intent.packageName : undefined;
  if (editedName !== undefined) assertName(editedName);
  if (intent.kind === "add" || intent.kind === "enable") {
    localBundleOverrides.disabled = localBundleOverrides.disabled.filter(name => name !== editedName);
    localBundleOverrides.removed = localBundleOverrides.removed.filter(name => name !== editedName);
  } else if (intent.kind === "disable") {
    localBundleOverrides.disabled = [...new Set([...localBundleOverrides.disabled, intent.packageName])].sort();
  } else if (intent.kind === "remove") {
    localBundleOverrides.disabled = localBundleOverrides.disabled.filter(name => name !== intent.packageName);
    localBundleOverrides.removed = [...new Set([...localBundleOverrides.removed, intent.packageName])].sort();
  }
  let configuredPatch: string | undefined;
  if (intent.kind === "configure") configuredPatch = await regularText(resolve(intent.patchFile), "Cannot read the requested configuration as a regular UTF-8 patch file", 200_000);
  const addedBundle = intent.kind === "add" ? fixedBundle(intent.bundle) : undefined;
  let removedFromCandidate = false;
  let disabledFromCandidate = Boolean(intent.kind === "disable" && current?.localBundleOverrides?.disabled.includes(intent.packageName));
  const localEdit = {
    bundleOverrides: localBundleOverrides,
    dependencies: addedBundle && addedBundle.sourceKind !== "builtin" ? [addedBundle] : undefined,
    transform(local: { manifest: ProfileJsonValue | undefined; patch: string | undefined }) {
      if (intent.kind === "configure") return { ...local, patch: configuredPatch };
      if (!object(local.manifest)) return local;
      const manifest = local.manifest;
      if (intent.kind === "disable" && object(manifest.dsh) && object(manifest.dsh.profile) && Array.isArray(manifest.dsh.profile.bundles)) {
        disabledFromCandidate ||= manifest.dsh.profile.bundles.includes(intent.packageName);
      }
      if (intent.kind === "remove") {
        assertName(intent.packageName);
        if (object(manifest.dependencies) && Object.hasOwn(manifest.dependencies, intent.packageName)) {
          removedFromCandidate = true; delete manifest.dependencies[intent.packageName];
        }
        if (object(manifest.dsh) && object(manifest.dsh.profile) && Array.isArray(manifest.dsh.profile.bundles)) {
          if (manifest.dsh.profile.bundles.includes(intent.packageName)) removedFromCandidate = true;
          put(manifest.dsh.profile, "bundles", manifest.dsh.profile.bundles.filter(name => name !== intent.packageName));
        }
      } else if (addedBundle && addedBundle.sourceKind !== "builtin" && object(manifest.dependencies)) {
        put(manifest.dependencies, addedBundle.packageName, addedBundle.sourceKind === "npm" ? addedBundle.version : addedBundle.installSpec);
      }
      return local;
    },
  };
  const prepare = (resolutions?: ProfileUpgradeResolutions): Promise<ProfileUpgradePreparation | LocalProfilePreparation> => baseline
    ? prepareProfileUpgrade({ profile: options.profile, dshHome: options.dshHome, slug: baseline.slug, release: baseline.release, resolved: baseline.resolved, resolutions, localEdit })
    : prepareLocalProfile({ profile: options.profile, dshHome: options.dshHome, runtimeVersion: selectedRuntime!, descriptorHash: descriptor!.fingerprint,
      builtinBundles: descriptor!.builtins, initialManifest: descriptor!.manifest, initialPatch: descriptor!.patch, resolutions, localEdit });
  let enabledEvidence: string | undefined;
  if (intent.kind === "enable" && !knownBuiltins.some(item => item.packageName === intent.packageName)) {
    assertName(intent.packageName);
    enabledEvidence = await installedBundleEvidence(directory, intent.packageName);
  }
  let prepared = await prepare();
  const contextHash = hash({ context: prepared.contextHash, intent, patchFile: intent.kind === "configure" ? resolve(intent.patchFile) : undefined,
    configuredPatchHash: configuredPatch === undefined ? undefined : hash(configuredPatch), enabledEvidence,
    runtimeDescriptor: descriptor?.fingerprint });
  if (options.resolutions) {
    if (options.resolutions.contextHash !== contextHash) throw new Error("The edit choices belong to another intent, configuration file or local snapshot; prepare this edit again");
    prepared = await prepare({ ...options.resolutions, contextHash: prepared.contextHash });
  }
  if (prepared.status !== "ready") throw new ProfileUpgradeBlockedError(prepared.summary, prepared.status === "baseline_required", contextHash);
  const manifest = clone(prepared.manifest), dependencies = clone(prepared.dependencies);
  let effectiveBundles = clone(prepared.effectiveBundles), localInputs = clone(current?.localInputs ?? (source === "local" ? current?.inputs ?? [] : [])), localBundleRules = clone(current?.localBundleRules ?? []);
  let patch = prepared.patch;
  if (!object(manifest.dependencies) || !object(manifest.dsh) || !object(manifest.dsh.profile)) throw new Error("The effective local manifest is invalid for editing");
  const changes: ProfileEditSummary["changes"] = [];
  const packageName = intent.kind === "add" ? intent.bundle.packageName : "packageName" in intent ? intent.packageName : undefined;
  if (packageName !== undefined) assertName(packageName);
  switch (intent.kind) {
    case "add": {
      const bundle = fixedBundle(intent.bundle);
      if (bundle.sourceKind === "builtin" && !knownBuiltins.some(item => item.packageName === bundle.packageName
        && item.version === bundle.version && item.installSpec === bundle.installSpec)) throw new Error("Only builtins from the pinned author runtime can be added to this Profile");
      if (intent.rule) {
        if (intent.rule.packageName !== bundle.packageName || intent.rule.version !== bundle.version) throw new Error("The local bundle rule must describe the exact package and version being added");
        localBundleRules = localBundleRules.filter(item => item.packageName !== bundle.packageName); localBundleRules.push(clone(intent.rule));
      }
      if (bundle.sourceKind !== "builtin") {
        const index = dependencies.findIndex(item => item.packageName === bundle.packageName);
        const dependency = { ...bundle, origin: "local" as const };
        if (index < 0) dependencies.push(dependency); else dependencies[index] = dependency;
        put(manifest.dependencies, bundle.packageName, bundle.sourceKind === "npm" ? bundle.version : bundle.installSpec);
      }
      const existing = effectiveBundles.findIndex(item => item.packageName === bundle.packageName);
      effectiveBundles = effectiveBundles.filter(item => item.packageName !== bundle.packageName);
      const position = intent.position ?? (existing < 0 ? effectiveBundles.length : existing);
      if (!Number.isInteger(position) || position < 0 || position > effectiveBundles.length) throw new Error("The bundle position must be an integer within the effective load order");
      effectiveBundles.splice(position, 0, bundle);
      changes.push({ path: "package.json#/dependencies", action: "install_fixed_bundle" }, { path: "package.json#/dsh/profile/bundles", action: "enable_at_position" });
      break;
    }
    case "remove": {
      if (!removedFromCandidate && !dependencies.some(item => item.packageName === intent.packageName) && !effectiveBundles.some(item => item.packageName === intent.packageName)) throw new Error("The package is not part of the local Profile");
      const index = dependencies.findIndex(item => item.packageName === intent.packageName);
      if (index >= 0) dependencies.splice(index, 1);
      delete manifest.dependencies[intent.packageName];
      localBundleRules = localBundleRules.filter(item => item.packageName !== intent.packageName);
      effectiveBundles = effectiveBundles.filter(item => item.packageName !== intent.packageName);
      changes.push({ path: "package.json#/dependencies", action: "remove_dependency" }, { path: "cordis.patch.yml", action: "retain_and_validate" });
      break;
    }
    case "disable":
      if (!disabledFromCandidate && !effectiveBundles.some(item => item.packageName === intent.packageName) && !dependencies.some(item => item.packageName === intent.packageName)) throw new Error("The package is not part of the local Profile");
      effectiveBundles = effectiveBundles.filter(item => item.packageName !== intent.packageName);
      changes.push({ path: "package.json#/dsh/profile/bundles", action: "disable_keep_dependency" });
      break;
    case "enable": {
      if (!effectiveBundles.some(item => item.packageName === intent.packageName)) {
        const dependency = dependencies.find(item => item.packageName === intent.packageName);
        const builtin = knownBuiltins.find(item => item.packageName === intent.packageName);
        if (dependency) {
          // Resolutions may have changed the effective dependency after the first preview.
          const evidence = await installedBundleEvidence(directory, dependency.packageName, dependency.version);
          if (enabledEvidence !== undefined && evidence !== enabledEvidence) throw new Error("The installed bundle changed while preparing this edit; prepare it again");
          enabledEvidence = evidence;
          const { origin: _, ...bundle } = dependency; effectiveBundles.push(bundle);
        } else if (builtin) effectiveBundles.push(clone(builtin));
        else throw new Error("Enable requires a fixed installed dependency or a builtin from the pinned runtime");
      }
      changes.push({ path: "package.json#/dsh/profile/bundles", action: "enable" });
      break;
    }
    case "reorder": {
      if (new Set(intent.order).size !== intent.order.length || intent.order.length !== effectiveBundles.length
        || intent.order.some(name => !effectiveBundles.some(item => item.packageName === name))) throw new Error("Reorder must list every enabled bundle exactly once");
      effectiveBundles = intent.order.map(name => effectiveBundles.find(item => item.packageName === name)!);
      changes.push({ path: "package.json#/dsh/profile/bundles", action: "reorder" });
      break;
    }
    case "configure":
      patch = configuredPatch!;
      changes.push({ path: "cordis.patch.yml", action: "replace_and_validate" });
      break;
    case "input-declare": {
      const declaration = inputDeclaration(intent.declaration, true), author = baseline?.release.inputs.find(item => item.key === declaration.key);
      if (author && (author.required && !declaration.required || author.secret && !declaration.secret)) throw new Error("A local declaration cannot weaken an author's required or secret input policy");
      localInputs = localInputs.filter(item => item.key !== declaration.key); localInputs.push(declaration);
      changes.push({ path: `inputs#/${declaration.key}`, action: "declare_local" });
      break;
    }
    case "input-remove":
      assertProfileInputKey(intent.key);
      if (!localInputs.some(item => item.key === intent.key)) throw new Error("The input has no local declaration to remove; author declarations are retained");
      localInputs = localInputs.filter(item => item.key !== intent.key);
      changes.push({ path: `inputs#/${intent.key}`, action: "remove_local_declaration_keep_stored_value" });
      break;
    default: throw new Error("Unsupported Profile edit intent");
  }
  try {
    validateProfileBundleOrder(effectiveBundles.map(bundle => {
      const reference = baseline?.release.bundles.find(item => item.packageName === bundle.packageName);
      return { packageName: bundle.packageName, selector: bundle.selector, before: reference?.before ?? [], after: reference?.after ?? [] };
    }));
  } catch { throw new Error("The edited bundle order violates the author's before/after constraints; choose a compatible edit"); }
  put(manifest.dsh.profile, "bundles", effectiveBundles.map(item => item.packageName));
  dependencies.sort((left, right) => left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0);
  const inputs = mergeProfileInputDeclarations(baseline?.release.inputs ?? [], localInputs);
  localBundleRules = validateLocalBundleRules({ bundles: effectiveBundles, dependencies, rules: localBundleRules, runtimeVersion: runtime.version! });
  if (firstFingerprint !== prepared.expectedFingerprint || firstFingerprint !== await installationFingerprint(directory, statePath)) throw new Error("The local Profile changed while preparing this edit; prepare it again");
  const summary: ProfileEditSummary = { profile: options.profile, action: intent.kind, ...(packageName ? { packageName } : {}),
    ...(intent.kind === "reorder" ? { order: [...intent.order] } : {}), ...(runtime?.version ? { runtimeVersion: runtime.version } : {}), source, changes };
  const resultHash = hash({ previousResult: prepared.resultHash, contextHash, intent, manifest, patch, effectiveBundles, dependencies, runtime, inputs, localInputs, localBundleRules, enabledEvidence });
  return { ...prepared, current: current ? clone(current) : undefined, source, resolved: { profileVersion: baseline?.resolved.profileVersion ?? "local", bundles: clone(effectiveBundles) },
    manifest, patch, effectiveBundles, dependencies, runtime, inputs, localInputs, localBundleRules,
    contextHash, resultHash, summary, upgradeSummary: prepared.summary };
}

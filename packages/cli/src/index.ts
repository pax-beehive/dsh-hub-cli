import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { satisfies, validRange } from "semver";
import type { ResolvedProfile, ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import type { HubProfileVersion, ProfileDraft } from "@dsh-plugin-hub/schemas";
import { exactSemverSchema, npmPackageNameSchema, profileDraftSchema } from "@dsh-plugin-hub/schemas";
import { directoryFingerprint, installationFingerprint, withProfileMutationLock } from "./profile-files.js";
import { missingProfileInputMessage, resolveProfileInputs, stripStoredInputEnvironment } from "./profile-inputs.js";
export { DSH_HUB_STORED_INPUT_KEYS, stripStoredInputEnvironment } from "./profile-inputs.js";
import { preparePinnedRuntime, RuntimePreparationError } from "./runtime-launch.js";
import { inspectLocalRuntimeDefaults } from "./profile-runtime.js";
import { readProfileState, resolveProfileExportRuntime } from "./profile-lifecycle.js";
import { buildAuthorBaseline, prepareProfileUpgrade, type AuthorBaseline } from "./profile-upgrade.js";
import { copyProfileFiles, scanProfileFiles, type ProfileFileEntry } from "./profile-upgrade-files.js";
import type { ProfileJsonObject } from "./profile-merge.js";
import { buildProfileDependencyCommands, installLockedProfileDependencies,
  type EffectiveProfileDependencyLock, type ProfileDependencyCommand } from "./profile-dependency-install.js";
import { prepareProfileEdit, mergeProfileInputDeclarations, validateLocalBundleRules,
  type LocalBundleRule, type ProfileEditIntent, type ProfileEditSummary } from "./profile-edit.js";

export interface DshInstallCommand { command: "dsh" | "npx"; args: string[] }

export interface HubLockfile {
  schemaVersion: 2;
  profile: string;
  source?: "author" | "local";
  hubProfile?: { slug: string; version: string };
  resolvedAt: string;
  contentHash?: string;
  runtime?: HubProfileVersion["runtime"];
  inputs?: HubProfileVersion["inputs"];
  /** Explicit declarations for personal plugins; values remain in the separate input store. */
  localInputs?: HubProfileVersion["inputs"];
  /** Registry-declared constraints for exact versions added locally. */
  localBundleRules?: LocalBundleRule[];
  /** Explicit disable/remove choices survive author removal and later reintroduction. */
  localBundleOverrides?: { disabled: string[]; removed: string[] };
  localFilesHash?: string;
  unmanaged?: true;
  verification?: { structural: "passed"; composition: "passed"; platform: NodeJS.Platform; verifiedAt: string };
  buildAllowlist?: string[];
  /** The original author content is kept separate from the effective local installation. */
  authorBaseline?: AuthorBaseline;
  /** All installed dependencies, including libraries that are not loaded as Profile bundles. */
  dependencies?: ResolvedProfileBundle[];
  /** Native pnpm graph verified by the built-in aggregate installer. */
  effectiveLock?: EffectiveProfileDependencyLock;
  /** Installer-generated files before any explicitly retained personal overrides. */
  generatedFiles?: ProfileFileEntry[];
  bundles: ResolvedProfileBundle[];
}

export interface ProfileRevision { id: string; createdAt: string; state: HubLockfile }

export function dshHomePath(dshHome?: string): string {
  return dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function assertProfileName(profile: string): void {
  if (profile.toLowerCase() === "node_modules") {
    throw new Error("DSH profile name node_modules is reserved for the runtime's shared package resolution directory");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === "." || profile === "..") {
    throw new Error(`Invalid DSH profile name: ${profile}`);
  }
}

export function profileDirectory(profile: string, dshHome?: string): string {
  assertProfileName(profile);
  return join(dshHomePath(dshHome), "profiles", profile);
}

/** Kept for API compatibility; V1 stores Hub state outside official Profiles. */
export function profileLockPath(profile: string, dshHome?: string): string {
  assertProfileName(profile);
  return join(dshHomePath(dshHome), ".hub", "installations", profile, "current.json");
}

function installationDirectory(profile: string, dshHome?: string): string {
  return dirname(profileLockPath(profile, dshHome));
}

export function buildDshInstallCommand(profile: string, installSpec: string, runtimeVersion?: string): DshInstallCommand {
  assertProfileName(profile);
  if (installSpec.trim() === "" || installSpec.startsWith("-")) {
    throw new Error(`Invalid install spec: ${installSpec}`);
  }
  return runtimeVersion
    ? { command: "npx", args: ["-y", `@deepseek-ai/dsh@${runtimeVersion}`, "plugin", "--profile", profile, "add", "--save-exact", installSpec] }
    : { command: "dsh", args: ["plugin", "--profile", profile, "add", "--save-exact", installSpec] };
}

export function buildDshValidationCommand(profile: string, runtimeVersion?: string): DshInstallCommand {
  assertProfileName(profile);
  return runtimeVersion
    ? { command: "npx", args: ["-y", `@deepseek-ai/dsh@${runtimeVersion}`, "--profile", profile, "--dump-config"] }
    : { command: "dsh", args: ["--profile", profile, "--dump-config"] };
}

export async function validateCurrentProfile(
  profile: string,
  runtimeVersion?: string,
  execute?: (command: DshInstallCommand, env?: NodeJS.ProcessEnv) => Promise<void>,
  options: { dshHome?: string; inputs?: HubProfileVersion["inputs"] } = {},
): Promise<void> {
  const inputs = await resolveProfileInputs({ profile, declarations: options.inputs ?? [], dshHome: options.dshHome });
  if (inputs.missing.length) throw new Error(missingProfileInputMessage(profile, inputs.missing));
  await (execute ?? ((command, env) => run(command, options.dshHome, env, true)))(buildDshValidationCommand(profile, runtimeVersion), inputs.env);
}

async function run(command: DshInstallCommand, dshHome?: string, environment?: NodeJS.ProcessEnv, validation = false): Promise<void> {
  // Validate provenance even for caller-supplied environments. Only the exact
  // launch/validation shapes we construct may carry marked target inputs. Other
  // commands (including package management in any argument position) are clean.
  const cleanEnvironment = stripStoredInputEnvironment(environment ?? process.env);
  const runtimeArgs = command.command === "npx" ? command.args.slice(2) : command.args;
  const targetInputs = runtimeArgs[0] === "--profile" && Boolean(runtimeArgs[1]) &&
    (runtimeArgs.length === 2 || runtimeArgs.length === 3 && runtimeArgs[2] === "--dump-config");
  if (targetInputs) assertProfileName(runtimeArgs[1]!);
  const inherited = environment && targetInputs ? { ...environment } : cleanEnvironment;
  let executable: string = command.command;
  let args = command.args;
  if (command.command === "npx") {
    const prefix = "@deepseek-ai/dsh@";
    if (args[0] !== "-y" || !args[1]?.startsWith(prefix)) throw new Error("Unsupported pinned DSH runtime command");
    // npm may run lifecycle scripts when it prepares a missing runtime. Keep saved inputs
    // out of that phase; invoke the verified package executable directly afterwards.
    let entry: string;
    try { entry = await preparePinnedRuntime(args[1].slice(prefix.length), dshHomePath(dshHome ?? environment?.DSH_HOME)); }
    catch (error) {
      if (error instanceof RuntimePreparationError) throw error;
      throw new RuntimePreparationError("Pinned DSH runtime preparation or cache verification failed");
    }
    executable = process.execPath;
    args = [entry, ...args.slice(2)];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      // Composed config and validation diagnostics may contain substituted input values.
      stdio: validation ? "ignore" : process.env.DSH_HUB_MACHINE === "1" ? ["ignore", "ignore", "inherit"] : "inherit",
      env: dshHome ? { ...inherited, DSH_HOME: dshHome } : inherited,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`dsh ${validation ? "configuration validation" : "command"} failed (${signal ?? `exit ${String(code)}`})${validation ? "; check the Profile configuration and declared inputs before retrying" : ""}`));
    });
  });
}

export function executeDshCommand(command: DshInstallCommand, dshHome?: string, environment?: NodeJS.ProcessEnv): Promise<void> {
  return run(command, dshHome, environment);
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Presets require Node.js >=22.13.0 (current: ${version})`);
  }
}

function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", env: stripStoredInputEnvironment(process.env) });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

export async function assertProfileApplyPrerequisites(options?: {
  nodeVersion?: string;
  pnpmAvailable?: () => Promise<boolean>;
}): Promise<void> {
  assertSupportedNodeVersion(options?.nodeVersion);
  if (!await (options?.pnpmAvailable ?? (() => commandSucceeds("pnpm", ["--version"])))()) {
    throw new Error("Presets require pnpm on PATH. Install pnpm, then retry.");
  }
}

export function detectDshVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("dsh", ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: stripStoredInputEnvironment(process.env) });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { errorOutput += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      const version = output.match(/\b(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
      if (code === 0 && version) resolve(version);
      else reject(new Error(
        `Unable to detect DSH version (${errorOutput.trim() || output.trim() || `exit ${code}`}); pass --runtime-version <exact-semver>`,
      ));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Existing local contents participate in preservation even before Hub adoption. */
export async function profileNeedsPreservation(profile: string, dshHome?: string): Promise<boolean> {
  return await exists(profileDirectory(profile, dshHome)) || await exists(profileLockPath(profile, dshHome));
}

async function readJSON(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

const npmPackageName = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const pinnedGitHubSpec = /^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)#([0-9a-f]{40})$/i;

export function parseAllowBuilds(workspaceYaml: string): string[] {
  if (Buffer.byteLength(workspaceYaml, "utf8") > 128 * 1024) {
    throw new Error("Pinned GitHub pnpm-workspace.yaml is too large");
  }
  const lines = workspaceYaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^allowBuilds:\s*(?:#.*)?$/.test(line));
  if (start === -1) return [];
  const allowed: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s{2}([^:#][^:]*):\s*(true|false)\s*(?:#.*)?$/);
    if (!match) throw new Error("Unsupported allowBuilds entry in pinned GitHub workspace");
    const key = match[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!npmPackageName.test(key)) {
      throw new Error(`Unsupported allowBuilds package in pinned GitHub workspace: ${key}`);
    }
    if (match[2] === "true") allowed.push(key);
    if (allowed.length > 64) throw new Error("Pinned GitHub allowBuilds contains too many packages");
  }
  return [...new Set(allowed)].sort();
}

export async function resolvePinnedGitHubBuildAllowlist(bundles: ResolvedProfileBundle[]): Promise<string[]> {
  const keys = await Promise.all(bundles.map(async (bundle) => {
    if (bundle.sourceKind !== "github") return [];
    const match = bundle.installSpec.match(pinnedGitHubSpec);
    if (!match) throw new Error(`GitHub Preset bundle must use an immutable commit: ${bundle.installSpec}`);
    const [, owner, repository, commit] = match;
    const prepareKey = bundle.packageName;
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/pnpm-workspace.yaml`,
      { headers: { accept: "text/plain", "user-agent": "dsh-hub-cli/0.2.0" }, signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 404) return [prepareKey];
    if (!response.ok) throw new Error(`Unable to read pinned GitHub build policy (${response.status}) for ${bundle.packageName}`);
    return [prepareKey, ...parseAllowBuilds(await response.text())];
  }));
  return [...new Set(keys.flat())].sort();
}

async function writeBuildWorkspace(stage: string, allowBuilds: string[]): Promise<void> {
  await mkdir(stage, { recursive: true });
  const policy = allowBuilds.length
    ? `allowBuilds:\n${allowBuilds.map((key) => `  ${key}: true`).join("\n")}\n`
    : "";
  await writeFile(join(stage, "pnpm-workspace.yaml"), [
    "packages:",
    "  - .",
    "nodeLinker: hoisted",
    "autoInstallPeers: false",
    policy.trimEnd(),
    "",
  ].filter((line, index, all) => line || index === all.length - 1).join("\n"), { encoding: "utf8", mode: 0o600 });
}

async function materializeProfile(stage: string, profileName: string, resolved: ResolvedProfile, release?: HubProfileVersion,
  document?: { manifest: ProfileJsonObject; patch: string }) {
  await mkdir(stage, { recursive: true });
  const manifestPath = join(stage, "package.json");
  if (document) {
    await writeFile(manifestPath, `${JSON.stringify(document.manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(stage, "cordis.patch.yml"), document.patch, { encoding: "utf8", mode: 0o600 });
    return;
  }
  const current = (await exists(manifestPath)) ? await readJSON(manifestPath) : {};
  const dependencies = typeof current.dependencies === "object" && current.dependencies
    ? current.dependencies as Record<string, string> : {};
  for (const bundle of resolved.bundles) {
    if (bundle.sourceKind === "builtin") continue;
    dependencies[bundle.packageName] = bundle.sourceKind === "npm" ? bundle.version : bundle.installSpec;
  }
  const dsh = typeof current.dsh === "object" && current.dsh
    ? current.dsh as Record<string, unknown> : {};
  dsh.profile = { bundles: resolved.bundles.map((bundle) => bundle.packageName) };
  await writeFile(manifestPath, `${JSON.stringify({
    ...current,
    name: `dsh-hub-${profileName.toLowerCase()}`,
    private: true,
    dependencies,
    dsh,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const patch = release?.patchYaml ?? `${JSON.stringify(release?.patch ?? [], null, 2)}\n`;
  await writeFile(join(stage, "cordis.patch.yml"), patch, { encoding: "utf8", mode: 0o600 });
}

async function structuralValidation(stage: string, resolved: ResolvedProfile) {
  const manifest = await readJSON(join(stage, "package.json"));
  const dsh = manifest.dsh as { profile?: { bundles?: unknown } } | undefined;
  const actual = dsh?.profile?.bundles;
  const expected = resolved.bundles.map((bundle) => bundle.packageName);
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Staged Profile bundle sequence does not match the effective installation");
  }
  if (!(await exists(join(stage, "cordis.patch.yml")))) {
    throw new Error("Staged Preset is missing cordis.patch.yml");
  }
}

async function validateInstalledDependencies(stage: string, dependencies: ResolvedProfileBundle[]): Promise<void> {
  for (const dependency of dependencies) {
    if (dependency.sourceKind === "builtin") continue;
    let installed: Record<string, unknown>;
    try { installed = await readJSON(join(stage, "node_modules", ...dependency.packageName.split("/"), "package.json")); }
    catch { throw new Error(`Installed dependency is missing or unreadable: ${dependency.packageName}`); }
    if (installed.name !== dependency.packageName || installed.version !== dependency.version) {
      throw new Error(`Installed dependency does not match the pinned identity and version: ${dependency.packageName}`);
    }
  }
}

async function writeState(path: string, state: HubLockfile) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    if (await exists(temporary)) await rm(temporary, { force: true });
    throw error;
  }
}

export interface InstallProfileOptions {
  profile: string;
  resolved: ResolvedProfile;
  release?: HubProfileVersion;
  hubProfileSlug?: string;
  dryRun?: boolean;
  dshHome?: string;
  execute?: (command: DshInstallCommand, env?: NodeJS.ProcessEnv) => Promise<void>;
  validate?: (command: DshInstallCommand, env?: NodeJS.ProcessEnv) => Promise<void>;
  persistState?: (path: string, state: HubLockfile) => Promise<void>;
  resolveBuildAllowlist?: (bundles: ResolvedProfileBundle[]) => Promise<string[]>;
  expectedFingerprint?: string;
  mode?: "apply" | "upgrade";
  resolutions?: Parameters<typeof prepareProfileUpgrade>[0]["resolutions"];
  baselineRelease?: HubProfileVersion;
  baselineResolved?: ResolvedProfile;
  expectedUpgradeHash?: string;
}

export type ProfileUpgradeSummary = Awaited<ReturnType<typeof prepareProfileUpgrade>>["summary"];

export class ProfileUpgradeBlockedError extends Error {
  readonly code = "PROFILE_UPGRADE_BLOCKED";
  constructor(readonly summary: ProfileUpgradeSummary, baselineRequired = false, readonly contextHash?: string) {
    super(baselineRequired
      ? "A verified author baseline is required before upgrading this Profile; retrieve its original Release or install into a new Profile"
      : "Profile upgrade has unresolved conflicts; inspect profile diff and provide a context-bound --resolutions file before retrying");
    this.name = "ProfileUpgradeBlockedError";
  }
}

export interface InstallProfileResult {
  commands: Array<DshInstallCommand | ProfileDependencyCommand>;
  lockfile: HubLockfile;
  revision?: string;
  upgrade?: ProfileUpgradeSummary;
  edit?: ProfileEditSummary;
}

export interface ApplyProfileEditOptions {
  profile: string;
  intent: ProfileEditIntent;
  runtimeVersion?: string;
  resolutions?: InstallProfileOptions["resolutions"];
  expectedContextHash?: string;
  expectedResultHash?: string;
  dryRun?: boolean;
  dshHome?: string;
  execute?: InstallProfileOptions["execute"];
  validate?: InstallProfileOptions["validate"];
  persistState?: InstallProfileOptions["persistState"];
  resolveBuildAllowlist?: InstallProfileOptions["resolveBuildAllowlist"];
}

/** Prepare an explicitly selected local runtime without changing any active Profile. */
export async function prepareLocalProfileRuntime(options: {
  profile: string; runtimeVersion?: string; dshHome?: string;
}): Promise<{ runtimeVersion?: string; source: "author" | "local" }> {
  assertProfileName(options.profile);
  let current: HubLockfile | undefined;
  try {
    current = JSON.parse(await readFile(profileLockPath(options.profile, options.dshHome), "utf8")) as HubLockfile;
    if (!current || typeof current !== "object" || Array.isArray(current) || current.schemaVersion !== 2 ||
      current.profile !== options.profile || !Array.isArray(current.bundles)) throw new Error("Invalid Profile state");
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read the Profile state; inspect or recover it before preparing an edit");
  }
  const recorded = current?.runtime?.version ?? current?.authorBaseline?.release.runtime?.version;
  const author = Boolean(current?.authorBaseline || current?.hubProfile || current?.contentHash || current?.source === "author");
  if (options.runtimeVersion && !exactSemverSchema.safeParse(options.runtimeVersion).success) {
    throw new Error("Local editing requires --runtime-version <exact-semver>, not a tag or range");
  }
  if (author) {
    if (options.runtimeVersion && options.runtimeVersion !== recorded) {
      throw new Error("An author Profile's runtime is pinned by its Release; apply a Release with the required runtime instead");
    }
    return { source: "author", runtimeVersion: recorded };
  }
  const selected = options.runtimeVersion ?? recorded;
  if (!selected || !exactSemverSchema.safeParse(selected).success) {
    throw new Error("No exact runtime is recorded for this local Profile; pass --runtime-version <exact-semver>");
  }
  await preparePinnedRuntime(selected, dshHomePath(options.dshHome));
  return { source: "local", runtimeVersion: selected };
}

/** Local edits use the same staging, validation, history and recovery transaction as upgrades. */
export async function applyProfileEdit(options: ApplyProfileEditOptions): Promise<InstallProfileResult> {
  stripStoredInputEnvironment(process.env); // Reject invalid provenance before creating a mutation lock.
  assertProfileName(options.profile);
  const apply = async () => {
    if (!options.dryRun) await prepareLocalProfileRuntime(options);
    const prepared = await prepareProfileEdit(options);
    return installProfile({ ...options, resolved: prepared.resolved,
      release: prepared.authorBaseline?.release, hubProfileSlug: prepared.authorBaseline?.slug }, options, prepared);
  };
  if (options.dryRun) return apply();
  return withProfileMutationLock(profileLockPath(options.profile, options.dshHome), apply);
}

export async function installResolvedProfile(options: InstallProfileOptions): Promise<InstallProfileResult> {
  stripStoredInputEnvironment(process.env); // Library callers may be running inside a Profile host.
  assertProfileName(options.profile);
  if (options.dryRun) return installProfile(options);
  return withProfileMutationLock(profileLockPath(options.profile, options.dshHome), () => installProfile(options));
}

async function installProfile(options: InstallProfileOptions, editOptions?: ApplyProfileEditOptions,
  preparedEdit?: Awaited<ReturnType<typeof prepareProfileEdit>>): Promise<InstallProfileResult> {
  assertProfileName(options.profile);
  const home = dshHomePath(options.dshHome);
  const target = profileDirectory(options.profile, home);
  const install = installationDirectory(options.profile, home);
  const statePath = profileLockPath(options.profile, home);
  const previousState = await exists(statePath) ? await readFile(statePath) : undefined;
  const current = previousState ? JSON.parse(previousState.toString("utf8")) as HubLockfile : undefined;
  const initialFingerprint = await installationFingerprint(target, statePath);
  if (options.expectedFingerprint && initialFingerprint !== options.expectedFingerprint) {
    throw new Error("Profile changed after planning; create a new plan");
  }
  const upgrading = !editOptions && (options.mode === "upgrade" || Boolean(options.release && await profileNeedsPreservation(options.profile, home)));
  if (!options.release && (options.mode === "upgrade" || current?.authorBaseline || current?.hubProfile)) {
    throw new Error("An exact Release is required to update a managed Profile without losing local customizations");
  }
  const prepare = () => prepareProfileUpgrade({
    profile: options.profile, slug: options.hubProfileSlug, release: options.release!, resolved: options.resolved,
    dshHome: home, resolutions: options.resolutions, baselineRelease: options.baselineRelease, baselineResolved: options.baselineResolved,
  });
  const prepared = upgrading ? await prepare() : undefined;
  if (prepared && prepared.status !== "ready") throw new ProfileUpgradeBlockedError(prepared.summary, prepared.status === "baseline_required", prepared.contextHash);
  const upgrade = prepared?.status === "ready" ? prepared : undefined;
  const edit = preparedEdit;
  if (edit && (edit.expectedFingerprint !== initialFingerprint ||
    editOptions?.expectedContextHash && editOptions.expectedContextHash !== edit.contextHash ||
    editOptions?.expectedResultHash && editOptions.expectedResultHash !== edit.resultHash)) {
    throw new Error("Profile edit changed after planning; create a new plan");
  }
  const document = edit ?? upgrade;
  if (options.expectedUpgradeHash && options.expectedUpgradeHash !== upgrade?.resultHash) {
    throw new Error("Profile upgrade result changed after planning; create a new plan");
  }
  const authorBaseline = document?.authorBaseline ?? (options.release ? buildAuthorBaseline({
    profile: options.profile, slug: options.hubProfileSlug, release: options.release, resolved: options.resolved,
  }) : undefined);
  const fixedInstallSpec = (bundle: ResolvedProfileBundle): ResolvedProfileBundle => bundle.sourceKind === "npm"
    ? { ...bundle, installSpec: `${bundle.packageName}@${bundle.version}` } : bundle;
  const effectiveBundles = (document?.effectiveBundles ?? options.resolved.bundles).map(fixedInstallSpec);
  const dependencies = (document?.dependencies ?? options.resolved.bundles.filter(bundle => bundle.sourceKind !== "builtin")).map(fixedInstallSpec);
  const effective = { profileVersion: options.resolved.profileVersion, bundles: effectiveBundles };
  const stageProfile = `.hub-${options.profile}-${randomUUID().slice(0, 8)}`;
  const runtime = edit?.runtime ?? options.release?.runtime;
  const runtimeVersion = runtime?.version;
  const localInputs = edit?.localInputs ?? current?.localInputs ?? [];
  const effectiveInputs = edit?.inputs ?? mergeProfileInputDeclarations(options.release?.inputs ?? [], localInputs);
  const localBundleRules = validateLocalBundleRules({ bundles: effectiveBundles, dependencies,
    rules: edit?.localBundleRules ?? current?.localBundleRules ?? [], runtimeVersion: runtimeVersion ?? "" });
  const localBundleOverrides = document?.localBundleOverrides ?? current?.localBundleOverrides;
  const externalCommands = dependencies
    .filter((bundle) => bundle.sourceKind !== "builtin")
    .map((bundle) => buildDshInstallCommand(stageProfile,
      bundle.sourceKind === "npm" ? `${bundle.packageName}@${bundle.version}` : bundle.installSpec, runtimeVersion));
  const commands = options.execute ? externalCommands : buildProfileDependencyCommands();
  const lockfile: HubLockfile = {
    schemaVersion: 2,
    profile: options.profile,
    ...(edit ? { source: edit.source } : authorBaseline ? { source: "author" as const } : {}),
    hubProfile: options.hubProfileSlug
      ? { slug: options.hubProfileSlug, version: options.resolved.profileVersion } : undefined,
    resolvedAt: new Date().toISOString(),
    contentHash: options.release?.contentHash,
    runtime,
    inputs: effectiveInputs,
    ...(localInputs.length ? { localInputs } : {}),
    ...(localBundleRules.length ? { localBundleRules } : {}),
    ...(localBundleOverrides ? { localBundleOverrides } : {}),
    authorBaseline,
    dependencies: dependencies.map(({ packageName, selector, version, installSpec, sourceKind, integrity }) =>
      ({ packageName, selector, version, installSpec, sourceKind, integrity })),
    bundles: effectiveBundles,
  };
  if (options.dryRun) return { commands, lockfile, upgrade: upgrade?.summary, edit: edit?.summary };

  const inputs = await resolveProfileInputs({ profile: options.profile, declarations: effectiveInputs, dshHome: home });
  if (inputs.missing.length) throw new Error(missingProfileInputMessage(options.profile, inputs.missing));
  const stage = profileDirectory(stageProfile, home);
  await mkdir(join(home, "profiles"), { recursive: true });
  const revisionsPath = join(install, "revisions");
  const hadRevisions = await exists(revisionsPath);
  let revision: string | undefined;
  let switched = false;
  const generated = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]);
  async function removeSelectedGeneratedFiles(): Promise<void> {
    for (const path of document?.removedFiles ?? []) {
      // Only this generated configuration can be deliberately absent. Dependency
      // locks must be regenerated rather than copied from another dependency graph.
      if (path !== "pnpm-workspace.yaml") throw new Error("Unsupported generated file deletion in upgrade preparation");
      await rm(join(stage, path), { force: true });
    }
  }
  try {
    const buildAllowlist = await (options.resolveBuildAllowlist ?? resolvePinnedGitHubBuildAllowlist)(dependencies);
    if (buildAllowlist.length) lockfile.buildAllowlist = buildAllowlist;
    await writeBuildWorkspace(stage, buildAllowlist);
    const generatedWorkspace = (await scanProfileFiles(stage)).filter(file => file.relativePath === "pnpm-workspace.yaml");
    if (document) {
      // Package-manager configuration, overrides and their supporting files must
      // affect the actual install. Keep VCS metadata out of package lifecycle hooks.
      await copyProfileFiles(target, stage, document.preservedFiles.filter(file => file.relativePath !== ".git" && !file.relativePath.startsWith(".git/")));
      await removeSelectedGeneratedFiles();
    }
    await materializeProfile(stage, options.profile, effective, options.release,
      document ? { manifest: document.manifest, patch: document.patch } : authorBaseline);
    // The explicit external executor is a compatibility seam and does not earn a
    // native lock receipt. All built-in CLI/host installs use the aggregate graph.
    let verifiedDependencies: Awaited<ReturnType<typeof installLockedProfileDependencies>> | undefined;
    if (options.execute) {
      for (const command of externalCommands) await options.execute(command, { ...stripStoredInputEnvironment(process.env), DSH_HOME: home });
    } else {
      verifiedDependencies = await installLockedProfileDependencies({ directory: stage, dshHome: home, dependencies,
        previousDirectory: target, previousReceipt: current?.effectiveLock });
      lockfile.effectiveLock = verifiedDependencies.receipt;
    }
    lockfile.generatedFiles = [...generatedWorkspace,
      ...(await scanProfileFiles(stage)).filter(file => generated.has(file.relativePath) && file.relativePath !== "pnpm-workspace.yaml")];
    if (document) {
      await copyProfileFiles(target, stage, document.preservedFiles);
      await removeSelectedGeneratedFiles();
    }
    await materializeProfile(stage, options.profile, effective, options.release,
      document ? { manifest: document.manifest, patch: document.patch } : authorBaseline);
    await structuralValidation(stage, effective);
    if (options.release || edit || !options.execute) await validateInstalledDependencies(stage, dependencies);
    if (edit) {
      for (const bundle of effectiveBundles) {
        if (bundle.sourceKind === "builtin") continue;
        const metadata = await readJSON(join(stage, "node_modules", ...bundle.packageName.split("/"), "package.json"));
        const declaration = metadata.dsh as { bundle?: { patch?: unknown } } | undefined;
        if (typeof declaration?.bundle?.patch !== "string" || !declaration.bundle.patch.trim()) {
          throw new Error(`Enabled package does not declare a DSH bundle: ${bundle.packageName}`);
        }
      }
    }
    if (options.validate || !options.execute) {
      try {
        if (options.validate) await options.validate(buildDshValidationCommand(stageProfile, runtimeVersion), inputs.env);
        else await run(buildDshValidationCommand(stageProfile, runtimeVersion), home, inputs.env, true);
      } catch (error) {
        if (options.validate) throw error; // preserve errors from the caller's explicitly supplied validation hook
        if (error instanceof RuntimePreparationError) {
          throw new RuntimePreparationError(`${error.message}; the existing Profile was not switched. Check npm availability, registry access, and the pinned runtime cache before retrying.`, error.exitCode);
        }
        throw new Error(edit
          ? "The edited Profile failed composition validation; the existing Profile was not switched. Check the local patch, enabled bundles and declared inputs before retrying."
          : "The new Release failed composition validation; the existing Profile was not switched. Check the new Release configuration and declared inputs before retrying.");
      }
      lockfile.verification = { structural: "passed", composition: "passed", platform: process.platform, verifiedAt: new Date().toISOString() };
    }

    // Preserved files, materialization and composition must not replace the lock
    // or change inputs after its frozen installation has been accepted.
    await verifiedDependencies?.assertUnchanged();

    if (initialFingerprint !== await installationFingerprint(target, profileLockPath(options.profile, home))) {
      throw new Error("Profile changed while preparing the Release; local files were preserved. Create a new plan");
    }
    if (upgrade) {
      // Includes preserved VCS files and the installed metadata used to pin local ranges.
      // Neither is covered by the original directory fingerprint's dependency exclusions.
      const finalUpgrade = await prepare();
      if (finalUpgrade.status !== "ready" || finalUpgrade.contextHash !== upgrade.contextHash || finalUpgrade.resultHash !== upgrade.resultHash) {
        throw new Error("Profile changed while preparing the Release; local files were preserved. Create a new plan");
      }
    }
    if (edit && editOptions) {
      const finalEdit = await prepareProfileEdit(editOptions);
      if (finalEdit.contextHash !== edit.contextHash || finalEdit.resultHash !== edit.resultHash) {
        throw new Error("Profile or edit source changed during preparation; local files were preserved. Create a new plan");
      }
    }
    lockfile.localFilesHash = await directoryFingerprint(stage);
    if (await exists(target)) {
      revision = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const revisionDirectory = join(install, "revisions", revision);
      await mkdir(revisionDirectory, { recursive: true });
      if (await exists(profileLockPath(options.profile, home))) {
        await cp(profileLockPath(options.profile, home), join(revisionDirectory, "state.json"));
      } else {
        await writeState(join(revisionDirectory, "state.json"), {
          schemaVersion: 2, profile: options.profile, resolvedAt: new Date().toISOString(), bundles: [], unmanaged: true,
        });
      }
      await rename(target, join(revisionDirectory, "profile"));
    }
    await rename(stage, target);
    switched = true;
    await (options.persistState ?? writeState)(profileLockPath(options.profile, home), lockfile);
    return { commands, lockfile, revision, upgrade: upgrade?.summary, edit: edit?.summary };
  } catch (error) {
    if (switched && await exists(target)) {
      await rm(target, { recursive: true, force: true });
    }
    if (switched) {
      if (previousState) await writeFile(statePath, previousState, { mode: 0o600 });
      else await rm(statePath, { force: true });
    }
    if (revision && !(await exists(target))) {
      const revisionDirectory = join(install, "revisions", revision);
      const prior = join(revisionDirectory, "profile");
      if (await exists(prior)) await rename(prior, target);
      if (!(await exists(prior))) await rm(revisionDirectory, { recursive: true, force: true });
    }
    if (await exists(stage)) await rm(stage, { recursive: true, force: true });
    if (!hadRevisions) {
      // Failed first adoption must not leave an apparent history entry or a new
      // history directory. rmdir leaves any concurrently created contents alone.
      try { await rmdir(revisionsPath); }
      catch (cleanupError) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((cleanupError as NodeJS.ErrnoException).code ?? "")) throw cleanupError;
      }
    }
    throw error;
  }
}

export async function listProfileRevisions(profile: string, dshHome?: string): Promise<ProfileRevision[]> {
  const directory = join(installationDirectory(profile, dshHome), "revisions");
  if (!(await exists(directory))) return [];
  const revisions: ProfileRevision[] = [];
  for (const id of (await readdir(directory)).sort().reverse()) {
    const statePath = join(directory, id, "state.json");
    if (!(await exists(statePath)) || !(await exists(join(directory, id, "profile")))) continue;
    const state = JSON.parse(await readFile(statePath, "utf8")) as HubLockfile;
    revisions.push({ id, createdAt: id, state });
  }
  return revisions;
}

export interface RollbackProfileOptions {
  profile: string;
  revision?: string;
  dshHome?: string;
  expectedFingerprint?: string;
  expectedRevisionFingerprint?: string;
  persistState?: (path: string, state: HubLockfile) => Promise<void>;
}

export async function rollbackProfile(options: RollbackProfileOptions) {
  assertProfileName(options.profile);
  return withProfileMutationLock(profileLockPath(options.profile, options.dshHome), async () => {
    const revisions = await listProfileRevisions(options.profile, options.dshHome);
    const selected = options.revision ? revisions.find((item) => item.id === options.revision) : revisions[0];
    if (!selected) throw new Error(`No rollback revision for Profile ${options.profile}`);
    const home = dshHomePath(options.dshHome);
    const target = profileDirectory(options.profile, home);
    const statePath = profileLockPath(options.profile, home);
    const install = installationDirectory(options.profile, home);
    const selectedDirectory = join(install, "revisions", selected.id);
    const selectedProfile = join(selectedDirectory, "profile");
    if (!(await exists(selectedProfile))) throw new Error(`Rollback revision ${selected.id} is incomplete`);
    if (options.expectedFingerprint && options.expectedFingerprint !== await installationFingerprint(target, statePath)) {
      throw new Error("Profile changed after planning; create a new plan");
    }
    if (options.expectedRevisionFingerprint && options.expectedRevisionFingerprint !== await directoryFingerprint(selectedDirectory)) {
      throw new Error("Rollback revision changed after planning; create a new plan");
    }
    const displaced = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const displacedDirectory = join(install, "revisions", displaced);
    const previousState = await exists(statePath) ? await readFile(statePath) : undefined;
    let movedCurrent = false;
    let movedSelected = false;
    await mkdir(displacedDirectory, { recursive: true });
    try {
      if (previousState) await writeFile(join(displacedDirectory, "state.json"), previousState, { mode: 0o600 });
      else await writeState(join(displacedDirectory, "state.json"), {
        schemaVersion: 2, profile: options.profile, resolvedAt: new Date().toISOString(), bundles: [], unmanaged: true,
      });
      if (await exists(target)) {
        await rename(target, join(displacedDirectory, "profile"));
        movedCurrent = true;
      }
      await rename(selectedProfile, target);
      movedSelected = true;
      await (options.persistState ?? writeState)(statePath, selected.state);
      if (selected.state.unmanaged) await rm(statePath, { force: true });
    } catch (error) {
      if (movedSelected) await rename(target, selectedProfile);
      if (movedCurrent) await rename(join(displacedDirectory, "profile"), target);
      if (previousState) await writeFile(statePath, previousState, { mode: 0o600 });
      else await rm(statePath, { force: true });
      await rm(displacedDirectory, { recursive: true, force: true });
      throw error;
    }
    await rm(selectedDirectory, { recursive: true, force: true });
    if (!movedCurrent) await rm(displacedDirectory, { recursive: true, force: true });
    return { restored: selected.id };
  });
}

function localInstallSpec(spec: string): boolean {
  return /^(?:file:|link:|workspace:|\.\.?\/|\/)/.test(spec);
}

function containsLikelySecret(value: string): boolean {
  return /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(value) ||
    /\b(?:api[_-]?key|token|secret|password)\s*:\s*["']?(?!\$\{|[A-Z][A-Z0-9_]*(?:["']?\s*$))[A-Za-z0-9_+/=.-]{12,}/im.test(value);
}

export async function captureProfile(options: {
  profile: string; slug: string; name?: string; description?: string; dsh?: string; dshHome?: string; runtimeVersion?: string;
}): Promise<ProfileDraft> {
  const directory = profileDirectory(options.profile, options.dshHome);
  const manifest = await readJSON(join(directory, "package.json"));
  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
  const dshSection = manifest.dsh as { profile?: { bundles?: unknown } } | undefined;
  const sequence = dshSection?.profile?.bundles;
  if (!Array.isArray(sequence) || sequence.length === 0 || sequence.some((item) => !npmPackageNameSchema.safeParse(item).success) || new Set(sequence).size !== sequence.length) {
    throw new Error("Profile package.json has no ordered dsh.profile.bundles sequence");
  }
  const current = await readProfileState(options.profile, options.dshHome);
  const recorded = current && !current.unmanaged ? current.runtime?.version ?? current.authorBaseline?.release.runtime?.version : undefined;
  const { version: runtimeVersion } = await resolveProfileExportRuntime(options);
  let runtimeBuiltins: ResolvedProfileBundle[] | undefined;
  const inspectBuiltins = async () => runtimeBuiltins ??= (await inspectLocalRuntimeDefaults({ profile: options.profile,
    runtimeVersion, dshHome: options.dshHome, bundleNames: sequence as string[] })).builtins;
  // Cached descriptor wins; otherwise recorded effective builtin versions remain usable in an offline preview.
  if (await exists(join(dshHomePath(options.dshHome), ".hub", "runtimes", runtimeVersion))) await inspectBuiltins();
  const bundles = await Promise.all((sequence as string[]).map(async (packageName) => {
    const dependency = dependencies[packageName];
    const recordedBundle = current && !current.unmanaged && recorded === runtimeVersion ? current.bundles.find(bundle => bundle.packageName === packageName) : undefined;
    let builtin: ResolvedProfileBundle | undefined;
    if (dependency === undefined) {
      builtin = runtimeBuiltins?.find(bundle => bundle.packageName === packageName);
      if (!runtimeBuiltins && recordedBundle?.sourceKind === "builtin" && exactSemverSchema.safeParse(recordedBundle.version).success) builtin = recordedBundle;
      if (!builtin) builtin = (await inspectBuiltins()).find(bundle => bundle.packageName === packageName);
      if (!builtin) throw new Error(`${packageName} has no installed dependency or builtin in the selected runtime; repair the Profile before sharing`);
    }
    if (builtin) return { packageName, selector: builtin.version, version: builtin.version,
      installSpec: `builtin:${packageName}@${builtin.version}`, sourceKind: "builtin" as const, before: [], after: [] };
    const selector = dependency!;
    if (typeof selector !== "string") throw new Error(`${packageName} has an invalid dependency source; repair the Profile before sharing`);
    if (localInstallSpec(selector)) throw new Error(`${packageName} uses a local source; publish it to npm or GitHub before sharing`);
    const github = selector.startsWith("github:");
    if (github && !pinnedGitHubSpec.test(selector)) throw new Error(`${packageName} uses a mutable GitHub reference; pin it to a full commit before sharing`);
    if (!github && !validRange(selector)) throw new Error(`${packageName} uses an unsupported dependency source; use an npm version/range or an immutable GitHub commit before sharing`);
    const installedPath = join(directory, "node_modules", ...packageName.split("/"), "package.json");
    const installed = await readJSON(installedPath);
    if (installed.name !== packageName || !exactSemverSchema.safeParse(installed.version).success) {
      throw new Error(`${packageName} has no valid installed exact version; repair the Profile before sharing`);
    }
    const version = installed.version as string;
    if (!github && !satisfies(version, selector, { includePrerelease: true })) throw new Error(`${packageName}'s installed version does not satisfy its dependency range; repair the Profile before sharing`);
    return { packageName, selector, version, installSpec: github ? selector : `${packageName}@${version}`,
      sourceKind: github ? "github" as const : "npm" as const, before: [], after: [] };
  }));
  const patchPath = join(directory, "cordis.patch.yml");
  const patchYaml = (await exists(patchPath)) ? await readFile(patchPath, "utf8") : "[]\n";
  if (containsLikelySecret(patchYaml)) {
    throw new Error("Profile patch appears to contain a credential value; replace it with a local environment-variable reference before sharing");
  }
  const inputKeys = new Set<string>();
  for (const match of patchYaml.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) inputKeys.add(match[1]!);
  for (const match of patchYaml.matchAll(/\b(?:apiKeyEnv|[A-Za-z][A-Za-z0-9]*Env)\s*:\s*["']?([A-Z][A-Z0-9_]*)/g)) {
    inputKeys.add(match[1]!);
  }
  const declared = mergeProfileInputDeclarations(current?.inputs ?? [], current?.localInputs ?? []);
  const declaredKeys = new Set(declared.map(input => input.key));
  const inputs = [...declared, ...[...inputKeys].filter(key => !declaredKeys.has(key)).sort().map(key => ({
    key, label: key.replaceAll("_", " ").toLowerCase(), required: true, secret: /KEY|TOKEN|SECRET|PASSWORD/.test(key),
  }))];
  return profileDraftSchema.parse({ schemaVersion: 1, slug: options.slug, name: options.name ?? options.profile,
    description: options.description ?? "", visibility: "public", dsh: options.dsh ?? "*",
    runtime: { range: options.dsh ?? "*", version: runtimeVersion }, bundles, patch: [], patchYaml, inputs });
}

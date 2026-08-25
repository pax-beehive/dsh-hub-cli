import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ResolvedProfile, ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import type { HubProfileVersion, ProfileDraft } from "@dsh-plugin-hub/schemas";
import { profileDraftSchema } from "@dsh-plugin-hub/schemas";

export interface DshInstallCommand { command: "dsh" | "npx"; args: string[] }

export interface HubLockfile {
  schemaVersion: 2;
  profile: string;
  hubProfile?: { slug: string; version: string };
  resolvedAt: string;
  contentHash?: string;
  verification?: { structural: "passed"; composition: "passed"; platform: NodeJS.Platform; verifiedAt: string };
  buildAllowlist?: string[];
  bundles: ResolvedProfileBundle[];
}

export interface ProfileRevision { id: string; createdAt: string; state: HubLockfile }

export function dshHomePath(dshHome?: string): string {
  return dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function assertProfileName(profile: string): void {
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
    ? { command: "npx", args: ["-y", `@deepseek-ai/dsh@${runtimeVersion}`, "plugin", "--profile", profile, "add", installSpec] }
    : { command: "dsh", args: ["plugin", "--profile", profile, "add", installSpec] };
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
  execute: (command: DshInstallCommand) => Promise<void> = run,
): Promise<void> {
  await execute(buildDshValidationCommand(profile, runtimeVersion));
}

function run(command: DshInstallCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: process.env.DSH_HUB_MACHINE === "1" ? ["ignore", "ignore", "inherit"] : "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`dsh command failed (${signal ?? `exit ${String(code)}`})`));
    });
  });
}

export function executeDshCommand(command: DshInstallCommand): Promise<void> {
  return run(command);
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Profiles require Node.js >=22.13.0 (current: ${version})`);
  }
}

function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", env: process.env });
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
    throw new Error("Profiles require pnpm on PATH. Install pnpm, then retry.");
  }
}

export function detectDshVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("dsh", ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
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
    if (!match) throw new Error(`GitHub Profile bundle must use an immutable commit: ${bundle.installSpec}`);
    const [, owner, repository, commit] = match;
    const prepareKey = bundle.packageName;
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/pnpm-workspace.yaml`,
      { headers: { accept: "text/plain", "user-agent": "dsh-hub-cli/0.1" }, signal: AbortSignal.timeout(15_000) },
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

async function materializeProfile(stage: string, profileName: string, resolved: ResolvedProfile, release?: HubProfileVersion) {
  await mkdir(stage, { recursive: true });
  const manifestPath = join(stage, "package.json");
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
    throw new Error("Staged Profile bundle sequence does not match the release");
  }
  if (!(await exists(join(stage, "cordis.patch.yml")))) {
    throw new Error("Staged Profile is missing cordis.patch.yml");
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

export async function installResolvedProfile(options: {
  profile: string;
  resolved: ResolvedProfile;
  release?: HubProfileVersion;
  hubProfileSlug?: string;
  dryRun?: boolean;
  dshHome?: string;
  execute?: (command: DshInstallCommand) => Promise<void>;
  validate?: (command: DshInstallCommand) => Promise<void>;
  persistState?: (path: string, state: HubLockfile) => Promise<void>;
  resolveBuildAllowlist?: (bundles: ResolvedProfileBundle[]) => Promise<string[]>;
}): Promise<{ commands: DshInstallCommand[]; lockfile: HubLockfile; revision?: string }> {
  assertProfileName(options.profile);
  const stageProfile = `.hub-${options.profile}-${randomUUID().slice(0, 8)}`;
  const runtimeVersion = options.release?.runtime?.version;
  const commands = options.resolved.bundles
    .filter((bundle) => bundle.sourceKind !== "builtin")
    .map((bundle) => buildDshInstallCommand(stageProfile, bundle.installSpec, runtimeVersion));
  const lockfile: HubLockfile = {
    schemaVersion: 2,
    profile: options.profile,
    hubProfile: options.hubProfileSlug
      ? { slug: options.hubProfileSlug, version: options.resolved.profileVersion } : undefined,
    resolvedAt: new Date().toISOString(),
    contentHash: options.release?.contentHash,
    bundles: options.resolved.bundles,
  };
  if (options.dryRun) return { commands, lockfile };

  const missingInputs = (options.release?.inputs ?? [])
    .filter((input) => input.required && !process.env[input.key])
    .map((input) => input.key);
  if (missingInputs.length) {
    throw new Error(`Missing required local Profile inputs: ${missingInputs.join(", ")}`);
  }

  const home = dshHomePath(options.dshHome);
  const stage = profileDirectory(stageProfile, home);
  const target = profileDirectory(options.profile, home);
  const install = installationDirectory(options.profile, home);
  await mkdir(join(home, "profiles"), { recursive: true });
  await mkdir(join(install, "revisions"), { recursive: true });
  let revision: string | undefined;
  let switched = false;
  try {
    const buildAllowlist = await (options.resolveBuildAllowlist ?? resolvePinnedGitHubBuildAllowlist)(options.resolved.bundles);
    if (buildAllowlist.length) lockfile.buildAllowlist = buildAllowlist;
    await writeBuildWorkspace(stage, buildAllowlist);
    for (const command of commands) await (options.execute ?? run)(command);
    await materializeProfile(stage, options.profile, options.resolved, options.release);
    await structuralValidation(stage, options.resolved);
    if (options.validate) {
      await options.validate(buildDshValidationCommand(stageProfile, runtimeVersion));
      lockfile.verification = { structural: "passed", composition: "passed", platform: process.platform, verifiedAt: new Date().toISOString() };
    } else if (!options.execute) {
      await run(buildDshValidationCommand(stageProfile, runtimeVersion));
      lockfile.verification = { structural: "passed", composition: "passed", platform: process.platform, verifiedAt: new Date().toISOString() };
    }

    if (await exists(target)) {
      revision = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const revisionDirectory = join(install, "revisions", revision);
      await mkdir(revisionDirectory, { recursive: true });
      await rename(target, join(revisionDirectory, "profile"));
      if (await exists(profileLockPath(options.profile, home))) {
        await cp(profileLockPath(options.profile, home), join(revisionDirectory, "state.json"));
      }
    }
    await rename(stage, target);
    switched = true;
    await (options.persistState ?? writeState)(profileLockPath(options.profile, home), lockfile);
    return { commands, lockfile, revision };
  } catch (error) {
    if (switched && await exists(target)) {
      await rm(target, { recursive: true, force: true });
    }
    if (revision && !(await exists(target))) {
      const revisionDirectory = join(install, "revisions", revision);
      const prior = join(revisionDirectory, "profile");
      if (await exists(prior)) await rename(prior, target);
      if (!(await exists(prior))) await rm(revisionDirectory, { recursive: true, force: true });
    }
    if (await exists(stage)) await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function listProfileRevisions(profile: string, dshHome?: string): Promise<ProfileRevision[]> {
  const directory = join(installationDirectory(profile, dshHome), "revisions");
  if (!(await exists(directory))) return [];
  const revisions: ProfileRevision[] = [];
  for (const id of (await readdir(directory)).sort().reverse()) {
    const statePath = join(directory, id, "state.json");
    if (!(await exists(statePath))) continue;
    const state = JSON.parse(await readFile(statePath, "utf8")) as HubLockfile;
    revisions.push({ id, createdAt: id, state });
  }
  return revisions;
}

export async function rollbackProfile(options: { profile: string; revision?: string; dshHome?: string }) {
  const revisions = await listProfileRevisions(options.profile, options.dshHome);
  const selected = options.revision ? revisions.find((item) => item.id === options.revision) : revisions[0];
  if (!selected) throw new Error(`No rollback revision for Profile ${options.profile}`);
  const home = dshHomePath(options.dshHome);
  const target = profileDirectory(options.profile, home);
  const install = installationDirectory(options.profile, home);
  const selectedDirectory = join(install, "revisions", selected.id);
  if (!(await exists(join(selectedDirectory, "profile")))) throw new Error(`Rollback revision ${selected.id} is incomplete`);
  const displaced = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const displacedDirectory = join(install, "revisions", displaced);
  await mkdir(displacedDirectory, { recursive: true });
  if (await exists(target)) await rename(target, join(displacedDirectory, "profile"));
  if (await exists(profileLockPath(options.profile, home))) {
    await cp(profileLockPath(options.profile, home), join(displacedDirectory, "state.json"));
  }
  await rename(join(selectedDirectory, "profile"), target);
  await writeState(profileLockPath(options.profile, home), selected.state);
  await rm(selectedDirectory, { recursive: true, force: true });
  return { restored: selected.id };
}

function localInstallSpec(spec: string): boolean {
  return /^(?:file:|link:|workspace:|\.\.?\/|\/)/.test(spec);
}

function containsLikelySecret(value: string): boolean {
  return /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(value) ||
    /\b(?:api[_-]?key|token|secret|password)\s*:\s*["']?(?!\$\{|[A-Z][A-Z0-9_]*(?:["']?\s*$))[A-Za-z0-9_+/=.-]{12,}/im.test(value);
}

export async function captureProfile(options: {
  profile: string; slug: string; name?: string; description?: string; dsh?: string; dshHome?: string;
}): Promise<ProfileDraft> {
  const directory = profileDirectory(options.profile, options.dshHome);
  const manifest = await readJSON(join(directory, "package.json"));
  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
  const dshSection = manifest.dsh as { profile?: { bundles?: unknown } } | undefined;
  const sequence = dshSection?.profile?.bundles;
  if (!Array.isArray(sequence) || sequence.length === 0 || sequence.some((item) => typeof item !== "string")) {
    throw new Error("Profile package.json has no ordered dsh.profile.bundles sequence");
  }
  const bundles = await Promise.all((sequence as string[]).map(async (packageName) => {
    const selector = dependencies[packageName] ?? "latest";
    if (localInstallSpec(selector)) {
      throw new Error(`${packageName} uses local source ${selector}; publish it to npm or GitHub before sharing`);
    }
    const installedPath = join(directory, "node_modules", ...packageName.split("/"), "package.json");
    let version: string | undefined;
    if (await exists(installedPath)) {
      const installed = await readJSON(installedPath);
      if (typeof installed.version === "string") version = installed.version;
    }
    const builtin = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-headless"].includes(packageName);
    const github = selector.startsWith("github:");
    if (github && !pinnedGitHubSpec.test(selector)) {
      throw new Error(`${packageName} uses a mutable GitHub reference; pin it to a full commit before sharing`);
    }
    return {
      packageName,
      selector,
      version,
      installSpec: github ? selector : version ? `${packageName}@${version}` : undefined,
      sourceKind: builtin ? "builtin" as const : github ? "github" as const : "npm" as const,
      before: [],
      after: [],
    };
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
  return profileDraftSchema.parse({ schemaVersion: 1, slug: options.slug, name: options.name ?? options.profile,
    description: options.description ?? "", visibility: "public", dsh: options.dsh ?? "*",
    bundles, patch: [], patchYaml, inputs: [...inputKeys].sort().map((key) => ({
      key, label: key.replaceAll("_", " ").toLowerCase(), required: true, secret: /KEY|TOKEN|SECRET|PASSWORD/.test(key),
    })) });
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { prepareProfilePackageManager, type PreparedProfilePackageManager } from "./profile-package-manager.js";
import { validateProfileDependencyLock, type ProfileDependencyLockReceipt } from "./profile-dependency-lock.js";
import { stripStoredInputEnvironment } from "./profile-inputs.js";
import { scanProfileFiles, type ProfileFileEntry } from "./profile-upgrade-files.js";

/** Records a locally resolved graph. This does not attest Runtime or GitHub build outputs. */
export interface EffectiveProfileDependencyLock {
  schemaVersion: 1;
  packageManager: { name: "pnpm"; version: string };
  lock: ProfileDependencyLockReceipt;
  manifestHash: string;
  configurationHash: string;
  /** Used for reuse only; credential rotation does not itself invalidate a running Profile. */
  environmentHash: string;
  externalFiles: Array<{ path: string; hash: string | null }>;
  platform: NodeJS.Platform;
  arch: string;
  nodeAbi: string;
  hooksPresent: boolean;
  resolution: "new" | "reused";
}

export interface ProfileDependencyCommand { command: "pnpm"; args: string[] }
const controls = ["--config.manage-package-manager-versions=false", "--config.package-manager-strict=true",
  "--config.package-manager-strict-version=true", "--config.verify-store-integrity=true", "--config.side-effects-cache=false"];
export function buildProfileDependencyCommands(): ProfileDependencyCommand[] {
  return [
    { command: "pnpm", args: ["install", "--lockfile-only", "--ignore-scripts", ...controls] },
    { command: "pnpm", args: ["install", "--frozen-lockfile", ...controls] },
  ];
}

function fail(message: string): never { throw new Error(message); }
function hash(bytes: string | Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function assertEffectiveProfileDependencyLock(value: unknown): asserts value is EffectiveProfileDependencyLock {
  const bad = () => fail("The effective dependency lock receipt is invalid; repair the Profile before continuing");
  if (!object(value) || value.schemaVersion !== 1 || !object(value.packageManager) || value.packageManager.name !== "pnpm" ||
    typeof value.packageManager.version !== "string" || !exactVersion.test(value.packageManager.version) ||
    !["manifestHash", "configurationHash", "environmentHash"].every(key => typeof value[key] === "string" && digestPattern.test(value[key])) ||
    !["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"].includes(String(value.platform)) ||
    typeof value.arch !== "string" || !/^[a-z0-9_]{1,32}$/.test(value.arch) || typeof value.nodeAbi !== "string" || !/^\d{1,8}$/.test(value.nodeAbi) ||
    typeof value.hooksPresent !== "boolean" || !["new", "reused"].includes(String(value.resolution)) ||
    !Array.isArray(value.externalFiles) || value.externalFiles.length > 64 || !object(value.lock)) bad();
  // Narrowing is intentionally explicit: unknown state is never trusted as a receipt.
  const receipt = value as unknown as EffectiveProfileDependencyLock, lock = receipt.lock;
  if (lock.schemaVersion !== 1 || lock.format !== "pnpm" || lock.lockfileVersion !== "9.0" || !digestPattern.test(lock.hash) ||
    ![lock.packages, lock.snapshots, lock.directDependencies, lock.registryIntegrity, lock.declaredIntegrityVerified, lock.unverifiedGitHubBuilds]
      .every(count => Number.isSafeInteger(count) && count >= 0 && count <= 300_000) ||
    lock.declaredIntegrityVerified > lock.directDependencies || lock.registryIntegrity + lock.unverifiedGitHubBuilds > lock.packages) bad();
  const paths = new Set<string>();
  for (const file of receipt.externalFiles) {
    if (!object(file) || typeof file.path !== "string" || !isAbsolute(file.path) || file.path.length > 8192 || file.path.includes("\0") ||
      paths.has(file.path) || file.hash !== null && (typeof file.hash !== "string" || !digestPattern.test(file.hash))) bad();
    paths.add(file.path);
  }
}

async function manifestAt(directory: string): Promise<Record<string, unknown>> {
  try {
    const path = join(directory, "package.json"), info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(manifest)) throw new Error();
    return manifest;
  } catch { fail("The staged Profile manifest is missing or invalid"); }
}
function manifestHash(manifest: Record<string, unknown>, hooksPresent: boolean): string {
  const copy = structuredClone(manifest);
  // Ordering and enable/disable choices do not change the installed graph. Hooks
  // can read these values, so hooked Profiles deliberately bind the whole file.
  if (!hooksPresent && object(copy.dsh) && object(copy.dsh.profile)) delete copy.dsh.profile.bundles;
  return hash(canonical(copy));
}
function configurationFile(file: ProfileFileEntry, hooksPresent: boolean): boolean {
  const name = file.relativePath;
  return name !== ".git" && !name.startsWith(".git/") && name !== "package.json" && name !== "pnpm-lock.yaml" &&
    (hooksPresent || name !== "cordis.patch.yml");
}
async function configuration(directory: string, hooksPresent: boolean): Promise<ProfileFileEntry[]> {
  return (await scanProfileFiles(directory)).filter(file => configurationFile(file, hooksPresent));
}
async function externalHash(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    // External user config may be a symlink; hash its resolved content as used by pnpm.
    if (!info.isFile() && !info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error();
    const bytes = await readFile(path);
    if (bytes.length > 8 * 1024 * 1024) throw new Error();
    return hash(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("A package-manager configuration file cannot be inspected safely");
  }
}
function environmentHash(environment: NodeJS.ProcessEnv): string {
  const env = stripStoredInputEnvironment(environment);
  return hash(canonical(Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:npm_config_|pnpm_|npm_token$|node_auth_token$)/i.test(key)))));
}

async function invoke(pm: PreparedProfilePackageManager, directory: string, args: string[], phase: string, capture = false): Promise<string> {
  await pm.assertUnchanged();
  const output = await new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, [pm.executable, ...args], { cwd: directory, env: pm.environment,
      stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"], windowsHide: true });
    const chunks: Buffer[] = []; let bytes = 0, finished = false;
    const timeout = setTimeout(() => { child.kill(); end(new Error(`Profile dependency ${phase} timed out; the active Profile was not changed`)); }, 120_000);
    const end = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timeout);
      if (error) reject(error); else done(Buffer.concat(chunks).toString("utf8"));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill(); end(new Error("Package-manager configuration output exceeded the inspection limit")); }
      else chunks.push(chunk);
    });
    child.once("error", () => end(new Error(`Profile dependency ${phase} could not start; the active Profile was not changed`)));
    child.once("close", (code, signal) => end(code === 0 ? undefined : new Error(`Profile dependency ${phase} failed (${signal ?? `exit ${String(code)}`}); check registry access, dependency integrity and package-manager configuration before retrying`)));
  });
  await pm.assertUnchanged();
  return output;
}

async function configurationInputs(pm: PreparedProfilePackageManager, directory: string): Promise<{ externalFiles: EffectiveProfileDependencyLock["externalFiles"]; hooksPresent: boolean }> {
  let config: Record<string, unknown>;
  try {
    const result: unknown = JSON.parse(await invoke(pm, directory, ["config", "list", "--json", ...controls], "configuration inspection", true));
    if (!object(result)) throw new Error(); config = result;
  } catch { fail("Package-manager configuration could not be inspected; no dependency installation was accepted"); }
  const paths = new Set<string>();
  for (const key of ["userconfig", "globalconfig", "npm-globalconfig", "global-pnpmfile", "pnpmfile"]) {
    const value = config[key];
    if (value === undefined || value === null || value === false) continue;
    if (typeof value !== "string" || !value.length || value.length > 8192 || value.includes("\0")) fail("Unsupported package-manager configuration file setting");
    paths.add(resolve(directory, value));
  }
  // Detect addition/removal as well as mutation of the default local hook.
  const localHook = join(directory, ".pnpmfile.cjs");
  const hooksPresent = config["pnpmfile"] !== undefined || config["global-pnpmfile"] !== undefined || await externalHash(localHook) !== null;
  // A local symlink's text alone does not bind the config bytes read by pnpm.
  // Capture external targets for known config/hook entries as well.
  for (const path of [...paths, join(directory, ".npmrc"), localHook]) {
    try { if ((await lstat(path)).isSymbolicLink()) paths.add(await realpath(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Local files travel with the Profile and use relative paths in configurationHash.
  const externalFiles = await Promise.all([...paths].filter(path => {
    const part = relative(directory, path);
    return part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part);
  })
    .sort().map(async path => ({ path, hash: await externalHash(path) })));
  return { externalFiles, hooksPresent };
}

export async function verifyEffectiveProfileDependencyLock(directory: string, receipt: EffectiveProfileDependencyLock): Promise<void> {
  assertEffectiveProfileDependencyLock(receipt);
  if (receipt.platform !== process.platform || receipt.arch !== process.arch || receipt.nodeAbi !== process.versions.modules) {
    fail("The dependency installation targets a different platform or Node ABI; reinstall it before running");
  }
  let bytes: Buffer;
  try {
    const path = join(directory, "pnpm-lock.yaml"), info = await lstat(path);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error();
    bytes = await readFile(path);
  } catch { fail("The recorded native dependency lock is missing or unreadable; repair the Profile before running"); }
  if (hash(bytes) !== receipt.lock.hash || manifestHash(await manifestAt(directory), receipt.hooksPresent) !== receipt.manifestHash ||
    hash(canonical(await configuration(directory, receipt.hooksPresent))) !== receipt.configurationHash) {
    fail("The dependency lock or its Profile inputs changed; repair the Profile before running");
  }
  for (const file of receipt.externalFiles) if (await externalHash(file.path) !== file.hash) {
    fail("Recorded package-manager configuration changed; repair the Profile before running");
  }
}

export async function installLockedProfileDependencies(options: {
  directory: string;
  dshHome: string;
  dependencies: ResolvedProfileBundle[];
  previousDirectory?: string;
  previousReceipt?: EffectiveProfileDependencyLock;
}): Promise<{ receipt: EffectiveProfileDependencyLock; assertUnchanged: () => Promise<void> }> {
  const directory = resolve(options.directory), manifest = await manifestAt(directory);
  const pm = await prepareProfilePackageManager({ manifest, dshHome: options.dshHome });
  const { externalFiles, hooksPresent } = await configurationInputs(pm, directory);
  const beforeFiles = await configuration(directory, hooksPresent), expectedManifest = manifestHash(manifest, hooksPresent);
  const expectedEnvironment = environmentHash(pm.environment);
  const checkInputs = async () => {
    if (manifestHash(await manifestAt(directory), hooksPresent) !== expectedManifest) fail("Package installation changed the Profile manifest; the staged installation was rejected");
    const files = await configuration(directory, hooksPresent), indexed = new Map(files.map(file => [file.relativePath, file]));
    for (const before of beforeFiles) if (canonical(indexed.get(before.relativePath)) !== canonical(before)) {
      fail("Package installation changed an existing Profile input; the staged installation was rejected");
    }
    // New build output is allowed, but newly introduced config must not alter the next phase.
    const priorNames = new Set(beforeFiles.map(file => file.relativePath));
    if (files.some(file => !priorNames.has(file.relativePath) && /(?:^|\/)(?:\.npmrc|\.pnpmfile\.[cm]?js|pnpm-workspace\.yaml)$/.test(file.relativePath))) {
      fail("Package installation introduced package-manager configuration; the staged installation was rejected");
    }
    for (const file of externalFiles) if (await externalHash(file.path) !== file.hash) fail("External package-manager configuration changed during installation");
  };
  let reused = false;
  const previous = options.previousReceipt;
  if (previous && options.previousDirectory) {
    // Local edits can legitimately change manifest/config inputs. Only an intact
    // previous installation can seed a new stage; otherwise resolve a fresh graph.
    assertEffectiveProfileDependencyLock(previous);
    let intact = false;
    try { await verifyEffectiveProfileDependencyLock(options.previousDirectory, previous); intact = true; }
    catch { /* The old lock is not reused. The active Profile remains untouched. */ }
    if (intact && previous.packageManager.version === pm.version && previous.manifestHash === expectedManifest &&
      previous.configurationHash === hash(canonical(beforeFiles)) && previous.environmentHash === expectedEnvironment &&
      canonical(previous.externalFiles) === canonical(externalFiles) && previous.hooksPresent === hooksPresent) {
      await writeFile(join(directory, "pnpm-lock.yaml"), await readFile(join(options.previousDirectory, "pnpm-lock.yaml")), { mode: 0o600 });
      reused = true;
    }
  }
  if (!reused) await invoke(pm, directory, buildProfileDependencyCommands()[0]!.args, "resolution");
  await checkInputs();
  const readLock = async () => {
    const path = join(directory, "pnpm-lock.yaml"), info = await lstat(path);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) fail("The package manager did not produce a bounded regular dependency lock");
    return readFile(path);
  };
  const lock = validateProfileDependencyLock({ bytes: await readLock(), manifest, dependencies: options.dependencies });
  await invoke(pm, directory, buildProfileDependencyCommands()[1]!.args, "frozen installation");
  await checkInputs();
  if (hash(await readLock()) !== lock.hash) fail("Frozen installation changed the dependency lock; the staged installation was rejected");
  const receipt: EffectiveProfileDependencyLock = { schemaVersion: 1, packageManager: { name: "pnpm", version: pm.version }, lock,
    manifestHash: expectedManifest, configurationHash: hash(canonical(await configuration(directory, hooksPresent))),
    environmentHash: expectedEnvironment, externalFiles, platform: process.platform, arch: process.arch,
    nodeAbi: process.versions.modules!, hooksPresent, resolution: reused ? "reused" : "new" };
  const assertUnchanged = async () => { await pm.assertUnchanged(); await verifyEffectiveProfileDependencyLock(directory, receipt); };
  await assertUnchanged();
  return { receipt, assertUnchanged };
}

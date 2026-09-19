import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { exactSemverSchema } from "@dsh-plugin-hub/schemas";
import { stripStoredInputEnvironment } from "./profile-inputs.js";

export const DEFAULT_PROFILE_PACKAGE_MANAGER_VERSION = "10.33.0";
const versionArguments = ["--version", "--config.manage-package-manager-versions=false",
  "--config.package-manager-strict=true", "--config.package-manager-strict-version=true"];

export class ProfilePackageManagerError extends Error {
  readonly phase = "profile-package-manager";
  constructor(message: string) { super(message); this.name = "ProfilePackageManagerError"; }
}

export interface PreparedProfilePackageManager {
  version: string;
  /** Verified JavaScript entry; invoke with process.execPath, never through a shim. */
  executable: string;
  environment: NodeJS.ProcessEnv;
  /** Rechecks identity and all regular files, paths and permissions in the pnpm package. */
  assertUnchanged: () => Promise<void>;
}

function fail(message: string): never { throw new ProfilePackageManagerError(message); }
function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function versionFor(manifest: { packageManager?: unknown }): string {
  if (manifest.packageManager === undefined) return DEFAULT_PROFILE_PACKAGE_MANAGER_VERSION;
  if (typeof manifest.packageManager !== "string" || !manifest.packageManager.startsWith("pnpm@")) {
    fail("Profile packageManager must declare an exact pnpm version");
  }
  const version = manifest.packageManager.slice(5);
  if (version.includes("+")) fail("Hash-decorated packageManager versions are not supported; use a verified exact pnpm version without a suffix");
  if (version.length > 100 || !exactSemverSchema.safeParse(version).success) fail("Profile packageManager must declare an exact pnpm version");
  return version;
}

function pinnedEnvironment(input: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env = stripStoredInputEnvironment(input);
  const controls: NodeJS.ProcessEnv = {
    npm_config_manage_package_manager_versions: "false",
    npm_config_package_manager_strict: "true",
    npm_config_package_manager_strict_version: "true",
    DSH_HOME: home,
  };
  const keys = new Set(Object.keys(controls).map(key => key.toUpperCase()));
  for (const key of Object.keys(env)) if (keys.has(key.toUpperCase())) delete env[key];
  return { ...env, ...controls };
}

async function realDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("Package-manager storage must use real directories");
}

async function inspectPackage(directory: string, version: string): Promise<{ directory: string; executable: string }> {
  await realDirectory(directory);
  const root = await realpath(directory);
  const metadataPath = join(root, "package.json");
  if (!(await lstat(metadataPath)).isFile()) fail("Pinned pnpm metadata must be a regular file");
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); }
  catch { fail("Pinned pnpm package metadata is unreadable"); }
  if (metadata?.name !== "pnpm" || metadata.version !== version) fail("Pinned pnpm package identity or exact version does not match");
  const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pnpm;
  if (typeof bin !== "string" || isAbsolute(bin) || !inside(root, resolve(root, bin)) || !/\.[cm]?js$/.test(bin)) {
    fail("Pinned pnpm must declare a JavaScript executable inside its package");
  }
  const entry = resolve(root, bin), executable = await realpath(entry);
  if (!inside(root, executable) || !(await lstat(entry)).isFile()) fail("Pinned pnpm executable must be a regular file inside its package");
  return { directory: root, executable };
}

/** Full package-tree fingerprint, including bundled modules. No user config or Node binary is claimed. */
async function fingerprint(directory: string): Promise<string> {
  const digest = createHash("sha256");
  let files = 0, bytes = 0;
  async function visit(path: string): Promise<void> {
    const info = await lstat(path), name = relative(directory, path).split(sep).join("/");
    if (++files > 20000) fail("Pinned pnpm package exceeds the inspection file limit");
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail("Pinned pnpm package cannot contain symlinks or special files");
    digest.update(JSON.stringify([name, info.mode, info.isDirectory() ? "directory" : "file"]));
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else {
      bytes += info.size;
      if (bytes > 64 * 1024 * 1024) fail("Pinned pnpm package exceeds the inspection byte limit");
      const body = await readFile(path);
      if (body.length !== info.size) fail("Pinned pnpm package changed while being inspected");
      digest.update(JSON.stringify(body.length)); digest.update(body);
    }
  }
  await visit(directory);
  return digest.digest("hex");
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  return env[Object.keys(env).sort().find(key => key.toUpperCase() === name.toUpperCase()) ?? name];
}

/** Discover package files only. Volta/Corepack/PATH shims are never executed as pnpm. */
async function findInstalledPackage(version: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const path of (envValue(env, "PATH") ?? "").split(delimiter).filter(isAbsolute).slice(0, 128)) {
    for (const name of ["pnpm", "pnpm.cjs", "pnpm.cmd"]) {
      try {
        let parent = dirname(await realpath(join(path, name)));
        for (let depth = 0; depth < 5; depth++) {
          candidates.add(parent);
          const next = dirname(parent); if (next === parent) break; parent = next;
        }
      } catch (error) { if (!missing(error)) throw error; }
    }
    candidates.add(join(path, "node_modules", "pnpm"));
    candidates.add(resolve(path, "..", "lib", "node_modules", "pnpm"));
    candidates.add(resolve(path, "..", "node_modules", "pnpm"));
  }
  const home = envValue(env, "HOME") ?? envValue(env, "USERPROFILE");
  const volta = envValue(env, "VOLTA_HOME") ?? (home ? join(home, ".volta") : undefined);
  if (volta) candidates.add(join(volta, "tools", "image", "packages", "pnpm", "lib", "node_modules", "pnpm"));
  for (const candidate of candidates) {
    let metadata;
    try { metadata = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")); }
    catch (error) { if (missing(error) || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue; throw error; }
    if (metadata?.name === "pnpm" && metadata.version === version) {
      await inspectPackage(candidate, version);
      return candidate;
    }
  }
  return undefined;
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, label: string): Promise<string> {
  return new Promise((done, reject) => {
    execFile(executable, args, { cwd, env, timeout: 120000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      if (error) reject(new ProfilePackageManagerError(`${label} failed; no package-manager cache was accepted`));
      else done(stdout);
    });
  });
}

async function npmCommand(env: NodeJS.ProcessEnv): Promise<{ executable: string; args: string[] }> {
  if (process.platform !== "win32") return { executable: "npm", args: [] };
  // Windows .cmd wrappers require a shell; locate npm's Node entry instead.
  const paths = [dirname(process.execPath), ...(envValue(env, "PATH") ?? "").split(delimiter).filter(isAbsolute)];
  for (const directory of paths) {
    const entry = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    try { if ((await lstat(entry)).isFile()) return { executable: process.execPath, args: [entry] }; }
    catch (error) { if (!missing(error)) throw error; }
  }
  fail("Preparing pnpm requires npm's Node executable; install the selected exact pnpm version and retry");
}

export async function prepareProfilePackageManager(options: {
  manifest: { packageManager?: unknown };
  dshHome: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PreparedProfilePackageManager> {
  const version = versionFor(options.manifest);
  // Validate provenance before filesystem mutation or process creation.
  const initialEnv = pinnedEnvironment(options.env ?? process.env, resolve(options.dshHome));
  await realDirectory(resolve(options.dshHome), true);
  const home = await realpath(resolve(options.dshHome));
  const environment = pinnedEnvironment(initialEnv, home);
  const parents = [home, join(home, ".hub"), join(home, ".hub", "package-managers"), join(home, ".hub", "package-managers", "pnpm")];
  for (const directory of parents) await realDirectory(directory, true);
  const root = parents.at(-1)!, target = join(root, version);
  const cachedPackage = join(target, "node_modules", "pnpm");
  const inspectCache = async () => {
    for (const directory of [...parents, target, join(target, "node_modules")]) await realDirectory(directory);
    return inspectPackage(cachedPackage, version);
  };
  let selected: string | undefined;
  try { await realDirectory(target); await inspectCache(); selected = cachedPackage; }
  catch (error) {
    if (!missing(error)) throw error;
    // An existing incomplete cache must never be overwritten or silently bypassed.
    try { await lstat(target); fail("Pinned pnpm cache is incomplete; repair it before retrying"); }
    catch (targetError) { if (!missing(targetError)) throw targetError; }
  }
  if (!selected) selected = await findInstalledPackage(version, environment);
  let createdCacheIdentity: { dev: number; ino: number } | undefined;
  try {
  if (!selected) {
    const lockPath = join(root, `${version}.lock`);
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("Another operation is preparing this exact pnpm version; retry when it completes");
      throw error;
    }
    const stage = join(root, `.prepare-${randomUUID()}`);
    try {
      let exists = false;
      try { await lstat(target); exists = true; } catch (error) { if (!missing(error)) throw error; }
      if (exists) await inspectCache();
      else {
        await mkdir(stage, { mode: 0o700 });
        await writeFile(join(stage, "package.json"), JSON.stringify({ name: "dsh-hub-package-manager", version: "0.0.0", private: true }), { mode: 0o600 });
        const npm = await npmCommand(environment);
        await run(npm.executable, [...npm.args, "install", "--prefix", stage, "--global=false", "--workspaces=false", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", `pnpm@${version}`], stage, environment, "Pinned pnpm preparation");
        await realDirectory(join(stage, "node_modules"));
        const inspected = await inspectPackage(join(stage, "node_modules", "pnpm"), version);
        const before = await fingerprint(inspected.directory);
        const installedVersion = (await run(process.execPath, [inspected.executable, ...versionArguments], stage, environment, "Pinned pnpm version verification")).trim();
        if (installedVersion !== version) fail("Pinned pnpm executable reported a different exact version");
        if (await fingerprint(inspected.directory) !== before) fail("Pinned pnpm package changed during preparation");
        for (const directory of parents) await realDirectory(directory);
        const stageIdentity = await lstat(stage);
        await rename(stage, target);
        createdCacheIdentity = { dev: stageIdentity.dev, ino: stageIdentity.ino };
        await inspectCache();
      }
      selected = cachedPackage;
    } finally {
      await rm(stage, { recursive: true, force: true });
      await lock.close(); await rm(lockPath, { force: true });
    }
  }
  const chosen = selected;
  const inspected = await inspectPackage(chosen, version), expected = await fingerprint(inspected.directory);
  const assertUnchanged = async () => {
    if (chosen === cachedPackage) await inspectCache();
    const current = await inspectPackage(chosen, version);
    if (current.directory !== inspected.directory || current.executable !== inspected.executable || await fingerprint(current.directory) !== expected) {
      fail("Pinned pnpm package changed after preparation; abort this installation and retry");
    }
  };
  const actualVersion = (await run(process.execPath, [inspected.executable, ...versionArguments], root, environment, "Pinned pnpm version verification")).trim();
  if (actualVersion !== version) fail("Pinned pnpm executable reported a different exact version");
  await assertUnchanged();
  return { version, executable: inspected.executable, environment, assertUnchanged };
  } catch (error) {
    // Only remove the directory published by this call. Existing caches and a
    // replacement directory from another operation must never be deleted.
    if (createdCacheIdentity) {
      try {
        const current = await lstat(target);
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === createdCacheIdentity.dev && current.ino === createdCacheIdentity.ino) {
          await rm(target, { recursive: true, force: true });
        }
      } catch (cleanupError) { if (!missing(cleanupError)) throw cleanupError; }
    }
    throw error;
  }
}

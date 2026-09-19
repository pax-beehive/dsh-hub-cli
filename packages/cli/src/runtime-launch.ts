import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { exactSemverSchema } from "@dsh-plugin-hub/schemas";
import { stripStoredInputEnvironment } from "./profile-inputs.js";

export class RuntimePreparationError extends Error {
  readonly phase = "runtime-preparation";
  constructor(message: string, readonly exitCode?: number | null) { super(message); this.name = "RuntimePreparationError"; }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Inspect only the requested installation prefix, never cwd, PATH or global packages. */
export async function inspectPinnedRuntime(prefix: string, version: string): Promise<string> {
  exactSemverSchema.parse(version);
  const root = await realpath(prefix);
  const packageDirectory = await realpath(join(root, "node_modules", "@deepseek-ai", "dsh"));
  if (!within(root, packageDirectory)) throw new RuntimePreparationError("Pinned DSH runtime package resolves outside its installation");
  let manifest;
  try { manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")); }
  catch { throw new RuntimePreparationError("Pinned DSH runtime package metadata is unreadable"); }
  if (manifest.name !== "@deepseek-ai/dsh" || manifest.version !== version) {
    throw new RuntimePreparationError("Pinned DSH runtime package identity or exact version does not match");
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
  if (typeof bin !== "string" || isAbsolute(bin) || !within(packageDirectory, resolve(packageDirectory, bin))) {
    throw new RuntimePreparationError("Pinned DSH runtime has an invalid executable declaration");
  }
  const executable = await realpath(resolve(packageDirectory, bin));
  if (!within(packageDirectory, executable) || !(await lstat(executable)).isFile()) {
    throw new RuntimePreparationError("Pinned DSH runtime executable must be a file inside its package");
  }
  return executable;
}

async function realDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new RuntimePreparationError("Pinned runtime storage must use real directories");
}

/** Prepare with external environment only, excluding inherited stored Profile inputs. */
export async function preparePinnedRuntime(version: string, dshHome: string): Promise<string> {
  const environment = stripStoredInputEnvironment(process.env);
  exactSemverSchema.parse(version);
  const home = resolve(dshHome);
  const root = join(home, ".hub", "runtimes");
  for (const directory of [home, join(home, ".hub"), root]) await realDirectory(directory);
  const target = join(root, version);
  let exists = false;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RuntimePreparationError("Pinned runtime storage must use real directories");
    exists = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (exists) return inspectPinnedRuntime(target, version);
  const lockPath = join(root, `${version}.lock`);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RuntimePreparationError("Another operation is preparing this exact DSH runtime; retry when it completes");
    throw error;
  }
  const stage = join(root, `.prepare-${randomUUID()}`);
  try {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new RuntimePreparationError("Pinned runtime storage must use real directories");
      return await inspectPinnedRuntime(target, version);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(stage, { mode: 0o700 });
    await writeFile(join(stage, "package.json"), JSON.stringify({ private: true, name: "dsh-hub-local-runtime", version: "0.0.0" }), { mode: 0o600 });
    await new Promise<void>((done, fail) => {
      const child = spawn("npm", ["install", "--prefix", stage, "--global=false", "--workspaces=false", "--save-exact", "--no-audit", "--no-fund", "--loglevel=error", `@deepseek-ai/dsh@${version}`], {
        cwd: stage, env: { ...environment, DSH_HOME: home }, stdio: "ignore",
      });
      child.once("error", () => fail(new RuntimePreparationError("Unable to start npm while preparing the pinned DSH runtime")));
      child.once("exit", (code, signal) => code === 0 ? done() : fail(new RuntimePreparationError(`Pinned DSH runtime preparation failed (${signal ?? `exit ${String(code)}`})`, code)));
    });
    await inspectPinnedRuntime(stage, version);
    await rename(stage, target);
    return await inspectPinnedRuntime(target, version);
  } finally {
    await rm(stage, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

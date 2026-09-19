import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import { dshHomePath, profileDirectory } from "./index.js";

const maxValueBytes = 64 * 1024;
const maxStoreBytes = 1024 * 1024;
const maxStoredInputMarkerBytes = 64 * 1024;
const maxStoredInputMarkerKeys = 1024;
/** Private process provenance only; never include this marker in plans or tool results. */
export const DSH_HUB_STORED_INPUT_KEYS = "DSH_HUB_STORED_INPUT_KEYS";
const reservedKeys = new Set([
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SHELL", "COMSPEC",
  "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "CDPATH", "PWD", "OLDPWD", "TMP", "TEMP", "TMPDIR",
  "SYSTEMROOT", "WINDIR", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "DSH_HOME", "DSH_HUB_TOKEN", "DSH_HUB_API_URL", "DO_NOT_TRACK", "CI",
]);

function processControlled(key: string): boolean {
  return reservedKeys.has(key) || /^(?:NODE_|NPM_|PNPM_|COREPACK_|DSH_HUB_|LD_|DYLD_|XDG_|GIT_)/.test(key);
}

function storedInputMarkerKeys(value: unknown): string[] {
  const invalid = () => new Error("Invalid stored-input environment marker; use a clean trusted environment and retry");
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxStoredInputMarkerBytes) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 2
    || !Object.hasOwn(parsed, "v") || !Object.hasOwn(parsed, "keys")) throw invalid();
  const marker = parsed as { v?: unknown; keys?: unknown };
  if (marker.v !== 1 || !Array.isArray(marker.keys) || marker.keys.length > maxStoredInputMarkerKeys) throw invalid();
  const seen = new Set<string>();
  for (const key of marker.keys) {
    if (typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key) || processControlled(key) || seen.has(key)) throw invalid();
    seen.add(key);
  }
  return [...seen];
}

/**
 * Copy an inherited environment and remove inputs attributed to an outer
 * Profile's store. Absence of a marker preserves legacy inherited behavior;
 * provenance cannot be inferred for older hosts. Windows case aliases are
 * removed together; POSIX input names retain their case-sensitive semantics.
 * No key names or values appear in errors. The platform seam defaults to the
 * current process and lets callers test Windows spawn behavior without a child.
 */
export function stripStoredInputEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const copy = { ...env };
  const markers = Object.keys(copy).filter(key => key.toUpperCase() === DSH_HUB_STORED_INPUT_KEYS);
  if (!markers.length) return copy;
  if (markers.length !== 1) throw new Error("Invalid stored-input environment marker; use a clean trusted environment and retry");
  const removed = new Set(storedInputMarkerKeys(copy[markers[0]!]));
  delete copy[markers[0]!];
  for (const key of Object.keys(copy)) if (removed.has(platform === "win32" ? key.toUpperCase() : key)) delete copy[key];
  return copy;
}

function inheritedInputEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const inherited = stripStoredInputEnvironment(env, platform);
  if (platform !== "win32") return inherited;
  // Match Node's Windows child_process selection: lexicographically first name
  // wins for each case-insensitive key, even if that first value is undefined.
  // Canonical names prevent an injected uppercase stored value competing with
  // an external mixed-case value when the environment is spawned later.
  const normalized: NodeJS.ProcessEnv = {}, seen = new Set<string>();
  for (const key of Object.keys(inherited).sort()) {
    const name = key.toUpperCase();
    if (seen.has(name)) continue;
    seen.add(name); normalized[name] = inherited[key];
  }
  return normalized;
}

export function assertProfileInputKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("Input keys must use uppercase letters, digits, and underscores");
  if (processControlled(key)) {
    throw new Error(`Input key ${key} is reserved for process configuration`);
  }
}

export function assertProfileInputValue(value: string): void {
  if (value.includes("\0")) throw new Error("Input values must not contain NUL bytes");
  if (Buffer.byteLength(value, "utf8") > maxValueBytes) throw new Error("Input value exceeds the 64 KiB limit");
}

export interface ProfileInputStatus {
  key: string;
  configured: boolean;
  source: "environment" | "stored" | "runtime" | "missing";
  declared: boolean;
  configurable: boolean;
  required: boolean;
  secret: boolean;
}

interface InputStore { schemaVersion: 1; values: Record<string, string> }

function paths(profile: string, dshHome?: string) {
  profileDirectory(profile, dshHome); // use the same target validation as every Profile command
  const home = dshHomePath(dshHome);
  const hub = join(home, ".hub");
  const directory = join(hub, "inputs");
  return { home, hub, directory, file: join(directory, `${profile}.json`) };
}

async function inspectDirectory(path: string, privateDirectory: boolean): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Profile input storage must use real directories, not symbolic links");
  if (privateDirectory && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Profile input directory permissions are too broad; run chmod 700 '${path.replaceAll("'", "'\\''")}'`);
  }
  return true;
}

async function prepareDirectory(profile: string, dshHome: string | undefined, create: boolean): Promise<boolean> {
  const location = paths(profile, dshHome);
  for (const path of [location.home, location.hub, location.directory]) {
    if (!await inspectDirectory(path, path === location.directory)) {
      if (!create) return false;
      await mkdir(path, { recursive: true, mode: 0o700 });
      await inspectDirectory(path, path === location.directory);
    }
  }
  return true;
}

async function readStore(profile: string, dshHome?: string): Promise<InputStore> {
  if (!await prepareDirectory(profile, dshHome, false)) return { schemaVersion: 1, values: {} };
  const { file } = paths(profile, dshHome);
  let handle;
  try {
    // O_NOFOLLOW closes the final-component symlink race on POSIX.
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Profile input storage must be a regular file, not a symbolic link");
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const actual = await handle.stat();
    if (actual.size > maxStoreBytes) throw new Error("Profile input storage exceeds the 1 MiB limit");
    if (process.platform !== "win32" && (actual.mode & 0o077) !== 0) {
      throw new Error(`Profile input file permissions are too broad; run chmod 600 '${file.replaceAll("'", "'\\''")}'`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error("Profile input storage is invalid JSON; values were not loaded"); }
    const store = parsed as Partial<InputStore> | null;
    if (!store || store.schemaVersion !== 1 || !store.values || typeof store.values !== "object" || Array.isArray(store.values)) {
      throw new Error("Profile input storage has an unsupported format");
    }
    for (const [key, value] of Object.entries(store.values)) {
      assertProfileInputKey(key);
      if (typeof value !== "string") throw new Error("Profile input storage contains a non-string value");
      assertProfileInputValue(value);
    }
    return store as InputStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, values: {} };
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Profile input storage must not be a symbolic link");
    throw error;
  } finally { await handle?.close(); }
}

async function mutateStore(profile: string, dshHome: string | undefined, update: (values: Record<string, string>) => void): Promise<void> {
  await prepareDirectory(profile, dshHome, true);
  const { file } = paths(profile, dshHome);
  const lockPath = `${file}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another operation is updating these Profile inputs; retry when it completes");
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const store = await readStore(profile, dshHome);
    update(store.values);
    const serialized = JSON.stringify(store);
    if (Buffer.byteLength(serialized) > maxStoreBytes) throw new Error("Profile input storage exceeds the 1 MiB limit");
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${serialized}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await prepareDirectory(profile, dshHome, false);
    // Recheck that a concurrently replaced target is not a symlink before the atomic swap.
    await readStore(profile, dshHome);
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function setProfileInput(profile: string, key: string, value: string, dshHome?: string): Promise<void> {
  assertProfileInputKey(key);
  assertProfileInputValue(value);
  await mutateStore(profile, dshHome, (values) => { values[key] = value; });
}

export async function unsetProfileInput(profile: string, key: string, dshHome?: string): Promise<void> {
  assertProfileInputKey(key);
  await mutateStore(profile, dshHome, (values) => { delete values[key]; });
}

export function missingProfileInputMessage(profile: string, keys: string[]): string {
  return `Missing required local Profile inputs: ${keys.join(", ")}. Configure locally: ${keys.map((key) =>
    processControlled(key) ? `${key} is process-controlled; provide it through your trusted launch environment` :
      `dsh-hub profile inputs set ${key} --profile ${profile}`).join("; ")} (configurable values also accept --stdin)`;
}

export async function resolveProfileInputs(options: {
  profile: string;
  declarations: HubProfileVersion["inputs"];
  dshHome?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to this process; used to test platform-specific environment semantics. */
  platform?: NodeJS.Platform;
}): Promise<{ env: NodeJS.ProcessEnv; statuses: ProfileInputStatus[]; missing: string[] }> {
  const inherited = inheritedInputEnvironment(options.env ?? process.env, options.platform ?? process.platform);
  const env = { ...inherited };
  env.DSH_HOME = dshHomePath(options.dshHome ?? env.DSH_HOME);
  const store = options.declarations.length ? await readStore(options.profile, env.DSH_HOME) : { schemaVersion: 1 as const, values: {} };
  const storedKeys = new Set<string>();
  const statuses = options.declarations.map((input) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(input.key)) throw new Error("Release contains an invalid input key");
    const controlled = processControlled(input.key);
    const source: ProfileInputStatus["source"] = input.key === "DSH_HOME" ? "runtime" : inherited[input.key] !== undefined ? "environment" :
      controlled ? "missing" :
      store.values[input.key] !== undefined ? "stored" : "missing";
    if (source === "stored") { env[input.key] = store.values[input.key]; storedKeys.add(input.key); }
    return { key: input.key, configured: Boolean(env[input.key]), source, declared: true,
      configurable: !controlled, required: input.required, secret: input.secret };
  });
  if (storedKeys.size) {
    const marker = JSON.stringify({ v: 1, keys: [...storedKeys].sort() });
    storedInputMarkerKeys(marker); // Apply the same bounded contract to generated provenance.
    env[DSH_HUB_STORED_INPUT_KEYS] = marker;
  }
  return { env, statuses, missing: statuses.filter((item) => item.required && !item.configured).map((item) => item.key) };
}

export async function listProfileInputs(options: {
  profile: string; declarations?: HubProfileVersion["inputs"]; dshHome?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
}): Promise<ProfileInputStatus[]> {
  const declarations = options.declarations ?? [];
  const resolved = await resolveProfileInputs({ ...options, declarations });
  const declared = new Set(declarations.map((input) => input.key));
  const store = await readStore(options.profile, resolved.env.DSH_HOME);
  const env = inheritedInputEnvironment(options.env ?? process.env, options.platform ?? process.platform);
  const orphaned = Object.keys(store.values).filter((key) => !declared.has(key)).sort().map((key) => ({
    key, configured: Boolean(env[key] !== undefined ? env[key] : store.values[key]),
    source: env[key] !== undefined ? "environment" as const : "stored" as const,
    declared: false, configurable: true, required: false, secret: true,
  }));
  return [...resolved.statuses, ...orphaned];
}

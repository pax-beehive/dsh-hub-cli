import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { exactSemverSchema } from "@dsh-plugin-hub/schemas";
import type { ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { dshHomePath, profileDirectory } from "./index.js";
import type { ProfileJsonObject } from "./profile-merge.js";
import { inspectPinnedRuntime, RuntimePreparationError } from "./runtime-launch.js";

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function object(value: unknown): value is ProfileJsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hash(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

export interface LocalRuntimeDefaults {
  runtimeVersion: string;
  defaults: ResolvedProfileBundle[];
  builtins: ResolvedProfileBundle[];
  manifest: ProfileJsonObject;
  patch: string;
  fingerprint: string;
}

function within(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function literalBundles(value: string): string[] {
  // Only a string-array literal is accepted. No imports, identifiers, templates,
  // expressions, getters or runtime code are evaluated during a preview.
  if (!/^\[\s*(?:"[A-Za-z0-9@/._-]+"\s*(?:,\s*"[A-Za-z0-9@/._-]+"\s*)*,?\s*)?\]$/.test(value)) throw new Error();
  const parsed = JSON.parse(value.replace(/,\s*\]$/, "]")) as string[];
  if (!parsed.length || parsed.some(name => !packageNamePattern.test(name)) || new Set(parsed).size !== parsed.length) throw new Error();
  return parsed;
}

/** Inspect private cached metadata and strict static template literals; never execute runtime code. */
export async function inspectLocalRuntimeDefaults(options: { profile: string; runtimeVersion: string; dshHome?: string; bundleNames?: string[] }): Promise<LocalRuntimeDefaults> {
  profileDirectory(options.profile, options.dshHome);
  if (!exactSemverSchema.safeParse(options.runtimeVersion).success) throw new RuntimePreparationError("Local Profile preparation requires --runtime-version <exact-semver>");
  const prefix = join(dshHomePath(options.dshHome), ".hub", "runtimes", options.runtimeVersion);
  try { await inspectPinnedRuntime(prefix, options.runtimeVersion); }
  catch { throw new RuntimePreparationError(`The exact local runtime is not ready. Run dsh-hub runtime prepare --runtime-version ${options.runtimeVersion}, then repeat the preview`); }
  try {
    const root = await realpath(prefix);
    const runtimeMetadataText = await regularText(join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"), "Cannot inspect runtime metadata");
    const runtimeMetadata = JSON.parse(runtimeMetadataText) as Record<string, unknown>;
    const bootDirectory = await realpath(join(root, "node_modules", "@deepseek-ai", "dsh-app-boot"));
    if (!within(root, bootDirectory)) throw new Error();
    const bootMetadataText = await regularText(join(bootDirectory, "package.json"), "Cannot inspect runtime template metadata");
    const bootMetadata = JSON.parse(bootMetadataText) as Record<string, unknown>;
    if (bootMetadata.name !== "@deepseek-ai/dsh-app-boot" || typeof bootMetadata.main !== "string" || isAbsolute(bootMetadata.main)) throw new Error();
    const bootEntry = await realpath(resolve(bootDirectory, bootMetadata.main));
    if (!within(bootDirectory, bootEntry)) throw new Error();
    const source = await regularText(bootEntry, "Cannot inspect runtime template metadata", 4_000_000);
    const defaultsLiteral = /\bconst\s+DEFAULT_PROFILE_BUNDLES\s*=\s*(\[[^\]]*\])\s*;/.exec(source)?.[1];
    const templatesLiteral = /\bconst\s+PROFILE_TEMPLATES\s*=\s*\{([^}]*)\}\s*;/.exec(source)?.[1];
    if (!defaultsLiteral || templatesLiteral === undefined) throw new Error();
    const defaults = literalBundles(defaultsLiteral), templates = new Map<string, string[]>();
    const entry = /\s*(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9._-]+)")\s*:\s*(\[[^\]]*\])\s*,?\s*/gy;
    let offset = 0;
    while (offset < templatesLiteral.length && templatesLiteral.slice(offset).trim()) {
      entry.lastIndex = offset; const match = entry.exec(templatesLiteral);
      if (!match || !match[3]) throw new Error();
      const name = match[1] ?? match[2]!;
      if (templates.has(name)) throw new Error();
      templates.set(name, literalBundles(match[3])); offset = entry.lastIndex;
    }
    const requiredNames = new Set([...defaults, ...[...templates.values()].flat()]);
    const names = [...new Set([...requiredNames, ...(object(runtimeMetadata.dependencies) ? Object.keys(runtimeMetadata.dependencies) : []), ...(options.bundleNames ?? [])])].sort();
    if (names.length > 1000 || names.some(name => !packageNamePattern.test(name))) throw new Error();
    const builtins: ResolvedProfileBundle[] = [], evidence: unknown[] = [runtimeMetadataText, bootMetadataText, defaultsLiteral, templatesLiteral];
    for (const name of names) {
      let directory: string;
      try { directory = await realpath(join(root, "node_modules", ...name.split("/"))); }
      catch (error) { if (!requiredNames.has(name) && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!within(root, directory)) throw new Error();
      const text = await regularText(join(directory, "package.json"), "Cannot inspect builtin package metadata");
      const metadata = JSON.parse(text) as Record<string, unknown>;
      if (!requiredNames.has(name) && (!object(metadata.dsh) || !object(metadata.dsh.bundle) || metadata.dsh.bundle.patch === undefined)) continue;
      if (metadata.name !== name || !exactSemverSchema.safeParse(metadata.version).success || !object(metadata.dsh)
        || !object(metadata.dsh.bundle) || typeof metadata.dsh.bundle.patch !== "string") throw new Error();
      const patch = await realpath(resolve(directory, metadata.dsh.bundle.patch));
      if (!within(directory, patch) || !(await stat(patch)).isFile()) throw new Error();
      const version = metadata.version as string;
      builtins.push({ packageName: name, selector: version, version, sourceKind: "builtin", installSpec: `builtin:${name}@${version}` });
      evidence.push([name, text]);
    }
    const chosen = templates.get(options.profile) ?? defaults;
    return { runtimeVersion: options.runtimeVersion, builtins, defaults: chosen.map(name => clone(builtins.find(item => item.packageName === name)!)),
      manifest: { name: `dsh-profile-${options.profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [...chosen] } } },
      patch: "[]\n", fingerprint: hash(evidence) };
  } catch { throw new RuntimePreparationError("The cached runtime's Profile template descriptor is unsupported or inconsistent; use a supported exact runtime and prepare it again"); }
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

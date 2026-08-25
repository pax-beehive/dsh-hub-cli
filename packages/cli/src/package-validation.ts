import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  dshPackageManifestSchema,
  dshProfileManifestSchema,
  exactSemverSchema,
  hubListingSchema,
} from "@dsh-plugin-hub/schemas";

export interface PackageValidationResult {
  kind: "plugin" | "profile";
  directory: string;
  name: string;
  version: string;
  patch?: string;
  bundleCount?: number;
  warnings: string[];
}

export async function validatePackageDirectory(
  inputDirectory = ".",
): Promise<PackageValidationResult> {
  const directory = await realpath(resolve(inputDirectory));
  const packageJsonPath = resolve(directory, "package.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read a valid package.json in ${directory}: ${errorMessage(error)}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("package.json must contain an object");
  }
  const record = raw as Record<string, unknown>;
  const rawDsh = record.dsh && typeof record.dsh === "object"
    ? record.dsh as Record<string, unknown>
    : {};
  const listing = hubListingSchema.parse(record.dshHub ?? rawDsh.hub ?? {});

  const plugin = dshPackageManifestSchema.safeParse(raw);
  if (plugin.success) {
    const version = exactSemverSchema.parse(plugin.data.version);
    const repository = normalizeGitHubRepository(plugin.data.repository);
    if (!repository) {
      throw new Error("Plugin package.json requires a public GitHub repository URL");
    }
    const patchPath = await validatePatchPath(
      directory,
      plugin.data.dsh.bundle.patch,
    );
    const patch = await readFile(patchPath, "utf8");
    for (const entryId of listing.entryIds) {
      const escaped = entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`^\\s+- id: ['"]?${escaped}['"]?\\s*$`, "m").test(patch)) {
        throw new Error(`Cordis patch does not declare dsh.hub entryId ${entryId}`);
      }
    }
    const warnings: string[] = [];
    if (!listing.summary) warnings.push("Add dsh.hub.summary for useful search results");
    if (!listing.compatibility) warnings.push("Declare dsh.hub.compatibility explicitly");
    if (!plugin.data.license) warnings.push("Declare a package license");
    if (!listing.screenshots.length) warnings.push("Add a screenshot before launch");
    return {
      kind: "plugin",
      directory,
      name: plugin.data.name,
      version,
      patch: relative(directory, patchPath),
      warnings,
    };
  }

  const profile = dshProfileManifestSchema.safeParse(raw);
  if (profile.success) {
    const version = exactSemverSchema.parse(record.version);
    const warnings = profile.data.dsh.profile.bundles
      .filter((packageName) => !profile.data.dependencies[packageName])
      .map((packageName) => `${packageName} has no dependency selector; Hub will use latest`);
    if (!listing.summary && !listing.description) {
      warnings.push("Add dsh.hub.summary or description for the profile listing");
    }
    return {
      kind: "profile",
      directory,
      name: profile.data.name,
      version,
      bundleCount: profile.data.dsh.profile.bundles.length,
      warnings,
    };
  }

  throw new Error("package.json must declare a valid dsh.bundle or dsh.profile");
}

async function validatePatchPath(
  directory: string,
  declaredPatch: string,
): Promise<string> {
  const candidate = resolve(directory, declaredPatch);
  const lexicalRelative = relative(directory, candidate);
  if (isOutsideDirectory(lexicalRelative)) {
    throw new Error("dsh.bundle.patch must stay inside the package directory");
  }
  let resolvedPatch: string;
  try {
    resolvedPatch = await realpath(candidate);
  } catch (error) {
    throw new Error(`Cannot read dsh.bundle.patch ${declaredPatch}: ${errorMessage(error)}`);
  }
  if (isOutsideDirectory(relative(directory, resolvedPatch))) {
    throw new Error("dsh.bundle.patch cannot escape the package through a symlink");
  }
  if (!(await stat(resolvedPatch)).isFile()) {
    throw new Error("dsh.bundle.patch must point to a file");
  }
  return resolvedPatch;
}

function isOutsideDirectory(value: string): boolean {
  return value === ".." || value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(value);
}

function normalizeGitHubRepository(value: unknown): string | null {
  const raw = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as Record<string, unknown>).url === "string"
      ? (value as Record<string, string>).url
      : null;
  if (!raw) return null;
  const normalized = raw
    .replace(/^github:/i, "https://github.com/")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git(?:#.*)?$/, "");
  try {
    const url = new URL(normalized);
    const parts = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      parts.length === 2 &&
      parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))
      ? `${parts[0]}/${parts[1]}`
      : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

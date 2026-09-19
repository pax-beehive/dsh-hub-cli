import { createHash } from "node:crypto";
import { valid } from "semver";
import { parseDocument, visit } from "yaml";
import type { ResolvedProfileBundle } from "@dsh-plugin-hub/registry";

/** This is a local lock receipt, not an attestation of downloaded or built bytes. */
export interface ProfileDependencyLockReceipt {
  schemaVersion: 1;
  format: "pnpm";
  lockfileVersion: "9.0";
  hash: string;
  packages: number;
  snapshots: number;
  directDependencies: number;
  /** Registry package records with syntactically valid lock integrity, including transitives. */
  registryIntegrity: number;
  /** Direct declarations whose integrity is enforced by the lock's effective SRI. */
  declaredIntegrityVerified: number;
  /** GitHub source records with fixed commits; prepared artifacts remain unverified. */
  unverifiedGitHubBuilds: number;
}

const messages = {
  LOCK_SIZE: "The dependency lock must be nonempty and at most 8 MiB.",
  LOCK_YAML: "The dependency lock is not valid, bounded YAML with unique string keys and no aliases.",
  LOCK_FORMAT: "The dependency lock must use supported pnpm lockfile format 9.0.",
  LOCK_IMPORTER: "The dependency lock must contain exactly the Profile importer and match all manifest dependency sections.",
  LOCK_DECLARATION: "Every direct dependency must have one matching fixed source declaration.",
  LOCK_SOURCE: "The dependency lock contains an unsupported or unfixed package source.",
  LOCK_INTEGRITY: "The dependency lock contains invalid integrity or cannot enforce a declared integrity digest.",
  LOCK_GRAPH: "The dependency lock has an invalid package, snapshot, or dependency reference.",
} as const;
export type ProfileDependencyLockErrorCode = keyof typeof messages;

/** Messages deliberately exclude package names, URLs, YAML diagnostics, and local values. */
export class ProfileDependencyLockValidationError extends Error {
  readonly code: ProfileDependencyLockErrorCode;
  constructor(code: ProfileDependencyLockErrorCode) {
    super(messages[code]); this.name = "ProfileDependencyLockValidationError"; this.code = code;
  }
}

const maxBytes = 8 * 1024 * 1024;
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const commitPattern = /^[a-f0-9]{40}$/i;
type RecordValue = Record<string, unknown>;
function fail(code: ProfileDependencyLockErrorCode): never { throw new ProfileDependencyLockValidationError(code); }
function record(value: unknown, code: ProfileDependencyLockErrorCode): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as RecordValue;
}
function optionalRecord(value: unknown, code: ProfileDependencyLockErrorCode): RecordValue {
  return value === undefined ? Object.create(null) as RecordValue : record(value, code);
}
function keys(value: RecordValue, allowed: readonly string[], code: ProfileDependencyLockErrorCode): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(code);
}
function exactVersion(value: unknown): value is string { return typeof value === "string" && valid(value) === value; }
function strings(value: unknown, code: ProfileDependencyLockErrorCode): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) fail(code);
}
function stringMap(value: unknown, code: ProfileDependencyLockErrorCode): void {
  if (Object.values(record(value, code)).some(item => typeof item !== "string")) fail(code);
}
function validateMetadata(root: RecordValue): void {
  if (root.settings !== undefined) {
    const settings = record(root.settings, "LOCK_FORMAT");
    keys(settings, ["autoInstallPeers", "excludeLinksFromLockfile", "injectWorkspacePackages", "peersSuffixMaxLength"], "LOCK_FORMAT");
    for (const [key, value] of Object.entries(settings)) {
      if (key === "peersSuffixMaxLength" ? typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 : typeof value !== "boolean") fail("LOCK_FORMAT");
    }
  }
  for (const key of ["overrides", "time"]) if (root[key] !== undefined) stringMap(root[key], "LOCK_FORMAT");
  for (const key of ["packageExtensionsChecksum", "pnpmfileChecksum"]) {
    if (root[key] !== undefined && (typeof root[key] !== "string" || !root[key].length)) fail("LOCK_FORMAT");
  }
  if (root.ignoredOptionalDependencies !== undefined) strings(root.ignoredOptionalDependencies, "LOCK_FORMAT");
  for (const raw of Object.values(optionalRecord(root.patchedDependencies, "LOCK_FORMAT"))) {
    const patch = record(raw, "LOCK_FORMAT"); keys(patch, ["hash", "path"], "LOCK_FORMAT");
    if (typeof patch.hash !== "string" || !patch.hash || typeof patch.path !== "string" || !patch.path) fail("LOCK_FORMAT");
  }
  for (const rawCatalog of Object.values(optionalRecord(root.catalogs, "LOCK_FORMAT"))) {
    for (const [name, rawEntry] of Object.entries(record(rawCatalog, "LOCK_FORMAT"))) {
      const entry = record(rawEntry, "LOCK_FORMAT"); keys(entry, ["specifier", "version"], "LOCK_FORMAT");
      if (!namePattern.test(name) || typeof entry.specifier !== "string" || typeof entry.version !== "string") fail("LOCK_FORMAT");
      const source = withoutSuffix(entry.version);
      if (!exactVersion(source) && !githubIdentity(source)) fail("LOCK_SOURCE");
    }
  }
}

function parseLock(bytes: Buffer | string): { root: RecordValue; hash: string } {
  if (typeof bytes !== "string" && !Buffer.isBuffer(bytes)) fail("LOCK_YAML");
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  if (!buffer.length || buffer.length > maxBytes) fail("LOCK_SIZE");
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const document = parseDocument(source, { uniqueKeys: true, strict: true, version: "1.2", logLevel: "silent" });
    if (document.errors.length || document.warnings.length) fail("LOCK_YAML");
    // Native pnpm locks do not require aliases. Reject them before any expansion.
    visit(document, { Alias() { fail("LOCK_YAML"); } });
    let nodes = 0;
    function convert(value: unknown, depth: number): unknown {
      if (++nodes > 300_000 || depth > 100) fail("LOCK_YAML");
      if (value instanceof Map) {
        const result: RecordValue = Object.create(null) as RecordValue;
        for (const [key, item] of value) {
          if (typeof key !== "string" || key === "<<") fail("LOCK_YAML");
          result[key] = convert(item, depth + 1);
        }
        return result;
      }
      if (Array.isArray(value)) return value.map(item => convert(item, depth + 1));
      if (value !== null && typeof value === "object" || typeof value === "number" && !Number.isFinite(value)) fail("LOCK_YAML");
      return value;
    }
    const root = record(convert(document.toJS({ mapAsMap: true, maxAliasCount: 0 }), 0), "LOCK_FORMAT");
    return { root, hash: `sha256:${createHash("sha256").update(buffer).digest("hex")}` };
  } catch (error) {
    if (error instanceof ProfileDependencyLockValidationError) throw error;
    fail("LOCK_YAML");
  }
}

interface Integrity { algorithm: string; digests: Set<string> }
/** SRI chooses its strongest algorithm and treats that algorithm's digests as alternatives. */
function integrity(value: unknown): Integrity {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) fail("LOCK_INTEGRITY");
  const algorithms = ["sha1", "sha256", "sha384", "sha512"];
  const lengths = [20, 32, 48, 64];
  let strongest = -1;
  const byAlgorithm = new Map<number, Set<string>>();
  for (const part of value.trim().split(/\s+/)) {
    const matched = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?[\x21-\x7e]+)?$/.exec(part);
    if (!matched) fail("LOCK_INTEGRITY");
    const rank = algorithms.indexOf(matched[1]!);
    const digest = Buffer.from(matched[2]!, "base64");
    const canonical = digest.toString("base64");
    // The grammar above allows only trailing padding. Split once instead of
    // scanning every possible start of an unbounded trailing-padding regex.
    if (digest.length !== lengths[rank] || canonical.split("=", 1)[0] !== matched[2]!.split("=", 1)[0]) fail("LOCK_INTEGRITY");
    if (matched[2]!.includes("=") && canonical !== matched[2]) fail("LOCK_INTEGRITY");
    const values = byAlgorithm.get(rank) ?? new Set<string>(); values.add(canonical); byAlgorithm.set(rank, values);
    strongest = Math.max(strongest, rank);
  }
  return { algorithm: algorithms[strongest]!, digests: byAlgorithm.get(strongest)! };
}
function enforceIntegrity(declared: unknown, locked: unknown): void {
  const expected = integrity(declared), actual = integrity(locked);
  // An overlap is insufficient: pnpm must not accept an undeclared alternative,
  // or choose a stronger algorithm whose digest was not declared.
  if (actual.algorithm !== expected.algorithm || [...actual.digests].some(digest => !expected.digests.has(digest))) fail("LOCK_INTEGRITY");
}

interface GitHubIdentity { owner: string; repo: string; commit: string }
function githubIdentity(value: string): GitHubIdentity | undefined {
  const shortcut = /^github:([\w.-]+)\/([\w.-]+)#([a-f0-9]{40})$/i.exec(value);
  const tarball = /^https:\/\/codeload\.github\.com\/([\w.-]+)\/([\w.-]+)\/tar\.gz\/([a-f0-9]{40})$/i.exec(value);
  const git = /^(?:git\+)?(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?#([a-f0-9]{40})$/i.exec(value);
  const matched = shortcut ?? tarball ?? git;
  if (!matched || [".", ".."].includes(matched[1]!) || [".", ".."].includes(matched[2]!)) return undefined;
  return { owner: matched[1]!.toLowerCase(), repo: matched[2]!.replace(/\.git$/i, "").toLowerCase(), commit: matched[3]!.toLowerCase() };
}
function sameGit(a: GitHubIdentity | undefined, b: GitHubIdentity | undefined): boolean {
  return !!a && !!b && a.owner === b.owner && a.repo === b.repo && a.commit === b.commit;
}

/** Strip pnpm peer/patch suffixes while rejecting malformed nesting, without guessing peers. */
function withoutSuffix(value: string): string {
  if (!value || /[\s\x00-\x1f\x7f]/.test(value)) fail("LOCK_GRAPH");
  const start = value.indexOf("(");
  if (start === -1) { if (value.includes(")")) fail("LOCK_GRAPH"); return value; }
  let depth = 0;
  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (character === "(") { if (++depth > 100 || value[index + 1] === ")") fail("LOCK_GRAPH"); }
    else if (character === ")") { if (--depth < 0) fail("LOCK_GRAPH"); }
    else if (depth === 0) fail("LOCK_GRAPH");
  }
  if (depth) fail("LOCK_GRAPH");
  return value.slice(0, start);
}
interface PackageIdentity { name: string; version?: string; github?: GitHubIdentity; integrity?: string }
function packageIdentity(key: string, entry: RecordValue): PackageIdentity {
  if (withoutSuffix(key) !== key) fail("LOCK_GRAPH");
  const separator = key.indexOf("@", 1);
  if (separator < 1 || !namePattern.test(key.slice(0, separator))) fail("LOCK_SOURCE");
  const name = key.slice(0, separator), source = key.slice(separator + 1);
  if (entry.name !== undefined && entry.name !== name) fail("LOCK_SOURCE");
  const resolution = record(entry.resolution, "LOCK_SOURCE");
  if (exactVersion(source)) {
    keys(resolution, ["integrity", "tarball"], "LOCK_SOURCE");
    if (entry.version !== undefined && entry.version !== source) fail("LOCK_SOURCE");
    integrity(resolution.integrity);
    if (resolution.tarball !== undefined) {
      if (typeof resolution.tarball !== "string" || !resolution.tarball.length) fail("LOCK_SOURCE");
      // Native locks may retain private registry URLs or registry-relative paths.
      // Git-hosted tarballs have prepare semantics and cannot masquerade as npm.
      let url: URL;
      try { url = new URL(resolution.tarball, "https://registry.invalid/"); } catch { fail("LOCK_SOURCE"); }
      if (!["https:", "http:"].includes(url.protocol) || ["codeload.github.com", "github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname.toLowerCase())) fail("LOCK_SOURCE");
    }
    return { name, version: source, integrity: resolution.integrity as string };
  }
  const github = githubIdentity(source);
  if (!github || !exactVersion(entry.version)) fail("LOCK_SOURCE");
  if (resolution.type === "git") {
    keys(resolution, ["type", "repo", "commit"], "LOCK_SOURCE");
    if (typeof resolution.repo !== "string" || typeof resolution.commit !== "string" || !commitPattern.test(resolution.commit)
      || !sameGit(github, githubIdentity(`${resolution.repo}#${resolution.commit}`))) fail("LOCK_SOURCE");
  } else {
    keys(resolution, ["tarball", "integrity"], "LOCK_SOURCE");
    if (typeof resolution.tarball !== "string" || !sameGit(github, githubIdentity(resolution.tarball))) fail("LOCK_SOURCE");
    if (resolution.integrity !== undefined) integrity(resolution.integrity);
  }
  return { name, version: entry.version, github };
}

// Mirrors pnpm's v9 refToRelative: aliases are qualified names; ordinary refs
// are prefixed by the dependency name. No URL or filesystem lookup takes place.
function relativeReference(name: string, reference: unknown): string {
  if (!namePattern.test(name) || typeof reference !== "string") fail("LOCK_GRAPH");
  withoutSuffix(reference);
  if (/^(?:link:|file:|workspace:|catalog:|npm:)/.test(reference)) fail("LOCK_SOURCE");
  if (reference.startsWith("@")) return reference;
  const at = reference.indexOf("@"), colon = reference.indexOf(":"), bracket = reference.indexOf("(");
  return at !== -1 && (colon === -1 || at < colon) && (bracket === -1 || at < bracket) ? reference : `${name}@${reference}`;
}

/**
 * Validate a complete native pnpm v9 graph against the effective manifest and
 * its fixed direct sources. Transitive overrides and peer suffixes are retained.
 * This does not fetch bytes, execute hooks, or verify GitHub prepare output.
 * Unsupported graph/source forms fail closed, with no private values in errors.
 */
export function validateProfileDependencyLock(options: {
  bytes: Buffer | string;
  manifest: Record<string, unknown>;
  dependencies: ResolvedProfileBundle[];
}): ProfileDependencyLockReceipt {
  const { root, hash } = parseLock(options.bytes);
  if (root.lockfileVersion !== "9.0" && root.lockfileVersion !== 9) fail("LOCK_FORMAT");
  keys(root, ["lockfileVersion", "settings", "importers", "packages", "snapshots", "overrides", "patchedDependencies",
    "packageExtensionsChecksum", "pnpmfileChecksum", "ignoredOptionalDependencies", "catalogs", "time"], "LOCK_FORMAT");
  validateMetadata(root);
  const importers = record(root.importers, "LOCK_IMPORTER");
  if (Object.keys(importers).length !== 1 || !Object.hasOwn(importers, ".")) fail("LOCK_IMPORTER");
  const importer = record(importers["."], "LOCK_IMPORTER");
  keys(importer, [...dependencyFields, "dependenciesMeta", "publishDirectory"], "LOCK_IMPORTER");
  if (importer.publishDirectory !== undefined && typeof importer.publishDirectory !== "string") fail("LOCK_IMPORTER");
  for (const [name, value] of Object.entries(optionalRecord(importer.dependenciesMeta, "LOCK_IMPORTER"))) {
    if (!namePattern.test(name)) fail("LOCK_IMPORTER");
    const meta = record(value, "LOCK_IMPORTER"); keys(meta, ["injected", "built"], "LOCK_IMPORTER");
    if (Object.values(meta).some(item => typeof item !== "boolean")) fail("LOCK_IMPORTER");
  }
  const packages = optionalRecord(root.packages, "LOCK_GRAPH"), snapshots = optionalRecord(root.snapshots, "LOCK_GRAPH");
  const identities = new Map<string, PackageIdentity>();
  let registryIntegrity = 0, unverifiedGitHubBuilds = 0;
  for (const [key, rawEntry] of Object.entries(packages)) {
    const entry = record(rawEntry, "LOCK_GRAPH");
    keys(entry, ["resolution", "name", "version", "engines", "cpu", "os", "libc", "hasBin", "deprecated", "peerDependencies", "peerDependenciesMeta", "bundledDependencies"], "LOCK_GRAPH");
    for (const field of ["engines", "peerDependencies"]) if (entry[field] !== undefined) stringMap(entry[field], "LOCK_GRAPH");
    for (const field of ["cpu", "os", "libc"]) if (entry[field] !== undefined) strings(entry[field], "LOCK_GRAPH");
    if (entry.bundledDependencies !== undefined && typeof entry.bundledDependencies !== "boolean") strings(entry.bundledDependencies, "LOCK_GRAPH");
    if (entry.hasBin !== undefined && typeof entry.hasBin !== "boolean" || entry.deprecated !== undefined && typeof entry.deprecated !== "string") fail("LOCK_GRAPH");
    for (const [name, value] of Object.entries(optionalRecord(entry.peerDependenciesMeta, "LOCK_GRAPH"))) {
      if (!namePattern.test(name)) fail("LOCK_GRAPH");
      const meta = record(value, "LOCK_GRAPH"); keys(meta, ["optional"], "LOCK_GRAPH");
      if (typeof meta.optional !== "boolean") fail("LOCK_GRAPH");
    }
    const identity = packageIdentity(key, entry); identities.set(key, identity);
    if (identity.github) unverifiedGitHubBuilds++; else registryIntegrity++;
  }
  const snapshotPackages = new Set<string>();
  const edges = new Map<string, string[]>();
  function reference(name: string, value: unknown): string {
    const key = relativeReference(name, value);
    if (!Object.hasOwn(snapshots, key) || !identities.has(withoutSuffix(key))) fail("LOCK_GRAPH");
    return key;
  }
  for (const [key, rawSnapshot] of Object.entries(snapshots)) {
    const packageKey = withoutSuffix(key), identity = identities.get(packageKey);
    if (!identity) fail("LOCK_GRAPH");
    snapshotPackages.add(packageKey);
    const snapshot = record(rawSnapshot, "LOCK_GRAPH");
    keys(snapshot, ["dependencies", "optionalDependencies", "transitivePeerDependencies", "optional", "id"], "LOCK_GRAPH");
    // pnpm uses id as a fetch/cache identity override. Accept only the same
    // identity already validated in packages, never an unreviewed source.
    if (snapshot.id !== undefined && snapshot.id !== packageKey && snapshot.id !== packageKey.slice(identity.name.length + 1)) fail("LOCK_SOURCE");
    const outgoing: string[] = [];
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      for (const [name, value] of Object.entries(optionalRecord(snapshot[field], "LOCK_GRAPH"))) outgoing.push(reference(name, value));
    }
    if (snapshot.transitivePeerDependencies !== undefined && (!Array.isArray(snapshot.transitivePeerDependencies)
      || snapshot.transitivePeerDependencies.some(name => typeof name !== "string" || !namePattern.test(name)))) fail("LOCK_GRAPH");
    if (snapshot.optional !== undefined && typeof snapshot.optional !== "boolean") fail("LOCK_GRAPH");
    edges.set(key, outgoing);
  }
  if (snapshotPackages.size !== identities.size) fail("LOCK_GRAPH");
  const declarations = new Map<string, ResolvedProfileBundle>();
  for (const dependency of options.dependencies) {
    if (!namePattern.test(dependency.packageName) || declarations.has(dependency.packageName) || !exactVersion(dependency.version)
      || !["npm", "github"].includes(dependency.sourceKind)) fail("LOCK_DECLARATION");
    declarations.set(dependency.packageName, dependency);
  }
  const manifest = record(options.manifest, "LOCK_IMPORTER");
  const directNames = new Set<string>(), roots: string[] = [];
  let declaredIntegrityVerified = 0;
  for (const field of dependencyFields) {
    const wanted = optionalRecord(manifest[field], "LOCK_IMPORTER"), locked = optionalRecord(importer[field], "LOCK_IMPORTER");
    if (Object.keys(wanted).length !== Object.keys(locked).length) fail("LOCK_IMPORTER");
    for (const [name, specifier] of Object.entries(wanted)) {
      if (!Object.hasOwn(locked, name) || typeof specifier !== "string" || !namePattern.test(name)) fail("LOCK_IMPORTER");
      const entry = record(locked[name], "LOCK_IMPORTER"); keys(entry, ["specifier", "version"], "LOCK_IMPORTER");
      if (entry.specifier !== specifier) fail("LOCK_IMPORTER");
      const dependency = declarations.get(name);
      if (!dependency) fail("LOCK_DECLARATION");
      const key = reference(name, entry.version), identity = identities.get(withoutSuffix(key))!;
      if (identity.name !== name || identity.version !== dependency.version) fail("LOCK_DECLARATION");
      if (dependency.sourceKind === "npm") {
        if (identity.github || specifier !== dependency.version || dependency.installSpec !== `${name}@${dependency.version}`) fail("LOCK_DECLARATION");
        if (dependency.integrity !== undefined) { enforceIntegrity(dependency.integrity, identity.integrity); if (!directNames.has(name)) declaredIntegrityVerified++; }
      } else {
        if (!sameGit(identity.github, githubIdentity(dependency.installSpec)) || !sameGit(identity.github, githubIdentity(specifier))
          || dependency.integrity !== undefined) fail("LOCK_DECLARATION");
      }
      directNames.add(name); roots.push(key);
    }
  }
  if (directNames.size !== declarations.size) fail("LOCK_DECLARATION");
  const reached = new Set<string>();
  while (roots.length) {
    const key = roots.pop()!; if (reached.has(key)) continue;
    reached.add(key); roots.push(...edges.get(key)!);
  }
  if (reached.size !== edges.size) fail("LOCK_GRAPH");
  return { schemaVersion: 1, format: "pnpm", lockfileVersion: "9.0", hash, packages: identities.size, snapshots: edges.size,
    directDependencies: directNames.size, registryIntegrity, declaredIntegrityVerified, unverifiedGitHubBuilds };
}

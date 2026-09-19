import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stringify } from "yaml";
import type { ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { ProfileDependencyLockValidationError, validateProfileDependencyLock } from "../src/profile-dependency-lock.ts";

const sri = (input: string, algorithm = "sha512") => `${algorithm}-${createHash(algorithm).update(input).digest("base64")}`;
const good = sri("reviewed artifact"), other = sri("different artifact");
const npm = (packageName = "plugin", version = "1.0.0", integrity?: string): ResolvedProfileBundle => ({
  packageName, version, selector: version, installSpec: `${packageName}@${version}`, sourceKind: "npm", ...(integrity === undefined ? {} : { integrity }),
});
const commit = "0123456789abcdef".repeat(2) + "01234567";
const gitUrl = `https://codeload.github.com/Example/Plugin/tar.gz/${commit}`;
const git = (): ResolvedProfileBundle => ({ packageName: "plugin", version: "1.0.0", selector: "1.0.0",
  installSpec: `github:example/plugin#${commit}`, sourceKind: "github" });
type Lock = Record<string, any>;
function fixture() {
  return {
    manifest: { dependencies: { plugin: "1.0.0" } } as Record<string, any>,
    dependencies: [npm("plugin", "1.0.0", good)],
    lock: { lockfileVersion: "9.0", settings: { autoInstallPeers: false, excludeLinksFromLockfile: false },
      importers: { ".": { dependencies: { plugin: { specifier: "1.0.0", version: "1.0.0" } } } },
      packages: { "plugin@1.0.0": { resolution: { integrity: good } } }, snapshots: { "plugin@1.0.0": {} },
    } as Lock,
  };
}
function validate(input: ReturnType<typeof fixture>) {
  return validateProfileDependencyLock({ ...input, bytes: stringify(input.lock) });
}
function rejects(input: ReturnType<typeof fixture>, code?: string) {
  assert.throws(() => validate(input), (error: unknown) => error instanceof ProfileDependencyLockValidationError && (!code || error.code === code));
}

test("native registry lock produces only a safe count/hash receipt and does not mutate inputs", () => {
  const input = fixture();
  input.lock.packages["plugin@1.0.0"].resolution.tarball = "https://username:private-token@private.example/archive.tgz?access=secret";
  const before = JSON.stringify(input), bytes = stringify(input.lock), receipt = validate(input);
  assert.deepEqual(receipt, { schemaVersion: 1, format: "pnpm", lockfileVersion: "9.0",
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, packages: 1, snapshots: 1,
    directDependencies: 1, registryIntegrity: 1, declaredIntegrityVerified: 1, unverifiedGitHubBuilds: 0 });
  assert.equal(JSON.stringify(input), before);
  assert.equal(/secret|token|private\.example|username|plugin/.test(JSON.stringify(receipt)), false);
  assert.deepEqual(validateProfileDependencyLock({ ...input, bytes: Buffer.from(bytes) }), receipt);
});

test("ordinary local dependencies without declared SRI have lock evidence, not declared verification", () => {
  const input = fixture(); input.dependencies = [npm()];
  assert.equal(validate(input).registryIntegrity, 1);
  assert.equal(validate(input).declaredIntegrityVerified, 0);
});

test("empty builtin-only native locks may omit packages and snapshots", () => {
  const receipt = validateProfileDependencyLock({ bytes: "lockfileVersion: '9.0'\nimporters:\n  .: {}\n", manifest: { dependencies: {} }, dependencies: [] });
  assert.equal(receipt.packages, 0); assert.equal(receipt.snapshots, 0); assert.equal(receipt.directDependencies, 0);
});

test("manifest regular, dev and optional declarations match exact importer sections", () => {
  const input = fixture();
  for (const [section, name] of [["devDependencies", "tool"], ["optionalDependencies", "optional"]] as const) {
    input.manifest[section] = { [name]: "2.0.0" };
    input.lock.importers["."][section] = { [name]: { specifier: "2.0.0", version: "2.0.0" } };
    input.lock.packages[`${name}@2.0.0`] = { resolution: { integrity: good } };
    input.lock.snapshots[`${name}@2.0.0`] = {};
    input.dependencies.push(npm(name, "2.0.0"));
  }
  assert.equal(validate(input).directDependencies, 3);
  delete input.lock.importers["."].optionalDependencies; rejects(input, "LOCK_IMPORTER");
});

test("unexpected importers, omitted fields, surplus declarations and floating direct specs fail", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.lock.importers.other = {}; },
    (f: ReturnType<typeof fixture>) => { delete f.lock.importers["."]; },
    (f: ReturnType<typeof fixture>) => { f.lock.importers["."].dependencies.plugin.specifier = "^1.0.0"; },
    (f: ReturnType<typeof fixture>) => { f.manifest.devDependencies = { tool: "1.0.0" }; },
    (f: ReturnType<typeof fixture>) => { f.lock.importers["."].optionalDependencies = { tool: { specifier: "1.0.0", version: "1.0.0" } }; },
    (f: ReturnType<typeof fixture>) => { f.dependencies.push(npm("unused")); },
    (f: ReturnType<typeof fixture>) => { f.dependencies.push(npm()); },
    (f: ReturnType<typeof fixture>) => { f.dependencies = []; },
    (f: ReturnType<typeof fixture>) => { f.manifest.dependencies.plugin = "^1.0.0"; f.lock.importers["."].dependencies.plugin.specifier = "^1.0.0"; },
  ]) { const input = fixture(); mutate(input); rejects(input); }
});

test("direct npm actual version and source identity cannot be replaced by an override", () => {
  const input = fixture();
  input.lock.importers["."].dependencies.plugin.version = "2.0.0";
  input.lock.packages = { "plugin@2.0.0": { resolution: { integrity: good } } };
  input.lock.snapshots = { "plugin@2.0.0": {} };
  rejects(input, "LOCK_DECLARATION");
  const alias = fixture(); alias.lock.importers["."].dependencies.plugin.version = "other@1.0.0";
  alias.lock.packages = { "other@1.0.0": { resolution: { integrity: good } } }; alias.lock.snapshots = { "other@1.0.0": {} };
  rejects(alias, "LOCK_DECLARATION");
});

test("all native peer snapshots, optional references and transitive aliases are validated", () => {
  const input = fixture();
  const suffix = "(peer@2.0.0(nested@3.0.0))", root = `plugin@1.0.0${suffix}`;
  input.lock.importers["."].dependencies.plugin.version = `1.0.0${suffix}`;
  input.lock.packages["peer@2.0.0"] = { resolution: { integrity: good } };
  input.lock.packages["nested@3.0.0"] = { resolution: { integrity: good } };
  input.lock.snapshots = { [root]: { dependencies: { peer: "2.0.0(nested@3.0.0)", renamed: "nested@3.0.0" }, optionalDependencies: { optionalAlias: "nested@3.0.0" } },
    "peer@2.0.0(nested@3.0.0)": { dependencies: { nested: "3.0.0" } }, "nested@3.0.0": {} };
  const receipt = validate(input);
  assert.equal(receipt.packages, 3); assert.equal(receipt.snapshots, 3); assert.equal(receipt.registryIntegrity, 3);
  delete input.lock.snapshots["nested@3.0.0"]; rejects(input, "LOCK_GRAPH");
});

test("transitive overrides can change the graph while fixed direct identity remains intact", () => {
  const input = fixture(); input.manifest.pnpm = { overrides: { transitive: "2.0.0" } };
  input.lock.overrides = { transitive: "2.0.0" };
  input.lock.snapshots["plugin@1.0.0"] = { dependencies: { transitive: "2.0.0" } };
  input.lock.packages["transitive@2.0.0"] = { resolution: { integrity: good } };
  input.lock.snapshots["transitive@2.0.0"] = { dependencies: { plugin: "1.0.0" } };
  assert.equal(validate(input).packages, 2, "cycles do not lose nodes or recurse forever");
});

test("missing package, missing snapshot, hidden orphan and unfixed transitive sources fail", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { delete f.lock.packages["plugin@1.0.0"]; },
    (f: ReturnType<typeof fixture>) => { delete f.lock.snapshots["plugin@1.0.0"]; },
    (f: ReturnType<typeof fixture>) => { f.lock.packages["unused@1.0.0"] = { resolution: { integrity: good } }; f.lock.snapshots["unused@1.0.0"] = {}; },
    (f: ReturnType<typeof fixture>) => { f.lock.snapshots["plugin@1.0.0"].dependencies = { missing: "1.0.0" }; },
    (f: ReturnType<typeof fixture>) => { f.lock.snapshots["plugin@1.0.0"].optionalDependencies = { missing: "1.0.0" }; },
    (f: ReturnType<typeof fixture>) => { f.lock.snapshots["plugin@1.0.0"].dependencies = { missing: "file:../private" }; },
    (f: ReturnType<typeof fixture>) => { f.lock.packages["plugin@1.0.0"].dependencies = { hidden: "1.0.0" }; },
    (f: ReturnType<typeof fixture>) => { f.lock.snapshots["plugin@1.0.0"].id = "https://private.example/different.tgz"; },
  ]) { const input = fixture(); mutate(input); rejects(input); }
});

test("integrity compares decoded digest semantics and ignores order or weaker shared algorithms", () => {
  const input = fixture();
  input.dependencies[0]!.integrity = `${sri("weaker", "sha1")} ${good.replace(/=+$/, "")} ${other}`;
  input.lock.packages["plugin@1.0.0"].resolution.integrity = `${good}?metadata ${sri("different weaker", "sha1")}`;
  assert.equal(validate(input).declaredIntegrityVerified, 1);
  input.lock.packages["plugin@1.0.0"].resolution.integrity = `${sri("undeclared alternative")} ${good}`;
  rejects(input, "LOCK_INTEGRITY");
});

test("wrong digest, malformed SRI and mismatched effective algorithms fail closed", () => {
  for (const value of [other, "sha512-not-base64!", "sha512-YQ==", "md5-aaaaaaaaaaaaaaaaaaaaaa==", `${good} malformed`, ""]) {
    const input = fixture(); input.lock.packages["plugin@1.0.0"].resolution.integrity = value; rejects(input, "LOCK_INTEGRITY");
  }
  const input = fixture(); input.dependencies[0]!.integrity = sri("same weaker", "sha256");
  input.lock.packages["plugin@1.0.0"].resolution.integrity = `${input.dependencies[0]!.integrity} ${good}`;
  rejects(input, "LOCK_INTEGRITY");
  input.dependencies[0]!.integrity = "bad-private-value"; rejects(input, "LOCK_INTEGRITY");
});

test("registry source cannot silently become a GitHub tarball or filesystem source", () => {
  for (const resolution of [{ integrity: good, tarball: gitUrl }, { integrity: good, tarball: "file:private.tgz" },
    { integrity: good, type: "directory", directory: "/private/path" }, { tarball: "https://private.example/unverified.tgz" }]) {
    const input = fixture(); input.lock.packages["plugin@1.0.0"].resolution = resolution; rejects(input);
  }
});

function githubFixture(transport: "tarball" | "git") {
  const input = fixture(); input.dependencies = [git()]; input.manifest.dependencies.plugin = git().installSpec;
  const source = transport === "tarball" ? gitUrl : `git+ssh://git@github.com/Example/Plugin.git#${commit}`;
  input.lock.importers["."].dependencies.plugin = { specifier: git().installSpec, version: source };
  input.lock.packages = { [`plugin@${source}`]: { version: "1.0.0", resolution: transport === "tarball"
    ? { tarball: gitUrl } : { type: "git", repo: "ssh://git@github.com/Example/Plugin.git", commit } } };
  input.lock.snapshots = { [`plugin@${source}`]: {} };
  return input;
}

test("native GitHub tarball and git transports bind repository plus full commit, not built artifact integrity", () => {
  for (const transport of ["tarball", "git"] as const) {
    const input = githubFixture(transport), receipt = validate(input);
    assert.equal(receipt.unverifiedGitHubBuilds, 1); assert.equal(receipt.registryIntegrity, 0); assert.equal(receipt.declaredIntegrityVerified, 0);
    input.dependencies[0]!.installSpec = `github:different/repository#${commit}`; rejects(input, "LOCK_DECLARATION");
  }
});

test("GitHub floating branch, commit mismatch, fake npm identity and path extraction fail", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.dependencies[0]!.installSpec = "github:example/plugin#main"; },
    (f: ReturnType<typeof fixture>) => { Object.values<any>(f.lock.packages)[0].resolution.tarball = gitUrl.replace(commit, "0".repeat(40)); },
    (f: ReturnType<typeof fixture>) => { f.dependencies[0]!.sourceKind = "npm"; f.dependencies[0]!.installSpec = "plugin@1.0.0"; },
    (f: ReturnType<typeof fixture>) => { Object.values<any>(f.lock.packages)[0].resolution.path = "nested"; },
  ]) { const input = githubFixture("tarball"); mutate(input); rejects(input); }
});

test("malformed YAML, aliases, duplicate keys, unknown tags and non-string mapping keys never leak contents", () => {
  const privateValue = "private-url-and-token";
  for (const bytes of ["", "null", "[]", "false", "lockfileVersion: '8.0'", `x: ${privateValue}\nx: other`,
    `x: &secret [${privateValue}]\ny: *secret`, `x: !!js/function ${privateValue}`, "? [a, b]\n: value", "x: 1\n---\nx: 2", "x: { <<: {} }",
    `lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages: [${privateValue}]`,
  ]) {
    assert.throws(() => validateProfileDependencyLock({ bytes, manifest: {}, dependencies: [] }), (error: unknown) => {
      assert.ok(error instanceof ProfileDependencyLockValidationError); assert.equal(error.message.includes(privateValue), false); return true;
    });
  }
  assert.throws(() => validateProfileDependencyLock({ bytes: Buffer.from([0xc3, 0x28]), manifest: {}, dependencies: [] }), ProfileDependencyLockValidationError);
});

test("lock size and nesting bounds reject before accepting a receipt", () => {
  assert.throws(() => validateProfileDependencyLock({ bytes: " ".repeat(8 * 1024 * 1024 + 1), manifest: {}, dependencies: [] }),
    (error: unknown) => error instanceof ProfileDependencyLockValidationError && error.code === "LOCK_SIZE");
  assert.throws(() => validateProfileDependencyLock({ bytes: `x: ${"[".repeat(110)}0${"]".repeat(110)}`, manifest: {}, dependencies: [] }), ProfileDependencyLockValidationError);
});

test("prototype-named map keys are ordinary data and never pollute process prototypes", () => {
  assert.throws(() => validateProfileDependencyLock({ bytes: "lockfileVersion: '9.0'\nimporters:\n  .: {}\n__proto__: { pollutedByLock: true }\n", manifest: {}, dependencies: [] }), ProfileDependencyLockValidationError);
  assert.equal(Object.hasOwn(Object.prototype, "pollutedByLock"), false);
});

test("invalid native metadata and malformed peer suffixes fail without losing nodes", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.lock.settings = []; },
    (f: ReturnType<typeof fixture>) => { f.lock.settings.autoInstallPeers = "false"; },
    (f: ReturnType<typeof fixture>) => { f.lock.overrides = { plugin: {} }; },
    (f: ReturnType<typeof fixture>) => { f.lock.patchedDependencies = { plugin: { path: "private-file" } }; },
    (f: ReturnType<typeof fixture>) => { f.lock.packages["plugin@1.0.0"].peerDependencies = []; },
    (f: ReturnType<typeof fixture>) => { f.lock.packages["plugin@1.0.0"].peerDependenciesMeta = { peer: { optional: "yes" } }; },
    (f: ReturnType<typeof fixture>) => { f.lock.importers["."].dependencies.plugin.version = "1.0.0(peer@2.0.0"; },
    (f: ReturnType<typeof fixture>) => { f.lock.importers["."].dependencies.plugin.version = "1.0.0()"; },
    (f: ReturnType<typeof fixture>) => { f.lock.importers["."].dependencies.plugin.version = "1.0.0(peer@2.0.0)trailing"; },
  ]) { const input = fixture(); mutate(input); rejects(input); }
});

test("native patch and opaque peer hash suffixes retain their graph records", () => {
  const input = fixture(), version = "1.0.0(patch_hash=abc123)(9fd9d0e6f09d42a1981aab6414050000)";
  input.lock.patchedDependencies = { "plugin@1.0.0": { hash: "abc123", path: "patches/plugin.patch" } };
  input.lock.importers["."].dependencies.plugin.version = version;
  input.lock.snapshots = { [`plugin@${version}`]: {} };
  assert.equal(validate(input).snapshots, 1);
});

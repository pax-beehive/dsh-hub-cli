import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import type { ResolvedProfile, ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { ProfileUpgradeBlockedError, profileLockPath } from "../dist/index.js";
import { buildAuthorBaseline, prepareProfileUpgrade, scanProfileFiles } from "../dist/profile-upgrade.js";
import { mergeProfileInputDeclarations, prepareProfileEdit, validateLocalBundleRules, type LocalBundleRule, type ProfileEditIntent } from "../dist/profile-edit.js";

const profile = "personal", slug = "example";
const bundle = (packageName: string, version = "1.0.0"): ResolvedProfileBundle => ({ packageName, version, selector: version, installSpec: `${packageName}@${version}`, sourceKind: "npm" });
const declaration = (key: string, required = true, secret = true) => ({ key, label: key, required, secret });
async function fixture(t: test.TestContext) {
  const dshHome = await mkdtemp(join(tmpdir(), "dsh-edit-module-"));
  t.after(() => rm(dshHome, { recursive: true, force: true }));
  const directory = join(dshHome, "profiles", profile), statePath = profileLockPath(profile, dshHome);
  await mkdir(directory, { recursive: true }); await mkdir(dirname(statePath), { recursive: true });
  const resolved: ResolvedProfile = { profileVersion: "1.0.0", bundles: [bundle("author-plugin"), bundle("second-plugin")] };
  const release: HubProfileVersion = { schemaVersion: 1, version: "1.0.0", name: "Example", description: "", dsh: "*",
    runtime: { range: "^1.0.0", version: "1.0.0" }, bundles: resolved.bundles.map(item => ({ ...item, sourceKind: "npm" as const, before: [], after: [] })),
    inputs: [declaration("AUTHOR_KEY")], patch: [], patchYaml: "- id: author\n", publishedAt: "2026-09-17T00:00:00Z" };
  const authorBaseline = buildAuthorBaseline({ profile, slug, release, resolved });
  const manifest = structuredClone(authorBaseline.manifest) as any;
  const state = { schemaVersion: 2, profile, hubProfile: { slug, version: release.version }, resolvedAt: release.publishedAt,
    runtime: release.runtime, inputs: release.inputs, authorBaseline, bundles: resolved.bundles, dependencies: resolved.bundles,
    localInputs: [] as HubProfileVersion["inputs"] };
  const save = async () => {
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  };
  await save(); await writeFile(join(directory, "cordis.patch.yml"), release.patchYaml!);
  const prepare = (intent: ProfileEditIntent, resolutions?: { contextHash: string; choices: Record<string, "local" | "upstream"> }) => prepareProfileEdit({ profile, dshHome, intent, resolutions });
  return { dshHome, directory, statePath, state, manifest, save, prepare };
}
async function installed(directory: string, item: ResolvedProfileBundle, isBundle = true) {
  const packageDirectory = join(directory, "node_modules", ...item.packageName.split("/"));
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: item.packageName, version: item.version,
    ...(isBundle ? { dsh: { bundle: { patch: "patch.yml" } } } : {}) }));
  if (isBundle) await writeFile(join(packageDirectory, "patch.yml"), "[]\n");
}

test("add preserves disabled dependencies, personal fields, patch and author baseline without writing files", async t => {
  const f = await fixture(t);
  f.manifest.dsh.profile.bundles = ["author-plugin"];
  f.manifest.personal = "private-setting"; await f.save();
  await writeFile(join(f.directory, "cordis.patch.yml"), "personal: private-patch\n");
  const before = await scanProfileFiles(f.directory);
  const prepared = await f.prepare({ kind: "add", bundle: bundle("personal-plugin", "2.0.0"), position: 0 });
  assert.deepEqual(prepared.effectiveBundles.map(item => item.packageName), ["personal-plugin", "author-plugin"]);
  assert.deepEqual(prepared.dependencies.map(item => item.packageName), ["author-plugin", "personal-plugin", "second-plugin"]);
  assert.equal(prepared.manifest.personal, "private-setting");
  assert.equal(prepared.patch, "personal: private-patch\n");
  assert.deepEqual(prepared.authorBaseline, f.state.authorBaseline);
  assert.equal(JSON.stringify(prepared.summary).includes("private-"), false);
  assert.deepEqual(await scanProfileFiles(f.directory), before);
});

test("add requires a truly fixed source and valid position", async t => {
  const f = await fixture(t);
  for (const intent of [
    { kind: "add", bundle: { ...bundle("local-plugin"), installSpec: "local-plugin@latest" } },
    { kind: "add", bundle: { ...bundle("local-plugin"), sourceKind: "github", installSpec: "github:owner/repo#main" } },
    { kind: "add", bundle: bundle("local-plugin"), position: -1 },
  ] as ProfileEditIntent[]) await assert.rejects(f.prepare(intent));
});

test("disable retains the fixed dependency; remove leaves personal patch for transaction validation", async t => {
  const f = await fixture(t);
  const disabled = await f.prepare({ kind: "disable", packageName: "second-plugin" });
  assert.equal(disabled.dependencies.some(item => item.packageName === "second-plugin"), true);
  assert.equal(disabled.effectiveBundles.some(item => item.packageName === "second-plugin"), false);
  const removed = await f.prepare({ kind: "remove", packageName: "second-plugin" });
  assert.equal(removed.dependencies.some(item => item.packageName === "second-plugin"), false);
  assert.equal(Object.hasOwn(removed.manifest.dependencies as object, "second-plugin"), false);
  assert.equal(removed.patch, f.state.authorBaseline.patch);
});

test("enable promotes a verified installed ordinary dependency and binds its patch metadata", async t => {
  const f = await fixture(t), helper = bundle("helper");
  f.manifest.dependencies.helper = helper.version; f.state.dependencies.push(helper); await f.save();
  await installed(f.directory, helper, false);
  await assert.rejects(f.prepare({ kind: "enable", packageName: "helper" }), /verified DSH bundle/);
  await installed(f.directory, helper);
  const first = await f.prepare({ kind: "enable", packageName: "helper" });
  assert.deepEqual(first.effectiveBundles.map(item => item.packageName), ["author-plugin", "second-plugin", "helper"]);
  await writeFile(join(f.directory, "node_modules", "helper", "patch.yml"), "different: patch\n");
  const second = await f.prepare({ kind: "enable", packageName: "helper" });
  assert.equal(first.expectedFingerprint, second.expectedFingerprint);
  assert.notEqual(first.contextHash, second.contextHash);
});

test("enable rejects a bundle patch escaping its package", async t => {
  const f = await fixture(t), helper = bundle("helper");
  f.manifest.dependencies.helper = helper.version; f.state.dependencies.push(helper); await f.save();
  await installed(f.directory, helper);
  const directory = join(f.directory, "node_modules", "helper");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "helper", version: "1.0.0", dsh: { bundle: { patch: "../../cordis.patch.yml" } } }));
  await assert.rejects(f.prepare({ kind: "enable", packageName: "helper" }), /package-local patch/);
});

test("reorder requires the complete enabled set and honors author ordering constraints", async t => {
  const f = await fixture(t);
  const reordered = await f.prepare({ kind: "reorder", order: ["second-plugin", "author-plugin"] });
  assert.deepEqual(reordered.effectiveBundles.map(item => item.packageName), ["second-plugin", "author-plugin"]);
  await assert.rejects(f.prepare({ kind: "reorder", order: ["author-plugin", "author-plugin"] }), /exactly once/);
  await assert.rejects(f.prepare({ kind: "reorder", order: ["author-plugin"] }), /exactly once/);
  f.state.authorBaseline.release.bundles[1]!.after = ["author-plugin"]; await f.save();
  await assert.rejects(f.prepare({ kind: "reorder", order: ["second-plugin", "author-plugin"] }), /before\/after/);
  await assert.rejects(f.prepare({ kind: "disable", packageName: "author-plugin" }), error => {
    assert.ok(error instanceof ProfileUpgradeBlockedError);
    assert.ok(error.summary.conflicts.some(item => item.reason?.includes("before/after")));
    return true;
  });
});

test("builtin disable/remove recognize original membership, and a repeated disable remains disabled", async t => {
  const f = await fixture(t), builtin: ResolvedProfileBundle & { sourceKind: "builtin" } = { packageName: "@deepseek-ai/dsh-web", version: "1.0.0", selector: "1.0.0",
    sourceKind: "builtin", installSpec: "builtin:@deepseek-ai/dsh-web@1.0.0" };
  const release = structuredClone(f.state.authorBaseline.release);
  release.bundles = [release.bundles[0]!, { ...builtin, before: [], after: [] }];
  f.state.authorBaseline = buildAuthorBaseline({ profile, slug, release, resolved: { profileVersion: release.version, bundles: [bundle("author-plugin"), builtin] } });
  f.state.bundles = [bundle("author-plugin"), builtin]; f.state.dependencies = [bundle("author-plugin")];
  Object.assign(f.manifest, f.state.authorBaseline.manifest); await f.save();
  const disabled = await f.prepare({ kind: "disable", packageName: builtin.packageName });
  assert.deepEqual(disabled.effectiveBundles.map(item => item.packageName), ["author-plugin"]);
  assert.deepEqual(disabled.localBundleOverrides.disabled, [builtin.packageName]);
  const removed = await f.prepare({ kind: "remove", packageName: builtin.packageName });
  assert.deepEqual(removed.localBundleOverrides.removed, [builtin.packageName]);
  (f.state as any).localBundleOverrides = disabled.localBundleOverrides; f.state.bundles = disabled.effectiveBundles;
  Object.assign(f.manifest, disabled.manifest); await f.save();
  const repeated = await f.prepare({ kind: "disable", packageName: builtin.packageName });
  assert.deepEqual(repeated.localBundleOverrides.disabled, [builtin.packageName]);
  assert.equal(repeated.effectiveBundles.some(item => item.packageName === builtin.packageName), false);
});

test("configure hashes file contents without including them or the source path in its summary", async t => {
  const f = await fixture(t), patchFile = join(f.dshHome, "private-source.yml");
  await writeFile(patchFile, "token: first-secret\n");
  const first = await f.prepare({ kind: "configure", patchFile });
  assert.equal(first.patch, "token: first-secret\n");
  assert.equal(JSON.stringify(first.summary).includes("first-secret"), false);
  assert.equal(JSON.stringify(first.summary).includes(patchFile), false);
  await writeFile(patchFile, "token: second-secret\n");
  const second = await f.prepare({ kind: "configure", patchFile });
  assert.notEqual(first.contextHash, second.contextHash); assert.notEqual(first.resultHash, second.resultHash);
  assert.equal(await readFile(join(f.directory, "cordis.patch.yml"), "utf8"), f.state.authorBaseline.patch);
  await symlink(patchFile, join(f.dshHome, "link.yml"));
  await assert.rejects(f.prepare({ kind: "configure", patchFile: join(f.dshHome, "link.yml") }), /regular UTF-8/);
  await writeFile(patchFile, Buffer.from([0xff]));
  await assert.rejects(f.prepare({ kind: "configure", patchFile }), /regular UTF-8/);
});

test("edit conflict choices bind the intent and configuration file content", async t => {
  const f = await fixture(t), patchFile = join(f.dshHome, "private.yml");
  await writeFile(patchFile, "token: private-config\n");
  await writeFile(join(f.directory, "pnpm-workspace.yaml"), "local: workspace\n");
  let blocked: ProfileUpgradeBlockedError | undefined;
  try { await f.prepare({ kind: "configure", patchFile }); } catch (error) { assert.ok(error instanceof ProfileUpgradeBlockedError); blocked = error; }
  assert.ok(blocked?.contextHash);
  const resolutions = { contextHash: blocked.contextHash,
    choices: Object.fromEntries(blocked.summary.conflicts.map(item => [item.id, "local" as const])) };
  const ready = await f.prepare({ kind: "configure", patchFile }, resolutions);
  assert.equal(ready.patch, "token: private-config\n");
  await assert.rejects(f.prepare({ kind: "disable", packageName: "second-plugin" }, resolutions), /another intent/);
  await writeFile(patchFile, "token: changed\n");
  await assert.rejects(f.prepare({ kind: "configure", patchFile }, resolutions), /another intent/);
  assert.equal(JSON.stringify(blocked.summary).includes("private-config"), false);
});

test("local declaration edits preserve author policy and never read or remove stored values", async t => {
  const f = await fixture(t);
  const declared = await f.prepare({ kind: "input-declare", declaration: declaration("LOCAL_KEY") });
  assert.deepEqual(declared.localInputs, [declaration("LOCAL_KEY")]);
  assert.deepEqual(declared.inputs.map(item => item.key), ["AUTHOR_KEY", "LOCAL_KEY"]);
  assert.ok(declared.authorBaseline);
  assert.deepEqual(declared.authorBaseline.release.inputs, [declaration("AUTHOR_KEY")]);
  await assert.rejects(f.prepare({ kind: "input-declare", declaration: declaration("AUTHOR_KEY", false, true) }), /cannot weaken/);
  await assert.rejects(f.prepare({ kind: "input-declare", declaration: declaration("AUTHOR_KEY", true, false) }), /cannot weaken/);
  await assert.rejects(f.prepare({ kind: "input-remove", key: "AUTHOR_KEY" }), /author declarations are retained/);
  f.state.localInputs = [declaration("LOCAL_KEY")]; await f.save();
  const inputFile = join(f.dshHome, ".hub", "inputs", `${profile}.json`);
  await mkdir(dirname(inputFile)); await writeFile(inputFile, "sensitive-store-not-even-parsed");
  const removed = await f.prepare({ kind: "input-remove", key: "LOCAL_KEY" });
  assert.deepEqual(removed.localInputs, []);
  assert.equal(await readFile(inputFile, "utf8"), "sensitive-store-not-even-parsed");
  assert.equal(JSON.stringify(removed.summary).includes("sensitive-store"), false);
});

test("merging upgraded author declarations preserves local extras and strengthens conflicting policies", () => {
  const author = [declaration("SHARED_KEY", true, true)], local = [declaration("SHARED_KEY", false, false), declaration("PERSONAL_KEY", false, true)];
  assert.deepEqual(mergeProfileInputDeclarations(author, local), [declaration("SHARED_KEY", true, true), declaration("PERSONAL_KEY", false, true)]);
  assert.deepEqual(local[0], declaration("SHARED_KEY", false, false));
  assert.throws(() => mergeProfileInputDeclarations(author, [declaration("PATH")]), /reserved/);
});

test("edits require an exact recorded runtime and never fall back to global dsh", async t => {
  const f = await fixture(t);
  delete (f.state as any).runtime; delete f.state.authorBaseline.release.runtime; await f.save();
  await assert.rejects(f.prepare({ kind: "disable", packageName: "second-plugin" }), /exact recorded runtime/);
  f.state.runtime = { range: "*", version: "latest" }; await f.save();
  await assert.rejects(f.prepare({ kind: "disable", packageName: "second-plugin" }), /exact recorded runtime/);
});

test("configure repairs a missing patch, and remove/add repair unsupported sources entirely in memory", async t => {
  const f = await fixture(t), patchFile = join(f.dshHome, "replacement.yml");
  await rm(join(f.directory, "cordis.patch.yml")); await writeFile(patchFile, "replacement: private\n");
  const configured = await f.prepare({ kind: "configure", patchFile });
  assert.equal(configured.patch, "replacement: private\n");
  await assert.rejects(readFile(join(f.directory, "cordis.patch.yml")));
  await writeFile(join(f.directory, "cordis.patch.yml"), "[]\n");
  f.manifest.dependencies.broken = "file:../missing"; f.manifest.dsh.profile.bundles.push("broken"); await f.save();
  const removed = await f.prepare({ kind: "remove", packageName: "broken" });
  assert.equal(removed.dependencies.some(item => item.packageName === "broken"), false);
  assert.deepEqual(removed.localBundleOverrides.removed, ["broken"]);
  const replaced = await f.prepare({ kind: "add", bundle: { ...bundle("broken"), sourceKind: "github", installSpec: `github:owner/repo#${"a".repeat(40)}` } });
  assert.equal(replaced.dependencies.find(item => item.packageName === "broken")?.sourceKind, "github");
  assert.equal(JSON.parse(await readFile(join(f.directory, "package.json"), "utf8")).dependencies.broken, "file:../missing");
});

test("explicit disable/removal survive an author's removal and later reintroduction", async t => {
  const f = await fixture(t);
  (f.state as any).localBundleOverrides = { disabled: ["author-plugin"], removed: ["second-plugin"] };
  f.manifest.dsh.profile.bundles = []; delete f.manifest.dependencies["second-plugin"]; await f.save();
  const second = structuredClone(f.state.authorBaseline.release);
  second.version = "2.0.0"; second.bundles = [];
  const v2 = await prepareProfileUpgrade({ profile, slug, dshHome: f.dshHome, release: second, resolved: { profileVersion: "2.0.0", bundles: [] } });
  assert.equal(v2.status, "ready"); if (v2.status !== "ready") return;
  await writeFile(f.statePath, JSON.stringify({ ...f.state, hubProfile: { slug, version: "2.0.0" }, authorBaseline: v2.authorBaseline,
    bundles: v2.effectiveBundles, dependencies: v2.dependencies, localBundleOverrides: v2.localBundleOverrides }));
  await writeFile(join(f.directory, "package.json"), JSON.stringify(v2.manifest));
  const third = structuredClone(f.state.authorBaseline.release); third.version = "3.0.0";
  const v3 = await prepareProfileUpgrade({ profile, slug, dshHome: f.dshHome, release: third,
    resolved: { profileVersion: "3.0.0", bundles: f.state.dependencies } });
  assert.equal(v3.status, "ready"); if (v3.status !== "ready") return;
  assert.deepEqual(v3.effectiveBundles, []);
  assert.deepEqual(v3.dependencies.map(item => item.packageName), ["author-plugin"]);
  assert.deepEqual(v3.localBundleOverrides, { disabled: ["author-plugin"], removed: ["second-plugin"] });
  assert.ok(v3.summary.changes.some(item => item.action === "preserve_disabled"));
  assert.ok(v3.summary.changes.some(item => item.action === "preserve_removed"));
  assert.deepEqual(v3.authorBaseline.release.bundles.map(item => item.packageName), ["author-plugin", "second-plugin"]);
});

test("local bundle rules persist while disabled, constrain order and runtime, and expire with a different installed version", async t => {
  const f = await fixture(t), plugin = bundle("local-plugin");
  const rule: LocalBundleRule = { packageName: plugin.packageName, version: plugin.version, before: [], after: ["author-plugin"],
    compatibility: { dsh: "~1.0.0", node: ">=22", platforms: [], surfaces: ["any"], hmr: "restart" } };
  const added = await f.prepare({ kind: "add", bundle: plugin, rule });
  assert.deepEqual(added.localBundleRules, [rule]);
  const rules = validateLocalBundleRules({ bundles: [bundle("author-plugin")], dependencies: added.dependencies, rules: [rule], runtimeVersion: "1.0.1-rc.1" });
  assert.deepEqual(rules, [rule], "disable retains constraints for later enable and prerelease range checks include prereleases");
  assert.throws(() => validateLocalBundleRules({ bundles: [plugin, bundle("author-plugin")], dependencies: added.dependencies, rules: [rule], runtimeVersion: "1.0.0" }), /before\/after/);
  assert.throws(() => validateLocalBundleRules({ bundles: [], dependencies: added.dependencies, rules: [rule], runtimeVersion: "2.0.0" }), /DSH runtime/);
  assert.throws(() => validateLocalBundleRules({ bundles: [], dependencies: added.dependencies, rules: [rule], runtimeVersion: "1.0.0", nodeVersion: "20.0.0" }), /Node.js/);
  assert.throws(() => validateLocalBundleRules({ bundles: [], dependencies: added.dependencies,
    rules: [{ ...rule, compatibility: { ...rule.compatibility!, platforms: ["win32"] } }], runtimeVersion: "1.0.0", platform: "linux" }), /operating system/);
  assert.deepEqual(validateLocalBundleRules({ bundles: [], dependencies: [bundle("local-plugin", "2.0.0")], rules: [rule], runtimeVersion: "2.0.0" }), []);
});

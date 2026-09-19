import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import { inspectLocalRuntimeDefaults, prepareProfileEdit } from "../dist/profile-edit.js";
import { buildAuthorBaseline, prepareProfileUpgrade, scanProfileFiles, type ProfileUpgradePreparation } from "../dist/profile-upgrade.js";
import { profileLockPath } from "../dist/index.js";

const version = "1.0.0", base = "@deepseek-ai/dsh-base", web = "@deepseek-ai/dsh-web-app", headless = "@deepseek-ai/dsh-headless";
const localBundle = { packageName: "local-plugin", selector: "2.0.0", version: "2.0.0", sourceKind: "npm" as const, installSpec: "local-plugin@2.0.0" };
async function write(path: string, contents: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
async function packageMetadata(prefix: string, name: string, value: unknown) { await write(join(prefix, "node_modules", ...name.split("/"), "package.json"), JSON.stringify(value)); }
async function cachedRuntime(home: string, selectedVersion = version, builtinVersion = "4.5.6") {
  const prefix = join(home, ".hub", "runtimes", selectedVersion);
  await packageMetadata(prefix, "@deepseek-ai/dsh", { name: "@deepseek-ai/dsh", version: selectedVersion, bin: "bin/dsh.js", dependencies: { [base]: builtinVersion } });
  await write(join(prefix, "node_modules", "@deepseek-ai", "dsh", "bin", "dsh.js"), "throw new Error('must not execute a runtime during preview');\n");
  await packageMetadata(prefix, "@deepseek-ai/dsh-app-boot", { name: "@deepseek-ai/dsh-app-boot", version: selectedVersion, main: "lib/index.js" });
  const boot = join(prefix, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  await write(boot, `throw new Error('must not import runtime code');\nconst PROFILE_TEMPLATES = ${JSON.stringify({ web: [base, web], headless: [base, headless] })};\nconst DEFAULT_PROFILE_BUNDLES = ${JSON.stringify([base])};\n`);
  for (const name of [base, web, headless]) {
    await packageMetadata(prefix, name, { name, version: builtinVersion, dsh: { bundle: { patch: "patch.yml" } } });
    await write(join(prefix, "node_modules", ...name.split("/"), "patch.yml"), "[]\n");
  }
  return { prefix, boot };
}
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "dsh-local-module-")); t.after(() => rm(home, { recursive: true, force: true }));
  return { home, ...await cachedRuntime(home) };
}

test("runtime defaults read static templates without execution and pin actual builtin versions", async t => {
  const { home } = await fixture(t);
  for (const [profile, expected] of [["web", [base, web]], ["headless", [base, headless]], ["personal", [base]]] as const) {
    const descriptor = await inspectLocalRuntimeDefaults({ profile, runtimeVersion: version, dshHome: home });
    assert.deepEqual(descriptor.defaults.map(item => item.packageName), expected);
    assert.equal(descriptor.defaults[0]?.version, "4.5.6");
    assert.equal(descriptor.manifest.name, `dsh-profile-${profile}`);
  }
});

test("template expressions and builtin symlink escapes are rejected without evaluating code", async t => {
  const { home, prefix, boot } = await fixture(t);
  const original = await readFile(boot, "utf8");
  await writeFile(boot, original.replace(JSON.stringify([base]), "[globalThis.__do_not_execute() ]"));
  await assert.rejects(inspectLocalRuntimeDefaults({ profile: "personal", runtimeVersion: version, dshHome: home }), /unsupported or inconsistent/);
  await writeFile(boot, original);
  const outside = join(home, "outside"); await mkdir(outside);
  await writeFile(join(outside, "package.json"), JSON.stringify({ name: base, version: "4.5.6", dsh: { bundle: { patch: "patch.yml" } } }));
  await writeFile(join(outside, "patch.yml"), "[]\n");
  await rm(join(prefix, "node_modules", ...base.split("/")), { recursive: true });
  await symlink(outside, join(prefix, "node_modules", ...base.split("/")));
  await assert.rejects(inspectLocalRuntimeDefaults({ profile: "personal", runtimeVersion: version, dshHome: home }), /unsupported or inconsistent/);
});

test("cold cache previews give an exact preparation command and write nothing", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsh-local-cold-")); t.after(() => rm(home, { recursive: true, force: true }));
  const before = await scanProfileFiles(home);
  await assert.rejects(prepareProfileEdit({ profile: "personal", dshHome: home, intent: { kind: "add", bundle: localBundle } }), /--runtime-version/);
  await assert.rejects(prepareProfileEdit({ profile: "personal", dshHome: home, runtimeVersion: version, intent: { kind: "add", bundle: localBundle } }), /runtime prepare --runtime-version 1\.0\.0/);
  assert.deepEqual(await scanProfileFiles(home), before);
});

test("new local preparation has no invented author baseline and follows the final profile template", async t => {
  const { home } = await fixture(t);
  const prepared = await prepareProfileEdit({ profile: "web", dshHome: home, runtimeVersion: version, intent: { kind: "add", bundle: localBundle } });
  assert.equal(prepared.source, "local"); assert.equal(prepared.current, undefined); assert.equal(prepared.authorBaseline, undefined);
  assert.equal(prepared.resolved.profileVersion, "local");
  assert.deepEqual(prepared.effectiveBundles.map(item => item.packageName), [base, web, "local-plugin"]);
  assert.deepEqual(prepared.dependencies.map(item => item.packageName), ["local-plugin"]);
  await assert.rejects(readFile(join(home, "profiles", "web", "package.json")));
});

test("unmanaged adoption preserves personal values and fixes installed semver ranges without state writes", async t => {
  const { home } = await fixture(t), profile = "custom", directory = join(home, "profiles", profile);
  await write(join(directory, "package.json"), JSON.stringify({ name: "personal-private-name", personal: "private-value", dependencies: { helper: "^3.0.0" },
    dsh: { profile: { bundles: [base, web] } } }));
  await write(join(directory, "cordis.patch.yml"), "personal: private-patch\n");
  await write(join(directory, "pnpm-workspace.yaml"), "nodeLinker: hoisted\nstrictPeerDependencies: false\n");
  await packageMetadata(directory, "helper", { name: "helper", version: "3.4.5" });
  const before = await scanProfileFiles(directory);
  const prepared = await prepareProfileEdit({ profile, dshHome: home, runtimeVersion: version, intent: { kind: "add", bundle: localBundle } });
  assert.equal(prepared.manifest.personal, "private-value"); assert.equal(prepared.patch, "personal: private-patch\n");
  assert.deepEqual(prepared.effectiveBundles.map(item => item.packageName), [base, web, "local-plugin"]);
  assert.equal(prepared.dependencies.find(item => item.packageName === "helper")?.installSpec, "helper@3.4.5");
  assert.ok(prepared.preservedFiles.some(item => item.relativePath === "pnpm-workspace.yaml"));
  assert.equal(JSON.stringify(prepared.summary).includes("private-"), false);
  assert.deepEqual(await scanProfileFiles(directory), before);
  await assert.rejects(readFile(profileLockPath(profile, home)));
});

test("corrupted and legacy author states cannot be silently adopted as local", async t => {
  const { home } = await fixture(t), profile = "personal", statePath = profileLockPath(profile, home);
  for (const value of [null, [], {}, { schemaVersion: 2, profile, bundles: [], source: "local", hubProfile: { slug: "old-author", version: "1.0.0" } }]) {
    await write(statePath, JSON.stringify(value));
    await assert.rejects(prepareProfileEdit({ profile, dshHome: home, runtimeVersion: version, intent: { kind: "add", bundle: localBundle } }), /state|author baseline/);
  }
});

test("persisted local metadata supports another edit and an explicit runtime switch rebinds builtins", async t => {
  const { home } = await fixture(t), profile = "personal";
  const first = await prepareProfileEdit({ profile, dshHome: home, runtimeVersion: version, intent: { kind: "add", bundle: localBundle } });
  const directory = join(home, "profiles", profile);
  await write(join(directory, "package.json"), JSON.stringify(first.manifest)); await write(join(directory, "cordis.patch.yml"), first.patch);
  await write(profileLockPath(profile, home), JSON.stringify({ schemaVersion: 2, profile, source: "local", bundles: first.effectiveBundles,
    dependencies: first.dependencies, runtime: first.runtime, localInputs: first.localInputs, localBundleOverrides: first.localBundleOverrides }));
  const args = { profile, dshHome: home, intent: { kind: "disable" as const, packageName: "local-plugin" } };
  const implicit = await prepareProfileEdit(args), explicit = await prepareProfileEdit({ ...args, runtimeVersion: version });
  assert.equal(implicit.contextHash, explicit.contextHash); assert.equal(implicit.resultHash, explicit.resultHash);
  await cachedRuntime(home, "2.0.0", "7.8.9");
  const changed = await prepareProfileEdit({ ...args, runtimeVersion: "2.0.0" });
  assert.equal(changed.effectiveBundles.find(item => item.packageName === base)?.version, "7.8.9");
  assert.notEqual(changed.contextHash, implicit.contextHash);
});

test("local-to-author adoption conflicts honestly and never stores personal configuration as the author baseline", async t => {
  const { home } = await fixture(t), profile = "personal", directory = join(home, "profiles", profile);
  await write(join(directory, "package.json"), JSON.stringify({ name: "dsh-hub-personal", private: true, dependencies: {}, personal: "private-local-value", dsh: { profile: { bundles: [base] } } }));
  await write(join(directory, "cordis.patch.yml"), "personal: private-patch\n");
  const builtin = { packageName: base, selector: "4.5.6", version: "4.5.6", sourceKind: "builtin" as const, installSpec: `builtin:${base}@4.5.6` };
  const release: HubProfileVersion = { schemaVersion: 1, version: "1.0.0", name: "Author", description: "", dsh: "*", runtime: { range: "*", version },
    bundles: [{ ...builtin, before: [], after: [] }], inputs: [], patch: [], patchYaml: "author: value\n", publishedAt: "2026-09-17T00:00:00Z" };
  const args = { profile, slug: "author", dshHome: home, release, resolved: { profileVersion: release.version, bundles: [builtin] } };
  const preview = await prepareProfileUpgrade(args);
  assert.equal(preview.status, "conflicted"); assert.equal(JSON.stringify(preview).includes("private-patch"), false);
  const prepared = await prepareProfileUpgrade({ ...args, resolutions: { contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "local" as const])) } });
  assert.equal(prepared.status, "ready"); if (prepared.status !== "ready") return;
  assert.equal(prepared.manifest.personal, "private-local-value"); assert.equal(prepared.patch, "personal: private-patch\n");
  assert.equal(JSON.stringify(prepared.authorBaseline).includes("private-"), false);
  assert.equal(prepared.authorBaseline.patch, "author: value\n");
});

test("descriptor metadata drift changes the prepared context and unknown in-box bundles can be adopted", async t => {
  const { home, prefix } = await fixture(t), profile = "custom", extra = "@example/in-box";
  await packageMetadata(prefix, extra, { name: extra, version: "3.2.1", dsh: { bundle: { patch: "patch.yml" } } });
  await write(join(prefix, "node_modules", ...extra.split("/"), "patch.yml"), "[]\n");
  await write(join(home, "profiles", profile, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [base, extra] } } }));
  const args = { profile, dshHome: home, runtimeVersion: version, intent: { kind: "add" as const, bundle: localBundle } };
  const before = await prepareProfileEdit(args);
  assert.equal(before.effectiveBundles.find(item => item.packageName === extra)?.version, "3.2.1");
  await packageMetadata(prefix, extra, { name: extra, version: "3.2.2", dsh: { bundle: { patch: "patch.yml" } } });
  const after = await prepareProfileEdit(args);
  assert.notEqual(before.contextHash, after.contextHash); assert.equal(after.effectiveBundles.find(item => item.packageName === extra)?.version, "3.2.2");
});

function authorTarget(releaseVersion = "1.0.0", runtimeVersion = version, builtinVersion = "4.5.6") {
  const builtin = { packageName: base, selector: builtinVersion, version: builtinVersion, sourceKind: "builtin" as const, installSpec: `builtin:${base}@${builtinVersion}` };
  const release: HubProfileVersion = { schemaVersion: 1, version: releaseVersion, name: "Author", description: "", dsh: "*",
    runtime: { range: "*", version: runtimeVersion }, bundles: [{ ...builtin, before: [], after: [] }], inputs: [], patch: [], patchYaml: "[]\n",
    publishedAt: "2026-09-17T00:00:00Z" };
  return { release, resolved: { profileVersion: releaseVersion, bundles: [builtin] } };
}
async function extraBuiltinProfile(home: string, profile = "personal") {
  const directory = join(home, "profiles", profile);
  await write(join(directory, "package.json"), JSON.stringify({ name: `dsh-hub-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [base, web] } } }));
  await write(join(directory, "cordis.patch.yml"), "[]\n");
  return directory;
}
async function saveAuthorPreparation(home: string, profile: string, prepared: Extract<ProfileUpgradePreparation, { status: "ready" }>) {
  const directory = join(home, "profiles", profile), baseline = prepared.authorBaseline;
  await write(join(directory, "package.json"), JSON.stringify(prepared.manifest));
  await write(join(directory, "cordis.patch.yml"), prepared.patch);
  await write(profileLockPath(profile, home), JSON.stringify({ schemaVersion: 2, profile, source: "author", bundles: prepared.effectiveBundles,
    dependencies: prepared.dependencies, runtime: baseline.release.runtime, authorBaseline: baseline, contentHash: baseline.release.contentHash,
    hubProfile: { slug: baseline.slug, version: baseline.release.version }, localBundleOverrides: prepared.localBundleOverrides }));
}

test("joining a base-only author retains the local web builtin across later releases and runtime changes", async t => {
  const { home } = await fixture(t), profile = "personal", directory = await extraBuiltinProfile(home, profile);
  const before = await scanProfileFiles(directory), args = { profile, slug: "author", dshHome: home, ...authorTarget() };
  const preview = await prepareProfileUpgrade(args);
  assert.equal(preview.status, "conflicted");
  assert.ok(preview.summary.conflicts.some(item => item.path === "package.json#/dsh/profile/bundles"));
  const prepared = await prepareProfileUpgrade({ ...args, resolutions: { contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "local" as const])) } });
  assert.equal(prepared.status, "ready"); if (prepared.status !== "ready") return;
  assert.deepEqual(prepared.effectiveBundles.map(item => [item.packageName, item.version]), [[base, "4.5.6"], [web, "4.5.6"]]);
  assert.deepEqual(prepared.authorBaseline.resolved.bundles.map(item => item.packageName), [base]);
  assert.ok(prepared.summary.changes.some(item => item.action === "retain_target_runtime_builtin"));
  assert.deepEqual(await scanProfileFiles(directory), before, "previews leave the active Profile unchanged");
  await saveAuthorPreparation(home, profile, prepared);

  const second = await prepareProfileUpgrade({ ...args, ...authorTarget("2.0.0") });
  assert.equal(second.status, "ready"); if (second.status !== "ready") return;
  assert.deepEqual(second.effectiveBundles.map(item => item.packageName), [base, web]);
  await saveAuthorPreparation(home, profile, second);
  await cachedRuntime(home, "2.0.0", "7.8.9");
  const third = await prepareProfileUpgrade({ ...args, ...authorTarget("3.0.0", "2.0.0", "7.8.9") });
  assert.equal(third.status, "ready"); if (third.status !== "ready") return;
  assert.deepEqual(third.effectiveBundles.map(item => [item.packageName, item.version]), [[base, "7.8.9"], [web, "7.8.9"]]);
  assert.deepEqual(third.authorBaseline.resolved.bundles.map(item => item.packageName), [base]);
});

test("extra builtin runtime metadata binds author upgrade choices without inventing author content", async t => {
  const { home, prefix } = await fixture(t), profile = "personal"; await extraBuiltinProfile(home, profile);
  const args = { profile, slug: "author", dshHome: home, ...authorTarget() };
  const preview = await prepareProfileUpgrade(args);
  const resolutions = { contextHash: preview.contextHash, choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "local" as const])) };
  await packageMetadata(prefix, web, { name: web, version: "4.5.7", dsh: { bundle: { patch: "patch.yml" } } });
  const stale = await prepareProfileUpgrade({ ...args, resolutions });
  assert.equal(stale.status, "conflicted"); assert.notEqual(stale.contextHash, preview.contextHash);
  assert.ok(stale.summary.conflicts.some(item => item.kind === "resolutions"));
  const fresh = await prepareProfileUpgrade(args);
  const ready = await prepareProfileUpgrade({ ...args, resolutions: { contextHash: fresh.contextHash,
    choices: Object.fromEntries(fresh.summary.conflicts.map(item => [item.id, "local" as const])) } });
  assert.equal(ready.status, "ready"); if (ready.status !== "ready") return;
  assert.equal(ready.effectiveBundles.find(item => item.packageName === web)?.version, "4.5.7");
  assert.equal(ready.authorBaseline.resolved.bundles.some(item => item.packageName === web), false);
});

test("only retaining extra builtins requires the target runtime cache and upstream choices work without it", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsh-author-cold-")); t.after(() => rm(home, { recursive: true, force: true }));
  const profile = "personal", directory = await extraBuiltinProfile(home, profile), args = { profile, slug: "author", dshHome: home, ...authorTarget() };
  const before = await scanProfileFiles(home);
  const preview = await prepareProfileUpgrade(args);
  assert.equal(preview.status, "conflicted");
  await assert.rejects(prepareProfileUpgrade({ ...args, resolutions: { contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "local" as const])) } }), /runtime prepare --runtime-version 1\.0\.0/);
  const upstream = await prepareProfileUpgrade({ ...args, resolutions: { contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "upstream" as const])) } });
  assert.equal(upstream.status, "ready");
  if (upstream.status === "ready") assert.deepEqual(upstream.effectiveBundles.map(item => item.packageName), [base]);
  assert.deepEqual(await scanProfileFiles(home), before);
  await cachedRuntime(home);
  const stale = await prepareProfileUpgrade({ ...args, resolutions: { contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "local" as const])) } });
  assert.equal(stale.status, "conflicted"); assert.notEqual(stale.contextHash, preview.contextHash);
  assert.ok(stale.summary.conflicts.some(item => item.kind === "resolutions"), "preparing a cache must invalidate choices made without that metadata");
  await rm(join(home, ".hub", "runtimes"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); manifest.dsh.profile.bundles = [base];
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  const ready = await prepareProfileUpgrade(args);
  assert.equal(ready.status, "ready", "a matching author-only preview must not require a prepared runtime");
});

test("an unchanged author builtin removed by the next release needs no target runtime cache", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsh-author-removal-")); t.after(() => rm(home, { recursive: true, force: true }));
  const profile = "personal", directory = join(home, "profiles", profile), original = authorTarget();
  const originalWeb = { packageName: web, selector: "4.5.6", version: "4.5.6", sourceKind: "builtin" as const, installSpec: `builtin:${web}@4.5.6` };
  original.release.bundles.push({ ...originalWeb, before: [], after: [] }); original.resolved.bundles.push(originalWeb);
  const baseline = buildAuthorBaseline({ profile, slug: "author", ...original });
  await write(join(directory, "package.json"), JSON.stringify(baseline.manifest)); await write(join(directory, "cordis.patch.yml"), baseline.patch);
  await write(profileLockPath(profile, home), JSON.stringify({ schemaVersion: 2, profile, source: "author", hubProfile: { slug: "author", version: "1.0.0" },
    bundles: original.resolved.bundles, runtime: original.release.runtime, authorBaseline: baseline }));
  const before = await scanProfileFiles(home);
  const prepared = await prepareProfileUpgrade({ profile, slug: "author", dshHome: home, ...authorTarget("2.0.0", "2.0.0", "7.8.9") });
  assert.equal(prepared.status, "ready");
  if (prepared.status === "ready") assert.deepEqual(prepared.effectiveBundles.map(item => item.packageName), [base]);
  assert.deepEqual(await scanProfileFiles(home), before);
});

test("a removed target runtime builtin blocks with recovery guidance and a local disable repairs the upgrade", async t => {
  const { home } = await fixture(t), profile = "personal"; await extraBuiltinProfile(home, profile);
  const args = { profile, slug: "author", dshHome: home, ...authorTarget() }, preview = await prepareProfileUpgrade(args);
  const original = await prepareProfileUpgrade({ ...args, resolutions: { contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "local" as const])) } });
  assert.equal(original.status, "ready"); if (original.status !== "ready") return;
  await saveAuthorPreparation(home, profile, original);
  const targetCache = await cachedRuntime(home, "2.0.0", "7.8.9");
  await writeFile(targetCache.boot, `const PROFILE_TEMPLATES = {};\nconst DEFAULT_PROFILE_BUNDLES = ${JSON.stringify([base])};\n`);
  await rm(join(targetCache.prefix, "node_modules", ...web.split("/")), { recursive: true });
  const target = { ...args, ...authorTarget("2.0.0", "2.0.0", "7.8.9") }, blocked = await prepareProfileUpgrade(target);
  assert.equal(blocked.status, "conflicted");
  assert.ok(blocked.summary.conflicts.some(item => item.reason?.includes(`profile plugin disable ${web} --profile ${profile}`)));
  assert.equal(Object.hasOwn(blocked, "manifest"), false);
  const disabled = await prepareProfileEdit({ profile, dshHome: home, intent: { kind: "disable", packageName: web } });
  assert.ok(disabled.authorBaseline);
  await saveAuthorPreparation(home, profile, { ...disabled, authorBaseline: disabled.authorBaseline, summary: disabled.upgradeSummary });
  const repaired = await prepareProfileUpgrade(target);
  assert.equal(repaired.status, "ready");
  if (repaired.status === "ready") assert.deepEqual(repaired.effectiveBundles.map(item => item.packageName), [base]);
});

test("an extra builtin can be disabled and re-enabled after adopting an author without changing its baseline", async t => {
  const { home, prefix } = await fixture(t), profile = "personal"; await extraBuiltinProfile(home, profile);
  const args = { profile, slug: "author", dshHome: home, ...authorTarget() }, preview = await prepareProfileUpgrade(args);
  const original = await prepareProfileUpgrade({ ...args, resolutions: { contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map(item => [item.id, "local" as const])) } });
  assert.equal(original.status, "ready"); if (original.status !== "ready") return;
  await saveAuthorPreparation(home, profile, original);
  const disabled = await prepareProfileEdit({ profile, dshHome: home, intent: { kind: "disable", packageName: web } });
  assert.ok(disabled.authorBaseline);
  await saveAuthorPreparation(home, profile, { ...disabled, authorBaseline: disabled.authorBaseline, summary: disabled.upgradeSummary });
  const enabled = await prepareProfileEdit({ profile, dshHome: home, intent: { kind: "enable", packageName: web } });
  assert.deepEqual(enabled.effectiveBundles.map(item => item.packageName), [base, web]);
  assert.deepEqual(enabled.authorBaseline, original.authorBaseline);
  assert.equal(enabled.localBundleOverrides.disabled.includes(web), false);
  await packageMetadata(prefix, web, { name: web, version: "4.5.7", dsh: { bundle: { patch: "patch.yml" } } });
  const changed = await prepareProfileEdit({ profile, dshHome: home, intent: { kind: "enable", packageName: web } });
  assert.notEqual(changed.contextHash, enabled.contextHash); assert.notEqual(changed.resultHash, enabled.resultHash);
  assert.equal(changed.effectiveBundles.find(item => item.packageName === web)?.version, "4.5.7");
});

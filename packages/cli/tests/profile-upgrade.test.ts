import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import type { ResolvedProfile } from "@dsh-plugin-hub/registry";
import { buildAuthorBaseline, prepareProfileUpgrade, scanProfileFiles, type ProfileUpgradeResolutions } from "../dist/profile-upgrade.js";
import { profileLockPath } from "../dist/index.js";

const profile = "private-research", slug = "author-research";
function release(version = "1.0.0", packageVersion = "1.0.0", patch = "- id: author\n") {
  const bundle = { packageName: "author-plugin", selector: packageVersion, version: packageVersion,
    sourceKind: "npm" as const, installSpec: `author-plugin@${packageVersion}` };
  const resolved: ResolvedProfile = { profileVersion: version, bundles: [bundle] };
  const release: HubProfileVersion = { schemaVersion: 1, version, name: "Research", description: "", dsh: "*",
    bundles: [{ ...bundle, before: [], after: [] }], patch: [], patchYaml: patch, inputs: [],
    publishedAt: "2026-09-17T00:00:00Z", contentHash: `sha256:${version.startsWith("1") ? "1".repeat(64) : "2".repeat(64)}` };
  return { release, resolved };
}
async function setup(t: test.TestContext, legacy = false) {
  const dshHome = await mkdtemp(join(tmpdir(), "dsh-upgrade-module-"));
  t.after(() => rm(dshHome, { recursive: true, force: true }));
  const directory = join(dshHome, "profiles", profile), statePath = profileLockPath(profile, dshHome);
  await mkdir(directory, { recursive: true }); await mkdir(dirname(statePath), { recursive: true });
  const previous = release(), baseline = buildAuthorBaseline({ profile, slug, ...previous });
  const manifest = structuredClone(baseline.manifest);
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "cordis.patch.yml"), baseline.patch);
  const state = { schemaVersion: 2, profile, hubProfile: { slug, version: previous.release.version },
    contentHash: previous.release.contentHash, bundles: previous.resolved.bundles,
    ...(legacy ? {} : { authorBaseline: baseline }) };
  await writeFile(statePath, JSON.stringify(state));
  const target = release("2.0.0", "2.0.0");
  const prepare = (resolutions?: ProfileUpgradeResolutions) => prepareProfileUpgrade({ profile, slug, dshHome, ...target, resolutions });
  const save = () => writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  return { dshHome, directory, statePath, previous, target, baseline, manifest, save, prepare };
}
async function installMetadata(directory: string, name: string, version: string) {
  const path = join(directory, "node_modules", name, "package.json");
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ name, version }));
}

test("author baseline is a detached normalized template and preserves raw YAML", () => {
  const source = release();
  const baseline = buildAuthorBaseline({ profile, slug, ...source });
  assert.deepEqual(baseline.manifest, { name: `dsh-hub-${profile}`, private: true, dependencies: { "author-plugin": "1.0.0" }, dsh: { profile: { bundles: ["author-plugin"] } } });
  assert.equal(baseline.patch, source.release.patchYaml);
  baseline.release.bundles[0]!.selector = "changed";
  baseline.resolved.bundles[0]!.version = "changed";
  assert.equal(source.release.bundles[0]!.selector, "1.0.0");
  assert.equal(source.resolved.bundles[0]!.version, "1.0.0");
  assert.equal(Object.hasOwn(buildAuthorBaseline({ profile, ...source }), "slug"), false);
  assert.throws(() => buildAuthorBaseline({ profile, ...source, resolved: { ...source.resolved, profileVersion: "2.0.0" } }), /do not match/);
});

test("a damaged or locally contaminated author sidecar requires recovering the real baseline", async t => {
  const fixture = await setup(t);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  const clean = structuredClone(state.authorBaseline);
  for (const authorBaseline of [{ schemaVersion: 1, profile }, { ...clean, patch: "private-local-patch\n" },
    { ...clean, manifest: { ...clean.manifest, personal: "private-value" } }]) {
    await writeFile(fixture.statePath, JSON.stringify({ ...state, authorBaseline }));
    const prepared = await fixture.prepare();
    assert.equal(prepared.status, "baseline_required");
    assert.equal(JSON.stringify(prepared).includes("private-value"), false);
    assert.equal(JSON.stringify(prepared).includes("private-local-patch"), false);
  }
});

test("extra plugins and ordinary dependencies install with fixed sources while author changes independently", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  manifest.dependencies["personal-plugin"] = "^3.0.0";
  manifest.dependencies["personal-helper"] = "4.2.0";
  manifest.dsh.profile.bundles.push("personal-plugin");
  manifest.personal = { token: "secret-never-in-summary" };
  await fixture.save(); await installMetadata(fixture.directory, "personal-plugin", "3.4.5");
  await writeFile(join(fixture.directory, "cordis.patch.yml"), "- id: personal-secret\n");
  const before = await scanProfileFiles(fixture.directory), prepared = await fixture.prepare();
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.deepEqual(prepared.dependencies.map(item => [item.packageName, item.installSpec]), [
    ["author-plugin", "author-plugin@2.0.0"], ["personal-helper", "personal-helper@4.2.0"], ["personal-plugin", "personal-plugin@3.4.5"],
  ]);
  assert.deepEqual(prepared.effectiveBundles.map(item => item.packageName), ["author-plugin", "personal-plugin"]);
  assert.equal((prepared.manifest.dependencies as any)["personal-plugin"], "3.4.5");
  assert.equal(prepared.patch, "- id: personal-secret\n");
  assert.equal(JSON.stringify(prepared.summary).includes("secret"), false);
  assert.equal(JSON.stringify(prepared.authorBaseline).includes("personal"), false);
  assert.deepEqual(await scanProfileFiles(fixture.directory), before, "preparation is read-only");
  assert.equal((await fixture.prepare()).contextHash, prepared.contextHash);
});

test("dependency range without matching installed evidence blocks rather than guessing", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  manifest.dependencies.helper = "^3.0.0"; await fixture.save();
  for (const installedVersion of [undefined, "2.9.9"]) {
    if (installedVersion) await installMetadata(fixture.directory, "helper", installedVersion);
    const prepared = await fixture.prepare();
    assert.equal(prepared.status, "conflicted");
    assert.equal(prepared.summary.conflicts[0]?.kind, "dependency");
    assert.equal(Object.hasOwn(prepared, "manifest"), false);
  }
});

test("unsupported floating git, file and alias sources do not expose their values", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  for (const selector of ["git+https://secret@example.invalid/repo#main", "file:/private/secret", "npm:secret-package@1.0.0", "latest"]) {
    manifest.dependencies.helper = selector; await fixture.save();
    const prepared = await fixture.prepare();
    assert.equal(prepared.status, "conflicted");
    assert.equal(JSON.stringify(prepared).includes(selector), false);
  }
});

test("manifest and atomic YAML conflicts resolve only with choices bound to the current context", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  manifest.dependencies["author-plugin"] = "3.0.0"; await fixture.save();
  await writeFile(join(fixture.directory, "cordis.patch.yml"), "private: secret-local-value\n");
  fixture.target.release.patchYaml = "author: new\n";
  const conflicted = await fixture.prepare();
  assert.equal(conflicted.status, "conflicted");
  assert.equal(conflicted.summary.conflicts.length, 2);
  assert.equal(JSON.stringify(conflicted).includes("secret-local-value"), false);
  const resolutions: ProfileUpgradeResolutions = { contextHash: conflicted.contextHash,
    choices: Object.fromEntries(conflicted.summary.conflicts.map(item => [item.id, "local"])) };
  const resolved = await fixture.prepare(resolutions);
  assert.equal(resolved.status, "ready");
  if (resolved.status === "ready") {
    assert.equal(resolved.patch, "private: secret-local-value\n");
    assert.equal((resolved.manifest.dependencies as any)["author-plugin"], "3.0.0");
    assert.equal(resolved.authorBaseline.patch, "author: new\n");
  }
  const stale = await fixture.prepare({ ...resolutions, contextHash: `sha256:${"0".repeat(64)}` });
  assert.equal(stale.status, "conflicted");
  assert.ok(stale.summary.conflicts.some(item => item.kind === "resolutions"));
  const unknown = await fixture.prepare({ ...resolutions, choices: { ...resolutions.choices, unknown: "local" } });
  assert.equal(unknown.status, "conflicted");
});

test("legacy state needs matching public release, version, hash and resolutions", async t => {
  const fixture = await setup(t, true);
  assert.equal((await fixture.prepare()).status, "baseline_required");
  const args = { profile, slug, dshHome: fixture.dshHome, ...fixture.target, baselineRelease: fixture.previous.release, baselineResolved: fixture.previous.resolved };
  args.baselineResolved.bundles[0]!.integrity = undefined;
  assert.equal((await prepareProfileUpgrade(args)).status, "ready");
  const wrong = structuredClone(fixture.previous.release); wrong.contentHash = `sha256:${"0".repeat(64)}`;
  assert.equal((await prepareProfileUpgrade({ ...args, baselineRelease: wrong })).status, "baseline_required");
  const changed = structuredClone(fixture.previous.resolved); changed.bundles[0]!.version = "9.0.0";
  assert.equal((await prepareProfileUpgrade({ ...args, baselineResolved: changed })).status, "baseline_required");
});

test("deleting generated workspace is an explicit keep-deletion choice while deleting a lock requires rebuilding", async t => {
  const fixture = await setup(t);
  for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) await writeFile(join(fixture.directory, name), "generated: true\n");
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.generatedFiles = (await scanProfileFiles(fixture.directory)).filter(item => item.relativePath.startsWith("pnpm-"));
  await writeFile(fixture.statePath, JSON.stringify(state));
  for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) await rm(join(fixture.directory, name));
  const prepared = await fixture.prepare();
  assert.equal(prepared.status, "conflicted");
  const lock = prepared.summary.conflicts.find(item => item.path === "pnpm-lock.yaml")!;
  const workspace = prepared.summary.conflicts.find(item => item.path === "pnpm-workspace.yaml")!;
  assert.deepEqual(lock.choices, ["upstream"]);
  assert.deepEqual(workspace.choices, ["local", "upstream"]);
  const resolved = await fixture.prepare({ contextHash: prepared.contextHash, choices: { [lock.id]: "upstream", [workspace.id]: "local" } });
  assert.equal(resolved.status, "ready");
  if (resolved.status === "ready") assert.deepEqual(resolved.removedFiles, ["pnpm-workspace.yaml"]);
});

test("local order must continue to satisfy target author constraints", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  const bundle = { packageName: "second-plugin", version: "1.0.0", selector: "1.0.0", installSpec: "second-plugin@1.0.0", sourceKind: "npm" as const };
  fixture.target.release.bundles.push({ ...bundle, before: [], after: ["author-plugin"] });
  fixture.target.resolved.bundles.push(bundle);
  manifest.dependencies["second-plugin"] = "1.0.0";
  manifest.dsh.profile.bundles = ["second-plugin", "author-plugin"];
  await fixture.save();
  const prepared = await fixture.prepare();
  assert.equal(prepared.status, "conflicted");
  const selected = await fixture.prepare({ contextHash: prepared.contextHash,
    choices: Object.fromEntries(prepared.summary.conflicts.map(item => [item.id, "local"])) });
  assert.equal(selected.status, "conflicted");
  assert.ok(selected.summary.conflicts.some(item => item.kind === "layout" && item.reason?.includes("before/after")));
});

test("range and GitHub metadata must name the exact requested package", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  for (const selector of ["^3.0.0", `github:owner/repo#${"a".repeat(40)}`]) {
    manifest.dependencies.helper = selector; await fixture.save();
    await installMetadata(fixture.directory, "helper", "3.1.0");
    for (const metadata of [{ version: "3.1.0" }, { name: "other-package", version: "3.1.0" }]) {
      await writeFile(join(fixture.directory, "node_modules", "helper", "package.json"), JSON.stringify(metadata));
      assert.equal((await fixture.prepare()).status, "conflicted");
    }
  }
});

test("unsupported dependency sections cannot survive as falsely installed packages", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  for (const section of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    manifest[section] = { helper: "1.0.0" }; await fixture.save();
    const prepared = await fixture.prepare();
    assert.equal(prepared.status, "conflicted");
    assert.ok(prepared.summary.conflicts.some(item => item.path === `package.json#/${section}`));
    delete manifest[section];
  }
});

test("local import replaces source identity without inheriting the previous Hub slug", async t => {
  const fixture = await setup(t);
  const prepared = await prepareProfileUpgrade({ profile, dshHome: fixture.dshHome, ...fixture.target });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.authorBaseline.slug, undefined);
  assert.equal(prepared.summary.target.slug, undefined);
  assert.equal(prepared.summary.target.source, "local_import");
  assert.equal(prepared.summary.baseline.slug, slug);
});

test("generated locks require explicit rebuilding; workspace modifications can survive after installation", async t => {
  const fixture = await setup(t);
  await writeFile(join(fixture.directory, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  await writeFile(join(fixture.directory, "pnpm-workspace.yaml"), "nodeLinker: hoisted\n");
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.generatedFiles = (await scanProfileFiles(fixture.directory)).filter(item => item.relativePath.startsWith("pnpm-"));
  await writeFile(fixture.statePath, JSON.stringify(state));
  assert.equal((await fixture.prepare()).status, "ready");
  await writeFile(join(fixture.directory, "pnpm-lock.yaml"), "local-lock-value: private\n");
  await writeFile(join(fixture.directory, "pnpm-workspace.yaml"), "local-workspace-value: private\n");
  const prepared = await fixture.prepare();
  assert.equal(prepared.status, "conflicted");
  const lock = prepared.summary.conflicts.find(item => item.path === "pnpm-lock.yaml")!;
  const workspace = prepared.summary.conflicts.find(item => item.path === "pnpm-workspace.yaml")!;
  assert.deepEqual(lock.choices, ["upstream"]);
  assert.deepEqual(workspace.choices, ["local", "upstream"]);
  const resolved = await fixture.prepare({ contextHash: prepared.contextHash, choices: { [lock.id]: "upstream", [workspace.id]: "local" } });
  assert.equal(resolved.status, "ready");
  if (resolved.status === "ready") {
    assert.equal(resolved.preservedFiles.some(item => item.relativePath === "pnpm-workspace.yaml"), true);
    assert.equal(resolved.preservedFiles.some(item => item.relativePath === "pnpm-lock.yaml"), false);
  }
  const forbidden = await fixture.prepare({ contextHash: prepared.contextHash, choices: { [lock.id]: "local", [workspace.id]: "local" } });
  assert.equal(forbidden.status, "conflicted");
});

test("files lacking an old generated baseline also require an explicit decision", async t => {
  const fixture = await setup(t);
  await writeFile(join(fixture.directory, "package-lock.json"), "{}\n");
  const prepared = await fixture.prepare();
  assert.equal(prepared.status, "conflicted");
  assert.equal(prepared.summary.conflicts[0]?.path, "package-lock.json");
});

test("VCS, empty directories, permissions and symlink metadata enter the preservation plan and context", async t => {
  const fixture = await setup(t);
  await mkdir(join(fixture.directory, ".git")); await writeFile(join(fixture.directory, ".git", "config"), "private git config");
  await mkdir(join(fixture.directory, "empty")); await chmod(join(fixture.directory, "empty"), 0o750);
  await symlink("/outside/do-not-follow", join(fixture.directory, "external"));
  const prepared = await fixture.prepare();
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.preservedFiles.find(item => item.relativePath === "external")?.kind, "symlink");
  assert.equal(prepared.preservedFiles.find(item => item.relativePath === "empty")?.mode, 0o750);
  assert.ok(prepared.preservedFiles.some(item => item.relativePath === ".git/config"));
  assert.equal(JSON.stringify(prepared.summary).includes("private git config"), false);
  assert.equal(JSON.stringify(prepared.summary).includes("/outside/"), false);
  await writeFile(join(fixture.directory, ".git", "config"), "changed");
  const changed = await fixture.prepare();
  assert.equal(changed.expectedFingerprint, prepared.expectedFingerprint, "existing installation fingerprint excludes VCS");
  assert.notEqual(changed.contextHash, prepared.contextHash, "upgrade context additionally binds VCS");
});

test("installed metadata that pins a local range is part of the context", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  manifest.dependencies.helper = "^3.0.0"; await fixture.save(); await installMetadata(fixture.directory, "helper", "3.1.0");
  const before = await fixture.prepare();
  await installMetadata(fixture.directory, "helper", "3.2.0");
  const after = await fixture.prepare();
  assert.equal(before.status, "ready"); assert.equal(after.status, "ready");
  assert.equal(before.expectedFingerprint, after.expectedFingerprint);
  assert.notEqual(before.contextHash, after.contextHash);
});

test("invalid effective layout and deletion of a required patch block installation", async t => {
  const fixture = await setup(t), manifest = fixture.manifest as any;
  manifest.dsh.profile.bundles.push("uninstalled-bundle"); await fixture.save();
  await rm(join(fixture.directory, "cordis.patch.yml"));
  const result = await fixture.prepare();
  assert.equal(result.status, "conflicted");
  assert.ok(result.summary.conflicts.some(item => item.kind === "layout"));
  assert.equal(Object.hasOwn(result, "manifest"), false);
});

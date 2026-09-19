import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import type { ResolvedProfile, ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { applyProfileEdit, installResolvedProfile, profileLockPath, rollbackProfile,
  type DshInstallCommand } from "../dist/index.js";
import { prepareProfileEdit } from "../dist/profile-edit.js";
import { doctorProfile } from "../dist/profile-lifecycle.js";
import { directoryFingerprint } from "../dist/profile-files.js";
import { listProfileInputs, setProfileInput } from "../dist/profile-inputs.js";

// Filesystem integration fixture, not an official runtime or registry test.
// Its installer models the official runtime's reconcilePlugins: every installed
// dependency declaring dsh.bundle.patch is appended to the enabled layer list.
const PROFILE = "editing";
const SLUG = "author-editing";
const RUNTIME = "0.1.0";
const BASE = "@deepseek-ai/dsh-base";
const FIRST = "dsh-author-first";
const SECOND = "dsh-author-second";
const LOCAL = "dsh-personal-plugin";
const INPUT = "PROFILE_EDIT_LOCAL_TOKEN";
const SECRET = "fixture-private-input-never-in-summary";
const PATCH = "- id: personal\n  config:\n    workspace: fixture-private-edit-config\n";
type EditIntent = Parameters<typeof prepareProfileEdit>[0]["intent"];
type EditOptions = Parameters<typeof applyProfileEdit>[0];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function bundle(packageName: string, version = "1.0.0"): ResolvedProfileBundle {
  return { packageName, selector: version, version, installSpec: `${packageName}@${version}`, sourceKind: "npm" };
}

function author(version = "1.0.0", firstVersion = "1.0.0") {
  const builtin: ResolvedProfileBundle = { packageName: BASE, selector: RUNTIME, version: RUNTIME,
    installSpec: `builtin:${BASE}@${RUNTIME}`, sourceKind: "builtin" };
  const bundles = [builtin, bundle(FIRST, firstVersion), bundle(SECOND)];
  const release: HubProfileVersion = { schemaVersion: 1, version, name: "Author editing fixture", description: "",
    dsh: "*", runtime: { range: "*", version: RUNTIME },
    bundles: bundles.map(item => ({ ...item, before: [], after: [] })),
    patch: [], patchYaml: "[]\n", inputs: [], publishedAt: "2026-09-17T00:00:00Z" };
  release.contentHash = `sha256:${createHash("sha256").update(canonical(release)).digest("hex")}`;
  const resolved: ResolvedProfile = { profileVersion: version, bundles };
  return { release, resolved };
}

async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }

async function installedPackage(directory: string, name: string, version: string) {
  const path = join(directory, "node_modules", ...name.split("/"));
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version, main: "index.cjs", dsh: { bundle: { patch: "patch.yml" } } }));
  await writeFile(join(path, "patch.yml"), "[]\n");
  await writeFile(join(path, "index.cjs"), `module.exports = ${JSON.stringify({ name, version })};\n`);
}

function filesystemInstaller(home: string) {
  const calls: Array<{ name: string; version: string; command: DshInstallCommand }> = [];
  const loaded: string[][] = [];
  const validationEnvironments: NodeJS.ProcessEnv[] = [];
  let afterInstall: (() => Promise<void>) | undefined;
  const stageFor = (command: DshInstallCommand) => {
    assert.equal(command.command, "npx", "edits must retain the recorded pinned runtime");
    assert.equal(command.args[1], `@deepseek-ai/dsh@${RUNTIME}`);
    const index = command.args.indexOf("--profile");
    assert.notEqual(index, -1);
    const profile = command.args[index + 1]!;
    assert.notEqual(profile, PROFILE, "edits install and validate in an isolated stage");
    return join(home, "profiles", profile);
  };
  const execute = async (command: DshInstallCommand, environment?: NodeJS.ProcessEnv) => {
    const stage = stageFor(command);
    assert.notEqual(environment?.[INPUT], SECRET, "saved runtime values must never enter installation scripts");
    const spec = command.args.at(-1)!;
    const match = /^(@[^/]+\/[^@]+|[^@]+)@(\d+\.\d+\.\d+)$/.exec(spec);
    assert.ok(match, `an edit must install a fixed source: ${spec}`);
    const name = match[1]!, version = match[2]!;
    await installedPackage(stage, name, version);
    const manifest = await json(join(stage, "package.json"));
    manifest.dependencies = { ...manifest.dependencies, [name]: version };
    const enabled: string[] = manifest.dsh.profile.bundles;
    // Match the real host's whole-dependency reconciliation, including a
    // previously disabled bundle encountered while installing another one.
    for (const dependency of Object.keys(manifest.dependencies)) {
      let metadata;
      try { metadata = await json(join(stage, "node_modules", ...dependency.split("/"), "package.json")); }
      catch { continue; }
      if (metadata.dsh?.bundle?.patch !== undefined && !enabled.includes(dependency)) enabled.push(dependency);
    }
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest));
    calls.push({ name, version, command });
    await afterInstall?.();
  };
  const validate = async (command: DshInstallCommand, environment?: NodeJS.ProcessEnv) => {
    const stage = stageFor(command), manifest = await json(join(stage, "package.json"));
    const requireFromStage = createRequire(join(stage, "package.json"));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const metadata = await json(join(stage, "node_modules", ...name.split("/"), "package.json"));
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, version);
    }
    const composition: string[] = [];
    for (const name of manifest.dsh.profile.bundles as string[]) {
      if (name === BASE) continue;
      const metadata = requireFromStage(name) as { name: string; version: string };
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, manifest.dependencies[name]);
      composition.push(name);
    }
    loaded.push(composition);
    validationEnvironments.push({ ...environment });
  };
  return { calls, loaded, validationEnvironments, execute, validate,
    onInstall(hook?: () => Promise<void>) { afterInstall = hook; } };
}

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "profile-edit-integration-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const active = join(home, "profiles", PROFILE), installer = filesystemInstaller(home);
  await installResolvedProfile({ profile: PROFILE, dshHome: home, hubProfileSlug: SLUG, ...author(),
    execute: installer.execute, validate: installer.validate });
  const original = await json(profileLockPath(PROFILE, home));
  installer.calls.length = 0;
  const edit = (intent: EditIntent, extra: Partial<EditOptions> = {}) => applyProfileEdit({
    profile: PROFILE, intent, dshHome: home, execute: installer.execute, validate: installer.validate, ...extra });
  return { home, active, installer, original, edit };
}

async function snapshot(home: string) {
  const statePath = profileLockPath(PROFILE, home);
  return { active: await directoryFingerprint(join(home, "profiles", PROFILE)), state: await readFile(statePath, "utf8"),
    history: await directoryFingerprint(join(dirname(statePath), "revisions")) };
}

function safe(value: unknown) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("fixture-private-edit-config"), false);
}

test("add installs through the pinned runtime, records the effective state and leaves the author baseline unchanged", async t => {
  const { home, active, installer, original, edit } = await fixture(t);
  const intent: EditIntent = { kind: "add", bundle: bundle(LOCAL, "2.0.0"), position: 1 };
  const prepared = await prepareProfileEdit({ profile: PROFILE, dshHome: home, intent });
  assert.equal(prepared.status, "ready");
  safe(prepared.summary);
  if (prepared.status !== "ready") return;
  const applied = await edit(intent, { expectedContextHash: prepared.contextHash, expectedResultHash: prepared.resultHash });
  assert.ok(applied.revision);
  assert.deepEqual(installer.calls.map(item => [item.name, item.version]).sort(),
    [[FIRST, "1.0.0"], [SECOND, "1.0.0"], [LOCAL, "2.0.0"]].sort());
  const current = await json(profileLockPath(PROFILE, home));
  assert.deepEqual(current.authorBaseline, original.authorBaseline);
  assert.deepEqual(current.hubProfile, original.hubProfile);
  assert.equal(current.contentHash, original.contentHash);
  assert.deepEqual(current.bundles.map((item: ResolvedProfileBundle) => item.packageName), [BASE, LOCAL, FIRST, SECOND]);
  assert.deepEqual((await json(join(active, "package.json"))).dsh.profile.bundles, [BASE, LOCAL, FIRST, SECOND]);
  assert.deepEqual(installer.loaded.at(-1), [LOCAL, FIRST, SECOND]);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);
});

test("disable survives host autoappend and later add; enable, reorder and remove change actual loaded plugins", async t => {
  const { home, active, installer, edit } = await fixture(t);
  await edit({ kind: "disable", packageName: FIRST });
  assert.equal((await json(join(active, "package.json"))).dependencies[FIRST], "1.0.0");
  assert.deepEqual(installer.loaded.at(-1), [SECOND]);
  await edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0") });
  assert.deepEqual(installer.loaded.at(-1), [SECOND, LOCAL], "reconciling the new dependency must not re-enable the disabled one");
  await edit({ kind: "enable", packageName: FIRST });
  assert.equal(installer.loaded.at(-1)?.includes(FIRST), true);
  await edit({ kind: "reorder", order: [BASE, LOCAL, SECOND, FIRST] });
  assert.deepEqual(installer.loaded.at(-1), [LOCAL, SECOND, FIRST]);
  await edit({ kind: "remove", packageName: LOCAL });
  const manifest = await json(join(active, "package.json"));
  assert.equal(Object.hasOwn(manifest.dependencies, LOCAL), false);
  assert.deepEqual(manifest.dsh.profile.bundles, [BASE, SECOND, FIRST]);
  await assert.rejects(access(join(active, "node_modules", LOCAL)));
  assert.deepEqual(installer.loaded.at(-1), [SECOND, FIRST]);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);
});

test("local additions, configuration and input declarations survive author upgrade without entering its baseline", async t => {
  const { home, active, installer, edit } = await fixture(t);
  const patchFile = join(home, "reviewed-patch.yml");
  await writeFile(patchFile, PATCH);
  await edit({ kind: "configure", patchFile });
  await setProfileInput(PROFILE, INPUT, SECRET, home);
  const declaration = { key: INPUT, label: "Personal fixture input", required: true, secret: true };
  await edit({ kind: "input-declare", declaration });
  await edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0") });
  const target = author("2.0.0", "1.1.0");
  await installResolvedProfile({ profile: PROFILE, dshHome: home, hubProfileSlug: SLUG, ...target,
    execute: installer.execute, validate: installer.validate, mode: "upgrade" });
  const current = await json(profileLockPath(PROFILE, home));
  assert.deepEqual(current.localInputs, [declaration]);
  assert.ok(current.inputs.some((input: { key: string }) => input.key === INPUT));
  assert.equal(JSON.stringify(current.authorBaseline).includes(INPUT), false);
  assert.equal(JSON.stringify(current.authorBaseline).includes(LOCAL), false);
  safe(current.authorBaseline);
  assert.equal(current.authorBaseline.release.version, "2.0.0");
  assert.equal((await json(join(active, "package.json"))).dependencies[LOCAL], "2.0.0");
  assert.equal(await readFile(join(active, "cordis.patch.yml"), "utf8"), PATCH);
  assert.equal(installer.validationEnvironments.at(-1)?.[INPUT], SECRET);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);
  await edit({ kind: "input-remove", key: INPUT });
  const after = await json(profileLockPath(PROFILE, home));
  assert.equal(after.inputs.some((input: { key: string }) => input.key === INPUT), false);
  const stored = await listProfileInputs({ profile: PROFILE, declarations: after.inputs, dshHome: home });
  assert.equal(stored.find(item => item.key === INPUT)?.configured, true, "removing a declaration must not erase the independently stored value");
  assert.equal(stored.find(item => item.key === INPUT)?.declared, false);
});

test("installation, composition and state persistence failures leave the active Profile and history intact", async t => {
  const { home, edit } = await fixture(t);
  const before = await snapshot(home);
  for (const failing of [
    { execute: async () => { throw new Error("fixture installation failed"); } },
    { validate: async () => { throw new Error("fixture composition failed"); } },
    { persistState: async () => { throw new Error("fixture persistence failed"); } },
  ]) {
    await assert.rejects(edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0") }, failing), /fixture .* failed/);
    assert.deepEqual(await snapshot(home), before);
    assert.deepEqual((await readdir(join(home, "profiles"))).filter(name => name.startsWith(".hub-")), []);
  }
});

test("rollback restores the edited dependency set and author state for a subsequent edit", async t => {
  const { home, active, original, edit } = await fixture(t);
  const before = await snapshot(home);
  const added = await edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0") });
  assert.ok(added.revision);
  await rollbackProfile({ profile: PROFILE, dshHome: home, revision: added.revision });
  assert.equal(await directoryFingerprint(active), before.active);
  assert.deepEqual(await json(profileLockPath(PROFILE, home)), original);
  await assert.rejects(access(join(active, "node_modules", LOCAL)));
  await edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0") });
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);
});

test("stale context and patch file changes reject an edit before installing or switching", async t => {
  const { home, active, installer, edit } = await fixture(t);
  const intent: EditIntent = { kind: "add", bundle: bundle(LOCAL, "2.0.0") };
  const prepared = await prepareProfileEdit({ profile: PROFILE, dshHome: home, intent });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  await writeFile(join(active, "personal-note"), "new local work");
  const changed = await snapshot(home);
  await assert.rejects(edit(intent, { expectedContextHash: prepared.contextHash, expectedResultHash: prepared.resultHash }));
  assert.equal(installer.calls.length, 0);
  assert.deepEqual(await snapshot(home), changed);

  const patchFile = join(home, "reviewed-patch.yml");
  await writeFile(patchFile, PATCH);
  const configuration: EditIntent = { kind: "configure", patchFile };
  const reviewed = await prepareProfileEdit({ profile: PROFILE, dshHome: home, intent: configuration });
  assert.equal(reviewed.status, "ready");
  if (reviewed.status !== "ready") return;
  safe(reviewed.summary);
  await writeFile(patchFile, `${PATCH}# externally edited after review\n`);
  await assert.rejects(edit(configuration, { expectedContextHash: reviewed.contextHash, expectedResultHash: reviewed.resultHash }));
  assert.equal(installer.calls.length, 0);
  assert.deepEqual(await snapshot(home), changed);

  let drifted = false;
  installer.onInstall(async () => {
    if (drifted) return;
    drifted = true;
    await writeFile(patchFile, `${PATCH}# externally edited during staging\n`);
  });
  await assert.rejects(edit(configuration));
  assert.equal(drifted, true);
  assert.deepEqual(await snapshot(home), changed);
});

test("dry-run prepares a safe edit without installing, creating history or changing active files", async t => {
  const { home, installer, edit } = await fixture(t);
  const before = await snapshot(home);
  await edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0") }, { dryRun: true });
  assert.equal(installer.calls.length, 0);
  assert.deepEqual(await snapshot(home), before);
  assert.deepEqual((await readdir(join(home, "profiles"))).filter(name => name.startsWith(".hub-")), []);
});

test("local bundle rules survive disable and later edits, reject invalid order, and stop incompatible author runtime upgrades", async t => {
  const { home, installer, edit } = await fixture(t);
  const rule = { packageName: LOCAL, version: "2.0.0", before: [], after: [FIRST],
    compatibility: { dsh: "~0.1.0", node: "*", platforms: [] } };
  await edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0"), rule });
  const beforeReorder = await snapshot(home);
  installer.calls.length = 0;
  await assert.rejects(edit({ kind: "reorder", order: [BASE, LOCAL, FIRST, SECOND] }));
  assert.equal(installer.calls.length, 0, "known incompatible order must be rejected before package installation");
  assert.deepEqual(await snapshot(home), beforeReorder);

  await edit({ kind: "disable", packageName: LOCAL });
  assert.deepEqual((await json(profileLockPath(PROFILE, home))).localBundleRules, [rule]);
  await edit({ kind: "add", bundle: bundle("dsh-extra-plugin", "3.0.0") });
  assert.equal(installer.loaded.at(-1)?.includes(LOCAL), false);
  assert.deepEqual((await json(profileLockPath(PROFILE, home))).localBundleRules, [rule]);
  await edit({ kind: "enable", packageName: LOCAL });
  await edit({ kind: "add", bundle: bundle(LOCAL, "2.0.0") });
  assert.deepEqual((await json(profileLockPath(PROFILE, home))).localBundleRules, [rule], "re-adding the same fixed bundle cannot erase its known constraints");

  const target = author("2.0.0", "1.1.0");
  target.release.runtime = { range: "*", version: "0.2.0" };
  for (const item of [...target.release.bundles, ...target.resolved.bundles]) {
    if (item.sourceKind !== "builtin") continue;
    item.selector = item.version = "0.2.0";
    item.installSpec = `builtin:${item.packageName}@0.2.0`;
  }
  delete target.release.contentHash;
  target.release.contentHash = `sha256:${createHash("sha256").update(canonical(target.release)).digest("hex")}`;
  const beforeUpgrade = await snapshot(home);
  installer.calls.length = 0;
  let installationAttempts = 0;
  await assert.rejects(installResolvedProfile({ profile: PROFILE, dshHome: home, hubProfileSlug: SLUG, ...target,
    mode: "upgrade", execute: async (command, environment) => {
      installationAttempts += 1;
      await installer.execute(command, environment);
    }, validate: installer.validate }));
  assert.equal(installationAttempts, 0, "compatibility must be checked before entering the installer at all");
  assert.equal(installer.calls.length, 0, "an enabled local bundle incompatible with the new runtime must stop before installation");
  assert.deepEqual(await snapshot(home), beforeUpgrade);
});

test("configure restores a missing patch and remove repairs an unsupported dependency through the normal edit transaction", async t => {
  const { home, active, installer, edit } = await fixture(t);
  const patchFile = join(home, "replacement-patch.yml");
  await writeFile(patchFile, PATCH);
  await rm(join(active, "cordis.patch.yml"));
  const configured = await edit({ kind: "configure", patchFile });
  assert.ok(configured.revision);
  assert.equal(await readFile(join(active, "cordis.patch.yml"), "utf8"), PATCH);
  assert.deepEqual(installer.loaded.at(-1), [FIRST, SECOND]);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);

  const manifest = await json(join(active, "package.json"));
  manifest.dependencies.broken = "file:../missing-local-package";
  manifest.dsh.profile.bundles.push("broken");
  await writeFile(join(active, "package.json"), JSON.stringify(manifest));
  const removed = await edit({ kind: "remove", packageName: "broken" });
  assert.ok(removed.revision);
  const restored = await json(join(active, "package.json"));
  assert.equal(Object.hasOwn(restored.dependencies, "broken"), false);
  assert.deepEqual(restored.dsh.profile.bundles, [BASE, FIRST, SECOND]);
  assert.deepEqual(installer.loaded.at(-1), [FIRST, SECOND]);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);
});

test("explicit disable and remove survive author removal and readdition until the user enables or adds the plugin", async t => {
  const { home, active, installer, edit } = await fixture(t);
  await edit({ kind: "disable", packageName: FIRST });
  await edit({ kind: "remove", packageName: SECOND });
  assert.deepEqual(installer.loaded.at(-1), []);
  const retainedIntent = { disabled: [FIRST], removed: [SECOND] };
  assert.deepEqual((await json(profileLockPath(PROFILE, home))).localBundleOverrides, retainedIntent);

  const second = author("2.0.0");
  second.release.bundles = second.release.bundles.filter(item => item.sourceKind === "builtin");
  second.resolved.bundles = second.resolved.bundles.filter(item => item.sourceKind === "builtin");
  delete second.release.contentHash;
  second.release.contentHash = `sha256:${createHash("sha256").update(canonical(second.release)).digest("hex")}`;
  await installResolvedProfile({ profile: PROFILE, dshHome: home, hubProfileSlug: SLUG, ...second,
    execute: installer.execute, validate: installer.validate, mode: "upgrade" });
  assert.deepEqual((await json(profileLockPath(PROFILE, home))).localBundleOverrides, retainedIntent,
    "an author version matching a local choice must not absorb the explicit local intent");

  await installResolvedProfile({ profile: PROFILE, dshHome: home, hubProfileSlug: SLUG, ...author("3.0.0"),
    execute: installer.execute, validate: installer.validate, mode: "upgrade" });
  const current = await json(profileLockPath(PROFILE, home));
  assert.deepEqual(current.localBundleOverrides, retainedIntent);
  assert.deepEqual(current.authorBaseline.resolved.bundles.map((item: ResolvedProfileBundle) => item.packageName), [BASE, FIRST, SECOND]);
  const manifest = await json(join(active, "package.json"));
  assert.deepEqual(manifest.dsh.profile.bundles, [BASE]);
  assert.equal(manifest.dependencies[FIRST], "1.0.0", "disable keeps the reintroduced package available without loading it");
  assert.equal(Object.hasOwn(manifest.dependencies, SECOND), false, "remove keeps the author-reintroduced package uninstalled");
  assert.deepEqual(installer.loaded.at(-1), []);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);

  await edit({ kind: "enable", packageName: FIRST });
  assert.deepEqual(installer.loaded.at(-1), [FIRST]);
  assert.deepEqual((await json(profileLockPath(PROFILE, home))).localBundleOverrides?.disabled ?? [], []);
  await edit({ kind: "add", bundle: bundle(SECOND) });
  assert.deepEqual(installer.loaded.at(-1), [FIRST, SECOND]);
  const restored = await json(profileLockPath(PROFILE, home));
  assert.deepEqual(restored.localBundleOverrides?.removed ?? [], []);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: home })).healthy, true);
});

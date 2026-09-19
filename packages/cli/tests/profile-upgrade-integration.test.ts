import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import type { ResolvedProfile } from "@dsh-plugin-hub/registry";
import {
  installResolvedProfile, listProfileRevisions, profileLockPath, rollbackProfile,
  type DshInstallCommand, type InstallProfileOptions,
} from "../dist/index.js";
import { prepareProfileUpgrade } from "../dist/profile-upgrade.js";
import { applyOperationPlan, createProfileApplyPlan } from "../dist/operations.js";
import { doctorProfile } from "../dist/profile-lifecycle.js";
import { directoryFingerprint } from "../dist/profile-files.js";

// This fixture implements package installation and module loading on disk. It
// deliberately does not claim to exercise the real DSH host or registry.
const PROFILE = "research";
const SLUG = "upgrade-research";
const AUTHOR_PACKAGE = "dsh-author-tools";
const LOCAL_PLUGIN = "dsh-personal-plugin";
const LOCAL_HELPER = "personal-utils";
const LOCAL_VALUE = "private-local-workspace-marker";
const EXTRA_FILE_VALUE = "personal-notes-never-in-summary";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function author(version: string, packageVersion: string, workspace = "author-workspace") {
  const base = { packageName: "@deepseek-ai/dsh-base", selector: "0.1.0", version: "0.1.0",
    installSpec: "builtin:@deepseek-ai/dsh-base@0.1.0", sourceKind: "builtin" as const, before: [], after: [] };
  const plugin = { packageName: AUTHOR_PACKAGE, selector: packageVersion, version: packageVersion,
    installSpec: `${AUTHOR_PACKAGE}@${packageVersion}`, sourceKind: "npm" as const, before: [], after: [] };
  const release: HubProfileVersion = {
    schemaVersion: 1, version, name: "Research", description: "Integration fixture", dsh: "*",
    runtime: { range: "*", version: "0.1.0" }, bundles: [base, plugin], patch: [],
    patchYaml: `${JSON.stringify([{ id: "workspace", config: { workspace } }])}\n`,
    inputs: [], publishedAt: "2026-09-17T00:00:00.000Z",
  };
  release.contentHash = `sha256:${createHash("sha256").update(canonical(release)).digest("hex")}`;
  const resolved: ResolvedProfile = { profileVersion: version, bundles: [base, plugin] };
  return { release, resolved };
}

async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }

async function packageOnDisk(directory: string, name: string, version: string) {
  const installed = join(directory, "node_modules", ...name.split("/"));
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name, version, main: "index.cjs" }));
  await writeFile(join(installed, "index.cjs"), `module.exports = ${JSON.stringify({ name, version })};\n`);
}

function fakeFilesystemInstaller(root: string) {
  const calls: Array<{ name: string; version: string; stage: string }> = [];
  const compositions: string[][] = [];
  let afterInstall: (() => Promise<void>) | undefined;
  const execute = async (command: DshInstallCommand) => {
    const targetIndex = command.args.indexOf("--profile");
    assert.notEqual(targetIndex, -1, "fixture requires an explicitly scoped installation");
    const stageName = command.args[targetIndex + 1]!;
    assert.notEqual(stageName, PROFILE, "dependencies must install in staging, never the active Profile");
    const stage = join(root, "profiles", stageName);
    const spec = command.args.at(-1)!;
    const match = /^(@[^/]+\/[^@]+|[^@]+)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.exec(spec);
    assert.ok(match, `fixture received a non-exact installation spec: ${spec}`);
    const [, name, version] = match;
    await packageOnDisk(stage, name!, version!);
    let manifest;
    try { manifest = await json(join(stage, "package.json")); } catch { manifest = {}; }
    manifest.dependencies = { ...manifest.dependencies, [name!]: version };
    // Like a Plugin installer, register newly installed packages. The real
    // upgrade materializer must subsequently restore the reviewed load order.
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile,
      bundles: [...new Set([...(manifest.dsh?.profile?.bundles ?? []), name])] } };
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest));
    calls.push({ name: name!, version: version!, stage });
    await afterInstall?.();
  };
  const validate = async (command: DshInstallCommand) => {
    const stageName = command.args[command.args.indexOf("--profile") + 1]!;
    const stage = join(root, "profiles", stageName);
    const manifest = await json(join(stage, "package.json"));
    const requireFromStage = createRequire(join(stage, "package.json"));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      assert.equal((await json(join(stage, "node_modules", ...name.split("/"), "package.json"))).version, version,
        `manifest dependency ${name} must really be installed`);
    }
    const loaded: string[] = [];
    for (const name of manifest.dsh.profile.bundles as string[]) {
      if (name.startsWith("@deepseek-ai/dsh-")) continue;
      const plugin = requireFromStage(name) as { name: string; version: string };
      assert.equal(plugin.name, name);
      assert.equal(plugin.version, manifest.dependencies[name]);
      loaded.push(name);
    }
    compositions.push(loaded);
  };
  return { calls, compositions, execute, validate, onInstall(hook?: () => Promise<void>) { afterInstall = hook; } };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-upgrade-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = join(root, "profiles", PROFILE);
  const installer = fakeFilesystemInstaller(root);
  const install = (version: ReturnType<typeof author>, extra: Partial<InstallProfileOptions> = {}) => installResolvedProfile({
    profile: PROFILE, dshHome: root, hubProfileSlug: SLUG, ...version,
    execute: installer.execute, validate: installer.validate, ...extra,
  });
  await install(author("1.0.0", "1.0.0"));
  return { root, active, installer, install };
}

async function customize(active: string) {
  const manifest = await json(join(active, "package.json"));
  manifest.dependencies[LOCAL_PLUGIN] = "2.0.0";
  manifest.dependencies[LOCAL_HELPER] = "3.0.0";
  manifest.dsh.profile.bundles.push(LOCAL_PLUGIN);
  manifest.personal = { workspace: LOCAL_VALUE };
  await writeFile(join(active, "package.json"), JSON.stringify(manifest));
  await packageOnDisk(active, LOCAL_PLUGIN, "2.0.0");
  await packageOnDisk(active, LOCAL_HELPER, "3.0.0");
  await writeFile(join(active, "cordis.patch.yml"), `${JSON.stringify([{ id: "workspace", config: { workspace: LOCAL_VALUE } }])}\n`);
  await mkdir(join(active, "notes"), { recursive: true });
  await writeFile(join(active, "notes", "strategy.txt"), EXTRA_FILE_VALUE);
}

async function snapshot(root: string) {
  const statePath = profileLockPath(PROFILE, root);
  return {
    active: await directoryFingerprint(join(root, "profiles", PROFILE)),
    state: await readFile(statePath, "utf8"),
    history: await directoryFingerprint(join(dirname(statePath), "revisions")),
  };
}

function assertSafe(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(LOCAL_VALUE), false, "review output disclosed local configuration");
  assert.equal(serialized.includes(EXTRA_FILE_VALUE), false, "review output disclosed a personal file");
}

test("planned v2 installs the effective plugin and ordinary dependency set, preserves personal configuration, and passes doctor", async (t) => {
  const { root, active, installer } = await fixture(t);
  await customize(active);
  const target = author("2.0.0", "1.1.0");
  const prepared = await prepareProfileUpgrade({ profile: PROFILE, slug: SLUG, dshHome: root, ...target });
  assert.equal(prepared.status, "ready");
  assertSafe(prepared.summary);
  const plan = await createProfileApplyPlan({ profile: PROFILE, slug: SLUG, dshHome: root, kind: "profile.upgrade", ...target });
  assertSafe(plan);
  installer.calls.length = 0;
  const applied = await applyOperationPlan({ id: plan.id, dshHome: root,
    install: (options) => installResolvedProfile({ ...options, execute: installer.execute, validate: installer.validate }) });
  assertSafe(applied);
  assert.deepEqual(installer.calls.map(({ name, version }) => [name, version]).sort(),
    [[AUTHOR_PACKAGE, "1.1.0"], [LOCAL_PLUGIN, "2.0.0"], [LOCAL_HELPER, "3.0.0"]].sort());
  assert.deepEqual(installer.compositions.at(-1), [AUTHOR_PACKAGE, LOCAL_PLUGIN]);
  const manifest = await json(join(active, "package.json"));
  assert.deepEqual(manifest.personal, { workspace: LOCAL_VALUE });
  assert.equal(manifest.dependencies[LOCAL_HELPER], "3.0.0");
  assert.equal(manifest.dsh.profile.bundles.includes(LOCAL_HELPER), false);
  assert.match(await readFile(join(active, "cordis.patch.yml"), "utf8"), new RegExp(LOCAL_VALUE));
  assert.equal(await readFile(join(active, "notes", "strategy.txt"), "utf8"), EXTRA_FILE_VALUE);
  const doctor = await doctorProfile({ profile: PROFILE, dshHome: root });
  assert.equal(doctor.healthy, true, JSON.stringify(doctor.checks));
  assert.equal(doctor.current?.hubProfile?.version, "2.0.0");
  assert.deepEqual(doctor.current?.bundles.map(bundle => bundle.packageName), ["@deepseek-ai/dsh-base", AUTHOR_PACKAGE, LOCAL_PLUGIN]);
  assert.equal((await listProfileRevisions(PROFILE, root)).length, 1);
});

test("preserved npm configuration and overrides govern installation and the plugin's actual transitive dependency", async (t) => {
  const { root, active, installer, install } = await fixture(t);
  const manifest = await json(join(active, "package.json"));
  manifest.pnpm = { overrides: { transitive: "1.0.0" } };
  await writeFile(join(active, "package.json"), JSON.stringify(manifest));
  const npmrc = "registry=https://fixture.registry.invalid\n";
  await writeFile(join(active, ".npmrc"), npmrc);
  await packageOnDisk(active, "transitive", "1.0.0");
  let installsWithConfiguration = 0;
  const execute = async (command: DshInstallCommand) => {
    const stage = join(root, "profiles", command.args[command.args.indexOf("--profile") + 1]!);
    const configuration = await json(join(stage, "package.json"));
    assert.equal(configuration.pnpm?.overrides?.transitive, "1.0.0", "retained overrides must govern installation");
    assert.equal(await readFile(join(stage, ".npmrc"), "utf8"), npmrc, "registry configuration must be present before installation");
    installsWithConfiguration += 1;
    await installer.execute(command);
    await packageOnDisk(stage, "transitive", configuration.pnpm.overrides.transitive);
    const authorDirectory = join(stage, "node_modules", AUTHOR_PACKAGE);
    const identity = await json(join(authorDirectory, "package.json"));
    await writeFile(join(authorDirectory, "index.cjs"), `module.exports = { ...${JSON.stringify({ name: identity.name, version: identity.version })}, transitiveVersion: require("transitive").version };\n`);
  };
  const validate = async (command: DshInstallCommand) => {
    await installer.validate(command);
    const stage = join(root, "profiles", command.args[command.args.indexOf("--profile") + 1]!);
    const requireFromStage = createRequire(join(stage, "package.json"));
    assert.equal(requireFromStage(AUTHOR_PACKAGE).transitiveVersion, "1.0.0", "composition must load the dependency selected by the override");
  };
  await install(author("2.0.0", "1.1.0"), { mode: "upgrade", execute, validate });
  assert.equal(installsWithConfiguration, 1);
  assert.equal((await json(join(active, "package.json"))).pnpm.overrides.transitive, "1.0.0");
  assert.equal(await readFile(join(active, ".npmrc"), "utf8"), npmrc);
  const requireFromActive = createRequire(join(active, "package.json"));
  assert.equal(requireFromActive(AUTHOR_PACKAGE).transitiveVersion, "1.0.0");
  assert.equal(requireFromActive("transitive").version, "1.0.0");
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: root })).healthy, true);
});

test("conflicts write no active files, revisions or dependencies; context-bound local resolution becomes executable", async (t) => {
  const { root, active, installer, install } = await fixture(t);
  await customize(active);
  const target = author("2.0.0", "1.1.0", "author-v2-workspace");
  const before = await snapshot(root);
  const prepared = await prepareProfileUpgrade({ profile: PROFILE, slug: SLUG, dshHome: root, ...target });
  assert.equal(prepared.status, "conflicted");
  assertSafe(prepared);
  installer.calls.length = 0;
  await assert.rejects(install(target, { mode: "upgrade" }), (error: Error & { summary?: unknown }) => {
    assert.ok(error.summary, "blocked installation exposes only the safe conflict summary");
    assertSafe({ message: error.message, summary: error.summary });
    return true;
  });
  assert.equal(installer.calls.length, 0);
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual((await readdir(join(root, "profiles"))).filter(name => name.startsWith(".hub-")), []);
  const resolutions = { contextHash: prepared.contextHash,
    choices: Object.fromEntries(prepared.summary.conflicts.map(conflict => [conflict.id, "local" as const])) };
  await assert.rejects(install(target, { mode: "upgrade", resolutions: { ...resolutions,
    contextHash: `sha256:${"0".repeat(64)}` } }));
  assert.equal(installer.calls.length, 0, "a choice from another review context cannot reach installation");
  assert.deepEqual(await snapshot(root), before);
  const plan = await createProfileApplyPlan({ profile: PROFILE, slug: SLUG, dshHome: root, kind: "profile.upgrade", ...target, resolutions });
  assertSafe(plan);
  await applyOperationPlan({ id: plan.id, dshHome: root,
    install: (options) => installResolvedProfile({ ...options, execute: installer.execute, validate: installer.validate }) });
  assert.match(await readFile(join(active, "cordis.patch.yml"), "utf8"), new RegExp(LOCAL_VALUE));
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: root })).healthy, true);
});

test("a third author version still conflicts with the personal patch instead of absorbing it into the author baseline", async (t) => {
  const { root, active, install } = await fixture(t);
  await customize(active);
  const second = author("2.0.0", "1.1.0");
  await install(second, { mode: "upgrade" });
  const current = await json(profileLockPath(PROFILE, root));
  assert.ok(current.authorBaseline, "successful installation records a separate author baseline");
  assert.equal(JSON.stringify(current.authorBaseline).includes(LOCAL_VALUE), false);
  assert.equal(JSON.stringify(current.authorBaseline).includes(LOCAL_PLUGIN), false);
  const third = author("3.0.0", "1.2.0", "author-v3-workspace");
  const prepared = await prepareProfileUpgrade({ profile: PROFILE, slug: SLUG, dshHome: root, ...third });
  assert.equal(prepared.status, "conflicted", "personal edit survives as a delta against the actual v2 author baseline");
  assertSafe(prepared);
  const resolutions = { contextHash: prepared.contextHash,
    choices: Object.fromEntries(prepared.summary.conflicts.map(conflict => [conflict.id, "local" as const])) };
  await install(third, { mode: "upgrade", resolutions });
  assert.match(await readFile(join(active, "cordis.patch.yml"), "utf8"), new RegExp(LOCAL_VALUE));
  const state = await json(profileLockPath(PROFILE, root));
  assert.equal(JSON.stringify(state.authorBaseline).includes(LOCAL_VALUE), false);
  assert.equal(JSON.stringify(state.authorBaseline).includes("author-v3-workspace"), true);
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: root })).healthy, true);
});

test("post-plan edits and edits during staged installation cannot be overwritten by an upgrade", async (t) => {
  const { root, active, installer, install } = await fixture(t);
  await customize(active);
  const target = author("2.0.0", "1.1.0");
  const plan = await createProfileApplyPlan({ profile: PROFILE, slug: SLUG, dshHome: root, kind: "profile.upgrade", ...target });
  await writeFile(join(active, "notes", "strategy.txt"), "edited-after-plan");
  const afterPlan = await snapshot(root);
  installer.calls.length = 0;
  await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root,
    install: (options) => installResolvedProfile({ ...options, execute: installer.execute, validate: installer.validate }) }), /changed after planning/);
  assert.equal(installer.calls.length, 0);
  assert.deepEqual(await snapshot(root), afterPlan);
  let edited = false;
  installer.onInstall(async () => {
    if (edited) return;
    edited = true;
    await writeFile(join(active, "notes", "strategy.txt"), "edited-during-staging");
  });
  await assert.rejects(install(target, { mode: "upgrade" }), /changed while preparing|changed after planning|files changed or cannot be safely preserved/);
  assert.ok(edited);
  assert.equal(await readFile(join(active, "notes", "strategy.txt"), "utf8"), "edited-during-staging");
  const afterStage = await snapshot(root);
  assert.equal(afterStage.state, afterPlan.state);
  assert.equal(afterStage.history, afterPlan.history);
  assert.equal((await json(join(active, "package.json"))).dependencies[AUTHOR_PACKAGE], "1.0.0");
});

test("rollback restores the corresponding author baseline and personal files for a later upgrade", async (t) => {
  const { root, active, install } = await fixture(t);
  await customize(active);
  const before = await snapshot(root);
  const result = await install(author("2.0.0", "1.1.0"), { mode: "upgrade" });
  assert.ok(result.revision);
  await rollbackProfile({ profile: PROFILE, dshHome: root, revision: result.revision });
  assert.equal(await directoryFingerprint(active), before.active);
  assert.deepEqual((await json(profileLockPath(PROFILE, root))).authorBaseline, JSON.parse(before.state).authorBaseline);
  const repeated = author("2.1.0", "1.1.1");
  await install(repeated, { mode: "upgrade" });
  assert.equal(await readFile(join(active, "notes", "strategy.txt"), "utf8"), EXTRA_FILE_VALUE);
  assert.match(await readFile(join(active, "cordis.patch.yml"), "utf8"), new RegExp(LOCAL_VALUE));
  assert.equal((await json(join(active, "package.json"))).dependencies[AUTHOR_PACKAGE], "1.1.1");
  assert.equal((await doctorProfile({ profile: PROFILE, dshHome: root })).healthy, true);
});

test("a failed state persistence restores the old Profile, baseline and revision history", async (t) => {
  const { root, active, install } = await fixture(t);
  await customize(active);
  const before = await snapshot(root);
  await assert.rejects(install(author("2.0.0", "1.1.0"), { mode: "upgrade",
    persistState: async () => { throw new Error("simulated state disk failure"); } }), /simulated state disk failure/);
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual((await readdir(join(root, "profiles"))).filter(name => name.startsWith(".hub-")), []);
});

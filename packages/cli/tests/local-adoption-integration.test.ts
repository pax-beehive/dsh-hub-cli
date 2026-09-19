import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import type { ResolvedProfileBundle } from "@dsh-plugin-hub/registry";
import { applyProfileEdit, installResolvedProfile, listProfileRevisions, profileLockPath, rollbackProfile,
  type DshInstallCommand } from "../dist/index.js";
import { prepareProfileEdit } from "../dist/profile-edit.js";
import { prepareProfileUpgrade } from "../dist/profile-upgrade.js";
import { scanProfileFiles } from "../dist/profile-upgrade-files.js";
import { doctorProfile, runLocalProfile } from "../dist/profile-lifecycle.js";
import { createProfileEditPlan } from "../dist/operations.js";
import { setProfileInput } from "../dist/profile-inputs.js";

// An isolated, inspectable runtime descriptor and filesystem package installer.
// This suite does not contact npm or claim to execute the official DSH runtime.
const RUNTIME = "0.1.1";
const BASE = "@deepseek-ai/dsh-base";
const WEB = "@deepseek-ai/dsh-web-app";
const HEADLESS = "@deepseek-ai/dsh-headless";
const BUILTINS = { [BASE]: "0.1.5", [WEB]: "0.1.6", [HEADLESS]: "0.1.7" };
const ADDED = "dsh-new-plugin";
const ENABLED = "dsh-existing-plugin";
const DISABLED = "dsh-disabled-plugin";
const HELPER = "plain-helper";
const AUTHOR = "dsh-author-plugin";
const PERSONAL = "private-personal-file-marker";
const PATCH = "- id: personal\n  config:\n    workspace: private-personal-patch-marker\n";
const NPMRC = "registry=https://fixture.invalid\n//fixture.invalid/:_authToken=private-npm-token-marker\n";
const INPUT = "ADOPTION_FIXTURE_TOKEN";
const VALUE = "private-stored-input-marker";
type EditOptions = Parameters<typeof applyProfileEdit>[0];
type Intent = EditOptions["intent"];

async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function optionalText(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function npmBundle(name: string, version = "2.0.0"): ResolvedProfileBundle {
  return { packageName: name, version, selector: version, sourceKind: "npm", installSpec: `${name}@${version}` };
}
function builtin(name: string): ResolvedProfileBundle {
  const version = BUILTINS[name]!;
  return { packageName: name, version, selector: version, sourceKind: "builtin", installSpec: `builtin:${name}@${version}` };
}
async function packageFiles(root: string, name: string, version: string, bundle = true) {
  const directory = join(root, "node_modules", ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, main: "index.cjs",
    ...(bundle ? { dsh: { bundle: { patch: "patch.yml" } } } : {}) }));
  await writeFile(join(directory, "index.cjs"), `module.exports = ${JSON.stringify({ name, version })};\n`);
  if (bundle) await writeFile(join(directory, "patch.yml"), "[]\n");
}

async function runtimeCache(home: string) {
  const prefix = join(home, ".hub", "runtimes", RUNTIME);
  const runtime = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  const boot = join(prefix, "node_modules", "@deepseek-ai", "dsh-app-boot");
  await mkdir(join(runtime, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(boot, "lib"), { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: RUNTIME, bin: "bin/dsh.js" }));
  await writeFile(join(runtime, "bin", "dsh.js"), "throw new Error('fixture runtime must never be executed');\n");
  await writeFile(join(boot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: RUNTIME, main: "lib/index.js" }));
  await writeFile(join(boot, "lib", "index.js"),
    `export const PROFILE_TEMPLATES = ${JSON.stringify({ web: [BASE, WEB], headless: [BASE, HEADLESS] })};\n` +
    `export const DEFAULT_PROFILE_BUNDLES = ${JSON.stringify([BASE])};\n`);
  for (const [name, version] of Object.entries(BUILTINS)) await packageFiles(prefix, name, version);
}

function installer(home: string, profile: string) {
  const calls: Array<{ name: string; version: string }> = [];
  const loaded: string[][] = [];
  let attempts = 0;
  function stageFor(command: DshInstallCommand) {
    assert.equal(command.command, "npx");
    assert.equal(command.args[1], `@deepseek-ai/dsh@${RUNTIME}`);
    const index = command.args.indexOf("--profile");
    assert.notEqual(index, -1);
    const stage = command.args[index + 1]!;
    assert.notEqual(stage, profile);
    return join(home, "profiles", stage);
  }
  const execute = async (command: DshInstallCommand, environment?: NodeJS.ProcessEnv) => {
    attempts += 1;
    assert.equal(environment?.DSH_HOME, home);
    assert.notEqual(environment?.[INPUT], VALUE);
    const stage = stageFor(command), spec = command.args.at(-1)!;
    const match = /^(@[^/]+\/[^@]+|[^@]+)@(\d+\.\d+\.\d+)$/.exec(spec);
    assert.ok(match, "all existing and new dependencies must have fixed installation sources");
    const name = match[1]!, version = match[2]!;
    await packageFiles(stage, name, version, name !== HELPER);
    const manifest = await json(join(stage, "package.json"));
    manifest.dependencies = { ...manifest.dependencies, [name]: version };
    for (const dependency of Object.keys(manifest.dependencies)) {
      let installed;
      try { installed = await json(join(stage, "node_modules", ...dependency.split("/"), "package.json")); }
      catch { continue; }
      if (installed.dsh?.bundle?.patch !== undefined && !manifest.dsh.profile.bundles.includes(dependency)) {
        manifest.dsh.profile.bundles.push(dependency);
      }
    }
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest));
    calls.push({ name, version });
  };
  const validate = async (command: DshInstallCommand) => {
    const stage = stageFor(command), manifest = await json(join(stage, "package.json"));
    const requireFromStage = createRequire(join(stage, "package.json"));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const identity = await json(join(stage, "node_modules", ...name.split("/"), "package.json"));
      assert.equal(identity.name, name); assert.equal(identity.version, version);
    }
    const active: string[] = [];
    for (const name of manifest.dsh.profile.bundles as string[]) {
      if (Object.hasOwn(BUILTINS, name)) continue;
      const identity = requireFromStage(name) as { name: string; version: string };
      assert.equal(identity.name, name); assert.equal(identity.version, manifest.dependencies[name]);
      active.push(name);
    }
    loaded.push(active);
  };
  return { calls, loaded, execute, validate, get attempts() { return attempts; } };
}

async function fixture(t: test.TestContext, profile = "personal") {
  const home = await mkdtemp(join(tmpdir(), "local-adoption-integration-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await runtimeCache(home);
  const active = join(home, "profiles", profile), install = installer(home, profile);
  const edit = (intent: Intent, extra: Partial<EditOptions> = {}) => applyProfileEdit({ profile, intent, dshHome: home,
    runtimeVersion: RUNTIME, execute: install.execute, validate: install.validate, ...extra });
  return { home, profile, active, install, edit };
}

async function unmanaged(active: string) {
  await mkdir(join(active, "notes"), { recursive: true });
  await mkdir(join(active, ".git"));
  await mkdir(join(active, "empty")); await chmod(join(active, "empty"), 0o750);
  await writeFile(join(active, "package.json"), JSON.stringify({ name: "existing-personal-profile", private: true,
    personal: { workspace: PERSONAL }, dependencies: { [ENABLED]: "^1.0.0", [DISABLED]: "2.0.0", [HELPER]: "3.0.0" },
    dsh: { profile: { bundles: [BASE, ENABLED] } } }));
  await writeFile(join(active, "cordis.patch.yml"), PATCH);
  await writeFile(join(active, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstrictPeerDependencies: false\n");
  await writeFile(join(active, ".npmrc"), NPMRC, { mode: 0o600 });
  await writeFile(join(active, ".git", "config"), PERSONAL, { mode: 0o600 });
  await writeFile(join(active, "notes", "personal.txt"), PERSONAL, { mode: 0o640 });
  await symlink("notes/personal.txt", join(active, "linked-note"));
  await packageFiles(active, ENABLED, "1.2.0");
  await packageFiles(active, DISABLED, "2.0.0");
  await packageFiles(active, HELPER, "3.0.0", false);
}

async function snapshot(home: string, profile: string) {
  return { files: await scanProfileFiles(join(home, "profiles", profile)),
    state: await optionalText(profileLockPath(profile, home)),
    revisions: await listProfileRevisions(profile, home) };
}
function assertLocalState(state: Record<string, unknown>) {
  assert.equal(state.source, "local");
  assert.equal(state.authorBaseline, undefined);
  assert.equal(state.hubProfile, undefined);
  assert.equal(state.contentHash, undefined);
}
function safe(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const marker of [PERSONAL, "private-personal-patch-marker", "private-npm-token-marker", VALUE]) {
    assert.equal(encoded.includes(marker), false, "review output or plan disclosed private local content");
  }
}

test("first add creates the final target's official template using actual cached builtin versions", async t => {
  for (const [profile, expected] of [["personal", [BASE]], ["web", [BASE, WEB]], ["headless", [BASE, HEADLESS]]] as const) {
    const { home, active, edit, install } = await fixture(t, profile);
    const added = await edit({ kind: "add", bundle: npmBundle(ADDED) });
    assert.equal(added.revision, undefined);
    const manifest = await json(join(active, "package.json"));
    assert.deepEqual(manifest.dsh.profile.bundles, [...expected, ADDED]);
    assert.equal(manifest.private, true);
    assert.equal(await readFile(join(active, "cordis.patch.yml"), "utf8").then(value => value.replace(/^#.*\n/gm, "").trim()), "[]");
    const workspace = await readFile(join(active, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /nodeLinker: hoisted/); assert.match(workspace, /autoInstallPeers: false/);
    const state = await json(profileLockPath(profile, home));
    assertLocalState(state);
    assert.equal(state.runtime.version, RUNTIME);
    for (const name of expected) assert.equal(state.bundles.find((item: ResolvedProfileBundle) => item.packageName === name).version, BUILTINS[name]);
    assert.deepEqual(install.loaded.at(-1), [ADDED]);
    assert.equal((await doctorProfile({ profile, dshHome: home })).healthy, true);
  }
});

test("adoption keeps unmanaged configuration, files, fixed dependencies and disabled bundle order", async t => {
  const { home, profile, active, install, edit } = await fixture(t);
  await unmanaged(active);
  const before = await scanProfileFiles(active);
  await edit({ kind: "add", bundle: npmBundle(ADDED) });
  assert.deepEqual(install.calls.map(item => [item.name, item.version]).sort(),
    [[ENABLED, "1.2.0"], [DISABLED, "2.0.0"], [HELPER, "3.0.0"], [ADDED, "2.0.0"]].sort());
  const manifest = await json(join(active, "package.json"));
  assert.equal(manifest.name, "existing-personal-profile");
  assert.deepEqual(manifest.personal, { workspace: PERSONAL });
  assert.deepEqual(manifest.dsh.profile.bundles, [BASE, ENABLED, ADDED]);
  assert.deepEqual(install.loaded.at(-1), [ENABLED, ADDED]);
  assert.equal(manifest.dependencies[DISABLED], "2.0.0");
  assert.equal(manifest.dependencies[HELPER], "3.0.0");
  assert.equal(await readFile(join(active, "cordis.patch.yml"), "utf8"), PATCH);
  assert.equal(await readFile(join(active, ".npmrc"), "utf8"), NPMRC);
  assert.equal(await readFile(join(active, ".git", "config"), "utf8"), PERSONAL);
  assert.equal(await readlink(join(active, "linked-note")), "notes/personal.txt");
  const after = await scanProfileFiles(active);
  for (const name of ["empty", "notes/personal.txt", ".git/config", "linked-note", "pnpm-workspace.yaml"]) {
    assert.deepEqual(after.find(item => item.relativePath === name), before.find(item => item.relativePath === name));
  }
  assertLocalState(await json(profileLockPath(profile, home)));
  assert.equal((await doctorProfile({ profile, dshHome: home })).healthy, true);
});

test("failed first creation or adoption leaves active files, current state and history unchanged", async t => {
  for (const hasExisting of [false, true]) for (const failure of ["install", "validate", "persist"] as const) {
    const { home, profile, active, edit } = await fixture(t);
    if (hasExisting) await unmanaged(active);
    const before = await snapshot(home, profile);
    const fail = async () => { throw new Error(`fixture ${failure} failed`); };
    const hooks = failure === "install" ? { execute: fail } : failure === "validate" ? { validate: fail } : { persistState: fail };
    await assert.rejects(edit({ kind: "add", bundle: npmBundle(ADDED) }, hooks), /fixture .* failed/);
    assert.deepEqual(await snapshot(home, profile), before);
    assert.deepEqual((await readdir(join(home, "profiles"))).filter(name => name.startsWith(".hub-")), []);
    if (hasExisting) assert.equal((await json(join(active, "node_modules", ENABLED, "package.json"))).version, "1.2.0");
  }
});

test("the first adoption revision rolls back to the original unmanaged directory without a forged Hub state", async t => {
  const { home, profile, active, edit } = await fixture(t);
  await unmanaged(active);
  const before = await snapshot(home, profile);
  const result = await edit({ kind: "add", bundle: npmBundle(ADDED) });
  assert.ok(result.revision);
  const revisions = await listProfileRevisions(profile, home);
  assert.equal(revisions.find(item => item.id === result.revision)?.state.unmanaged, true);
  await rollbackProfile({ profile, dshHome: home, revision: result.revision });
  assert.deepEqual(await scanProfileFiles(active), before.files);
  assert.equal(await optionalText(profileLockPath(profile, home)), undefined);
  assert.equal((await json(join(active, "node_modules", ENABLED, "package.json"))).version, "1.2.0");
  await assert.rejects(access(join(active, "node_modules", ADDED)));
});

test("read-only preview and saved adoption plan expose no local content and invent no author release", async t => {
  const { home, profile, active } = await fixture(t);
  await unmanaged(active);
  const before = await snapshot(home, profile);
  const options = { profile, dshHome: home, runtimeVersion: RUNTIME, intent: { kind: "add" as const, bundle: npmBundle(ADDED) } };
  const preview = await prepareProfileEdit(options);
  assert.equal(preview.source, "local");
  assert.equal(preview.authorBaseline, undefined);
  safe(preview.summary);
  const plan = await createProfileEditPlan(options);
  safe(plan);
  assert.deepEqual(await snapshot(home, profile), before);
});

test("a local Profile supports second edits, stored runtime inputs, run and doctor", async t => {
  const { home, profile, active, install, edit } = await fixture(t);
  await edit({ kind: "add", bundle: npmBundle(ADDED) });
  await applyProfileEdit({ profile, dshHome: home, intent: { kind: "add", bundle: npmBundle(ENABLED, "1.2.0") },
    execute: install.execute, validate: install.validate });
  await edit({ kind: "disable", packageName: ADDED });
  const patchFile = join(home, "personal.yml"); await writeFile(patchFile, PATCH);
  await edit({ kind: "configure", patchFile });
  await setProfileInput(profile, INPUT, VALUE, home);
  await edit({ kind: "input-declare", declaration: { key: INPUT, label: "Local fixture", required: true, secret: true } });
  assertLocalState(await json(profileLockPath(profile, home)));
  assert.deepEqual(install.loaded.at(-1), [ENABLED]);
  let ran = false;
  await runLocalProfile({ profile, dshHome: home, execute: async (command, environment) => {
    ran = true;
    assert.deepEqual(command.args, ["-y", `@deepseek-ai/dsh@${RUNTIME}`, "--profile", profile]);
    assert.equal(environment?.[INPUT], VALUE); assert.equal(environment?.DSH_HOME, home);
  } });
  assert.equal(ran, true);
  assert.equal(await readFile(join(active, "cordis.patch.yml"), "utf8"), PATCH);
  assert.equal((await doctorProfile({ profile, dshHome: home })).healthy, true);
});

function remote(version: string, pluginVersion: string) {
  const bundles = [builtin(BASE), npmBundle(AUTHOR, pluginVersion)];
  const release: HubProfileVersion = { schemaVersion: 1, version, name: "Published author fixture", description: "", dsh: "*",
    runtime: { range: "*", version: RUNTIME }, bundles: bundles.map(item => ({ ...item, before: [], after: [] })),
    patch: [], patchYaml: "[]\n", inputs: [], publishedAt: "2026-09-17T00:00:00Z" };
  release.contentHash = `sha256:${createHash("sha256").update(canonical(release)).digest("hex")}`;
  return { release, resolved: { profileVersion: version, bundles } };
}

test("a local Profile can attach to a real author release and upgrade again without losing personal content", async t => {
  const { home, profile, active, install, edit } = await fixture(t);
  await edit({ kind: "add", bundle: npmBundle(ADDED) });
  const patchFile = join(home, "personal.yml"); await writeFile(patchFile, PATCH);
  await edit({ kind: "configure", patchFile });
  await writeFile(join(active, "personal-note"), PERSONAL);
  const first = remote("1.0.0", "1.0.0"), slug = "published-author";
  const prepared = await prepareProfileUpgrade({ profile, dshHome: home, slug, ...first });
  assert.notEqual(prepared.status, "baseline_required", "local provenance must not be mistaken for a missing author baseline");
  safe(prepared.summary);
  const resolutions = prepared.status === "conflicted" ? { contextHash: prepared.contextHash,
    choices: Object.fromEntries(prepared.summary.conflicts.map(item => [item.id, item.choices.includes("local") ? "local" as const : "upstream" as const])) } : undefined;
  await installResolvedProfile({ profile, dshHome: home, hubProfileSlug: slug, ...first, resolutions,
    execute: install.execute, validate: install.validate });
  const attached = await json(profileLockPath(profile, home));
  assert.notEqual(attached.source, "local");
  assert.deepEqual(attached.hubProfile, { slug, version: "1.0.0" });
  assert.equal(attached.authorBaseline.release.version, "1.0.0");
  assert.equal(attached.authorBaseline.resolved.bundles.some((item: ResolvedProfileBundle) => item.packageName === ADDED), false);
  safe(attached.authorBaseline);
  await installResolvedProfile({ profile, dshHome: home, hubProfileSlug: slug, ...remote("2.0.0", "1.1.0"), mode: "upgrade",
    execute: install.execute, validate: install.validate });
  const current = await json(profileLockPath(profile, home));
  assert.equal(current.authorBaseline.release.version, "2.0.0");
  safe(current.authorBaseline);
  assert.equal(await readFile(join(active, "cordis.patch.yml"), "utf8"), PATCH);
  assert.equal(await readFile(join(active, "personal-note"), "utf8"), PERSONAL);
  const manifest = await json(join(active, "package.json"));
  assert.equal(manifest.dependencies[ADDED], "2.0.0");
  assert.equal((await json(join(active, "node_modules", AUTHOR, "package.json"))).version, "1.1.0");
  assert.equal(install.loaded.at(-1)?.includes(ADDED), true);
  assert.equal((await doctorProfile({ profile, dshHome: home })).healthy, true);
});

test("reviewed creation or adoption refuses a newly appearing target or changed unmanaged files", async t => {
  for (const originallyExisting of [false, true]) {
    const { home, profile, active, install, edit } = await fixture(t);
    if (originallyExisting) await unmanaged(active);
    const intent: Intent = { kind: "add", bundle: npmBundle(ADDED) };
    const prepared = await prepareProfileEdit({ profile, dshHome: home, runtimeVersion: RUNTIME, intent });
    if (originallyExisting) await writeFile(join(active, "notes", "personal.txt"), "work added after preview");
    else await unmanaged(active);
    const changed = await snapshot(home, profile);
    await assert.rejects(edit(intent, { expectedContextHash: prepared.contextHash, expectedResultHash: prepared.resultHash }));
    assert.equal(install.attempts, 0);
    assert.deepEqual(await snapshot(home, profile), changed);
  }
});

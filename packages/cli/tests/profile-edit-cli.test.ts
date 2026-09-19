import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyProfileEdit, installResolvedProfile, profileLockPath } from "../dist/index.js";
import { applyOperationPlan, createPluginInstallPlan, createProfileEditPlan } from "../dist/operations.js";
import { doctorProfile, readProfileState } from "../dist/profile-lifecycle.js";
import { installationFingerprint } from "../dist/profile-files.js";
import { setProfileInput } from "../dist/profile-inputs.js";
import { fakeRuntimeInstaller } from "./runtime-fixture.mjs";
import { installFakeProfilePackageManager, fakeProfilePackageIntegrity } from "./profile-package-manager-fixture.mjs";

const base = { packageName: "@deepseek-ai/dsh-base", selector: "0.1.0", version: "0.1.0",
  installSpec: "builtin:@deepseek-ai/dsh-base@0.1.0", sourceKind: "builtin" as const };
const toolsBundle = { ...base, packageName: "@deepseek-ai/dsh-tools", installSpec: "builtin:@deepseek-ai/dsh-tools@0.1.0" };
const release = { schemaVersion: 1 as const, version: "1.0.0", name: "Edit", description: "", dsh: "*",
  runtime: { range: "*", version: "0.1.0" }, bundles: [base, toolsBundle].map(bundle => ({ ...bundle, before: [], after: [] })),
  patch: [], patchYaml: "[]\n", inputs: [], publishedAt: "2026-09-17T00:00:00.000Z" };
const resolved = { profileVersion: release.version, bundles: [base, toolsBundle] };
const pluginVersion = { version: "1.2.3", channel: "stable", manifest: { name: "local-plugin", version: "1.2.3", dsh: { bundle: { patch: "patch.yml" } } },
  source: { kind: "npm", packageName: "local-plugin", version: "1.2.3", installSpec: "local-plugin@1.2.3", tarballUrl: "https://registry.npmjs.org/local-plugin/-/local-plugin-1.2.3.tgz", integrity: fakeProfilePackageIntegrity },
  compatibility: { dsh: "*", platforms: [], surfaces: ["any"], hmr: "restart" }, entryIds: [], before: [], after: [], publishedAt: "2026-09-17T00:00:00.000Z", yanked: false };
const plugin = { id: "123e4567-e89b-12d3-a456-426614174000", slug: "local-plugin", packageName: "local-plugin", displayName: "Local Plugin",
  summary: "Fixture", description: "", repository: "fixture/local-plugin", categories: [], keywords: [], screenshots: [], verified: false, deprecated: false,
  latestVersion: "1.2.3", distTags: { latest: "1.2.3" }, versions: [pluginVersion], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-edit-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installResolvedProfile({ profile: "web", dshHome: root, release, resolved, hubProfileSlug: "edit",
    execute: async () => {}, validate: async () => {} });
  const mock = join(root, "api.mjs");
  await writeFile(mock, `globalThis.fetch=async(url)=>{if(!String(url).endsWith('/packages/resolve?name=local-plugin'))throw new Error('unexpected test request');return new Response(${JSON.stringify(JSON.stringify(plugin))},{status:200,headers:{'content-type':'application/json'}});};\n`);
  return { root, mock, directory: join(root, "profiles", "web") };
}
function cli(root: string, mock: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", mock, fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...args, "--json"],
      { env: { ...process.env, DSH_HOME: root, DSH_HUB_TELEMETRY: "0", DSH_HUB_API_URL: "http://fixture.invalid", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", fail); child.once("close", code => done({ code, stdout, stderr }));
  });
}
const edit = (options: Parameters<typeof applyProfileEdit>[0]) => applyProfileEdit({ ...options, execute: async () => {}, validate: async () => {} });

test("plugin CLI previews and plans map to bounded local intents without changing the active Profile", async t => {
  const { root, mock, directory } = await fixture(t);
  const before = await installationFingerprint(directory, profileLockPath("web", root));
  const cases = [
    { args: ["remove", base.packageName], intent: { kind: "remove", packageName: base.packageName } },
    { args: ["disable", base.packageName], intent: { kind: "disable", packageName: base.packageName } },
    { args: ["enable", base.packageName], intent: { kind: "enable", packageName: base.packageName } },
    { args: ["reorder", toolsBundle.packageName, base.packageName], intent: { kind: "reorder", order: [toolsBundle.packageName, base.packageName] } },
  ];
  for (const item of cases) {
    const preview = await cli(root, mock, ["profile", "plugin", ...item.args, "--dry-run"]);
    assert.equal(preview.code, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).edit.action, item.intent.kind);
    const result = await cli(root, mock, ["profile", "plugin", ...item.args, "--plan"]);
    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.kind, "profile.edit"); assert.deepEqual(plan.input.intent, item.intent);
    assert.match(plan.precondition.contextHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(plan.precondition.resultHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(plan.effect.authorBaseline, "retained");
  }
  assert.equal(await installationFingerprint(directory, profileLockPath("web", root)), before);
});

test("install resolves tags into an exact add intent and does not execute a global runtime", async t => {
  const { root, mock, directory } = await fixture(t);
  const before = await installationFingerprint(directory, profileLockPath("web", root));
  const result = await cli(root, mock, ["install", "local-plugin", "--position", "1", "--plan"]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.kind, "profile.edit");
  assert.deepEqual(plan.input.intent, { kind: "add", position: 1, rule: { packageName: plugin.packageName, version: pluginVersion.version, before: [], after: [], compatibility: pluginVersion.compatibility }, bundle: { packageName: "local-plugin", selector: "1.2.3", version: "1.2.3", installSpec: "local-plugin@1.2.3", sourceKind: "npm", integrity: pluginVersion.source.integrity } });
  const compatible = await createPluginInstallPlan({ profile: "web", plugin: plugin as never, version: "1.2.3", installSpec: "local-plugin@1.2.3", dshHome: root });
  assert.equal(compatible.kind, "profile.edit");
  await assert.rejects(createPluginInstallPlan({ profile: "web", plugin: plugin as never, version: "1.2.3", installSpec: "local-plugin@latest", dshHome: root }), /exact version and source/);
  assert.equal(await installationFingerprint(directory, profileLockPath("web", root)), before);
});

test("configure plans omit configuration bytes and recheck file content before applying", async t => {
  const { root, mock, directory } = await fixture(t);
  const marker = "local-private-configuration-marker", patchFile = join(root, "private.yml");
  await writeFile(patchFile, `key: ${marker}\n`);
  const result = await cli(root, mock, ["profile", "configure", "--file", patchFile, "--plan"]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout), planPath = join(root, ".hub", "operations", `${plan.id}.json`);
  assert.deepEqual(plan.input.intent, { kind: "configure", patchFile });
  assert.equal(result.stdout.includes(marker), false); assert.equal((await readFile(planPath, "utf8")).includes(marker), false);
  const before = await installationFingerprint(directory, profileLockPath("web", root));
  await writeFile(patchFile, "key: changed\n");
  await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root, edit: async () => { throw new Error("must not execute"); } }), /changed after planning/);
  assert.equal(await installationFingerprint(directory, profileLockPath("web", root)), before);
});

test("edit plans bind intent and execute with the reviewed context under the shared transaction", async t => {
  const { root } = await fixture(t);
  const plan = await createProfileEditPlan({ profile: "web", intent: { kind: "disable", packageName: toolsBundle.packageName }, dshHome: root });
  const events: Record<string, unknown>[] = [];
  const result = await applyOperationPlan({ id: plan.id, dshHome: root, progress: event => events.push(event), edit: options => {
    assert.equal(options.expectedContextHash, plan.precondition.contextHash);
    assert.equal(options.expectedResultHash, plan.precondition.resultHash);
    return edit(options);
  } });
  assert.equal(result.edit?.action, "disable"); assert.ok(result.revision);
  assert.equal(events.at(-1)?.type, "operation.completed");
  assert.deepEqual((await readProfileState("web", root))!.bundles.map(item => item.packageName), [base.packageName]);
  await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root, edit }), /applied/);
  const forged = await createProfileEditPlan({ profile: "web", intent: { kind: "enable", packageName: toolsBundle.packageName }, dshHome: root });
  forged.input.intent = { kind: "remove", packageName: base.packageName };
  await writeFile(join(root, ".hub", "operations", `${forged.id}.json`), JSON.stringify(forged));
  await assert.rejects(applyOperationPlan({ id: forged.id, dshHome: root, edit }), /changed after review/);
});

test("declarations persist separately from values and remote doctor retains required local inputs", async t => {
  const { root, mock } = await fixture(t);
  const key = "HUB_TEST_LOCAL_EDIT_KEY", marker = "private-local-edit-input";
  const result = await cli(root, mock, ["profile", "inputs", "declare", key, "--label", "Fixture key", "--plan"]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.input.intent, { kind: "input-declare", declaration: { key, label: "Fixture key", required: true, secret: true } });
  await setProfileInput("web", key, marker, root);
  await applyOperationPlan({ id: plan.id, dshHome: root, edit });
  const state = (await readProfileState("web", root))!;
  assert.equal(state.localInputs?.[0].key, key); assert.deepEqual(state.authorBaseline!.release.inputs, []);
  assert.equal(JSON.stringify(state).includes(marker), false);
  await rm(join(root, ".hub", "inputs", "web.json"));
  const report = await doctorProfile({ profile: "web", dshHome: root, release, resolved, slug: "edit" });
  assert.equal(report.healthy, false); assert.ok(report.checks.some(item => item.id === "required-input" && item.status === "failed" && item.message.includes(key)));
  const removed = await cli(root, mock, ["profile", "inputs", "undeclare", key, "--plan"]);
  assert.equal(removed.code, 0, removed.stderr);
  await applyOperationPlan({ id: JSON.parse(removed.stdout).id, dshHome: root, edit });
  assert.deepEqual((await readProfileState("web", root))!.localInputs ?? [], []);
});

test("doctor rejects another package carrying the expected version", async t => {
  const { root, directory } = await fixture(t);
  const state = (await readProfileState("web", root))!;
  state.dependencies = [{ packageName: "library", selector: "1.0.0", version: "1.0.0", sourceKind: "npm", installSpec: "library@1.0.0" }];
  await writeFile(profileLockPath("web", root), JSON.stringify(state));
  await mkdir(join(directory, "node_modules", "library"), { recursive: true });
  await writeFile(join(directory, "node_modules", "library", "package.json"), JSON.stringify({ name: "wrong-library", version: "1.0.0" }));
  const result = await doctorProfile({ profile: "web", dshHome: root });
  assert.equal(result.healthy, false); assert.ok(result.checks.some(item => item.id === "dependency-version" && item.status === "failed"));
});

test("invalid local edits and new Profiles without an exact runtime fail without writing an operation", async t => {
  const { root, mock } = await fixture(t);
  for (const args of [["profile", "plugin", "reorder", base.packageName, "--plan"],
    ["profile", "configure", "--plan"], ["profile", "inputs", "declare", "PATH", "--plan"],
    ["profile", "inputs", "declare", "FIXTURE_KEY", "private-marker", "--plan"],
    ["profile", "plugin", "disable", base.packageName, "--dry-run", "--plan"],
    ["install", "local-plugin", "--profile", "missing", "--plan"]]) {
    const result = await cli(root, mock, args);
    assert.equal(result.code, 1, result.stdout); assert.equal(`${result.stdout}${result.stderr}`.includes("private-marker"), false);
  }
  await assert.rejects(readdir(join(root, ".hub", "operations")), { code: "ENOENT" });
});


test("direct CLI configuration validates with the pinned runtime and leaves the active Profile intact on failure", async t => {
  const { root, mock, directory } = await fixture(t);
  const patchFile = join(root, "direct.yml"), marker = "private-cli-configuration-marker";
  await writeFile(patchFile, `value: ${marker}\n`);
  await installFakeProfilePackageManager(root);
  const bin = await fakeRuntimeInstaller(root, `console.log(${JSON.stringify(marker)});console.error(${JSON.stringify(marker)});process.exit(Number(process.env.HUB_EDIT_VALIDATION_EXIT||0));`);
  const before = await installationFingerprint(directory, profileLockPath("web", root));
  const failure = await cli(root, mock, ["profile", "configure", "--file", patchFile], { PATH: `${bin}:${process.env.PATH}`, HUB_EDIT_VALIDATION_EXIT: "7" });
  assert.equal(failure.code, 1, failure.stdout);
  assert.match(failure.stderr, /existing Profile was not switched/);
  assert.equal(`${failure.stdout}${failure.stderr}`.includes(marker), false);
  assert.equal(await installationFingerprint(directory, profileLockPath("web", root)), before);
  const success = await cli(root, mock, ["profile", "configure", "--file", patchFile], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).edit.action, "configure");
  assert.ok(JSON.parse(success.stdout).revision);
  assert.equal(`${success.stdout}${success.stderr}`.includes(marker), false);
  assert.equal(await readFile(join(directory, "cordis.patch.yml"), "utf8"), `value: ${marker}\n`);
});

test("edit conflict responses provide safe choices bound to that edit", async t => {
  const { root, mock, directory } = await fixture(t);
  const marker = "private-generated-file-marker";
  await writeFile(join(directory, "pnpm-workspace.yaml"), `onlyBuiltDependencies:\n  - ${marker}\n`);
  const args = ["profile", "plugin", "disable", toolsBundle.packageName];
  const blocked = await cli(root, mock, [...args, "--dry-run"]);
  assert.equal(blocked.code, 2, blocked.stderr);
  const preview = JSON.parse(blocked.stdout);
  assert.equal(preview.error, "PROFILE_UPGRADE_BLOCKED");
  assert.match(preview.contextHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(`${blocked.stdout}${blocked.stderr}`.includes(marker), false);
  const choices = Object.fromEntries(preview.summary.conflicts.map((item: { id: string; choices: string[] }) => [item.id, "upstream"]));
  const file = join(root, "choices.json");
  await writeFile(file, JSON.stringify({ contextHash: preview.contextHash, choices }));
  const ready = await cli(root, mock, [...args, "--plan", "--resolutions", file]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).input.intent.kind, "disable");
  assert.equal(ready.stdout.includes(marker), false);
  const anotherEdit = await cli(root, mock, ["profile", "plugin", "remove", toolsBundle.packageName, "--plan", "--resolutions", file]);
  assert.equal(anotherEdit.code, 1); assert.match(anotherEdit.stderr, /another intent/);
});

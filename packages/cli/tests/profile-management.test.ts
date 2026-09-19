import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { installResolvedProfile, listProfileRevisions, profileLockPath, rollbackProfile } from "../dist/index.js";
import { createProfileApplyPlan, createProfileRollbackPlan, applyOperationPlan } from "../dist/operations.js";
import { listLocalProfiles, profileStatus, runLocalProfile } from "../dist/profile-lifecycle.js";
import { directoryFingerprint } from "../dist/profile-files.js";
import { fakeRuntimeInstaller } from "./runtime-fixture.mjs";

const executeFile = promisify(execFile);
const bundle = { packageName: "@deepseek-ai/dsh-base", selector: "0.1.0", version: "0.1.0",
  installSpec: "builtin:@deepseek-ai/dsh-base@0.1.0", sourceKind: "builtin" as const };
const release = { schemaVersion: 1 as const, version: "1.0.0", name: "Research", description: "", dsh: "*",
  runtime: { range: "*", version: "0.1.0" }, bundles: [{ ...bundle, before: [], after: [] }],
  patch: [], patchYaml: "[]\n", inputs: [], publishedAt: "2026-09-17T00:00:00.000Z", contentHash: "sha256:release" };
const resolved = { profileVersion: release.version, bundles: [bundle] };

test("shared runtime node_modules cannot be used as a Profile target in any case", async () => {
  for (const profile of ["node_modules", "NODE_MODULES", "Node_Modules"]) {
    await assert.rejects(installResolvedProfile({ profile, release, resolved, dryRun: true }), /reserved/);
  }
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-profile-management-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profiles", "web");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [bundle.packageName] } } }));
  await writeFile(join(profile, "cordis.patch.yml"), "[]\n");
  return { root, profile };
}

async function install(root: string, version = "1.0.0") {
  return installResolvedProfile({ profile: "web", dshHome: root, hubProfileSlug: "research",
    release: { ...release, version }, resolved: { ...resolved, profileVersion: version }, execute: async () => {}, validate: async () => {} });
}

test("apply and upgrade plans reject changed patch, custom files, deletion, and metadata without trusting contentHash", async (t) => {
  for (const kind of ["profile.apply", "profile.upgrade"] as const) {
    for (const change of ["patch", "custom", "delete", "state"] as const) {
      await t.test(`${kind}: ${change}`, async (t) => {
        const { root, profile } = await fixture(t);
        await install(root);
        const plan = await createProfileApplyPlan({ profile: "web", slug: "research", release, resolved, dshHome: root, kind });
        if (change === "patch") await writeFile(join(profile, "cordis.patch.yml"), "local: changed\n");
        if (change === "custom") await writeFile(join(profile, ".env"), "TOKEN=local-secret\n");
        if (change === "delete") await rm(join(profile, "package.json"));
        if (change === "state") {
          const path = profileLockPath("web", root);
          const state = JSON.parse(await readFile(path, "utf8"));
          await writeFile(path, JSON.stringify({ ...state, runtime: { range: "*", version: "0.2.0" } }));
        }
        let mutated = false;
        await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root,
          install: async () => { mutated = true; throw new Error("unexpected mutation"); } }), /changed after planning/);
        assert.equal(mutated, false);
        assert.equal(JSON.stringify(plan).includes("local-secret"), false);
      });
    }
  }
});

test("legacy plans without filesystem preconditions fail closed", async (t) => {
  const { root } = await fixture(t);
  const plan = await createProfileApplyPlan({ profile: "web", slug: "research", release, resolved, dshHome: root });
  const legacy = { ...plan, precondition: {} };
  await writeFile(join(root, ".hub", "operations", `${plan.id}.json`), JSON.stringify(legacy));
  await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root }), /changed after planning/);
});

test("edits made while a Release stages survive and abort the swap", async (t) => {
  const { root, profile } = await fixture(t);
  const before = await readFile(join(profile, "package.json"), "utf8");
  await assert.rejects(installResolvedProfile({ profile: "web", dshHome: root, release, resolved,
    execute: async () => {}, validate: async () => { await writeFile(join(profile, "notes.txt"), "keep my work"); } }), /changed while preparing/);
  assert.equal(await readFile(join(profile, "package.json"), "utf8"), before);
  assert.equal(await readFile(join(profile, "notes.txt"), "utf8"), "keep my work");
  assert.deepEqual(await listProfileRevisions("web", root), []);
});

test("Profile mutation locks exclude concurrent installs and release after failure", async (t) => {
  const { root } = await fixture(t);
  let unlock!: () => void;
  let staged!: () => void;
  const stageStarted = new Promise<void>((resolve) => { staged = resolve; });
  const pending = new Promise<void>((resolve) => { unlock = resolve; });
  const first = installResolvedProfile({ profile: "web", dshHome: root, release, resolved, execute: async () => {},
    validate: async () => { staged(); await pending; throw new Error("stop staging"); } });
  await stageStarted;
  await assert.rejects(install(root), /Another Hub operation/);
  unlock();
  await assert.rejects(first, /stop staging/);
  await install(root);
});

test("unmanaged Profiles are recoverable and failed rollback restores current directory and metadata", async (t) => {
  const { root, profile } = await fixture(t);
  await writeFile(join(profile, "custom.txt"), "original local work");
  const result = await install(root);
  const beforeState = await readFile(profileLockPath("web", root), "utf8");
  assert.equal((await listProfileRevisions("web", root)).length, 1);
  await assert.rejects(rollbackProfile({ profile: "web", dshHome: root, revision: result.revision,
    persistState: async () => { throw new Error("disk full"); } }), /disk full/);
  assert.equal(await readFile(profileLockPath("web", root), "utf8"), beforeState);
  assert.equal((await profileStatus("web", root)).release?.version, "1.0.0");
  assert.equal((await listProfileRevisions("web", root)).length, 1);
  await rollbackProfile({ profile: "web", dshHome: root, revision: result.revision });
  assert.equal(await readFile(join(profile, "custom.txt"), "utf8"), "original local work");
  assert.equal((await profileStatus("web", root)).managed, false);
  assert.equal((await profileStatus("web", root)).healthy, true);
});

test("rollback plans bind both the active Profile and the selected revision", async (t) => {
  const { root } = await fixture(t);
  const result = await install(root);
  const plan = await createProfileRollbackPlan({ profile: "web", dshHome: root, revision: result.revision });
  await writeFile(join(root, ".hub", "installations", "web", "revisions", result.revision!, "profile", "notes.txt"), "edited backup");
  await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root }), /revision changed after planning/);
  assert.equal((await profileStatus("web", root)).release?.version, "1.0.0");
});

test("local list and status report release, runtime, history, and actual file drift", async (t) => {
  const { root, profile } = await fixture(t);
  assert.equal((await profileStatus("web", root)).drift, "unknown");
  await install(root);
  await mkdir(join(root, "profiles", ".hub-web-staging"));
  // Real DSH creates this shared package resolution directory during --dump-config.
  await mkdir(join(root, "profiles", "node_modules"));
  let status = await profileStatus("web", root);
  assert.equal(status.drift, "clean");
  assert.equal(status.runtimeVersion, "0.1.0");
  assert.equal(status.revisionCount, 1);
  assert.equal(status.healthy, true);
  await writeFile(join(profile, "notes.txt"), "secret content is never returned");
  status = await profileStatus("web", root);
  assert.equal(status.drift, "modified");
  assert.equal(JSON.stringify(status).includes("secret content"), false);
  assert.deepEqual((await listLocalProfiles(root)).map((item) => item.profile), ["web"]);
});

test("run pins the installed runtime, supports explicit legacy runtime, and never returns local inputs", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(runLocalProfile({ profile: "web", dshHome: root, dryRun: true }), /No recorded runtime/);
  const legacy = await runLocalProfile({ profile: "web", dshHome: root, runtimeVersion: "0.2.0", dryRun: true });
  assert.equal(legacy.runtimeVersion, "0.2.0");
  await install(root);
  let command;
  const result = await runLocalProfile({ profile: "web", dshHome: root, execute: async (value) => { command = value; } });
  assert.deepEqual(command, { command: "npx", args: ["-y", "@deepseek-ai/dsh@0.1.0", "--profile", "web"] });
  assert.equal(result.runtimeVersion, "0.1.0");
  await assert.rejects(runLocalProfile({ profile: "web", dshHome: root, runtimeVersion: "latest", dryRun: true }));
});

test("fingerprints do not traverse symlinks or dependency trees", async (t) => {
  const { root, profile } = await fixture(t);
  const external = join(root, "secret.txt");
  await writeFile(external, "external secret");
  await symlink(external, join(profile, "linked.txt"));
  await mkdir(join(profile, "node_modules"));
  const before = await directoryFingerprint(profile);
  await writeFile(external, "changed external secret");
  await writeFile(join(profile, "node_modules", "ignored.txt"), "generated");
  assert.equal(await directoryFingerprint(profile), before);
  await rm(join(profile, "linked.txt"));
  assert.notEqual(await directoryFingerprint(profile), before);
});

test("CLI list, status and run preview work offline against isolated local state", async (t) => {
  const { root } = await fixture(t);
  await install(root);
  const env = { ...process.env, DSH_HOME: root, DSH_HUB_TELEMETRY: "0", DSH_HUB_API_URL: "http://127.0.0.1:1" };
  async function cli(args: string[]) {
    const { stdout } = await executeFile(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...args, "--json"], { env });
    return JSON.parse(stdout);
  }
  assert.equal((await cli(["profile", "list"]))[0].profile, "web");
  assert.equal((await cli(["profile", "status"])).runtimeVersion, "0.1.0");
  assert.equal((await cli(["profile", "run", "--dry-run"])).command.args[1], "@deepseek-ai/dsh@0.1.0");
});

test("CLI launch passes the exact runtime, isolated DSH_HOME and local inputs to its child without printing secrets", async (t) => {
  const { root } = await fixture(t);
  await install(root);
  const statePath = profileLockPath("web", root);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.inputs = [{ key: "DSH_HUB_TEST_RUN_KEY", label: "Local key", required: true, secret: true }];
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(runLocalProfile({ profile: "web", dshHome: root, execute: async () => { throw new Error("must not launch"); } }),
    /DSH_HUB_TEST_RUN_KEY is missing/);
  const mockBin = await fakeRuntimeInstaller(root,
    `require('node:fs').writeFileSync(require('node:path').join(process.env.DSH_HOME, 'launch.json'), JSON.stringify({args:process.argv.slice(2),home:process.env.DSH_HOME,key:process.env.DSH_HUB_TEST_RUN_KEY}));`);
  const env = { ...process.env, PATH: `${mockBin}:${process.env.PATH}`, DSH_HOME: root, DSH_HUB_TELEMETRY: "0",
    DSH_HUB_API_URL: "http://127.0.0.1:1", DSH_HUB_TEST_RUN_KEY: "only-in-the-local-child" };
  const { stdout } = await executeFile(process.execPath,
    [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), "profile", "run", "--json"], { env });
  const launched = JSON.parse(await readFile(join(root, "launch.json"), "utf8"));
  assert.deepEqual(launched.args, ["--profile", "web"]);
  assert.equal(launched.home, root);
  assert.equal(launched.key, env.DSH_HUB_TEST_RUN_KEY);
  assert.equal(stdout.includes(env.DSH_HUB_TEST_RUN_KEY), false);
  assert.equal((await readFile(statePath, "utf8")).includes(env.DSH_HUB_TEST_RUN_KEY), false);
});

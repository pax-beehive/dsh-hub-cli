import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { profileLockPath, rollbackProfile } from "../dist/index.js";
import { installLockedProfileDependencies } from "../dist/profile-dependency-install.js";
import { directoryFingerprint } from "../dist/profile-files.js";
import { doctorProfile, listLocalProfiles, profileStatus, readProfileState, runLocalProfile } from "../dist/profile-lifecycle.js";

const runtimeVersion = "0.1.0", privateConfig = "synthetic-private-registry-credential";
const builtin = { packageName: "@deepseek-ai/dsh-base", selector: runtimeVersion, version: runtimeVersion,
  installSpec: `builtin:@deepseek-ai/dsh-base@${runtimeVersion}`, sourceKind: "builtin" as const };
const nativeLock = "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n";

async function fixture(t: test.TestContext, hooks = false) {
  const root = await mkdtemp(join(tmpdir(), "dsh-dependency-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "profiles", "web"), statePath = profileLockPath("web", root);
  const pmEvents = join(root, "pm-events.jsonl"), runtimeEvents = join(root, "runtime-events.jsonl"), hookProof = join(root, "hook-was-run");
  const externalConfig = join(root, "user.npmrc");
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, ".hub", "installations", "web"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "dependency-state-fixture", private: true,
    packageManager: "pnpm@10.33.0", dependencies: {}, dsh: { profile: { bundles: [builtin.packageName] } } }));
  await writeFile(join(directory, "cordis.patch.yml"), "[]\n");
  await writeFile(join(directory, ".npmrc"), "registry=https://fixture.invalid\n");
  await writeFile(externalConfig, `//fixture.invalid/:_authToken=${privateConfig}\n`);
  if (hooks) await writeFile(join(directory, ".pnpmfile.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(hookProof)},'executed');module.exports={};\n`);
  const pm = join(root, ".hub", "package-managers", "pnpm", "10.33.0", "node_modules", "pnpm");
  await mkdir(pm, { recursive: true });
  await writeFile(join(pm, "package.json"), JSON.stringify({ name: "pnpm", version: "10.33.0", bin: { pnpm: "bin.cjs" } }));
  // The production installer creates the receipt. The fixture process supplies
  // a valid empty native graph, avoiding duplicated receipt hashing logic.
  await writeFile(join(pm, "bin.cjs"), `const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pmEvents)},JSON.stringify(args)+'\\n');
if(args[0]==='--version')console.log('10.33.0');
else if(args[0]==='config')console.log(JSON.stringify({userconfig:${JSON.stringify(externalConfig)}}));
else if(args.includes('--lockfile-only'))fs.writeFileSync(path.join(process.cwd(),'pnpm-lock.yaml'),${JSON.stringify(nativeLock)});
else if(!args.includes('--frozen-lockfile'))process.exit(37);\n`);
  const installed = await installLockedProfileDependencies({ directory, dshHome: root, dependencies: [] });
  const state = { schemaVersion: 2, profile: "web", source: "local", resolvedAt: "2026-09-18T00:00:00.000Z",
    runtime: { range: "*", version: runtimeVersion }, bundles: [builtin], dependencies: [], inputs: [],
    effectiveLock: installed.receipt, localFilesHash: await directoryFingerprint(directory) };
  await writeFile(statePath, JSON.stringify(state));
  const runtime = join(root, ".hub", "runtimes", runtimeVersion, "node_modules", "@deepseek-ai", "dsh");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: runtimeVersion, bin: { dsh: "bin.cjs" } }));
  await writeFile(join(runtime, "bin.cjs"), `require('node:fs').appendFileSync(${JSON.stringify(runtimeEvents)},'runtime-started\\n');\n`);
  return { root, directory, statePath, externalConfig, state, pmEvents, runtimeEvents, hookProof,
    preparedEvents: await readFile(pmEvents, "utf8") };
}
async function assertNoLaunch(f: Awaited<ReturnType<typeof fixture>>) {
  await assert.rejects(readFile(f.runtimeEvents), { code: "ENOENT" });
  await assert.rejects(readFile(f.hookProof), { code: "ENOENT" });
  assert.equal(await readFile(f.pmEvents, "utf8"), f.preparedEvents, "static inspection must not invoke package-manager code");
}

// These checks exercise state integration, using a receipt created through the
// actual production lock installer and real subprocesses only during setup.
test("doctor and status verify a recorded lock through pure reads, including hooked Profiles", async t => {
  const f = await fixture(t, true);
  const doctor = await doctorProfile({ profile: "web", dshHome: f.root });
  assert.equal(doctor.healthy, true); assert.equal(doctor.checks.find(check => check.id === "dependency-lock")?.status, "passed");
  const status = await profileStatus("web", f.root);
  assert.equal(status.healthy, true); assert.equal(status.drift, "clean");
  assert.equal(JSON.stringify(status).includes(privateConfig), false);
  assert.equal((await listLocalProfiles(f.root))[0]?.healthy, true);
  await assertNoLaunch(f);
});

test("missing or changed native lock and manifest/config drift block run before any child starts", async t => {
  for (const change of ["missing-lock", "changed-lock", "manifest", "local-config", "external-config", "removed-external-config", "platform", "node-abi"] as const) {
    await t.test(change, async t => {
      const f = await fixture(t);
      if (change === "missing-lock") await rm(join(f.directory, "pnpm-lock.yaml"));
      if (change === "changed-lock") await writeFile(join(f.directory, "pnpm-lock.yaml"), `${nativeLock}# changed\n`);
      if (change === "manifest") {
        const manifest = JSON.parse(await readFile(join(f.directory, "package.json"), "utf8"));
        manifest.dependencies = { "new-library": "1.0.0" }; await writeFile(join(f.directory, "package.json"), JSON.stringify(manifest));
      }
      if (change === "local-config") await writeFile(join(f.directory, ".npmrc"), "registry=https://other-fixture.invalid\n");
      if (change === "external-config") await writeFile(f.externalConfig, "//fixture.invalid/:_authToken=rotated-file-value\n");
      if (change === "removed-external-config") await rm(f.externalConfig);
      if (change === "platform" || change === "node-abi") {
        const receipt = f.state.effectiveLock;
        if (change === "platform") receipt.platform = process.platform === "win32" ? "linux" : "win32";
        else receipt.nodeAbi = process.versions.modules === "999999" ? "999998" : "999999";
        await writeFile(f.statePath, JSON.stringify(f.state));
      }
      const doctor = await doctorProfile({ profile: "web", dshHome: f.root });
      assert.equal(doctor.healthy, false); assert.equal(doctor.checks.find(check => check.id === "dependency-lock")?.status, "failed");
      const status = await profileStatus("web", f.root); assert.equal(status.healthy, false);
      assert.equal(JSON.stringify([doctor.checks, status]).includes(privateConfig), false);
      await assert.rejects(runLocalProfile({ profile: "web", dshHome: f.root }), /Profile is not ready/);
      await assertNoLaunch(f);
    });
  }
});

test("malformed optional receipts are rejected before doctor or runtime can use them", async t => {
  for (const malformed of [null, {}, { schemaVersion: 999 }, { schemaVersion: 1, manifestHash: privateConfig }]) {
    const f = await fixture(t);
    await writeFile(f.statePath, JSON.stringify({ ...f.state, effectiveLock: malformed }));
    for (const action of [() => readProfileState("web", f.root), () => doctorProfile({ profile: "web", dshHome: f.root }),
      () => runLocalProfile({ profile: "web", dshHome: f.root })]) {
      await assert.rejects(action(), error => {
        assert.match((error as Error).message, /dependency lock receipt is invalid/);
        assert.equal((error as Error).message.includes(privateConfig), false); return true;
      });
    }
    await assertNoLaunch(f);
  }
});

test("rotating package-manager environment credentials does not invalidate a ready Profile", async t => {
  const f = await fixture(t), key = "NPM_TOKEN", previous = process.env[key];
  try {
    process.env[key] = "synthetic-rotated-environment-credential";
    const status = await profileStatus("web", f.root);
    assert.equal(status.healthy, true); assert.equal(status.checks.find(check => check.id === "dependency-lock")?.status, "passed");
    assert.equal(JSON.stringify(status).includes(process.env[key]), false);
    await assertNoLaunch(f);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

test("rollback to a legacy revision without a receipt remains usable and reports the missing verification", async t => {
  const f = await fixture(t), id = "2026-09-17-legacy-fixture";
  const revision = join(f.root, ".hub", "installations", "web", "revisions", id), profile = join(revision, "profile");
  await mkdir(revision, { recursive: true }); await cp(f.directory, profile, { recursive: true });
  await rm(join(profile, "pnpm-lock.yaml"));
  const { effectiveLock: _receipt, ...legacy } = f.state;
  legacy.localFilesHash = await directoryFingerprint(profile);
  await writeFile(join(revision, "state.json"), JSON.stringify(legacy));
  await rollbackProfile({ profile: "web", dshHome: f.root, revision: id });
  assert.equal((await readProfileState("web", f.root))?.effectiveLock, undefined);
  const status = await profileStatus("web", f.root);
  assert.equal(status.healthy, true); assert.equal(status.checks.find(check => check.id === "dependency-lock")?.status, "warning");
  await assertNoLaunch(f);
  await runLocalProfile({ profile: "web", dshHome: f.root });
  assert.equal(await readFile(f.runtimeEvents, "utf8"), "runtime-started\n");
  assert.equal(await readFile(f.pmEvents, "utf8"), f.preparedEvents);
});

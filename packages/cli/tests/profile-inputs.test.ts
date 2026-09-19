import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureProfile, installResolvedProfile, profileLockPath, rollbackProfile } from "../dist/index.js";
import { doctorProfile, profileStatus, runLocalProfile } from "../dist/profile-lifecycle.js";
import { applyOperationPlan, createProfileEditPlan, createProfileApplyPlan } from "../dist/operations.js";
import { listProfileInputs, resolveProfileInputs, setProfileInput, unsetProfileInput } from "../dist/profile-inputs.js";
import { fakeRuntimeInstaller } from "./runtime-fixture.mjs";
import { installFakeProfilePackageManager } from "./profile-package-manager-fixture.mjs";

const key = "HUB_TEST_SECRET_INPUT";
const declaration = { key, label: "Local test key", required: true, secret: true };
const bundle = { packageName: "@deepseek-ai/dsh-base", selector: "0.1.0", version: "0.1.0", installSpec: "builtin:@deepseek-ai/dsh-base@0.1.0", sourceKind: "builtin" as const };
const release = { schemaVersion: 1 as const, version: "1.0.0", name: "Inputs", description: "", dsh: "*", runtime: { range: "*", version: "0.1.0" },
  bundles: [{ ...bundle, before: [], after: [] }], inputs: [declaration], patch: [], patchYaml: `apiKeyEnv: ${key}\n`, publishedAt: "2026-09-17T00:00:00Z" };
const resolved = { profileVersion: release.version, bundles: [bundle] };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-profile-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function cli(root: string, args: string[], input = "", extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DSH_HOME: root, DSH_HUB_TELEMETRY: "0", DSH_HUB_API_URL: "http://127.0.0.1:1", ...extraEnv };
    delete env[key];
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

test("pre-install values use private atomic storage outside shareable Profiles and never appear in listings", async (t) => {
  const root = await fixture(t);
  const secret = 'spaces = quotes " and\nmultiple lines';
  await setProfileInput("work", key, secret, root);
  const directory = join(root, ".hub", "inputs");
  const file = join(directory, "work.json");
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["work.json"]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).values[key], secret);
  const listed = await listProfileInputs({ profile: "work", dshHome: root, env: {} });
  assert.deepEqual(listed, [{ key, configured: true, source: "stored", declared: false, configurable: true, required: false, secret: true }]);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  await assert.rejects(lstat(join(root, "profiles")), { code: "ENOENT" });
});

test("profiles remain isolated; env wins, explicit empty does not fall back, and undeclared saved keys stay out", async (t) => {
  const root = await fixture(t);
  await setProfileInput("a", key, "stored-a", root);
  await setProfileInput("b", key, "stored-b", root);
  await setProfileInput("a", "UNDECLARED_SECRET", "not-for-child", root);
  const a = await resolveProfileInputs({ profile: "a", declarations: [declaration], dshHome: root, env: {} });
  const b = await resolveProfileInputs({ profile: "b", declarations: [declaration], dshHome: root, env: {} });
  assert.equal(a.env[key], "stored-a");
  assert.equal(b.env[key], "stored-b");
  assert.equal(a.env.UNDECLARED_SECRET, undefined);
  const override = await resolveProfileInputs({ profile: "a", declarations: [declaration], dshHome: root, env: { [key]: "explicit" } });
  assert.equal(override.env[key], "explicit");
  assert.equal(override.statuses[0].source, "environment");
  const empty = await resolveProfileInputs({ profile: "a", declarations: [declaration], dshHome: root, env: { [key]: "" } });
  assert.equal(empty.env[key], "");
  assert.deepEqual(empty.missing, [key]);
  await unsetProfileInput("a", key, root);
  assert.deepEqual((await resolveProfileInputs({ profile: "a", declarations: [declaration], dshHome: root, env: {} })).missing, [key]);
  assert.equal((await resolveProfileInputs({ profile: "b", declarations: [declaration], dshHome: root, env: {} })).env[key], "stored-b");
});

test("process controls cannot be stored, while declared DSH_HOME comes from the effective runtime home", async (t) => {
  const root = await fixture(t);
  for (const reserved of ["PATH", "NODE_OPTIONS", "DSH_HOME", "NPM_CONFIG_USERCONFIG", "LD_PRELOAD", "DYLD_LIBRARY_PATH", "HOME"]) {
    await assert.rejects(setProfileInput("web", reserved, "must-not-be-used", root), /reserved/);
  }
  await setProfileInput("web", "DSH_AGENTS_HOME", join(root, "agents"), root);
  const declarations = [
    { ...declaration, key: "DSH_HOME" }, { ...declaration, key: "DSH_AGENTS_HOME" }, { ...declaration, key: "NODE_OPTIONS", required: false },
  ];
  const selected = await resolveProfileInputs({ profile: "web", declarations, dshHome: root, env: { DSH_HOME: "/wrong-global-home", PATH: "/trusted/bin" } });
  assert.equal(selected.env.DSH_HOME, root);
  assert.equal(selected.statuses[0].source, "runtime");
  assert.equal(selected.statuses[0].configurable, false);
  assert.equal(selected.env.DSH_AGENTS_HOME, join(root, "agents"));
  assert.equal(selected.env.PATH, "/trusted/bin");
  assert.equal(selected.env.NODE_OPTIONS, undefined);
  assert.deepEqual(selected.missing, []);
});

test("input storage rejects symlink directories/files and broad permissions without exposing malformed values", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, join(root, ".hub"));
  await assert.rejects(setProfileInput("web", key, "value", root), /real directories/);
  await rm(join(root, ".hub"));
  await setProfileInput("web", key, "private-marker", root);
  const file = join(root, ".hub", "inputs", "web.json");
  await chmod(file, 0o644);
  await assert.rejects(listProfileInputs({ profile: "web", dshHome: root }), /permissions/);
  await chmod(file, 0o600);
  await writeFile(file, '{"values":"private-marker"');
  try { await listProfileInputs({ profile: "web", dshHome: root }); assert.fail("expected invalid JSON"); }
  catch (error) { assert.match(String(error), /invalid JSON/); assert.equal(String(error).includes("private-marker"), false); }
  await rm(file);
  await symlink(join(outside, "do-not-read"), file);
  await assert.rejects(setProfileInput("web", key, "value", root), /symbolic link/);
});

test("tampered storage cannot inject process controls, NUL or oversized values", async (t) => {
  const root = await fixture(t);
  await setProfileInput("web", key, "valid", root);
  const file = join(root, ".hub", "inputs", "web.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, values: { PATH: "/malicious" } }));
  await assert.rejects(resolveProfileInputs({ profile: "web", declarations: [declaration], dshHome: root, env: {} }), /reserved/);
  await assert.rejects(setProfileInput("other", key, "contains\0nul", root), /NUL/);
  await assert.rejects(setProfileInput("other", key, "x".repeat(65537), root), /64 KiB/);
});

test("apply, doctor and run share stored inputs without saving values in the release or history", async (t) => {
  const root = await fixture(t);
  const secret = "stored-for-install-and-run";
  await setProfileInput("web", key, secret, root);
  let validated = false;
  const installed = await installResolvedProfile({ profile: "web", dshHome: root, release, resolved, execute: async () => {},
    validate: async (_command, env) => { assert.equal(env?.[key], secret); assert.equal(env?.DSH_HOME, root); validated = true; } });
  assert.equal(validated, true);
  const doctor = await doctorProfile({ profile: "web", dshHome: root });
  assert.equal(doctor.healthy, true);
  assert.equal(doctor.inputs?.[0].source, "stored");
  let launched = false;
  await runLocalProfile({ profile: "web", dshHome: root, execute: async (_command, env) => { assert.equal(env?.[key], secret); launched = true; } });
  assert.equal(launched, true);
  const captured = await captureProfile({ profile: "web", dshHome: root, slug: "shareable" });
  const preview = await runLocalProfile({ profile: "web", dshHome: root, dryRun: true });
  assert.equal(JSON.stringify([installed, doctor, captured, preview]).includes(secret), false);
  assert.equal((await readFile(profileLockPath("web", root), "utf8")).includes(secret), false);
  const upgraded = await installResolvedProfile({ profile: "web", dshHome: root,
    release: { ...release, version: "2.0.0" }, resolved: { ...resolved, profileVersion: "2.0.0" }, execute: async () => {}, validate: async () => {} });
  await rollbackProfile({ profile: "web", revision: upgraded.revision, dshHome: root });
  assert.equal((await resolveProfileInputs({ profile: "web", declarations: [declaration], dshHome: root, env: {} })).env[key], secret);
});

test("plans bind declarations and resolve rotated values at apply time without fingerprinting credentials", async (t) => {
  const root = await fixture(t);
  await setProfileInput("web", key, "old-secret", root);
  const plan = await createProfileApplyPlan({ profile: "web", slug: "inputs", release, resolved, dshHome: root });
  assert.equal(plan.effect.localInputs, "resolved_at_apply_time");
  assert.equal(JSON.stringify(plan).includes("old-secret"), false);
  await setProfileInput("web", key, "rotated-secret", root);
  await applyOperationPlan({ id: plan.id, dshHome: root, install: async (options) => installResolvedProfile({ ...options,
    execute: async () => {}, validate: async (_command, env) => { assert.equal(env?.[key], "rotated-secret"); } }) });
  const next = await createProfileApplyPlan({ profile: "web", slug: "inputs", release, resolved, dshHome: root });
  await unsetProfileInput("web", key, root);
  await assert.rejects(applyOperationPlan({ id: next.id, dshHome: root }), /profile inputs set HUB_TEST_SECRET_INPUT --profile web/);
  assert.equal((await profileStatus("web", root)).healthy, false);
});

test("CLI stdin preserves multiline values, rejects arguments/NUL, and never prints the value", async (t) => {
  const root = await fixture(t);
  const secret = 'a=b "quoted"\nsecond-line';
  const saved = await cli(root, ["profile", "inputs", "set", key, "--stdin", "--json"], `${secret}\r\n`);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(saved.stdout.includes(secret), false);
  assert.equal(saved.stderr.includes(secret), false);
  assert.equal((await resolveProfileInputs({ profile: "web", declarations: [declaration], dshHome: root, env: {} })).env[key], secret);
  const listed = await cli(root, ["profile", "inputs", "list", "--json"]);
  assert.equal(JSON.parse(listed.stdout).inputs[0].source, "stored");
  assert.equal(listed.stdout.includes(secret), false);
  const invalid = await cli(root, ["profile", "inputs", "set", key, "--stdin", "--json"], "private-marker\0end");
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stderr.includes("private-marker"), false);
  const argument = await cli(root, ["profile", "inputs", "set", key, "private-marker", "--json"]);
  assert.equal(argument.code, 1);
  assert.equal(argument.stderr.includes("private-marker"), false);
  const noTerminal = await cli(root, ["profile", "inputs", "set", key, "--json"]);
  assert.match(noTerminal.stderr, /--stdin/);
  const unset = await cli(root, ["profile", "inputs", "unset", key, "--json"]);
  assert.equal(unset.code, 0);
});

test("a fresh CLI process launches with saved declared values and does not inject orphaned stored keys", async (t) => {
  const root = await fixture(t);
  await setProfileInput("web", key, "persisted-child-value", root);
  await setProfileInput("web", "ORPHANED_KEY", "must-stay-local", root);
  await installResolvedProfile({ profile: "web", dshHome: root, release, resolved, execute: async () => {}, validate: async () => {} });
  const bin = await fakeRuntimeInstaller(root, `require('node:fs').writeFileSync(require('node:path').join(process.env.DSH_HOME,'child.json'),JSON.stringify({args:process.argv.slice(2),value:process.env.${key},orphaned:process.env.ORPHANED_KEY,home:process.env.DSH_HOME}));`, [key, "ORPHANED_KEY"]);
  const result = await cli(root, ["profile", "run", "--json"], "", { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes("persisted-child-value"), false);
  const child = JSON.parse(await readFile(join(root, "child.json"), "utf8"));
  assert.equal(child.value, "persisted-child-value");
  assert.equal(child.orphaned, undefined);
  assert.equal(child.home, root);
  assert.deepEqual(child.args, ["--profile", "web"]);
  const prepared = JSON.parse(await readFile(join(root, "prepare.json"), "utf8"));
  assert.deepEqual(prepared.values, {});
  assert.ok(prepared.args.includes("--global=false"));
  assert.equal(prepared.args.at(-1), "@deepseek-ai/dsh@0.1.0");
  // A cached run executes the verified bin without any package-manager process.
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nprocess.exit(29);\n`, { mode: 0o700 });
  assert.equal((await cli(root, ["profile", "run", "--json"], "", { PATH: `${bin}:${process.env.PATH}` })).code, 0);
});

test("real validation subprocess output cannot leak a substituted stored value on success or failure", async (t) => {
  const root = await fixture(t);
  await installFakeProfilePackageManager(root);
  const secret = "synthetic-private-validation-value";
  await setProfileInput("web", key, secret, root);
  await installResolvedProfile({ profile: "web", dshHome: root, release, resolved, execute: async () => {}, validate: async () => {} });
  const prior = await readFile(profileLockPath("web", root), "utf8");
  const bin = await fakeRuntimeInstaller(root, `console.log(process.env.${key}); console.error(process.env.${key}); process.exit(Number(process.env.HUB_TEST_VALIDATION_EXIT||0));`, [key]);
  const env = { ...process.env, DSH_HOME: root, DSH_HUB_TELEMETRY: "0", DSH_HUB_API_URL: "http://127.0.0.1:1", PATH: `${bin}:${process.env.PATH}` };
  delete env[key];
  const script = join(root, "apply.mjs");
  await writeFile(script, `import {installResolvedProfile} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
try { await installResolvedProfile({profile:'web', dshHome:process.env.DSH_HOME,release:${JSON.stringify(release)},resolved:${JSON.stringify(resolved)}});console.log('applied'); }
catch(error){ console.error(error.message);process.exitCode=1; }\n`);
  const successful = await promisify(execFile)(process.execPath, [script], { env, timeout: 10000 });
  assert.equal(successful.stdout, "applied\n");
  assert.equal(successful.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(join(root, "prepare.json"), "utf8")).values, {});
  const installedState = await readFile(profileLockPath("web", root), "utf8");
  try {
    await promisify(execFile)(process.execPath, [script], { env: { ...env, HUB_TEST_VALIDATION_EXIT: "7" }, timeout: 10000 });
    assert.fail("expected failed validation");
  } catch (error) {
    const failed = error as Error & { stderr: string; stdout: string };
    assert.match(failed.stderr, /existing Profile was not switched/);
    assert.equal(`${failed.stdout}${failed.stderr}`.includes(secret), false);
  }
  assert.equal(await readFile(profileLockPath("web", root), "utf8"), installedState);
  assert.equal(prior.includes(secret), false);
  // Share capture reads the cached host's static builtin descriptor before validation.
  const cacheModules = join(root, ".hub", "runtimes", "0.1.0", "node_modules", "@deepseek-ai");
  const boot = join(cacheModules, "dsh-app-boot"), base = join(cacheModules, "dsh-base");
  await mkdir(boot, { recursive: true }); await mkdir(base, { recursive: true });
  await writeFile(join(boot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: "0.1.0", main: "index.js" }));
  await writeFile(join(boot, "index.js"), 'const PROFILE_TEMPLATES = {web:["@deepseek-ai/dsh-base"]}; const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];');
  await writeFile(join(base, "package.json"), JSON.stringify({ name: bundle.packageName, version: bundle.version, dsh: { bundle: { patch: "patch.yml" } } }));
  await writeFile(join(base, "patch.yml"), "[]\n");
  const share = await cli(root, ["profile", "share", "input-smoke", "--version", "1.0.0", "--runtime-version", "0.1.0", "--json"], "",
    { PATH: env.PATH, HUB_TEST_VALIDATION_EXIT: "7" });
  assert.equal(share.code, 1);
  assert.match(share.stderr, /configuration validation failed/);
  assert.equal(`${share.stdout}${share.stderr}`.includes(secret), false);
  // A preparation failure is reported as that phase, without blaming Profile config.
  await rm(join(root, ".hub", "runtimes", "0.1.0"), { recursive: true });
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nconsole.error('fixture-install-output');process.exit(19);\n`, { mode: 0o700 });
  try {
    await promisify(execFile)(process.execPath, [script], { env, timeout: 10000 });
    assert.fail("expected runtime preparation failure");
  } catch (error) {
    const failed = error as Error & { stderr: string; stdout: string };
    assert.match(failed.stderr, /runtime preparation failed \(exit 19\)/);
    assert.match(failed.stderr, /existing Profile was not switched/);
    assert.equal(failed.stderr.includes("composition validation"), false);
    assert.equal(failed.stderr.includes("fixture-install-output"), false);
  }
  assert.equal(await readFile(profileLockPath("web", root), "utf8"), installedState);
});

test("local edit operation validation uses installed declarations and its explicit isolated home", async (t) => {
  const root = await fixture(t);
  await installFakeProfilePackageManager(root);
  const secret = "plugin-validation-local-fixture";
  await setProfileInput("web", key, secret, root);
  await installResolvedProfile({ profile: "web", dshHome: root, release, resolved, execute: async () => {}, validate: async () => {} });
  const plan = await createProfileEditPlan({ profile: "web", intent: { kind: "add", bundle }, dshHome: root });
  const bin = await fakeRuntimeInstaller(root, `const fs=require('node:fs'); const path=require('node:path');
fs.writeFileSync(path.join(process.env.DSH_HOME,'validation.json'),JSON.stringify({home:process.env.DSH_HOME,value:process.env.${key},args:process.argv.slice(2)}));
console.log(process.env.${key}); console.error(process.env.${key});`, [key]);
  const script = join(root, "plugin-plan.mjs");
  await writeFile(script, `import {applyOperationPlan} from ${JSON.stringify(new URL("../dist/operations.js", import.meta.url).href)};
await applyOperationPlan({id:${JSON.stringify(plan.id)},dshHome:${JSON.stringify(root)}});\n`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DSH_HUB_TELEMETRY: "0" };
  delete env[key];
  delete env.DSH_HOME;
  const result = await promisify(execFile)(process.execPath, [script], { env, timeout: 10000 });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(join(root, "prepare.json"), "utf8")).values, {});
  const validation = JSON.parse(await readFile(join(root, "validation.json"), "utf8"));
  assert.equal(validation.home, root);
  assert.equal(validation.value, secret);
  assert.ok(validation.args.includes("--dump-config"));
});

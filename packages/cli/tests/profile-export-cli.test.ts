import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyOperationPlan } from "../dist/operations.js";
import { profileLockPath } from "../dist/index.js";
import { setProfileInput } from "../dist/profile-inputs.js";
import { fakeRuntimeInstaller } from "./runtime-fixture.mjs";

const version = "0.1.0", builtinVersion = "0.8.7", key = "HUB_EXPORT_SECRET_KEY", secret = "private-export-input-fixture";
const bundle = { packageName: "@example/runtime-builtin", selector: builtinVersion, version: builtinVersion, sourceKind: "builtin", installSpec: `builtin:@example/runtime-builtin@${builtinVersion}` };
async function fixture(t: test.TestContext, source: "author" | "local" | "legacy") {
  const root = await mkdtemp(join(tmpdir(), "dsh-export-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "profiles", "web"), statePath = profileLockPath("web", root), mock = join(root, "api.mjs");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "export-fixture", private: true, dependencies: {}, dsh: { profile: { bundles: [bundle.packageName] } } }));
  await writeFile(join(directory, "cordis.patch.yml"), `apiKeyEnv: ${key}\n`);
  if (source !== "legacy") {
    await mkdir(join(root, ".hub", "installations", "web"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ schemaVersion: 2, profile: "web", source, resolvedAt: "fixture", runtime: { range: "*", version },
      ...(source === "author" ? { hubProfile: { slug: "original", version: "1.0.0" } } : {}), bundles: [bundle], inputs: [{ key, label: key, required: true, secret: true }], localInputs: [{ key: "LOCAL_OPTIONAL_KEY", label: "Optional local credential", required: false, secret: true }] }));
  }
  await setProfileInput("web", key, secret, root);
  const runtimeScript = `const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.DSH_HOME,'validation.json'),JSON.stringify({version:require('./package.json').version,args:process.argv.slice(2),value:process.env.${key}}));
if(process.env.HUB_EXPORT_MUTATE_VALIDATION==='1'){const file=path.join(process.env.DSH_HOME,'.hub/installations/web/current.json'),state=JSON.parse(fs.readFileSync(file));state.runtime.version='0.2.0';fs.writeFileSync(file,JSON.stringify(state));}
console.log(process.env.${key});console.error(process.env.${key});`;
  const bin = await fakeRuntimeInstaller(root, runtimeScript, [key]);
  const prefix = join(root, ".hub", "runtimes", version), runtime = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  const boot = join(prefix, "node_modules", "@deepseek-ai", "dsh-app-boot"), builtin = join(prefix, "node_modules", "@example", "runtime-builtin");
  for (const dir of [runtime, boot, builtin]) await mkdir(dir, { recursive: true });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version, bin: { dsh: "bin.cjs" }, dependencies: { [bundle.packageName]: builtinVersion } }));
  await writeFile(join(runtime, "bin.cjs"), runtimeScript);
  await writeFile(join(boot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version, main: "index.js" }));
  await writeFile(join(boot, "index.js"), 'const PROFILE_TEMPLATES = {web:["@example/runtime-builtin"]}; const DEFAULT_PROFILE_BUNDLES = ["@example/runtime-builtin"]; throw new Error("must not execute metadata");');
  await writeFile(join(builtin, "package.json"), JSON.stringify({ name: bundle.packageName, version: builtinVersion, dsh: { bundle: { patch: "patch.yml" } } }));
  await writeFile(join(builtin, "patch.yml"), "[]\n");
  await writeFile(join(bin, "dsh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(require('node:path').join(process.env.DSH_HOME,'global-probe'),'called');console.log('9.9.9');\n`, { mode: 0o700 });
  await writeFile(mock, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
globalThis.fetch=async(url,init)=>{const pathname=new URL(url).pathname;appendFileSync(join(process.env.DSH_HOME,'api-calls.jsonl'),JSON.stringify({pathname,method:init?.method,body:JSON.parse(init?.body||'{}')})+'\\n');
if(pathname.endsWith('/draft')){if(process.env.HUB_EXPORT_MUTATE_SAVE==='1'){const file=join(process.env.DSH_HOME,'.hub/installations/web/current.json'),state=JSON.parse(readFileSync(file));state.runtime.version='0.2.0';writeFileSync(file,JSON.stringify(state));}return new Response(init.body,{status:200,headers:{'content-type':'application/json'}});}
if(pathname.endsWith('/releases'))return new Response(JSON.stringify({version:'1.0.0'}),{status:200,headers:{'content-type':'application/json'}});throw new Error('unexpected request');};\n`);
  return { root, directory, statePath, mock, env: { PATH: `${bin}:${process.env.PATH}`, DSH_HUB_TOKEN: "dshhub_export_fixture" } };
}
function cli(root: string, mock: string, args: string[], extra: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", mock, fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...args, "--json"],
      { env: { ...process.env, DSH_HOME: root, DSH_HUB_TELEMETRY: "0", DSH_HUB_API_URL: "http://fixture.invalid", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", fail); child.once("close", code => done({ code, stdout, stderr }));
  });
}
const share = ["profile", "share", "exported", "--version", "1.0.0"];
const capture = ["profile", "capture", "exported"];

async function missing(path: string) { await assert.rejects(readFile(path), { code: "ENOENT" }); }

test("local and author capture/share previews use the recorded runtime without executing or downloading anything", async t => {
  for (const source of ["local", "author"] as const) await t.test(source, async t => {
    const { root, mock, env } = await fixture(t, source);
    for (const args of [capture, [...share, "--dry-run"], [...share, "--plan"], [...capture, "--runtime-version", version]]) {
      const result = await cli(root, mock, args, env); assert.equal(result.code, 0, result.stderr);
      const body = JSON.parse(result.stdout), draft = body.input?.draft ?? body.draft ?? body;
      assert.equal(draft.runtime.version, version); assert.equal(draft.verification, undefined);
      assert.equal(draft.bundles[0].version, builtinVersion); assert.equal(draft.bundles[0].sourceKind, "builtin");
      assert.equal(draft.bundles[0].installSpec, `builtin:${bundle.packageName}@${builtinVersion}`);
      assert.deepEqual(draft.inputs.find(input => input.key === "LOCAL_OPTIONAL_KEY"), { key: "LOCAL_OPTIONAL_KEY", label: "Optional local credential", required: false, secret: true });
      assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
      if (body.kind === "profile.share") {
        assert.equal(body.precondition.runtimeVersion, version); assert.equal(body.precondition.runtimeSource, "recorded");
        assert.match(body.precondition.installationHash, /^sha256:/); assert.match(body.reviewHash, /^sha256:/);
      }
    }
    await missing(join(root, "global-probe")); await missing(join(root, "prepare.json")); await missing(join(root, "api-calls.jsonl"));
    assert.deepEqual(await readdir(join(root, ".hub", "runtimes")), [version]);
  });
});

test("export rejects runtime overrides that conflict with the Profile pin", async t => {
  for (const source of ["local", "author"] as const) await t.test(source, async t => {
    const { root, mock, env } = await fixture(t, source);
    for (const args of [capture, [...share, "--dry-run"], [...share, "--plan"], share]) {
      const result = await cli(root, mock, [...args, "--runtime-version", "0.2.0"], env);
      assert.equal(result.code, 1); assert.match(result.stderr, /recorded runtime/);
    }
    await missing(join(root, "global-probe")); await missing(join(root, "api-calls.jsonl"));
    await assert.rejects(readdir(join(root, ".hub", "operations")), { code: "ENOENT" });
  });
});

test("an unrecorded legacy Profile requires an explicit exact runtime for capture and sharing", async t => {
  const { root, mock, env } = await fixture(t, "legacy");
  for (const args of [capture, [...share, "--dry-run"], [...share, "--plan"], share]) {
    const failed = await cli(root, mock, args, env); assert.equal(failed.code, 1); assert.match(failed.stderr, /no recorded exact runtime/);
  }
  for (const args of [capture, [...share, "--dry-run"], [...share, "--plan"]]) {
    const result = await cli(root, mock, [...args, "--runtime-version", version], env); assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout), draft = body.input?.draft ?? body.draft ?? body;
    assert.equal(draft.runtime.version, version); assert.equal(draft.verification, undefined);
    if (body.kind) assert.equal(body.precondition.runtimeSource, "explicit");
  }
  const invalid = await cli(root, mock, [...capture, "--runtime-version", "latest"], env);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /exact-semver/);
  await missing(join(root, "global-probe")); await missing(join(root, "prepare.json"));
});

test("share plans reject changed runtime, unrelated local files, altered intent and legacy bindings before publication", async t => {
  for (const change of ["runtime", "file", "intent", "legacy"] as const) await t.test(change, async t => {
    const { root, mock, env, statePath, directory } = await fixture(t, "local");
    const result = await cli(root, mock, [...share, "--plan"], env); assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout), path = join(root, ".hub", "operations", `${plan.id}.json`);
    if (change === "runtime") { const state = JSON.parse(await readFile(statePath, "utf8")); state.runtime.version = "0.2.0"; await writeFile(statePath, JSON.stringify(state)); }
    if (change === "file") await writeFile(join(directory, "notes.txt"), "local change after review");
    if (change === "intent") { plan.input.version = "9.9.9"; await writeFile(path, JSON.stringify(plan)); }
    if (change === "legacy") { delete plan.precondition.installationHash; delete plan.precondition.runtimeSource; await writeFile(path, JSON.stringify(plan)); }
    await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root, share: async () => { assert.fail("must not publish"); } }), /recorded runtime|changed after|predates runtime/);
  });
});

test("direct share validates the recorded runtime and keeps saved values out of network payloads", async t => {
  const { root, mock, env } = await fixture(t, "local");
  const result = await cli(root, mock, share, env); assert.equal(result.code, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false); assert.equal(JSON.parse(result.stdout).version, "1.0.0");
  const validation = JSON.parse(await readFile(join(root, "validation.json"), "utf8"));
  assert.equal(validation.version, version); assert.ok(validation.args.includes("--dump-config")); assert.equal(validation.value, secret);
  const calls = (await readFile(join(root, "api-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.length, 2); assert.equal(calls[0].body.runtime.version, version); assert.equal(JSON.stringify(calls).includes(secret), false);
  assert.equal(calls[1].body.verification.composition, "locally_verified"); await missing(join(root, "global-probe"));
});

test("a runtime change during validation stops direct share before any API write", async t => {
  const { root, mock, env } = await fixture(t, "local");
  const result = await cli(root, mock, share, { ...env, HUB_EXPORT_MUTATE_VALIDATION: "1" });
  assert.equal(result.code, 1); assert.match(result.stderr, /recorded runtime|changed after/);
  await missing(join(root, "api-calls.jsonl")); assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

test("operation apply rechecks after saving the draft and before publishing an immutable Release", async t => {
  const { root, mock, env } = await fixture(t, "author");
  const preview = await cli(root, mock, [...share, "--plan"], env); assert.equal(preview.code, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  const result = await cli(root, mock, ["operation", "apply", plan.id], { ...env, HUB_EXPORT_MUTATE_SAVE: "1" });
  assert.equal(result.code, 1); assert.match(result.stderr, /recorded runtime|changed after/);
  const calls = (await readFile(join(root, "api-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.length, 1); assert.ok(calls[0].pathname.endsWith("/draft"));
  assert.equal(JSON.parse(await readFile(join(root, ".hub", "operations", `${plan.id}.json`), "utf8")).status, "planned");
});


test("run refuses a different override for recorded local and author runtimes", async t => {
  for (const source of ["local", "author"] as const) await t.test(source, async t => {
    const { root, mock, env } = await fixture(t, source);
    const result = await cli(root, mock, ["profile", "run", "--dry-run", "--runtime-version", "0.2.0"], env);
    assert.equal(result.code, 1); assert.match(result.stderr, /pinned to runtime/);
    await missing(join(root, "validation.json")); await missing(join(root, "global-probe"));
  });
});

test("offline recorded builtin pins remain capturable; an unrecorded builtin needs prepared exact metadata", async t => {
  for (const source of ["local", "legacy"] as const) await t.test(source, async t => {
    const { root, mock, env } = await fixture(t, source);
    await rm(join(root, ".hub", "runtimes"), { recursive: true });
    const result = await cli(root, mock, [...capture, "--runtime-version", version], env);
    assert.equal(result.code, source === "local" ? 0 : 1, result.stderr);
    if (source === "local") assert.equal(JSON.parse(result.stdout).bundles[0].version, builtinVersion);
    else assert.match(result.stderr, /runtime prepare --runtime-version 0.1.0/);
    await missing(join(root, "prepare.json")); await missing(join(root, "global-probe"));
  });
});


test("malformed recorded state cannot fall back to an explicit runtime during export", async t => {
  for (const state of [{}, [], { schemaVersion: 2, profile: "other", bundles: [] }]) {
    const { root, mock, env, statePath } = await fixture(t, "local");
    await writeFile(statePath, JSON.stringify(state));
    for (const args of [capture, [...share, "--plan"]]) {
      const result = await cli(root, mock, [...args, "--runtime-version", version], env);
      assert.equal(result.code, 1); assert.match(result.stderr, /state has an unsupported format/);
    }
    await missing(join(root, "api-calls.jsonl")); await missing(join(root, "prepare.json"));
  }
});


test("capture rejects ambiguous dependency sources and mismatched installed metadata without leaking source credentials", async t => {
  for (const failure of ["source", "name", "version", "range", "path"] as const) await t.test(failure, async t => {
    const { root, mock, env, directory } = await fixture(t, "local");
    const name = failure === "path" ? "../../outside" : "example-plugin";
    const selector = failure === "source" ? "https://credential-fixture-secret@example.invalid/package.tgz" : "^1.0.0";
    await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { [name]: selector }, dsh: { profile: { bundles: [name] } } }));
    if (failure !== "path") {
      const pkg = join(directory, "node_modules", name); await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: failure === "name" ? "wrong-package" : name, version: failure === "version" ? "latest" : failure === "range" ? "2.0.0" : "1.0.0" }));
    }
    const result = await cli(root, mock, [...share, "--plan"], env);
    assert.equal(result.code, 1); assert.equal(`${result.stdout}${result.stderr}`.includes("credential-fixture-secret"), false);
    await missing(join(root, "api-calls.jsonl"));
  });
});

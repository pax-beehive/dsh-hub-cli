import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyProfileEdit, installResolvedProfile, profileLockPath } from "../dist/index.js";
import { installationFingerprint } from "../dist/profile-files.js";
import { applyOperationPlan } from "../dist/operations.js";
import { readProfileState } from "../dist/profile-lifecycle.js";
import { setProfileInput } from "../dist/profile-inputs.js";
import { fakeRuntimeInstaller } from "./runtime-fixture.mjs";
import { installFakeProfilePackageManager } from "./profile-package-manager-fixture.mjs";

const version = "0.1.0";
const base = { packageName: "@deepseek-ai/dsh-base", selector: version, version,
  installSpec: `builtin:@deepseek-ai/dsh-base@${version}`, sourceKind: "builtin" as const };
const release = { schemaVersion: 1 as const, version: "1.0.0", name: "Author", description: "", dsh: "*",
  runtime: { range: "*", version }, bundles: [{ ...base, before: [], after: [] }], patch: [], patchYaml: "[]\n", inputs: [], publishedAt: "2026-09-17T00:00:00.000Z" };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-local-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = join(root, "network.mjs"), patch = join(root, "patch.yml");
  await writeFile(mock, "globalThis.fetch=async()=>{throw new Error('unexpected network request');};\n");
  await writeFile(patch, "[]\n");
  return { root, mock, patch };
}
function cli(root: string, mock: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", mock, fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...args, "--json"],
      { env: { ...process.env, DSH_HOME: root, DSH_HUB_TELEMETRY: "0", DSH_HUB_API_URL: "http://fixture.invalid", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", fail); child.once("close", code => done({ code, stdout, stderr }));
  });
}

test("local edit runtime selection is exact and cold previews never prepare a runtime or create a Profile", async t => {
  const { root, mock, patch } = await fixture(t);
  for (const mode of ["--dry-run", "--plan"]) {
    const missing = await cli(root, mock, ["profile", "configure", "--file", patch, mode]);
    assert.equal(missing.code, 1); assert.match(missing.stderr, /runtime-version/);
    const cold = await cli(root, mock, ["profile", "configure", "--file", patch, "--runtime-version", version, mode]);
    assert.equal(cold.code, 1); assert.match(cold.stderr, /runtime prepare --runtime-version/);
  }
  const invalid = await cli(root, mock, ["install", "local-plugin", "--runtime-version", "^0.1.0", "--plan"]);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /exact semantic version/);
  assert.equal(invalid.stderr.includes("unexpected network"), false);
  for (const path of [join(root, "profiles"), join(root, ".hub", "runtimes"), join(root, ".hub", "operations")]) {
    await assert.rejects(readdir(path), { code: "ENOENT" });
  }
});

test("runtime prepare reports only the exact version and never reads saved Profile values", async t => {
  const { root, mock } = await fixture(t);
  const key = "HUB_TEST_LOCAL_BOOTSTRAP_SECRET", value = "private-bootstrap-value";
  await setProfileInput("web", key, value, root);
  const bin = await fakeRuntimeInstaller(root, "process.exit(0);", [key]);
  const prepared = await cli(root, mock, ["runtime", "prepare", "--runtime-version", version], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), { status: "ready", runtimeVersion: version });
  assert.equal(`${prepared.stdout}${prepared.stderr}`.includes(value), false);
  assert.deepEqual(JSON.parse(await readFile(join(root, "prepare.json"), "utf8")).values, {});
  await assert.rejects(readdir(join(root, "profiles")), { code: "ENOENT" });
  const rejected = await cli(root, mock, ["runtime", "prepare", "--runtime-version", version, "--plan"]);
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /omit --dry-run and --plan/);
});

test("author edits reject a different runtime override and persist the exact recorded version in plans", async t => {
  const { root, mock, patch } = await fixture(t);
  await installResolvedProfile({ profile: "web", dshHome: root, release, resolved: { profileVersion: release.version, bundles: [base] },
    hubProfileSlug: "author", execute: async () => {}, validate: async () => {} });
  const before = await installationFingerprint(join(root, "profiles", "web"), profileLockPath("web", root));
  const invalid = await cli(root, mock, ["profile", "configure", "--file", patch, "--runtime-version", "0.2.0", "--dry-run"]);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /runtime/i);
  const result = await cli(root, mock, ["profile", "configure", "--file", patch, "--plan"]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.input.runtimeVersion, version); assert.equal(plan.effect.source, "author");
  assert.equal(await installationFingerprint(join(root, "profiles", "web"), profileLockPath("web", root)), before);
});


async function cachedRuntime(root: string, selected = version) {
  await installFakeProfilePackageManager(root);
  const prefix = join(root, ".hub", "runtimes", selected), modules = join(prefix, "node_modules", "@deepseek-ai");
  const names = ["dsh-base", "dsh-web-app", "dsh-headless"];
  const runtimeScript = `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
fs.appendFileSync(path.join(process.env.DSH_HOME,'runtime-events.jsonl'),JSON.stringify({args})+'\\n');
if(args.includes('plugin')&&args.includes('add')){const spec=args.at(-1),split=spec.lastIndexOf('@'),name=spec.slice(0,split),version=spec.slice(split+1),profile=args[args.indexOf('--profile')+1];
const target=path.join(process.env.DSH_HOME,'profiles',profile,'node_modules',...name.split('/'));fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name,version,dsh:{bundle:{patch:'patch.yml'}}}));fs.writeFileSync(path.join(target,'patch.yml'),'[]\\n');}
process.exit(Number(process.env.HUB_LOCAL_VALIDATION_EXIT||0));`;
  await mkdir(join(modules, "dsh"), { recursive: true });
  await writeFile(join(modules, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: selected, bin: { dsh: "bin.cjs" } }));
  await writeFile(join(modules, "dsh", "bin.cjs"), runtimeScript);
  await mkdir(join(modules, "dsh-app-boot", "lib"), { recursive: true });
  await writeFile(join(modules, "dsh-app-boot", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: selected, main: "lib/index.js" }));
  await writeFile(join(modules, "dsh-app-boot", "lib", "index.js"), 'const PROFILE_TEMPLATES = {web:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"],headless:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]};\nconst DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];\nthrow new Error("template metadata must never execute");\n');
  for (const name of names) {
    const directory = join(modules, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version: selected, dsh: { bundle: { patch: "patch.yml" } } }));
    await writeFile(join(directory, "patch.yml"), "[]\n");
  }
  const bin = join(root, "bin"); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nconsole.error('unexpected runtime download');process.exit(99);\n`, { mode: 0o700 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

test("new local Profiles use the target template, expose their local source and launch their recorded runtime", async t => {
  const { root, mock, patch } = await fixture(t), env = await cachedRuntime(root);
  for (const [profile, names] of [["web", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]],
    ["headless", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]], ["personal", ["@deepseek-ai/dsh-base"]]] as const) {
    const result = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", profile, "--runtime-version", version], env);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).source, "local");
    const directory = join(root, "profiles", profile), manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert.equal(manifest.name, `dsh-profile-${profile}`); assert.deepEqual(manifest.dsh.profile.bundles, names);
    assert.match(await readFile(join(directory, "pnpm-workspace.yaml"), "utf8"), /nodeLinker: hoisted/);
    const state = (await readProfileState(profile, root))!;
    assert.equal(state.source, "local"); assert.equal(state.authorBaseline, undefined); assert.equal(state.hubProfile, undefined); assert.equal(state.runtime?.version, version);
    const status = await cli(root, mock, ["profile", "status", "--profile", profile]);
    assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).source, "local"); assert.equal(JSON.parse(status.stdout).healthy, true);
    const run = await cli(root, mock, ["profile", "run", "--profile", profile], env);
    assert.equal(run.code, 0, run.stderr); assert.equal(JSON.parse(run.stdout).runtimeVersion, version);
  }
});

test("unmanaged adoption retains private files, fails without switching, and rolls back to its original state", async t => {
  const { root, mock, patch } = await fixture(t), env = await cachedRuntime(root), profile = "personal";
  const directory = join(root, "profiles", profile), marker = "personal-local-manifest-marker";
  await mkdir(directory, { recursive: true });
  const original = JSON.stringify({ name: "existing-personal", private: true, personal: marker, dependencies: {}, dsh: { profile: { bundles: [base.packageName] } } });
  await writeFile(join(directory, "package.json"), original); await writeFile(join(directory, "cordis.patch.yml"), "[]\n");
  await writeFile(join(directory, "notes.txt"), marker); await writeFile(patch, "[] # new local patch\n");
  const before = await installationFingerprint(directory, profileLockPath(profile, root));
  const failed = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", profile, "--runtime-version", version], { ...env, HUB_LOCAL_VALIDATION_EXIT: "7" });
  assert.equal(failed.code, 1); assert.match(failed.stderr, /existing Profile was not switched/);
  assert.equal(await installationFingerprint(directory, profileLockPath(profile, root)), before);
  const adopted = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", profile, "--runtime-version", version], env);
  assert.equal(adopted.code, 0, adopted.stderr); assert.ok(JSON.parse(adopted.stdout).revision);
  assert.equal(adopted.stdout.includes(marker), false);
  assert.equal(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).personal, marker);
  assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), marker);
  const rolledBack = await cli(root, mock, ["profile", "rollback", "--profile", profile]);
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(await readFile(join(directory, "package.json"), "utf8"), original);
  assert.equal(await readProfileState(profile, root), undefined);
  const status = JSON.parse((await cli(root, mock, ["profile", "status", "--profile", profile])).stdout);
  assert.equal(status.source, "unmanaged"); assert.equal(status.managed, false);
});

test("local plans pin the selected runtime and reject version tampering before any preparation", async t => {
  const { root, mock, patch } = await fixture(t); await cachedRuntime(root);
  const result = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", "personal", "--runtime-version", version, "--plan"]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.input.runtimeVersion, version); assert.equal(plan.effect.source, "local"); assert.equal(plan.effect.authorBaseline, "not_applicable");
  const applied = await applyOperationPlan({ id: plan.id, dshHome: root, edit: options => applyProfileEdit({ ...options, execute: async () => {}, validate: async () => {} }) });
  assert.equal(applied.edit?.source, "local");
  const second = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", "personal", "--plan"]);
  assert.equal(second.code, 0, second.stderr); const changed = JSON.parse(second.stdout);
  assert.equal(changed.input.runtimeVersion, version);
  changed.input.runtimeVersion = "0.2.0";
  await writeFile(join(root, ".hub", "operations", `${changed.id}.json`), JSON.stringify(changed));
  await assert.rejects(applyOperationPlan({ id: changed.id, dshHome: root }), /changed after review/);
});

test("an explicit local runtime switch updates builtin pins without creating an author baseline", async t => {
  const { root, mock, patch } = await fixture(t), env = await cachedRuntime(root);
  await cachedRuntime(root, "0.2.0");
  const first = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", "personal", "--runtime-version", version], env);
  assert.equal(first.code, 0, first.stderr);
  const next = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", "personal", "--runtime-version", "0.2.0", "--plan"]);
  assert.equal(next.code, 0, next.stderr); const plan = JSON.parse(next.stdout);
  assert.equal(plan.input.runtimeVersion, "0.2.0");
  await applyOperationPlan({ id: plan.id, dshHome: root, edit: options => applyProfileEdit({ ...options, execute: async () => {}, validate: async () => {} }) });
  const state = (await readProfileState("personal", root))!;
  assert.equal(state.runtime?.version, "0.2.0"); assert.equal(state.bundles[0].version, "0.2.0"); assert.equal(state.authorBaseline, undefined);
});

test("legacy Hub identity without an author baseline cannot become a local Profile", async t => {
  const { root, mock, patch } = await fixture(t);
  await installResolvedProfile({ profile: "web", dshHome: root, release, resolved: { profileVersion: release.version, bundles: [base] },
    hubProfileSlug: "author", execute: async () => {}, validate: async () => {} });
  const state = (await readProfileState("web", root))!; delete state.authorBaseline;
  await writeFile(profileLockPath("web", root), JSON.stringify(state));
  const before = await installationFingerprint(join(root, "profiles", "web"), profileLockPath("web", root));
  const result = await cli(root, mock, ["profile", "configure", "--file", patch, "--runtime-version", version, "--plan"]);
  assert.notEqual(result.code, 0); assert.match(`${result.stdout}${result.stderr}`, /baseline|original Release/i);
  assert.equal(await installationFingerprint(join(root, "profiles", "web"), profileLockPath("web", root)), before);
});


test("install creates a standalone Profile with host defaults and exact package identity", async t => {
  const { root, mock } = await fixture(t), env = await cachedRuntime(root);
  const selected = { version: "1.2.3", channel: "stable", manifest: { name: "local-plugin", version: "1.2.3", dsh: { bundle: { patch: "patch.yml" } } },
    source: { kind: "npm", packageName: "local-plugin", version: "1.2.3", installSpec: "local-plugin@1.2.3", tarballUrl: "https://registry.npmjs.org/local-plugin/-/local-plugin-1.2.3.tgz" },
    compatibility: { dsh: "*", platforms: [], surfaces: ["any"], hmr: "restart" }, entryIds: [], before: [], after: [], publishedAt: "2026-09-17T00:00:00.000Z", yanked: false };
  const plugin = { id: "123e4567-e89b-12d3-a456-426614174000", slug: "local-plugin", packageName: "local-plugin", displayName: "Local", summary: "Fixture", description: "", repository: "fixture/local-plugin",
    categories: [], keywords: [], screenshots: [], verified: false, deprecated: false, latestVersion: "1.2.3", distTags: { latest: "1.2.3" }, versions: [selected], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };
  await writeFile(mock, `globalThis.fetch=async(url)=>{if(!String(url).endsWith('/packages/resolve?name=local-plugin'))throw new Error('unexpected test request');return new Response(${JSON.stringify(JSON.stringify(plugin))},{status:200,headers:{'content-type':'application/json'}});};\n`);
  const result = await cli(root, mock, ["install", "local-plugin", "--profile", "personal", "--runtime-version", version], env);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).source, "local");
  const state = (await readProfileState("personal", root))!;
  assert.deepEqual(state.bundles.map(item => item.packageName), [base.packageName, "local-plugin"]);
  assert.equal(state.dependencies?.find(item => item.packageName === "local-plugin")?.version, "1.2.3");
  assert.equal(state.authorBaseline, undefined); assert.equal(state.runtime?.version, version);
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

test("Hub apply plans preserve existing local and unmanaged targets without making their private configuration an author baseline", async t => {
  for (const managed of [false, true]) await t.test(managed ? "local record" : "unmanaged directory", async t => {
    const { root, mock, patch } = await fixture(t), env = await cachedRuntime(root), profile = "personal", marker = "private-pre-adoption-marker";
    if (managed) {
      const result = await cli(root, mock, ["profile", "configure", "--file", patch, "--profile", profile, "--runtime-version", version], env);
      assert.equal(result.code, 0, result.stderr);
    } else {
      await mkdir(join(root, "profiles", profile), { recursive: true });
      await writeFile(join(root, "profiles", profile, "package.json"), JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [base.packageName] } } }));
      await writeFile(join(root, "profiles", profile, "cordis.patch.yml"), "[]\n");
    }
    const directory = join(root, "profiles", profile), manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    manifest.personal = marker; await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    const target = { ...release, contentHash: `sha256:${createHash("sha256").update(canonical(release)).digest("hex")}` };
    const remote = { id: "123e4567-e89b-12d3-a456-426614174000", slug: "author", owner: "fixture", claimed: true, visibility: "public", latestVersion: target.version,
      versions: [target], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };
    await writeFile(mock, `globalThis.fetch=async(url)=>{if(!String(url).endsWith('/profiles/author'))throw new Error('unexpected test request');return new Response(${JSON.stringify(JSON.stringify(remote))},{status:200,headers:{'content-type':'application/json'}});};\n`);
    const preview = await cli(root, mock, ["profile", "apply", "author", "--profile", profile, "--plan"]);
    assert.equal(preview.code, 2, preview.stderr || preview.stdout);
    const blocked = JSON.parse(preview.stdout).upgrade;
    assert.ok(blocked.summary.conflicts.some((item: { path: string }) => item.path === "package.json#/name"));
    assert.equal(preview.stdout.includes(marker), false);
    const choicesFile = join(root, "adoption-choices.json");
    await writeFile(choicesFile, JSON.stringify({ contextHash: blocked.contextHash, choices: Object.fromEntries(blocked.summary.conflicts.map((item: { id: string }) => [item.id, "local"])) }));
    const ready = await cli(root, mock, ["profile", "apply", "author", "--profile", profile, "--plan", "--resolutions", choicesFile]);
    assert.equal(ready.code, 0, ready.stderr || ready.stdout);
    const plan = JSON.parse(ready.stdout); assert.equal(plan.effect.mode, "preserve"); assert.equal(ready.stdout.includes(marker), false);
    await applyOperationPlan({ id: plan.id, dshHome: root, install: options => installResolvedProfile({ ...options, execute: async () => {}, validate: async () => {} }) });
    assert.equal(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).personal, marker);
    const state = (await readProfileState(profile, root))!;
    assert.equal(state.source, "author"); assert.equal(state.hubProfile?.slug, "author");
    assert.equal(JSON.stringify(state.authorBaseline).includes(marker), false);
  });
});

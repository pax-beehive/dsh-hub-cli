import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareProfilePackageManager } from "../dist/profile-package-manager.js";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-profile-pm-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), bin = join(root, "bin"), proof = join(root, "npm.jsonl");
  await mkdir(bin);
  return { root, home, bin, proof, env: { HOME: root, PATH: bin, PM_PROOF: proof } as NodeJS.ProcessEnv };
}

async function packageFixture(directory: string, version = "10.33.0", body?: string) {
  await mkdir(join(directory, "bin"), { recursive: true });
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "pnpm", version, bin: { pnpm: "bin/pnpm.cjs" } }));
  await writeFile(join(directory, "bin", "pnpm.cjs"), body ?? `if(process.argv.includes('--version')) console.log(${JSON.stringify(version)}); else console.log(JSON.stringify(process.env));\n`);
  await writeFile(join(directory, "dist", "engine.cjs"), "module.exports = 'original';\n");
  return join(directory, "bin", "pnpm.cjs");
}

async function fakeNpm(f: Awaited<ReturnType<typeof fixture>>, extra = "", reportedVersion?: string, entryBody?: string) {
  const installedScript = entryBody ? JSON.stringify(entryBody) : `'console.log('+JSON.stringify(${reportedVersion ? JSON.stringify(reportedVersion) : "version"})+');\\n'`;
  await writeFile(join(f.bin, "npm"), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),prefix=args[args.indexOf('--prefix')+1],version=args.at(-1).slice('pnpm@'.length);
fs.appendFileSync(process.env.PM_PROOF,JSON.stringify({args,env:process.env})+'\\n');
${extra}
const pkg=path.join(prefix,'node_modules','pnpm');fs.mkdirSync(path.join(pkg,'bin'),{recursive:true});
fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'pnpm',version,bin:{pnpm:'bin/pnpm.cjs'}}));
fs.writeFileSync(path.join(pkg,'bin','pnpm.cjs'),${installedScript});
`, { mode: 0o700 });
}

const cache = (home: string, version: string) => join(home, ".hub", "package-managers", "pnpm", version);
async function absent(path: string) { await assert.rejects(readFile(path), { code: "ENOENT" }); }

test("package manager reuses verified PATH package and runs its real entry, never an outer shim", async t => {
  const f = await fixture(t), directory = join(f.root, "installed", "pnpm");
  const entry = await packageFixture(directory);
  await symlink(entry, join(f.bin, "pnpm"));
  const prepared = await prepareProfilePackageManager({ manifest: {}, dshHome: f.home, env: f.env });
  assert.equal(prepared.version, "10.33.0"); assert.equal(prepared.executable, await realpath(entry));
  const output = await promisify(execFile)(process.execPath, [prepared.executable, "inspect-env"], { env: prepared.environment });
  assert.equal(JSON.parse(output.stdout).DSH_HOME, f.home);
  await prepared.assertUnchanged(); await absent(f.proof);
});

test("Volta shim is ignored while exact installed package is verified and reused", async t => {
  const f = await fixture(t), volta = join(f.root, "volta");
  const directory = join(volta, "tools", "image", "packages", "pnpm", "lib", "node_modules", "pnpm");
  const entry = await packageFixture(directory);
  await writeFile(join(f.bin, "pnpm"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(f.proof)}, 'shim executed');\n`, { mode: 0o700 });
  const prepared = await prepareProfilePackageManager({ manifest: { packageManager: "pnpm@10.33.0" }, dshHome: f.home, env: { ...f.env, VOLTA_HOME: volta } });
  assert.equal(prepared.executable, entry); await absent(f.proof);
});

test("missing exact pnpm prepares isolated cache with no stored inputs and preserves external config", async t => {
  const f = await fixture(t); await fakeNpm(f);
  const env = { ...f.env, SAVED_INPUT: "stored-secret", EXTERNAL_INPUT: "explicit-external", DSH_HUB_STORED_INPUT_KEYS: JSON.stringify({ v: 1, keys: ["SAVED_INPUT"] }),
    npm_config_userconfig: join(f.root, "personal.npmrc"), npm_config_registry: "https://example.invalid/", npm_config_ignore_pnpmfile: "false",
    NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "true", NPM_CONFIG_PACKAGE_MANAGER_STRICT_VERSION: "false" };
  const options = { manifest: { packageManager: "pnpm@11.2.3" }, dshHome: f.home, env };
  const prepared = await prepareProfilePackageManager(options);
  assert.equal(prepared.version, "11.2.3"); assert.equal(prepared.executable, join(cache(f.home, "11.2.3"), "node_modules", "pnpm", "bin", "pnpm.cjs"));
  const event = JSON.parse((await readFile(f.proof, "utf8")).trim());
  for (const actual of [event.env, prepared.environment]) {
    assert.equal(actual.SAVED_INPUT, undefined); assert.equal(actual.DSH_HUB_STORED_INPUT_KEYS, undefined);
    assert.equal(actual.EXTERNAL_INPUT, "explicit-external"); assert.equal(actual.npm_config_userconfig, env.npm_config_userconfig);
    assert.equal(actual.npm_config_registry, env.npm_config_registry); assert.equal(actual.npm_config_ignore_pnpmfile, "false");
    assert.equal(actual.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS, undefined);
    assert.equal(actual.NPM_CONFIG_PACKAGE_MANAGER_STRICT_VERSION, undefined);
    assert.equal(actual.npm_config_manage_package_manager_versions, "false");
    assert.equal(actual.npm_config_package_manager_strict, "true"); assert.equal(actual.npm_config_package_manager_strict_version, "true");
  }
  assert.equal(env.SAVED_INPUT, "stored-secret");
  assert.ok(event.args.includes("--global=false")); assert.ok(event.args.includes("--workspaces=false")); assert.ok(event.args.includes("--ignore-scripts"));
  assert.match(event.args[event.args.indexOf("--prefix") + 1], /\.prepare-/); assert.equal(event.args.at(-1), "pnpm@11.2.3");
  await prepareProfilePackageManager(options);
  assert.equal((await readFile(f.proof, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(await readdir(join(f.home, ".hub", "package-managers", "pnpm")), ["11.2.3"]);
});

test("invalid declarations and malformed provenance are rejected before storage writes or process execution", async t => {
  const f = await fixture(t); await fakeNpm(f);
  for (const packageManager of [null, "npm@10.0.0", "pnpm@latest", "pnpm@^10.33.0", "pnpm@10.33.0+sha512.abc", "pnpm@../../other"]) {
    await assert.rejects(prepareProfilePackageManager({ manifest: { packageManager }, dshHome: f.home, env: f.env }), /exact pnpm|suffix/);
  }
  await assert.rejects(prepareProfilePackageManager({ manifest: {}, dshHome: f.home, env: { ...f.env, DSH_HUB_STORED_INPUT_KEYS: "secret-malformed-value" } }), error => {
    assert.equal(String(error).includes("secret-malformed-value"), false); return true;
  });
  await assert.rejects(readdir(f.home), { code: "ENOENT" }); await absent(f.proof);
});

test("failed preparation and false version output leave no accepted cache and release lock", async t => {
  for (const mode of ["failure", "wrong-version"]) await t.test(mode, async sub => {
    const f = await fixture(sub);
    await fakeNpm(f, mode === "failure" ? "console.error('private-output-sentinel');process.exit(17);" : "", mode === "wrong-version" ? "9.9.9" : undefined);
    await assert.rejects(prepareProfilePackageManager({ manifest: {}, dshHome: f.home, env: f.env }), error => {
      assert.match(String(error), /failed|different exact version/); assert.equal(String(error).includes("private-output-sentinel"), false); return true;
    });
    assert.deepEqual(await readdir(join(f.home, ".hub", "package-managers", "pnpm")), []);
  });
});

test("post-publication verification failure removes only the newly created cache", async t => {
  const f = await fixture(t);
  await fakeNpm(f, "", undefined, "console.log(process.cwd().includes('.prepare-')?'10.33.0':'9.9.9');\n");
  await assert.rejects(prepareProfilePackageManager({ manifest: {}, dshHome: f.home, env: f.env }), /different exact version/);
  assert.deepEqual(await readdir(join(f.home, ".hub", "package-managers", "pnpm")), []);
  const directory = join(cache(f.home, "10.33.0"), "node_modules", "pnpm");
  const entry = await packageFixture(directory, "10.33.0", "console.log('9.9.9');\n");
  await assert.rejects(prepareProfilePackageManager({ manifest: {}, dshHome: f.home, env: f.env }), /different exact version/);
  assert.equal(await readFile(entry, "utf8"), "console.log('9.9.9');\n");
});

test("existing malformed and symlink caches fail closed without npm or outside writes", async t => {
  for (const mode of ["target-symlink", "storage-symlink", "incomplete", "wrong-identity", "entry-symlink", "escaped-entry"]) await t.test(mode, async sub => {
    const f = await fixture(sub), target = cache(f.home, "10.33.0"), directory = join(target, "node_modules", "pnpm"), outside = join(f.root, "outside");
    await mkdir(outside); await fakeNpm(f);
    if (mode === "storage-symlink") { await mkdir(f.home); await symlink(outside, join(f.home, ".hub")); }
    else if (mode === "target-symlink") { await mkdir(join(f.home, ".hub", "package-managers", "pnpm"), { recursive: true }); await symlink(outside, target); }
    else if (mode === "incomplete") await mkdir(target, { recursive: true });
    else {
      const entry = await packageFixture(directory);
      if (mode === "wrong-identity") await writeFile(join(directory, "package.json"), JSON.stringify({ name: "other", version: "10.33.0", bin: "bin/pnpm.cjs" }));
      if (mode === "entry-symlink") { const outsideEntry = join(outside, "bad.cjs"); await writeFile(outsideEntry, "throw Error('unexpected');"); await rm(entry); await symlink(outsideEntry, entry); }
      if (mode === "escaped-entry") await writeFile(join(directory, "package.json"), JSON.stringify({ name: "pnpm", version: "10.33.0", bin: "../outside.cjs" }));
    }
    await assert.rejects(prepareProfilePackageManager({ manifest: {}, dshHome: f.home, env: f.env }));
    await absent(f.proof);
    assert.deepEqual(await readdir(outside), mode === "entry-symlink" ? ["bad.cjs"] : []);
  });
});

test("assertUnchanged detects entry, metadata, bundled-module, permission and file-set drift", async t => {
  for (const mode of ["entry", "metadata", "module", "permission", "new-file", "symlink"]) await t.test(mode, async sub => {
    const f = await fixture(sub), directory = join(cache(f.home, "10.33.0"), "node_modules", "pnpm");
    const entry = await packageFixture(directory);
    const prepared = await prepareProfilePackageManager({ manifest: {}, dshHome: f.home, env: f.env });
    if (mode === "entry") await writeFile(entry, "console.log('10.33.0'); // changed\n");
    if (mode === "metadata") await writeFile(join(directory, "package.json"), JSON.stringify({ name: "pnpm", version: "10.33.0", bin: "bin/pnpm.cjs", extra: true }));
    if (mode === "module") await writeFile(join(directory, "dist", "engine.cjs"), "module.exports = 'modified';\n");
    if (mode === "permission") await chmod(entry, 0o700);
    if (mode === "new-file") await writeFile(join(directory, "new.cjs"), "// added");
    if (mode === "symlink") await symlink(entry, join(directory, "linked.cjs"));
    await assert.rejects(prepared.assertUnchanged(), /changed|symlinks/);
  });
});

test("concurrent preparation respects exact-version lock and successful first process remains usable", async t => {
  const f = await fixture(t), release = join(f.root, "release");
  await fakeNpm(f, `while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`);
  const options = { manifest: {}, dshHome: f.home, env: f.env };
  const first = prepareProfilePackageManager(options);
  try {
    let started = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await readFile(f.proof); started = true; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(started, "fake npm must start before concurrent request");
    await assert.rejects(prepareProfilePackageManager(options), /Another operation/);
  } finally { await writeFile(release, "go"); }
  const prepared = await first; await prepared.assertUnchanged();
  assert.equal((await readFile(f.proof, "utf8")).trim().split("\n").length, 1);
});

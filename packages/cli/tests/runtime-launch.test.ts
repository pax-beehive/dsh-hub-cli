import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { inspectPinnedRuntime } from "../dist/runtime-launch.js";
import { fakeRuntimeInstaller } from "./runtime-fixture.mjs";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-runtime-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function packageFixture(root: string, version = "1.0.0", bin = "bin.cjs") {
  const packageDirectory = join(root, "node_modules", "@deepseek-ai", "dsh");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version, bin: { dsh: bin } }));
  await writeFile(join(packageDirectory, "bin.cjs"), "process.exit(0);\n");
  return packageDirectory;
}

async function prepare(root: string, bin: string, version = "1.0.0") {
  const script = join(root, "prepare.mjs");
  await writeFile(script, `import {preparePinnedRuntime} from ${JSON.stringify(new URL("../dist/runtime-launch.js", import.meta.url).href)};
try { console.log(await preparePinnedRuntime(${JSON.stringify(version)},${JSON.stringify(root)})); }
catch(error) { console.error(error.message);process.exitCode=1; }\n`);
  return promisify(execFile)(process.execPath, [script], { env: { ...process.env, DSH_HOME: root, PATH: `${bin}:${process.env.PATH}` }, timeout: 10000 });
}

test("runtime identity and bin inspection rejects wrong versions, escaped paths, directories and symlinks", async (t) => {
  const root = await fixture(t);
  const packageDirectory = await packageFixture(root);
  assert.equal(await inspectPinnedRuntime(root, "1.0.0"), await realpath(join(packageDirectory, "bin.cjs")));
  await assert.rejects(inspectPinnedRuntime(root, "2.0.0"), /exact version/);
  await assert.rejects(inspectPinnedRuntime(root, "latest"));
  for (const bin of ["../outside.cjs", "/tmp/outside.cjs", "missing.cjs", "."]) {
    await packageFixture(root, "1.0.0", bin);
    await assert.rejects(inspectPinnedRuntime(root, "1.0.0"));
  }
  await packageFixture(root, "1.0.0", "linked.cjs");
  const outside = join(root, "outside.cjs");
  await writeFile(outside, "process.exit(0);");
  await symlink(outside, join(packageDirectory, "linked.cjs"));
  await assert.rejects(inspectPinnedRuntime(root, "1.0.0"), /inside its package/);
  const other = await fixture(t);
  await rm(packageDirectory, { recursive: true });
  await symlink(await packageFixture(other), packageDirectory);
  await assert.rejects(inspectPinnedRuntime(root, "1.0.0"), /outside its installation/);
});

test("failed or concurrent runtime preparation cannot replace a usable cached version", async (t) => {
  const root = await fixture(t);
  const cache = join(root, ".hub", "runtimes");
  const oldPackage = await packageFixture(join(cache, "1.0.0"));
  const bin = await fakeRuntimeInstaller(root, "process.exit(0);");
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nprocess.exit(17);\n`, { mode: 0o700 });
  await assert.rejects(prepare(root, bin, "2.0.0"), /preparation failed/);
  assert.deepEqual(await readdir(cache), ["1.0.0"]);
  assert.equal(await readFile(join(oldPackage, "bin.cjs"), "utf8"), "process.exit(0);\n");
  assert.match((await prepare(root, bin)).stdout, /1\.0\.0/);
  await writeFile(join(cache, "2.0.0.lock"), "");
  await assert.rejects(prepare(root, bin, "2.0.0"), /Another operation/);
  await rm(join(cache, "2.0.0.lock"));
  await fakeRuntimeInstaller(root, "process.exit(0);");
  assert.match((await prepare(root, bin, "2.0.0")).stdout, /2\.0\.0/);
  assert.deepEqual((await readdir(cache)).sort(), ["1.0.0", "2.0.0"]);
});

test("runtime preparation refuses symlink caches and invalid cached packages without invoking npm", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const bin = await fakeRuntimeInstaller(root, "process.exit(0);");
  const cache = join(root, ".hub", "runtimes");
  await mkdir(cache, { recursive: true });
  await symlink(outside, join(cache, "1.0.0"));
  await assert.rejects(prepare(root, bin), /real directories/);
  await rm(join(cache, "1.0.0"));
  await packageFixture(join(cache, "1.0.0"), "9.9.9");
  await assert.rejects(prepare(root, bin), /exact version/);
  await assert.rejects(readFile(join(root, "prepare.json")), { code: "ENOENT" });
});

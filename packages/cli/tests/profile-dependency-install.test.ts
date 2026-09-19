import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareProfilePackageManager } from "../dist/profile-package-manager.js";
import { installLockedProfileDependencies, verifyEffectiveProfileDependencyLock } from "../dist/profile-dependency-install.js";
import { installResolvedProfile, profileDirectory, profileLockPath, rollbackProfile } from "../dist/index.js";
import { installationFingerprint } from "../dist/profile-files.js";

// This test invokes the actual pinned pnpm package against a synthetic loopback
// registry. It neither substitutes the installer nor uses the public registry.
test("real pnpm aggregate locks enforce declared bytes, overrides, reuse and transactional recovery", { timeout: 120_000, skip: process.platform === "win32" }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-native-lock-")));
  const home = join(root, "dsh"), user = join(root, "home"), bin = join(root, "bin"), proofs = join(root, "proofs");
  for (const path of [home, user, bin, proofs]) await mkdir(path, { recursive: true });
  const initialEnvironment = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, initialEnvironment);
    await rm(root, { recursive: true, force: true });
  });
  const pm = await prepareProfilePackageManager({ manifest: {}, dshHome: home });
  await symlink(pm.executable, join(bin, "pnpm")); await symlink(process.execPath, join(bin, "node"));
  const packages = new Map<string, Map<string, { manifest: Record<string, unknown>; bytes: Buffer; integrity: string; path: string }>>();
  async function add(name: string, version: string, dependencies: Record<string, string> = {}) {
    const source = join(root, "sources", `${name}-${version}`), directory = join(source, "package");
    await mkdir(directory, { recursive: true });
    const manifest = { name, version, main: "index.cjs", dependencies, dsh: { bundle: { patch: "cordis.patch.yml" } }, scripts: { postinstall: "node postinstall.cjs" } };
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "index.cjs"), `module.exports={version:${JSON.stringify(version)}};`);
    await writeFile(join(directory, "cordis.patch.yml"), "[]\n");
    await writeFile(join(directory, "postinstall.cjs"), `const fs=require('node:fs'),path=require('node:path');if(process.env.HUB_TEST_SAVED)throw new Error('saved input leaked');fs.writeFileSync(path.join(process.env.DSH_TEST_PROOFS,${JSON.stringify(`${name}-${version}`)}),'ran');`);
    const archive = join(root, `${name}-${version}.tgz`);
    const tar = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", source, "package"]); assert.equal(tar.status, 0);
    const bytes = await readFile(archive), integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const versions = packages.get(name) ?? new Map(); versions.set(version, { manifest, bytes, integrity, path: `/-/${name}-${version}.tgz` }); packages.set(name, versions);
  }
  await add("fixture-leaf", "1.0.0"); await add("fixture-leaf", "2.0.0");
  await add("fixture-enabled", "1.0.0", { "fixture-leaf": "^2.0.0" });
  await add("fixture-enabled", "1.1.0", { "fixture-leaf": "^2.0.0" });
  await add("fixture-disabled", "1.0.0"); await add("fixture-library", "1.0.0");
  let origin = "", metadataRequests = 0, corruptTarball = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    const versions = packages.get(path.slice(1));
    if (versions) {
      metadataRequests++; response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ name: path.slice(1), "dist-tags": { latest: [...versions.keys()].at(-1) }, versions: Object.fromEntries([...versions].map(([version, item]) =>
        [version, { ...item.manifest, dist: { tarball: `${origin}${item.path}`, integrity: item.integrity } }])) })); return;
    }
    for (const versions of packages.values()) for (const item of versions.values()) if (item.path === path) {
      response.end(corruptTarball ? Buffer.from("changed bytes with unchanged registry integrity") : item.bytes); return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  t.after(() => new Promise<void>(done => server.close(() => done())));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const userconfig = join(root, "user.npmrc"), globalconfig = join(root, "global.npmrc");
  await writeFile(userconfig, ""); await writeFile(globalconfig, "");
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: user, DSH_HOME: home, CI: "1",
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_registry: origin,
    npm_config_store_dir: join(root, "store"), npm_config_cache: join(root, "cache"), npm_config_fetch_retries: "0", npm_config_fetch_timeout: "3000",
    npm_config_update_notifier: "false", DSH_TEST_PROOFS: proofs, HUB_TEST_SAVED: "private-saved-value",
    DSH_HUB_STORED_INPUT_KEYS: JSON.stringify({ v: 1, keys: ["HUB_TEST_SAVED"] }) });
  const dependencies = ["fixture-enabled", "fixture-disabled", "fixture-library"].map(packageName => ({ packageName, version: "1.0.0", selector: "1.0.0",
    installSpec: `${packageName}@1.0.0`, sourceKind: "npm" as const, integrity: packages.get(packageName)!.get("1.0.0")!.integrity }));
  const stage = join(home, "profiles", "aggregate"); await mkdir(stage, { recursive: true });
  const manifest = { name: "test-profile", private: true, dependencies: Object.fromEntries(dependencies.map(dep => [dep.packageName, dep.version])),
    pnpm: { overrides: { "fixture-leaf": "1.0.0" } }, dsh: { profile: { bundles: ["fixture-enabled"] } } };
  await writeFile(join(stage, "package.json"), JSON.stringify(manifest)); await writeFile(join(stage, "cordis.patch.yml"), "[]\n");
  await writeFile(join(stage, "pnpm-workspace.yaml"), `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n${[...packages.keys()].map(name => `  ${name}: true`).join("\n")}\n`);
  const first = await installLockedProfileDependencies({ directory: stage, dshHome: home, dependencies });
  assert.equal(first.receipt.resolution, "new"); assert.equal(first.receipt.lock.packages, 4); assert.equal(first.receipt.lock.declaredIntegrityVerified, 3);
  assert.equal(JSON.parse(await readFile(join(stage, "node_modules", "fixture-leaf", "package.json"), "utf8")).version, "1.0.0");
  assert.deepEqual(JSON.parse(await readFile(join(stage, "package.json"), "utf8")).dsh.profile.bundles, ["fixture-enabled"]);
  for (const name of ["fixture-enabled", "fixture-disabled", "fixture-library", "fixture-leaf"]) assert.equal(await readFile(join(proofs, `${name}-1.0.0`), "utf8"), "ran");
  await first.assertUnchanged();
  const next = join(home, "profiles", "reused");
  await cp(stage, next, { recursive: true, filter: source => source !== join(stage, "node_modules") && source !== join(stage, "pnpm-lock.yaml") });
  manifest.dsh.profile.bundles = ["fixture-disabled", "fixture-enabled"];
  await writeFile(join(next, "package.json"), JSON.stringify(manifest)); await writeFile(join(next, "cordis.patch.yml"), "[] # personal edit\n");
  const requestsBefore = metadataRequests;
  const second = await installLockedProfileDependencies({ directory: next, dshHome: home, dependencies, previousDirectory: stage, previousReceipt: first.receipt });
  assert.equal(second.receipt.resolution, "reused"); assert.equal(second.receipt.lock.hash, first.receipt.lock.hash); assert.equal(metadataRequests, requestsBefore);
  await writeFile(join(next, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await assert.rejects(verifyEffectiveProfileDependencyLock(next, second.receipt), /lock or its Profile inputs changed/);

  // Explicit declared integrity is checked after resolution and before any dependency script.
  const rejected = join(home, "profiles", "rejected"); await cp(stage, rejected, { recursive: true, filter: source => source !== join(stage, "node_modules") && source !== join(stage, "pnpm-lock.yaml") });
  const rejectedProofs = join(root, "rejected-proofs"); await mkdir(rejectedProofs); process.env.DSH_TEST_PROOFS = rejectedProofs;
  await assert.rejects(installLockedProfileDependencies({ directory: rejected, dshHome: home,
    dependencies: dependencies.map(dep => ({ ...dep, integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` })) }), /integrity/i);
  await assert.rejects(readFile(join(rejectedProofs, "fixture-enabled-1.0.0")), { code: "ENOENT" });

  // Exercise the production install transaction, including rollback of both native lock and receipt.
  const resolved = (version: string) => ({ profileVersion: version, bundles: [{ ...dependencies[0]!, selector: version, version,
    installSpec: `fixture-enabled@${version}`, integrity: packages.get("fixture-enabled")!.get(version)!.integrity }] });
  const install = (version: string) => installResolvedProfile({ profile: "transaction", dshHome: home, resolved: resolved(version),
    validate: async () => {}, resolveBuildAllowlist: async () => ["fixture-enabled", "fixture-leaf"] });
  const installed = await install("1.0.0"); assert.ok(installed.lockfile.effectiveLock);
  const target = profileDirectory("transaction", home), statePath = profileLockPath("transaction", home);
  const before = await installationFingerprint(target, statePath);
  const failed = { ...resolved("1.1.0"), bundles: [{ ...resolved("1.1.0").bundles[0]!, integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}` }] };
  await assert.rejects(installResolvedProfile({ profile: "transaction", dshHome: home, resolved: failed, validate: async () => {}, resolveBuildAllowlist: async () => [] }), /integrity/i);
  assert.equal(await installationFingerprint(target, statePath), before);
  const upgraded = await install("1.1.0"); assert.ok(upgraded.revision); assert.notEqual(upgraded.lockfile.effectiveLock!.lock.hash, installed.lockfile.effectiveLock!.lock.hash);
  await rollbackProfile({ profile: "transaction", dshHome: home, revision: upgraded.revision });
  assert.equal(await installationFingerprint(target, statePath), before);
  await verifyEffectiveProfileDependencyLock(target, installed.lockfile.effectiveLock!);

  // A fresh store cannot turn a changed tarball into a successful frozen install.
  process.env.npm_config_store_dir = join(root, "fresh-store"); process.env.npm_config_cache = join(root, "fresh-cache"); corruptTarball = true;
  await assert.rejects(installResolvedProfile({ profile: "corrupt", dshHome: home, resolved: resolved("1.0.0"), validate: async () => {}, resolveBuildAllowlist: async () => [] }), /frozen installation failed/);
  await assert.rejects(readFile(profileLockPath("corrupt", home)), { code: "ENOENT" });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installResolvedProfile, profileLockPath } from "../dist/index.js";
import { applyOperationPlan, createProfileApplyPlan, readUpgradeResolutions } from "../dist/operations.js";
import { diffResolvedProfile, doctorProfile, readProfileState } from "../dist/profile-lifecycle.js";
import { prepareProfileUpgrade } from "../dist/profile-upgrade.js";
import { installationFingerprint } from "../dist/profile-files.js";

const bundle = { packageName: "@deepseek-ai/dsh-base", selector: "0.1.0", version: "0.1.0",
  installSpec: "builtin:@deepseek-ai/dsh-base@0.1.0", sourceKind: "builtin" as const };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function release(version: string, patchYaml = "[]\n") {
  const body = { schemaVersion: 1 as const, version, name: "Upgrade", description: "", dsh: "*",
    runtime: { range: "*", version: "0.1.0" }, bundles: [{ ...bundle, before: [], after: [] }],
    patch: [], patchYaml, inputs: [], publishedAt: "2026-09-17T00:00:00.000Z" };
  return { ...body, contentHash: `sha256:${createHash("sha256").update(canonical(body)).digest("hex")}` };
}
const first = release("1.0.0");
const second = release("2.0.0", "author: next\n");
const resolved = (version: string) => ({ profileVersion: version, bundles: [bundle] });

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-upgrade-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installResolvedProfile({ profile: "web", dshHome: root, release: first, resolved: resolved(first.version),
    hubProfileSlug: "upgrade", execute: async () => {}, validate: async () => {} });
  const mock = join(root, "api.mjs");
  const profile = { id: "123e4567-e89b-12d3-a456-426614174000", slug: "upgrade", owner: "fixture",
    claimed: true, visibility: "public", latestVersion: "2.0.0", versions: [first, second],
    createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };
  await writeFile(mock, `globalThis.fetch=async(url)=>{if(!String(url).endsWith('/profiles/upgrade'))throw new Error('unexpected test request');return new Response(${JSON.stringify(JSON.stringify(profile))},{status:200,headers:{'content-type':'application/json'}});};\n`);
  return { root, mock, directory: join(root, "profiles", "web") };
}

function cli(root: string, mock: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", mock, fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...args, "--json"],
      { env: { ...process.env, DSH_HOME: root, DSH_HUB_TELEMETRY: "0", DSH_HUB_API_URL: "http://fixture.invalid" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

function archive(body: Buffer): Buffer {
  const name = Buffer.from("release.json");
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

test("resolutions accept only a context hash and choices, and invalid JSON never echoes values", async (t) => {
  const { root } = await fixture(t);
  const path = join(root, "choices.json");
  const contextHash = `sha256:${"a".repeat(64)}`;
  await writeFile(path, JSON.stringify({ contextHash, choices: { conflict: "local" } }));
  assert.deepEqual(await readUpgradeResolutions(path), { contextHash, choices: { conflict: "local" } });
  for (const body of ['{"secret":"private-marker"', JSON.stringify({ contextHash, choices: { conflict: "private-marker" } }),
    JSON.stringify({ contextHash, choices: {}, configuration: "private-marker" })]) {
    await writeFile(path, body);
    await assert.rejects(readUpgradeResolutions(path), (error: Error) => !error.message.includes("private-marker"));
  }
});

test("CLI conflict previews expose no config values and all mutation modes stop before writing a plan", async (t) => {
  const { root, mock, directory } = await fixture(t);
  const secret = "local-patch-private-fixture";
  await writeFile(join(directory, "cordis.patch.yml"), `key: ${secret}\n`);
  const before = await installationFingerprint(directory, profileLockPath("web", root));
  const diff = await cli(root, mock, ["profile", "diff"]);
  assert.equal(diff.code, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).upgrade.status, "conflicted");
  assert.equal(diff.stdout.includes(secret), false);
  for (const args of [["profile", "upgrade"], ["profile", "upgrade", "--dry-run"], ["profile", "upgrade", "--plan"],
    ["profile", "apply", "upgrade", "--plan"], ["profile", "apply", "upgrade", "--dry-run"]]) {
    const result = await cli(root, mock, args);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).upgrade.status, "conflicted");
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
  assert.equal(await installationFingerprint(directory, profileLockPath("web", root)), before);
  await assert.rejects(readdir(join(root, ".hub", "operations")), { code: "ENOENT" });
});

test("reviewed preserve plans omit local config, bind choices, and execute the same preparation", async (t) => {
  const { root, mock, directory } = await fixture(t);
  const secret = "local-merged-private-fixture";
  await writeFile(join(directory, "cordis.patch.yml"), `key: ${secret}\n`);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  manifest.personal = { secret };
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  const prepared = await prepareProfileUpgrade({ profile: "web", slug: "upgrade", release: second, resolved: resolved(second.version), dshHome: root });
  assert.equal(prepared.status, "conflicted");
  const choices = Object.fromEntries(prepared.summary.conflicts.map((item) => [item.id, item.choices.includes("local") ? "local" : "upstream"]));
  const resolutions = { contextHash: prepared.contextHash, choices } as { contextHash: string; choices: Record<string, "local" | "upstream"> };
  const path = join(root, "choices.json");
  await writeFile(path, JSON.stringify(resolutions));
  const result = await cli(root, mock, ["profile", "upgrade", "--plan", "--resolutions", path]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  const planPath = join(root, ".hub", "operations", `${plan.id}.json`);
  assert.equal(plan.effect.mode, "preserve");
  assert.equal(result.stdout.includes(secret), false);
  assert.equal((await readFile(planPath, "utf8")).includes(secret), false);
  await applyOperationPlan({ id: plan.id, dshHome: root, install: (options) => {
    assert.equal(options.mode, "upgrade");
    assert.equal(options.expectedUpgradeHash, plan.precondition.upgradeResultHash);
    return installResolvedProfile({ ...options, execute: async () => {}, validate: async () => {} });
  } });
  assert.equal(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).personal.secret, secret);
  assert.match(await readFile(join(directory, "cordis.patch.yml"), "utf8"), new RegExp(secret));
});

test("mutated choices and previous replace upgrade plans are rejected before installation", async (t) => {
  const { root } = await fixture(t);
  for (const mutate of [(plan: any) => { plan.input.resolutions = { contextHash: plan.precondition.upgradeContextHash, choices: { forged: "local" } }; },
    (plan: any) => { plan.effect.mode = "replace"; delete plan.reviewHash; }]) {
    const plan = await createProfileApplyPlan({ profile: "web", slug: "upgrade", release: second, resolved: resolved(second.version), kind: "profile.upgrade", dshHome: root });
    mutate(plan);
    await writeFile(join(root, ".hub", "operations", `${plan.id}.json`), JSON.stringify(plan));
    await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root, install: async () => { throw new Error("must-not-install"); } }), /create a new plan/);
  }
});

test("legacy baseline lookup binds the original exact Release and blocks a mismatched content hash", async (t) => {
  const { root, mock } = await fixture(t);
  const state = await readProfileState("web", root);
  delete state!.authorBaseline;
  await writeFile(profileLockPath("web", root), JSON.stringify(state));
  const ready = await cli(root, mock, ["profile", "diff"]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).upgrade.status, "ready");
  state!.contentHash = `sha256:${"f".repeat(64)}`;
  await writeFile(profileLockPath("web", root), JSON.stringify(state));
  const blocked = await cli(root, mock, ["profile", "upgrade", "--plan"]);
  assert.equal(blocked.code, 2, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).upgrade.status, "baseline_required");
  await assert.rejects(readdir(join(root, ".hub", "operations")), { code: "ENOENT" });
});

test("author diff excludes local bundles while doctor checks every effective dependency", async (t) => {
  const { root, directory } = await fixture(t);
  const state = (await readProfileState("web", root))!;
  const local = { packageName: "local-plugin", selector: "1.0.0", version: "1.0.0", installSpec: "local-plugin@1.0.0", sourceKind: "npm" as const };
  const library = { ...local, packageName: "local-library", installSpec: "local-library@1.0.0" };
  state.bundles.push(local);
  state.dependencies = [bundle, local, library];
  await writeFile(profileLockPath("web", root), JSON.stringify(state));
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  manifest.dsh.profile.bundles.push(local.packageName);
  manifest.dependencies = { [local.packageName]: "1.0.0", [library.packageName]: "1.0.0" };
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  for (const item of [local, library]) {
    await mkdir(join(directory, "node_modules", item.packageName), { recursive: true });
    await writeFile(join(directory, "node_modules", item.packageName, "package.json"), JSON.stringify({ name: item.packageName, version: item.version }));
  }
  const diff = diffResolvedProfile({ profile: "web", slug: "upgrade", release: second, resolved: resolved(second.version), current: state });
  assert.equal(diff.changes.some((item) => item.packageName === local.packageName), false);
  assert.equal((await doctorProfile({ profile: "web", dshHome: root })).healthy, true);
  await rm(join(directory, "node_modules", library.packageName), { recursive: true });
  const doctor = await doctorProfile({ profile: "web", dshHome: root });
  assert.equal(doctor.healthy, false);
  assert.ok(doctor.checks.some((item) => item.id === "dependency-version" && item.packageName === library.packageName && item.status === "failed"));
});

test("archive import cannot bypass preservation or retain an unauthenticated previous Hub slug", async (t) => {
  const { root, mock, directory } = await fixture(t);
  const secret = "archive-local-private-fixture";
  await writeFile(join(directory, "cordis.patch.yml"), `key: ${secret}\n`);
  const path = join(root, "target.dshprofile");
  await writeFile(path, archive(Buffer.from(JSON.stringify(second))));
  const before = await installationFingerprint(directory, profileLockPath("web", root));
  const blocked = await cli(root, mock, ["profile", "import", path, "--dry-run"]);
  assert.equal(blocked.code, 2, blocked.stderr);
  const preview = JSON.parse(blocked.stdout).upgrade;
  assert.equal(preview.status, "conflicted");
  const choices = join(root, "archive-choices.json");
  await writeFile(choices, JSON.stringify({ contextHash: preview.contextHash,
    choices: Object.fromEntries(preview.summary.conflicts.map((item: { id: string; choices: string[] }) => [item.id, item.choices.includes("local") ? "local" : "upstream"])) }));
  const ready = await cli(root, mock, ["profile", "import", path, "--dry-run", "--resolutions", choices]);
  assert.equal(ready.code, 0, ready.stderr);
  const result = JSON.parse(ready.stdout);
  assert.equal(result.upgrade.status, "ready");
  assert.equal(result.lockfile.hubProfile, undefined);
  assert.equal(result.lockfile.authorBaseline.slug, undefined);
  assert.equal(`${ready.stdout}${ready.stderr}`.includes(secret), false);
  const invalidPlan = await cli(root, mock, ["profile", "import", path, "--plan"]);
  assert.equal(invalidPlan.code, 1);
  assert.match(invalidPlan.stderr, /does not support --plan/);
  assert.equal(await installationFingerprint(directory, profileLockPath("web", root)), before);
});

test("an unchanged healthy Profile prepares successfully and avoids a redundant reinstall", async (t) => {
  const { root, mock, directory } = await fixture(t);
  const before = await installationFingerprint(directory, profileLockPath("web", root));
  const result = await cli(root, mock, ["profile", "upgrade", "--version", first.version]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.upToDate, true);
  assert.equal(output.upgrade.status, "ready");
  assert.equal(output.revision, undefined);
  assert.equal(await installationFingerprint(directory, profileLockPath("web", root)), before);
});

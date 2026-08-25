import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  dshPackageManifestSchema,
  hubListingSchema,
} from "@dsh-plugin-hub/schemas";
import {
  assertProfileApplyPrerequisites,
  buildDshInstallCommand,
  validateCurrentProfile,
  captureProfile,
  installResolvedProfile,
  listProfileRevisions,
  parseAllowBuilds,
  profileLockPath,
  rollbackProfile,
} from "../src/index.ts";
import { createPluginStarter } from "../src/scaffold.ts";
import { validatePackageDirectory } from "../src/package-validation.ts";
import { HubApiClient } from "../src/api-client.ts";
import {
  applyOperationPlan,
  createProfileApplyPlan,
  createProfileRollbackPlan,
  createProfileSharePlan,
} from "../dist/operations.js";
import { readProfileArchive, verifyProfileRelease } from "../dist/profile-archive.js";

test("creates a complete schema-valid plugin starter without overwriting files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-starter-"));
  const directory = join(root, "hello-world");
  const result = await createPluginStarter({
    directory,
    packageName: "@example/hello-world",
    repository: "example/hello-world",
    displayName: "Hello World's Plugin",
  });
  const rawPackage = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const manifest = dshPackageManifestSchema.parse(rawPackage);
  const listing = hubListingSchema.parse(manifest.dsh.hub);
  const patch = await readFile(join(directory, "cordis.patch.yml"), "utf8");

  assert.deepEqual(result.files, ["package.json", "cordis.patch.yml", "README.md"]);
  assert.equal(manifest.name, "@example/hello-world");
  assert.equal(listing.displayName, "Hello World's Plugin");
  assert.deepEqual(listing.entryIds, ["example-hello-world"]);
  assert.match(patch, /name: 'Hello World''s Plugin'/);
  const validation = await validatePackageDirectory(directory);
  assert.equal(validation.kind, "plugin");
  assert.equal(validation.name, "@example/hello-world");
  assert.equal(validation.patch, "cordis.patch.yml");
  await assert.rejects(
    createPluginStarter({
      directory,
      packageName: "@example/hello-world",
      repository: "example/hello-world",
    }),
    /Refusing to overwrite/,
  );
});

test("validates an ordered profile and reports implicit latest selectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-profile-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@example/starter-profile",
    version: "1.0.0",
    dependencies: { "dsh-base": "1.2.3" },
    dsh: {
      profile: { bundles: ["dsh-base", "dsh-memory"] },
      hub: { schemaVersion: 1, displayName: "Starter Profile" },
    },
  }), "utf8");

  const result = await validatePackageDirectory(root);
  assert.equal(result.kind, "profile");
  assert.equal(result.bundleCount, 2);
  assert.match(result.warnings.join("\n"), /dsh-memory.*latest/);
});

test("rejects patch traversal before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-traversal-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "dsh-traversal",
    version: "1.0.0",
    repository: "https://github.com/example/dsh-traversal",
    dsh: { bundle: { patch: "../outside.yml" } },
  }), "utf8");
  await assert.rejects(validatePackageDirectory(root), /must stay inside/);
});

test("rejects invalid package and repository identities before creating a starter", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-starter-invalid-"));
  await assert.rejects(createPluginStarter({
    directory: join(root, "bad-package"),
    packageName: "Bad Package",
    repository: "example/repository",
  }));
  await assert.rejects(createPluginStarter({
    directory: join(root, "bad-repository"),
    packageName: "valid-package",
    repository: "example",
  }), /owner\/repository/);
});

test("builds the official dsh plugin add command without a shell", () => {
  assert.deepEqual(buildDshInstallCommand("web", "dsh-memory@1.2.3"), {
    command: "dsh",
    args: ["plugin", "--profile", "web", "add", "dsh-memory@1.2.3"],
  });
  assert.throws(() => buildDshInstallCommand("../../web", "dsh-memory"));
  assert.throws(() => buildDshInstallCommand("web", "--config=/tmp/x"));
  assert.deepEqual(buildDshInstallCommand("web", "dsh-memory@1.2.3", "0.1.0-rc.7"), {
    command: "npx",
    args: ["-y", "@deepseek-ai/dsh@0.1.0-rc.7", "plugin", "--profile", "web", "add", "dsh-memory@1.2.3"],
  });
});

test("uses the bearer-aware production API origin by default", () => {
  assert.equal(new HubApiClient().baseUrl, "https://api.dshpluginhub.ai/api/v1");
});

test("validates a shared Profile with its exact DSH runtime", async () => {
  let command: { command: string; args: string[] } | undefined;
  await validateCurrentProfile("web", "0.1.1-rc.2", async (value) => { command = value; });
  assert.deepEqual(command, {
    command: "npx",
    args: ["-y", "@deepseek-ai/dsh@0.1.1-rc.2", "--profile", "web", "--dump-config"],
  });
});

test("fails Profile apply prerequisites before network or profile mutation", async () => {
  await assert.rejects(assertProfileApplyPrerequisites({
    nodeVersion: "20.6.1",
    pnpmAvailable: async () => true,
  }), /Node\.js >=22\.13\.0/);
  await assert.rejects(assertProfileApplyPrerequisites({
    nodeVersion: "22.13.0",
    pnpmAvailable: async () => false,
  }), /pnpm on PATH/);
});

test("accepts only explicitly true package names from pinned GitHub build policy", () => {
  assert.deepEqual(parseAllowBuilds(`packages:\n  - .\nallowBuilds:\n  node-pty: true\n  protobufjs: true\n  ignored: false\n`), ["node-pty", "protobufjs"]);
  assert.throws(() => parseAllowBuilds(`allowBuilds:\n  dangerouslyAllowAllBuilds: '*'\n`), /Unsupported allowBuilds entry/);
  assert.throws(() => parseAllowBuilds(`allowBuilds:\n  ../../escape: true\n`), /Unsupported allowBuilds package/);
});

test("dry-run produces commands without touching the profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-cli-"));
  const result = await installResolvedProfile({
    profile: "web",
    dshHome: root,
    dryRun: true,
    resolved: {
      profileVersion: "1.0.0",
      bundles: [{
        packageName: "dsh-memory",
        selector: "^1.0.0",
        version: "1.2.3",
        installSpec: "dsh-memory@1.2.3",
        integrity: "sha512-example",
        sourceKind: "npm",
      }],
    },
  });

  assert.equal(result.commands.length, 1);
  await assert.rejects(readFile(profileLockPath("web", root)));
});

test("successful installs are executed in profile order and locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-cli-"));
  const seen: string[] = [];
  await installResolvedProfile({
    profile: "research",
    dshHome: root,
    hubProfileSlug: "research-stack",
    execute: async (command) => { seen.push(command.args.at(-1)!); },
    resolved: {
      profileVersion: "2.0.0",
      bundles: [
        { packageName: "dsh-search", selector: "1.0.0", version: "1.0.0", installSpec: "dsh-search@1.0.0", sourceKind: "npm" },
        { packageName: "dsh-memory", selector: "2.0.0", version: "2.0.0", installSpec: "dsh-memory@2.0.0", sourceKind: "npm" },
      ],
    },
  });

  assert.deepEqual(seen, ["dsh-search@1.0.0", "dsh-memory@2.0.0"]);
  const lock = JSON.parse(await readFile(profileLockPath("research", root), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "profiles", "research", "package.json"), "utf8"));
  assert.equal(lock.hubProfile.slug, "research-stack");
  assert.equal(manifest.name, "dsh-hub-research");
  assert.deepEqual(lock.bundles.map((bundle: { packageName: string }) => bundle.packageName), ["dsh-search", "dsh-memory"]);
});

test("stages a pinned GitHub build allowlist before running dsh plugin add", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-github-builds-"));
  const commit = "f0965e1d6157a3e06ed2f5c7775a64428d5d3c29";
  let workspace = "";

  await installResolvedProfile({
    profile: "web",
    dshHome: root,
    resolveBuildAllowlist: async () => [
      "dsh-better-sidebar",
      "node-pty",
      "protobufjs",
    ],
    execute: async (command) => {
      const stageProfile = command.args[command.args.indexOf("--profile") + 1]!;
      workspace = await readFile(join(root, "profiles", stageProfile, "pnpm-workspace.yaml"), "utf8");
    },
    resolved: {
      profileVersion: "1.0.0",
      bundles: [{
        packageName: "dsh-better-sidebar",
        selector: "0.15.0",
        version: "0.15.0",
        installSpec: `github:omdsh-dev/DSH-better-sidebar#${commit}`,
        sourceKind: "github",
      }],
    },
  });

  assert.match(workspace, /allowBuilds:/);
  assert.match(workspace, /dsh-better-sidebar: true/);
  assert.match(workspace, /node-pty: true/);
  assert.match(workspace, /protobufjs: true/);
});

test("a validated install records local structural and composition evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-verified-install-"));
  await installResolvedProfile({
    profile: "web",
    dshHome: root,
    execute: async () => {},
    validate: async () => {},
    resolved: { profileVersion: "1.0.0", bundles: [
      { packageName: "dsh-memory", selector: "1.0.0", version: "1.0.0", installSpec: "dsh-memory@1.0.0", sourceKind: "npm" },
    ] },
  });
  const state = JSON.parse(await readFile(profileLockPath("web", root), "utf8"));
  assert.equal(state.verification.structural, "passed");
  assert.equal(state.verification.composition, "passed");
  assert.equal(typeof state.verification.verifiedAt, "string");
});

test("upgrade keeps the previous official Profile as a recoverable revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-upgrade-"));
  const profile = join(root, "profiles", "web");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "old-profile", marker: "keep-me" }), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), "[]\n", "utf8");
  await writeFile(profileLockPath("web", root), "", { flag: "a" }).catch(async () => {
    await mkdir(join(root, ".hub", "installations", "web"), { recursive: true });
    await writeFile(profileLockPath("web", root), JSON.stringify({ schemaVersion: 2, profile: "web", resolvedAt: "old", bundles: [] }), "utf8");
  });

  await installResolvedProfile({
    profile: "web",
    dshHome: root,
    execute: async () => {},
    resolved: { profileVersion: "2.0.0", bundles: [
      { packageName: "dsh-memory", selector: "2.0.0", version: "2.0.0", installSpec: "dsh-memory@2.0.0", sourceKind: "npm" },
    ] },
  });
  const revisions = await listProfileRevisions("web", root);
  assert.equal(revisions.length, 1);
  assert.equal((JSON.parse(await readFile(join(profile, "package.json"), "utf8"))).dsh.profile.bundles[0], "dsh-memory");
  await rollbackProfile({ profile: "web", dshHome: root });
  assert.equal((JSON.parse(await readFile(join(profile, "package.json"), "utf8"))).marker, "keep-me");
});

test("a sidecar persistence failure restores the previous complete Profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-switch-failure-"));
  const profile = join(root, "profiles", "web");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "old-profile", marker: "still-current" }), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), "[]\n", "utf8");

  await assert.rejects(installResolvedProfile({
    profile: "web",
    dshHome: root,
    execute: async () => {},
    persistState: async () => { throw new Error("disk full"); },
    resolved: { profileVersion: "2.0.0", bundles: [
      { packageName: "dsh-memory", selector: "2.0.0", version: "2.0.0", installSpec: "dsh-memory@2.0.0", sourceKind: "npm" },
    ] },
  }), /disk full/);

  assert.equal((JSON.parse(await readFile(join(profile, "package.json"), "utf8"))).marker, "still-current");
  assert.deepEqual(await listProfileRevisions("web", root), []);
});

test("captures exact bundle order, installed versions, patch and input candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-capture-"));
  const profile = join(root, "profiles", "web");
  await mkdir(join(profile, "node_modules", "@example", "memory"), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({
    dependencies: { "@example/memory": "^1.0.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@example/memory"] } },
  }), "utf8");
  await writeFile(join(profile, "node_modules", "@example", "memory", "package.json"), JSON.stringify({ version: "1.4.2" }), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), "apiKeyEnv: DEEPSEEK_API_KEY\n", "utf8");
  const draft = await captureProfile({ profile: "web", slug: "my-web", dshHome: root });
  assert.deepEqual(draft.bundles.map((bundle) => bundle.packageName), ["@deepseek-ai/dsh-base", "@example/memory"]);
  assert.equal(draft.bundles[1]?.version, "1.4.2");
  assert.equal(draft.inputs[0]?.key, "DEEPSEEK_API_KEY");
  assert.equal(draft.patchYaml, "apiKeyEnv: DEEPSEEK_API_KEY\n");
});

test("captures a pinned GitHub dependency without rewriting it as npm", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-capture-github-"));
  const profile = join(root, "profiles", "web");
  const commit = "f0965e1d6157a3e06ed2f5c7775a64428d5d3c29";
  await mkdir(join(profile, "node_modules", "dsh-better-sidebar"), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({
    dependencies: { "dsh-better-sidebar": `github:omdsh-dev/DSH-better-sidebar#${commit}` },
    dsh: { profile: { bundles: ["dsh-better-sidebar"] } },
  }), "utf8");
  await writeFile(join(profile, "node_modules", "dsh-better-sidebar", "package.json"), JSON.stringify({ version: "0.15.0" }), "utf8");
  const draft = await captureProfile({ profile: "web", slug: "github-web", dshHome: root });
  assert.equal(draft.bundles[0]?.sourceKind, "github");
  assert.equal(draft.bundles[0]?.installSpec, `github:omdsh-dev/DSH-better-sidebar#${commit}`);
  assert.equal(draft.bundles[0]?.version, "0.15.0");
});

test("operation plans are persisted, preconditioned and single-use", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-plan-"));
  const release = {
    schemaVersion: 1 as const, version: "1.0.0", name: "Research", description: "", dsh: "*",
    bundles: [{ packageName: "dsh-memory", selector: "^1.0.0", version: "1.2.0", installSpec: "dsh-memory@1.2.0", sourceKind: "npm" as const, before: [], after: [] }],
    patch: [], inputs: [], publishedAt: "2026-08-21T00:00:00.000Z",
  };
  const resolved = { profileVersion: "1.0.0", bundles: [
    { packageName: "dsh-memory", selector: "^1.0.0", version: "1.2.0", installSpec: "dsh-memory@1.2.0", sourceKind: "npm" as const },
  ] };
  const plan = await createProfileApplyPlan({ profile: "web", slug: "research", release, resolved, dshHome: root });
  const events: string[] = [];
  const result = await applyOperationPlan({
    id: plan.id, dshHome: root, progress: (event) => events.push(String(event.type)),
    install: async () => ({ commands: [], lockfile: { schemaVersion: 2, profile: "web", resolvedAt: "now", bundles: resolved.bundles } }),
  });
  assert.equal(result.plan.status, "applied");
  assert.deepEqual(events, ["operation.started", "operation.completed"]);
  await assert.rejects(applyOperationPlan({ id: plan.id, dshHome: root }), /applied/);
});

test("rollback uses the same preconditioned operation plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-rollback-plan-"));
  const install = join(root, ".hub", "installations", "web");
  const revision = "2026-08-21T00-00-00-000Z-test";
  await mkdir(join(install, "revisions", revision, "profile"), { recursive: true });
  const current = { schemaVersion: 2, profile: "web", resolvedAt: "now", contentHash: "sha256:current", bundles: [] };
  const target = { schemaVersion: 2, profile: "web", resolvedAt: "before", contentHash: "sha256:before", bundles: [] };
  await writeFile(join(install, "current.json"), JSON.stringify(current), "utf8");
  await writeFile(join(install, "revisions", revision, "state.json"), JSON.stringify(target), "utf8");
  const plan = await createProfileRollbackPlan({ profile: "web", dshHome: root });
  assert.equal(plan.kind, "profile.rollback");
  assert.equal(plan.input.revision, revision);
  let restored = "";
  const result = await applyOperationPlan({
    id: plan.id,
    dshHome: root,
    rollback: async (input) => { restored = input.revision ?? ""; return { restored }; },
  });
  assert.equal(restored, revision);
  assert.equal(result.plan.status, "applied");
});

test("share plans bind publication to the captured local Profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-share-plan-"));
  const profile = join(root, "profiles", "web");
  await mkdir(join(profile, "node_modules", "dsh-memory"), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({
    dependencies: { "dsh-memory": "^1.0.0" },
    dsh: { profile: { bundles: ["dsh-memory"] } },
  }), "utf8");
  await writeFile(join(profile, "node_modules", "dsh-memory", "package.json"), JSON.stringify({ version: "1.4.0" }), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), "[]\n", "utf8");
  const draft = await captureProfile({ profile: "web", slug: "research", name: "Research", dshHome: root });
  draft.runtime = { range: "*", version: "0.1.0-rc.7" };
  const plan = await createProfileSharePlan({
    profile: "web", slug: "research", version: "1.0.0", apiBase: "https://hub.test/api/v1", draft, dshHome: root,
  });
  let published = false;
  const result = await applyOperationPlan({
    id: plan.id,
    dshHome: root,
    share: async (input) => { published = input.version === "1.0.0"; return { published }; },
  });
  assert.equal(published, true);
  assert.deepEqual(result.publication, { published: true });

  const changedPlan = await createProfileSharePlan({
    profile: "web", slug: "research", version: "1.0.1", apiBase: "https://hub.test/api/v1", draft, dshHome: root,
  });
  await writeFile(join(profile, "cordis.patch.yml"), "- patch: changed\n", "utf8");
  await assert.rejects(applyOperationPlan({ id: changedPlan.id, dshHome: root, share: async () => ({}) }), /changed after planning/);
});

test("install blocks before mutation when a required local input is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-input-"));
  let executed = false;
  await assert.rejects(installResolvedProfile({
    profile: "web", dshHome: root, execute: async () => { executed = true; },
    release: {
      schemaVersion: 1, version: "1.0.0", name: "Secrets", description: "", dsh: "*",
      bundles: [{ packageName: "dsh-memory", selector: "1.0.0", version: "1.0.0", sourceKind: "npm", before: [], after: [] }],
      patch: [], inputs: [{ key: "DSH_HUB_TEST_MISSING_SECRET", label: "secret", required: true, secret: true }],
      publishedAt: "2026-08-21T00:00:00.000Z",
    },
    resolved: { profileVersion: "1.0.0", bundles: [
      { packageName: "dsh-memory", selector: "1.0.0", version: "1.0.0", installSpec: "dsh-memory@1.0.0", sourceKind: "npm" },
    ] },
  }), /Missing required local Profile inputs/);
  assert.equal(executed, false);
});

test("reads a portable .dshprofile ZIP release", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-profile-archive-"));
  const path = join(root, "research.dshprofile");
  const release = JSON.stringify({
    schemaVersion: 1, version: "1.2.3", name: "Research", description: "A stack", dsh: "^0.1.0",
    runtime: { range: "^0.1.0", version: "0.1.0-rc.7" },
    bundles: [
      { packageName: "@deepseek-ai/dsh-base", selector: "latest", version: "0.1.0-rc.7", installSpec: "builtin:@deepseek-ai/dsh-base@0.1.0-rc.7", sourceKind: "builtin", before: [], after: [] },
      { packageName: "dsh-memory", selector: "^2.0.0", version: "2.4.1", installSpec: "dsh-memory@2.4.1", integrity: "sha512-test", sourceKind: "npm", before: [], after: [] },
    ],
    patch: [], patchYaml: "[]\n", inputs: [{ key: "API_KEY", label: "API key", required: true, secret: true }],
    verification: { structural: "passed", composition: "local_required", activation: "local_required" },
    publishedAt: "2026-08-21T00:00:00Z",
    contentHash: "sha256:f07dd875862a77ec8ae27c0c3858beec2fb69031a57fbe99d49e3dc228d256f5",
  });
  await writeFile(path, deflatedZip("release.json", Buffer.from(release)));
  const parsed = await readProfileArchive(path);
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.bundles[0]?.sourceKind, "builtin");
});

test("rejects an unsigned portable Profile recipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-profile-unsigned-"));
  const path = join(root, "unsigned.dshprofile");
  const release = Buffer.from(JSON.stringify({
    schemaVersion: 1, version: "1.0.0", name: "Unsigned", description: "", dsh: "*",
    bundles: [{ packageName: "dsh-memory", selector: "1.0.0", before: [], after: [] }],
    patch: [], inputs: [], publishedAt: "2026-08-21T00:00:00Z",
  }));
  await writeFile(path, storedZip("release.json", release));
  await assert.rejects(readProfileArchive(path), /no content hash/);
});

test("verifies the Go API canonical Profile Release hash", () => {
  const release = {
    schemaVersion: 1 as const,
    version: "1.2.3",
    name: "Research",
    description: "A stack",
    dsh: "^0.1.0",
    runtime: { range: "^0.1.0", version: "0.1.0-rc.7" },
    bundles: [
      { packageName: "@deepseek-ai/dsh-base", selector: "latest", version: "0.1.0-rc.7", installSpec: "builtin:@deepseek-ai/dsh-base@0.1.0-rc.7", sourceKind: "builtin" as const, before: [], after: [] },
      { packageName: "dsh-memory", selector: "^2.0.0", version: "2.4.1", installSpec: "dsh-memory@2.4.1", integrity: "sha512-test", sourceKind: "npm" as const, before: [], after: [] },
    ],
    patch: [],
    patchYaml: "[]\n",
    inputs: [{ key: "API_KEY", label: "API key", required: true, secret: true }],
    verification: { structural: "passed" as const, composition: "local_required" as const, activation: "local_required" as const },
    publishedAt: "2026-08-21T00:00:00Z",
    contentHash: "sha256:f07dd875862a77ec8ae27c0c3858beec2fb69031a57fbe99d49e3dc228d256f5",
  };
  assert.doesNotThrow(() => verifyProfileRelease(release));
  assert.throws(() => verifyProfileRelease({ ...release, name: "Tampered" }), /content hash mismatch/);
});

function storedZip(name: string, body: Buffer): Buffer {
  return zipEntry(name, body, body, 0);
}

function deflatedZip(name: string, body: Buffer): Buffer {
  return zipEntry(name, body, deflateRawSync(body), 8);
}

function zipEntry(name: string, body: Buffer, compressedBody: Buffer, method: number): Buffer {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8); local.writeUInt32LE(compressedBody.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10); central.writeUInt32LE(compressedBody.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + filename.length, 12); eocd.writeUInt32LE(local.length + filename.length + compressedBody.length, 16);
  return Buffer.concat([local, filename, compressedBody, central, filename, eocd]);
}

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
import { getAccessToken } from "../dist/auth.js";
import {
  applyOperationPlan,
  createPluginInstallPlan,
  createProfileApplyPlan,
  createProfileRollbackPlan,
  createProfileSharePlan,
} from "../dist/operations.js";
import {
  diffResolvedProfile,
  doctorProfile,
} from "../dist/profile-lifecycle.js";
import {
  buildCliUsagePayload,
  cliErrorCode,
  initializeTelemetry,
  readTelemetryStatus,
  sendCliUsage,
  setTelemetryPreference,
  telemetryEndpoint,
  telemetryEnabled,
  telemetryNotice,
} from "../dist/telemetry.js";
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

test("sync posts the package name and reports accepted and rejected results", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        status: "accepted",
        kind: "profile",
        packageName: "dsh-example-preset",
        slug: "example-preset",
        versionsAdded: 1,
        versionsSeen: 2,
        latestVersion: "1.2.3",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new HubApiClient(undefined, async () => "token");
    const accepted = await client.syncPackage("dsh-example-preset");
    assert.deepEqual(calls, [{
      url: "https://api.dshpluginhub.ai/api/v1/manage/sync/npm",
      body: { packageName: "dsh-example-preset" },
    }]);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.kind, "profile");
    assert.equal(accepted.latestVersion, "1.2.3");

    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: "rejected",
      packageName: "not-a-plugin",
      reason: "not_a_dsh_bundle_or_profile",
    }), { status: 422, headers: { "content-type": "application/json" } })) as typeof fetch;
    const rejected = await client.syncPackage("not-a-plugin");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reason, "not_a_dsh_bundle_or_profile");
  } finally {
    globalThis.fetch = original;
  }
});

test("sync requires a Hub login", async () => {
  await assert.rejects(new HubApiClient().syncPackage("dsh-example"), /authentication is required/);
});

test("DSH_HUB_TOKEN replaces the stored WorkOS session in CI", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-token-"));
  const previous = process.env.DSH_HUB_TOKEN;
  const original = globalThis.fetch;
  try {
    delete process.env.DSH_HUB_TOKEN;
    await assert.rejects(getAccessToken(root), /Not signed in/);

    // Surrounding whitespace is trimmed so a secret copied with a trailing
    // newline still authenticates.
    process.env.DSH_HUB_TOKEN = "  dshhub_ci_token  ";
    assert.equal(await getAccessToken(root), "dshhub_ci_token");

    let authorization: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({
        status: "accepted",
        kind: "plugin",
        packageName: "dsh-example",
        slug: "dsh-example",
        versionsAdded: 1,
        versionsSeen: 1,
        latestVersion: "1.0.0",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new HubApiClient(undefined, () => getAccessToken(root));
    await client.syncPackage("dsh-example");
    assert.equal(authorization, "Bearer dshhub_ci_token");
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.DSH_HUB_TOKEN;
    else process.env.DSH_HUB_TOKEN = previous;
  }
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

test("Plugin install plans pin the exact source and carry its security assessment", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-plugin-plan-"));
  const profile = join(root, "profiles", "web");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "web" }), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), "[]\n", "utf8");
  const plugin = {
    packageName: "dsh-memory",
    security: {
      status: "passed", version: "1.2.3", scannerVersion: "1",
      integrityVerified: true, staticAnalyzed: true, capabilityAnalyzed: true,
      dependencyInventoryComplete: true, advisoryScanned: true, behaviorAnalyzed: false,
      capabilities: {
        cordisModules: [], cordisServices: [], clientPackages: [], environmentVariables: [], networkHosts: [],
        dynamicConfig: false, executablePatch: false, filesystemAccess: false, shellExecution: false,
        registersModelTools: false, sessionAccess: false,
      },
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  } as never;
  const plan = await createPluginInstallPlan({
    profile: "web", plugin, version: "1.2.3", installSpec: "dsh-memory@1.2.3", dshHome: root,
  });
  assert.equal(plan.kind, "plugin.install");
  assert.equal(plan.input.installSpec, "dsh-memory@1.2.3");
  assert.equal(plan.input.security?.integrityVerified, true);
  let installed = "";
  await applyOperationPlan({
    id: plan.id,
    dshHome: root,
    installPlugin: async (input) => { installed = input.installSpec; },
  });
  assert.equal(installed, "dsh-memory@1.2.3");
});

test("Profile diff reports additions, removals, updates, and immutable source changes", () => {
  const diff = diffResolvedProfile({
    profile: "web",
    slug: "research",
    release: {
      schemaVersion: 1, version: "2.0.0", name: "Research", description: "", dsh: "*",
      bundles: [], patch: [], inputs: [], publishedAt: "2026-08-30T00:00:00.000Z", contentHash: "sha256:new",
    },
    current: {
      schemaVersion: 2, profile: "web", resolvedAt: "before", contentHash: "sha256:old",
      hubProfile: { slug: "research", version: "1.0.0" },
      bundles: [
        { packageName: "removed", selector: "1.0.0", version: "1.0.0", installSpec: "removed@1.0.0", sourceKind: "npm" },
        { packageName: "updated", selector: "1.0.0", version: "1.0.0", installSpec: "updated@1.0.0", sourceKind: "npm" },
        { packageName: "moved", selector: "1.0.0", version: "1.0.0", installSpec: "moved@1.0.0", sourceKind: "npm" },
      ],
    },
    resolved: { profileVersion: "2.0.0", bundles: [
      { packageName: "added", selector: "1.0.0", version: "1.0.0", installSpec: "added@1.0.0", sourceKind: "npm" },
      { packageName: "updated", selector: "2.0.0", version: "2.0.0", installSpec: "updated@2.0.0", sourceKind: "npm" },
      { packageName: "moved", selector: "1.0.0", version: "1.0.0", installSpec: "github:acme/moved#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceKind: "github" },
    ] },
  });
  assert.deepEqual(diff.summary, { added: 1, removed: 1, updated: 1, sourceChanged: 1, unchanged: 0 });
  assert.equal(diff.order.changed, true);
  assert.equal(diff.changed, true);
});

test("Profile doctor detects lock drift and missing installed bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-doctor-"));
  const profile = join(root, "profiles", "web");
  await mkdir(profile, { recursive: true });
  await mkdir(join(root, ".hub", "installations", "web"), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({
    dsh: { profile: { bundles: ["dsh-memory"] } },
  }), "utf8");
  await writeFile(join(root, ".hub", "installations", "web", "current.json"), JSON.stringify({
    schemaVersion: 2, profile: "web", resolvedAt: "now",
    bundles: [{ packageName: "dsh-memory", selector: "1.0.0", version: "1.0.0", installSpec: "dsh-memory@1.0.0", sourceKind: "npm" }],
  }), "utf8");
  const result = await doctorProfile({ profile: "web", dshHome: root });
  assert.equal(result.healthy, false);
  assert.ok(result.checks.some((check) => check.packageName === "dsh-memory" && check.status === "failed"));
});

test("CLI telemetry is anonymous, optional, and reduces errors to stable codes", async () => {
  assert.equal(telemetryEnabled({ DSH_HUB_TELEMETRY: "0" }), false);
  assert.equal(telemetryEnabled({ DO_NOT_TRACK: "1" }), false);
  assert.equal(cliErrorCode(new Error("dsh command failed (exit 1)")), "dsh_command_failed");
  let payload: Record<string, unknown> | undefined;
  await sendCliUsage("https://hub.test/api/v1", {
    event: "plugin.install", outcome: "succeeded", packageName: "dsh-memory", version: "1.2.3", durationMs: 42,
  }, {
    env: {},
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(payload?.packageName, "dsh-memory");
  assert.equal(payload?.durationMs, 42);
  assert.equal("profile" in (payload ?? {}), false);
  assert.equal("path" in (payload ?? {}), false);
});

test("CLI telemetry notices before enabling and persists user control", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-hub-telemetry-"));
  assert.deepEqual(
    await readTelemetryStatus({ dshHome: root, env: {} }),
    {
      enabled: false,
      noticeShown: false,
      source: "default-pending-notice",
      configPath: join(root, ".hub", "telemetry.json"),
    },
  );
  const notices: string[] = [];
  const first = await initializeTelemetry({
    dshHome: root,
    env: {},
    onNotice: (message) => notices.push(message),
  });
  assert.equal(first.enabled, false);
  assert.deepEqual(notices, [telemetryNotice]);
  const saved = JSON.parse(await readFile(join(root, ".hub", "telemetry.json"), "utf8"));
  assert.equal(saved.enabled, true);

  const second = await initializeTelemetry({ dshHome: root, env: {} });
  assert.equal(second.enabled, true);
  assert.equal(second.noticeShown, true);

  const off = await setTelemetryPreference(false, { dshHome: root });
  assert.equal(off.enabled, false);
  assert.equal((await initializeTelemetry({ dshHome: root, env: {} })).enabled, false);
  const environment = await readTelemetryStatus({ dshHome: root, env: { DO_NOT_TRACK: "1" } });
  assert.equal(environment.enabled, false);
  assert.equal(environment.noticeShown, true);
  assert.equal(environment.source, "environment");
});

test("CLI telemetry debug reveals the bounded payload without delivery", async () => {
  assert.equal(telemetryEndpoint("http://collector.example/api/v1"), undefined);
  assert.equal(telemetryEndpoint("http://127.0.0.1:8787/api/v1"), "http://127.0.0.1:8787/api/v1/telemetry/cli");
  assert.equal(telemetryEndpoint("https://hub.test/api/v1"), "https://hub.test/api/v1/telemetry/cli");
  const built = buildCliUsagePayload({
    event: "profile.apply",
    outcome: "failed",
    profileSlug: "research",
    errorCode: "operation_failed",
    durationMs: 90_000_000,
  });
  assert.equal(built.durationMs, 86_400_000);

  let delivered = false;
  let debug: { endpoint: string; payload: Record<string, unknown> } | undefined;
  await sendCliUsage("https://hub.test/api/v1", {
    event: "plugin.install",
    outcome: "succeeded",
    packageName: "dsh-memory",
    version: "1.2.3",
    durationMs: 42,
  }, {
    env: { DSH_HUB_TELEMETRY_DEBUG: "1" },
    fetchImpl: async () => {
      delivered = true;
      return new Response(null, { status: 204 });
    },
    onDebug: (value) => {
      debug = value as { endpoint: string; payload: Record<string, unknown> };
    },
  });
  assert.equal(delivered, false);
  assert.equal(debug?.endpoint, "https://hub.test/api/v1/telemetry/cli");
  assert.equal(debug?.payload.packageName, "dsh-memory");
  assert.equal("account" in (debug?.payload ?? {}), false);
  assert.equal("machineId" in (debug?.payload ?? {}), false);
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  dshPackageManifestSchema,
  dshProfileManifestSchema,
  hubProfileVersionSchema,
  pluginRecordSchema,
  profileSearchResponseSchema,
} from "../src/index.ts";

test("accepts the official dsh.bundle package shape", () => {
  const manifest = dshPackageManifestSchema.parse({
    name: "@example/dsh-memory",
    version: "1.2.3",
    type: "module",
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      client: { inject: ["@deepseek-ai/dsh-client-runtime"], platform: "web" },
    },
  });

  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
});

test("rejects a plain dependency presented as a DSH plugin", () => {
  assert.throws(() =>
    dshPackageManifestSchema.parse({
      name: "plain-library",
      version: "1.0.0",
      dsh: {},
    }),
  );
});

test("preserves profile bundle order", () => {
  const profile = dshProfileManifestSchema.parse({
    name: "dsh-profile-web",
    dependencies: {
      "@deepseek-ai/dsh-base": "0.1.0-rc.7",
      "dsh-memory": "2.0.0",
    },
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "dsh-memory"],
      },
    },
  });

  assert.deepEqual(profile.dsh.profile.bundles, [
    "@deepseek-ai/dsh-base",
    "dsh-memory",
  ]);
});

test("validates a publishable Hub profile version", () => {
  const profile = hubProfileVersionSchema.parse({
    schemaVersion: 1,
    version: "1.0.0",
    name: "Research stack",
    bundles: [
      { packageName: "dsh-search", selector: "^2.0.0" },
      { packageName: "dsh-memory", selector: "1.4.0", after: ["dsh-search"] },
    ],
    publishedAt: "2026-08-18T00:00:00.000Z",
  });

  assert.equal(profile.bundles[1]?.after[0], "dsh-search");
});

test("validates compact profile search results", () => {
  const result = profileSearchResponseSchema.parse({
    items: [{
      id: "33333333-3333-4333-8333-333333333333",
      slug: "team-web",
      owner: "dsh-plugin-hub",
      latestVersion: "1.0.0",
      name: "Team Web",
      description: "A team community profile",
      bundleCount: 1,
      updatedAt: "2026-08-18T00:00:00.000Z",
    }],
  });

  assert.equal(result.items[0]?.bundleCount, 1);
});

test("plugin records accept optional github stars from the Hub API", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "hello-dsh",
    packageName: "dsh-hello",
    displayName: "Hello",
    summary: "A hello plugin",
    repository: "acme/dsh-hello",
    latestVersion: "1.0.0",
    versions: [{
      version: "1.0.0",
      manifest: {
        name: "dsh-hello",
        version: "1.0.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      },
      source: {
        kind: "github",
        repository: "acme/dsh-hello",
        ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        installSpec: "github:acme/dsh-hello#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      compatibility: {},
      publishedAt: "2026-08-20T00:00:00.000Z",
    }],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  pluginRecordSchema.parse(base);
  const withGithub = pluginRecordSchema.parse({
    ...base,
    github: { stars: 9, pushedAt: "2026-08-01T00:00:00.000Z" },
  });
  assert.equal(withGithub.github?.stars, 9);
});

test("plugin records accept the named security assurance contract", () => {
  const record = pluginRecordSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "hello-dsh",
    packageName: "dsh-hello",
    displayName: "Hello",
    summary: "A hello plugin",
    repository: "acme/dsh-hello",
    latestVersion: "1.0.0",
    security: {
      status: "incomplete",
      version: "1.0.0",
      scannerVersion: "v3",
      integrityVerified: true,
      staticAnalyzed: true,
      capabilityAnalyzed: true,
      dependencyInventoryComplete: false,
      advisoryScanned: true,
      behaviorAnalyzed: false,
      capabilities: {
        cordisModules: ["hello"],
        cordisServices: ["chat"],
        clientPackages: [],
        environmentVariables: ["HELLO_TOKEN"],
        networkHosts: ["api.example.com"],
        dynamicConfig: false,
        executablePatch: false,
        filesystemAccess: false,
        shellExecution: false,
        registersModelTools: true,
        sessionAccess: false,
      },
      updatedAt: "2026-08-24T07:34:56.724659Z",
    },
    versions: [{
      version: "1.0.0",
      manifest: {
        name: "dsh-hello",
        version: "1.0.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      },
      source: {
        kind: "npm",
        packageName: "dsh-hello",
        version: "1.0.0",
        tarballUrl: "https://registry.npmjs.org/dsh-hello/-/dsh-hello-1.0.0.tgz",
        integrity: "sha512-YWJj",
        installSpec: "dsh-hello@1.0.0",
      },
      compatibility: {},
      publishedAt: "2026-08-20T00:00:00.000Z",
    }],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-24T07:34:56.724659Z",
  });

  assert.equal(record.security?.status, "incomplete");
  assert.equal(record.security?.capabilities.registersModelTools, true);
});

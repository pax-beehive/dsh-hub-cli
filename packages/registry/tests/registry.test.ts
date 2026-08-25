import assert from "node:assert/strict";
import test from "node:test";
import type {
  PluginRecord,
  PluginVersion,
  ProfileBundle,
} from "@dsh-plugin-hub/schemas";
import {
  RegistryResolutionError,
  detectEntryIdConflicts,
  orderProfileBundles,
  resolvePluginVersion,
  resolveProfile,
  validateProfileBundleOrder,
} from "../src/index.ts";

function version(value: string, yanked = false): PluginVersion {
  return {
    version: value,
    channel: "stable",
    manifest: {
      name: "dsh-memory",
      version: value,
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    },
    source: {
      kind: "npm",
      packageName: "dsh-memory",
      version: value,
      tarballUrl: `https://registry.npmjs.org/dsh-memory/-/dsh-memory-${value}.tgz`,
      installSpec: `dsh-memory@${value}`,
    },
    compatibility: { dsh: "*", platforms: [], surfaces: ["any"], hmr: "restart" },
    entryIds: [],
    before: [],
    after: [],
    publishedAt: "2026-08-18T00:00:00.000Z",
    yanked,
  };
}

function plugin(versions: PluginVersion[]): PluginRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "dsh-memory",
    packageName: "dsh-memory",
    displayName: "Memory",
    summary: "Memory for DSH",
    description: "",
    repository: "example/dsh-memory",
    categories: [],
    keywords: [],
    screenshots: [],
    verified: false,
    deprecated: false,
    latestVersion: "2.1.0",
    distTags: { latest: "2.1.0", next: "3.0.0-beta.1" },
    versions,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

test("resolves exact, ranged, and tagged versions without selecting yanked builds", () => {
  const record = plugin([
    version("1.8.0"),
    version("2.0.0"),
    version("2.1.0"),
    version("2.2.0", true),
    version("3.0.0-beta.1"),
  ]);

  assert.equal(resolvePluginVersion(record, "latest").version, "2.1.0");
  assert.equal(resolvePluginVersion(record, "^2.0.0").version, "2.1.0");
  assert.equal(resolvePluginVersion(record, "next").version, "3.0.0-beta.1");
});

test("orders profile layers using stable before and after constraints", () => {
  const bundles: ProfileBundle[] = [
    { packageName: "dsh-ui", selector: "latest", before: [], after: ["dsh-memory"] },
    { packageName: "dsh-search", selector: "latest", before: ["dsh-memory"], after: [] },
    { packageName: "dsh-memory", selector: "latest", before: [], after: [] },
  ];

  assert.deepEqual(
    orderProfileBundles(bundles).map((bundle) => bundle.packageName),
    ["dsh-search", "dsh-memory", "dsh-ui"],
  );
});

test("rejects cyclic profile layer constraints", () => {
  assert.throws(
    () =>
      orderProfileBundles([
        { packageName: "dsh-a", selector: "latest", before: [], after: ["dsh-b"] },
        { packageName: "dsh-b", selector: "latest", before: [], after: ["dsh-a"] },
      ]),
    (error) =>
      error instanceof RegistryResolutionError && error.code === "ORDER_CYCLE",
  );
});

test("validates a published Profile sequence without reordering it", () => {
  const bundles: ProfileBundle[] = [
    { packageName: "dsh-search", selector: "latest", before: ["dsh-memory"], after: [] },
    { packageName: "dsh-memory", selector: "latest", before: [], after: [] },
  ];
  assert.deepEqual(validateProfileBundleOrder(bundles).map((bundle) => bundle.packageName), ["dsh-search", "dsh-memory"]);
  assert.throws(
    () => validateProfileBundleOrder([...bundles].reverse()),
    (error) => error instanceof RegistryResolutionError && error.code === "ORDER_CONSTRAINT",
  );
});

test("reports duplicate Cordis entry ids before a profile is applied", () => {
  const first = version("1.0.0");
  first.entryIds = ["storage", "memory"];
  const second = version("1.0.0");
  second.entryIds = ["storage"];

  assert.deepEqual(
    detectEntryIdConflicts([
      { packageName: "dsh-a", version: first },
      { packageName: "dsh-b", version: second },
    ]),
    [{ entryId: "storage", packages: ["dsh-a", "dsh-b"] }],
  );
});

test("resolves installation-owned DSH bundles without Registry records", () => {
  const resolved = resolveProfile({
    schemaVersion: 1, version: "1.0.0", name: "Web", description: "", dsh: "^0.1.0",
    runtime: { range: "^0.1.0", version: "0.1.0-rc.7" },
    bundles: [{ packageName: "@deepseek-ai/dsh-base", selector: "builtin", version: "0.1.0-rc.7", sourceKind: "builtin", before: [], after: [] }],
    patch: [], inputs: [], publishedAt: "2026-08-21T00:00:00.000Z",
  }, new Map());
  assert.equal(resolved.bundles[0]?.sourceKind, "builtin");
  assert.equal(resolved.bundles[0]?.version, "0.1.0-rc.7");
});

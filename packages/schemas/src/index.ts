import { z } from "zod";

const npmNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const npmPackageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(npmNamePattern, "Invalid npm package name");

export const exactSemverSchema = z
  .string()
  .regex(semverPattern, "Expected an exact semantic version");

export const dshBundleSchema = z
  .object({
    patch: z.string().min(1),
  })
  .strict();

export const dshClientSchema = z
  .object({
    inject: z.array(npmPackageNameSchema).default([]),
    platform: z.enum(["web", "headless", "desktop", "any"]).default("any"),
  })
  .passthrough();

export const dshPackageManifestSchema = z
  .object({
    name: npmPackageNameSchema,
    version: exactSemverSchema,
    description: z.string().max(2_000).optional(),
    license: z.string().max(100).optional(),
    main: z.string().min(1).optional(),
    exports: z.unknown().optional(),
    files: z.array(z.string()).optional(),
    sideEffects: z.union([z.boolean(), z.array(z.string())]).optional(),
    repository: z
      .union([
        z.string().min(1),
        z.object({ type: z.string().optional(), url: z.string().min(1) }).passthrough(),
      ])
      .optional(),
    dsh: z
      .object({
        bundle: dshBundleSchema,
        client: dshClientSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Keep only fields the Hub needs to install and describe a bundle. npm's
 * version endpoint adds maintainer emails and internal operational metadata to
 * package.json; those fields must never be mirrored into the public Registry.
 */
export function sanitizeDshPackageManifest(value: unknown) {
  const manifest = dshPackageManifestSchema.parse(value);
  const repository = typeof manifest.repository === "string"
    ? manifest.repository
    : manifest.repository
      ? {
          type: manifest.repository.type,
          url: manifest.repository.url,
          ...(typeof manifest.repository.directory === "string"
            ? { directory: manifest.repository.directory }
            : {}),
        }
      : undefined;
  return dshPackageManifestSchema.parse({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    main: manifest.main,
    exports: manifest.exports,
    files: manifest.files,
    sideEffects: manifest.sideEffects,
    repository,
    dsh: {
      bundle: { patch: manifest.dsh.bundle.patch },
      ...(manifest.dsh.client
        ? {
            client: {
              inject: manifest.dsh.client.inject,
              platform: manifest.dsh.client.platform,
            },
          }
        : {}),
    },
  });
}

export const dshProfileManifestSchema = z
  .object({
    name: npmPackageNameSchema,
    private: z.boolean().optional(),
    dependencies: z.record(npmPackageNameSchema, z.string().min(1)).default({}),
    dsh: z
      .object({
        profile: z
          .object({
            bundles: z.array(npmPackageNameSchema).min(1),
          })
          .strict(),
      })
      .passthrough(),
  })
  .passthrough();

export const screenshotSchema = z
  .object({
    url: z.url(),
    alt: z.string().min(1).max(300),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

export const pluginSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("npm"),
      packageName: npmPackageNameSchema,
      version: exactSemverSchema,
      tarballUrl: z.url(),
      integrity: z.string().min(1).optional(),
      installSpec: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("github"),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      ref: z.string().min(1),
      commit: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
      subdirectory: z.string().min(1).optional(),
      installSpec: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("r2"),
      objectKey: z.string().min(1),
      tarballUrl: z.url(),
      integrity: z.string().min(1),
      installSpec: z.string().min(1),
    })
    .strict(),
]);

export const compatibilitySchema = z
  .object({
    dsh: z.string().min(1).default("*"),
    node: z.string().min(1).optional(),
    platforms: z.array(z.enum(["darwin", "linux", "win32"])).default([]),
    surfaces: z.array(z.enum(["web", "headless", "desktop", "any"])).default(["any"]),
    hmr: z.enum(["full", "config", "refresh", "restart"]).default("restart"),
  })
  .strict();

export const hubListingSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    displayName: z.string().min(1).max(120).optional(),
    summary: z.string().min(1).max(300).optional(),
    description: z.string().max(20_000).optional(),
    homepage: z.url().optional(),
    categories: z.array(z.string().min(1).max(60)).max(12).default([]),
    keywords: z.array(z.string().min(1).max(60)).max(30).default([]),
    iconUrl: z.url().optional(),
    screenshots: z.array(screenshotSchema).max(8).default([]),
    compatibility: compatibilitySchema.optional(),
    entryIds: z.array(z.string().min(1)).max(100).default([]),
    before: z.array(npmPackageNameSchema).default([]),
    after: z.array(npmPackageNameSchema).default([]),
    channel: z.enum(["stable", "next", "beta", "canary"]).default("stable"),
  })
  .strict();

export const pluginVersionSchema = z
  .object({
    version: exactSemverSchema,
    channel: z.enum(["stable", "next", "beta", "canary"]).default("stable"),
    manifest: dshPackageManifestSchema,
    source: pluginSourceSchema,
    compatibility: compatibilitySchema,
    entryIds: z.array(z.string().min(1)).default([]),
    before: z.array(npmPackageNameSchema).default([]),
    after: z.array(npmPackageNameSchema).default([]),
    publishedAt: z.iso.datetime(),
    yanked: z.boolean().default(false),
    unpackedSize: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const publisherMetadataSchema = z
  .object({
    compatibility: z
      .object({
        dsh: z.string().min(1).max(120).optional(),
        hmr: z.enum(["full", "config", "refresh", "restart"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const pluginCapabilitiesSchema = z
  .object({
    cordisModules: z.array(z.string()),
    cordisServices: z.array(z.string()),
    clientPackages: z.array(z.string()),
    environmentVariables: z.array(z.string()),
    networkHosts: z.array(z.string()),
    dynamicConfig: z.boolean(),
    executablePatch: z.boolean(),
    filesystemAccess: z.boolean(),
    shellExecution: z.boolean(),
    registersModelTools: z.boolean(),
    sessionAccess: z.boolean(),
  })
  .strict();

export const securityAssessmentSchema = z
  .object({
    status: z.enum([
      "pending",
      "processing",
      "passed",
      "failed",
      "incomplete",
      "skipped",
      "error",
    ]),
    version: exactSemverSchema,
    scannerVersion: z.string().min(1),
    integrityVerified: z.boolean(),
    staticAnalyzed: z.boolean(),
    capabilityAnalyzed: z.boolean(),
    dependencyInventoryComplete: z.boolean(),
    advisoryScanned: z.boolean(),
    behaviorAnalyzed: z.boolean(),
    capabilities: pluginCapabilitiesSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const pluginRecordSchema = z
  .object({
    id: z.uuid(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    packageName: npmPackageNameSchema,
    displayName: z.string().min(1).max(120),
    summary: z.string().min(1).max(300),
    description: z.string().max(20_000).default(""),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    // GitHub-side trust signals, attached when the repository is present in
    // github_source_listings. Optional: source-only discovery may lag or a
    // package may come from a repository outside the discovered topics.
    github: z
      .object({
        stars: z.number().int().nonnegative(),
        pushedAt: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
    weeklyDownloads: z.number().int().nonnegative().default(0),
    // Catalog contract (PR #6 / 2e4541f): always present, 0 if unknown.
    dailyDownloads: z.number().int().nonnegative().default(0),
    dailyDownloadsDelta: z.number().int().nonnegative().default(0),
    // Deprecated compatibility flag; prefer the named checks in `security`.
    securityPassed: z.literal(true).optional(),
    security: securityAssessmentSchema.optional(),
    homepage: z.url().optional(),
    license: z.string().max(100).optional(),
    categories: z.array(z.string().min(1)).default([]),
    keywords: z.array(z.string().min(1)).default([]),
    iconUrl: z.url().optional(),
    screenshots: z.array(screenshotSchema).max(8).default([]),
    publisherMetadata: publisherMetadataSchema.default({}),
    claimed: z.boolean().default(false),
    verified: z.boolean().default(false),
    deprecated: z.boolean().default(false),
    replacement: npmPackageNameSchema.optional(),
    latestVersion: exactSemverSchema,
    distTags: z.record(z.string(), exactSemverSchema).default({}),
    versions: z.array(pluginVersionSchema).min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const profileBundleSchema = z
  .object({
    packageName: npmPackageNameSchema,
    selector: z.string().min(1).default("latest"),
    /** Exact immutable resolution. Required on Hub-authored releases. */
    version: exactSemverSchema.optional(),
    installSpec: z.string().min(1).optional(),
    integrity: z.string().min(1).optional(),
    sourceKind: z.enum(["npm", "github", "builtin"]).optional(),
    before: z.array(npmPackageNameSchema).default([]),
    after: z.array(npmPackageNameSchema).default([]),
  })
  .strict();

export const profileRuntimeSchema = z
  .object({
    range: z.string().min(1).default("*"),
    version: exactSemverSchema.optional(),
    integrity: z.string().min(1).optional(),
  })
  .strict();

export const profileInputSchema = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    label: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    required: z.boolean().default(true),
    secret: z.boolean().default(true),
  })
  .strict();

export const profileVerificationSchema = z
  .object({
    structural: z.literal("passed"),
    composition: z.enum(["local_required", "locally_verified"]).optional(),
    activation: z.enum(["local_required", "locally_verified"]),
    platform: z.enum(["darwin", "linux", "win32"]).optional(),
    verifiedAt: z.iso.datetime().optional(),
  })
  .strict();

export const hubProfileVersionSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: exactSemverSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).default(""),
    dsh: z.string().min(1).default("*"),
    runtime: profileRuntimeSchema.optional(),
    bundles: z.array(profileBundleSchema).min(1),
    patch: z.array(z.record(z.string(), z.unknown())).default([]),
    patchYaml: z.string().max(200_000).optional(),
    inputs: z.array(profileInputSchema).default([]),
    verification: profileVerificationSchema.optional(),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    publishedAt: z.iso.datetime(),
  })
  .strict();

export const profileDraftSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).default(""),
    visibility: z.enum(["public", "unlisted", "private"]).default("public"),
    dsh: z.string().min(1).default("*"),
    runtime: profileRuntimeSchema.optional(),
    bundles: z.array(profileBundleSchema).min(1),
    patch: z.array(z.record(z.string(), z.unknown())).default([]),
    patchYaml: z.string().max(200_000).optional(),
    inputs: z.array(profileInputSchema).default([]),
    updatedAt: z.iso.datetime().optional(),
  })
  .strict();

export const hubProfileSchema = z
  .object({
    id: z.uuid(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    packageName: npmPackageNameSchema.optional(),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
    owner: z.string().min(1),
    claimed: z.boolean().default(false),
    visibility: z.enum(["public", "unlisted", "private"]).default("public"),
    latestVersion: exactSemverSchema,
    versions: z.array(hubProfileVersionSchema).min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const profileCatalogItemSchema = z
  .object({
    id: z.uuid(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    packageName: npmPackageNameSchema.optional(),
    owner: z.string().min(1),
    claimed: z.boolean().default(false),
    latestVersion: exactSemverSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2_000),
    bundleCount: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const profileSearchResponseSchema = z
  .object({
    items: z.array(profileCatalogItemSchema),
  })
  .strict();

export const registrySearchResponseSchema = z
  .object({
    items: z.array(pluginRecordSchema.omit({ versions: true })),
    nextCursor: z.string().nullable(),
    // Present only when the backend supports numbered pagination
    // (page/sort params). Older backends omit it and the frontend falls back
    //    to cursor-only rendering.
    total: z.number().int().nonnegative().optional(),
  })
  .strict();

export type DshPackageManifest = z.infer<typeof dshPackageManifestSchema>;
export type DshProfileManifest = z.infer<typeof dshProfileManifestSchema>;
export type HubListing = z.infer<typeof hubListingSchema>;
export type PluginSource = z.infer<typeof pluginSourceSchema>;
export type PluginVersion = z.infer<typeof pluginVersionSchema>;
export type PluginRecord = z.infer<typeof pluginRecordSchema>;
export type ProfileBundle = z.infer<typeof profileBundleSchema>;
export type ProfileRuntime = z.infer<typeof profileRuntimeSchema>;
export type ProfileInput = z.infer<typeof profileInputSchema>;
export type ProfileDraft = z.infer<typeof profileDraftSchema>;
export type HubProfileVersion = z.infer<typeof hubProfileVersionSchema>;
export type HubProfile = z.infer<typeof hubProfileSchema>;
export type ProfileCatalogItem = z.infer<typeof profileCatalogItemSchema>;
